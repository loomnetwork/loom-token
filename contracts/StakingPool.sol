// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.7.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/utils/SafeCast.sol";
import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

//import "hardhat/console.sol"; // uncomment if you need to use console.log() to debug

/**
 * - Token holders can stake their tokens (`StakingPool.stake()`) for 2-week, 3-month, 6-month
 *   and 12-month periods.
 * - Stakeholders earn rewards on all tokens they have in the staking contract. Longer lockup
 *   periods grant higher reward rates:
 *   - 2-week lockup - base rate
 *   - 3-month lockup - `1.5x` base rate
 *   - 6-month lockup - `2x` base rate
 *   - 12-month lockup - `4x` base rate
 * - Stakeholders can claim any rewards earned on their staked tokens at any time. In most cases this
 *   will be done as part of `restake()` or `withdraw()` by setting the `_claim` arg to `true`,
 *   it's cheaper and easier to claim and do something with the rewards in one go than it is to do
 *   so separately. It's also possible to claim rewards via `claimRewards()`, but it's mostly
 *   just used for testing the claim logic.
 * - When rewards are claimed they are credited to the stakeholder's **unlocked balance**.
 *   The unlocked balance earns rewards at the base rate.
 * - Stakeholders can `restake()` or `withdraw() any tokens from their **unlocked balance** at any time.
 * - The number of active stakes a stakeholder can have at any one time is limited to ensure that
 *   reward claims don't require an excessive amounts of gas. The current limit is 10.
 * - Stakeholders can increase their total stake without creating new individual stakes by amending
 *   an existing stake via `amend()`. If there are multiple existing stakes with the same
 *   lockup period then the most recently created one will be amended. When a stake is amended its
 *   lockup expiry time can either remain unchanged, or it can be extended (though the owner can
 *   force the latter option by setting `_features.forceExtendOnAmend` to `true`).
 * - Staking data will be imported via `batchImportAccounts()`.
 */
contract StakingPool is Ownable {
    using SafeMath for uint256;
    using SafeCast for uint256;

    event AccountOpened(address indexed stakeholder);
    event AccountClosed(address indexed stakeholder);
    event Staked(address indexed stakeholder, uint256 amount, uint8 period, uint256 expiresOn);
    event Unstaked(address indexed stakeholder, uint256 amount, uint8 period, uint256 expiredOn);
    event Withdrawn(address indexed stakeholder, uint256 amount);
    event RewardsClaimed(address indexed stakeholder, uint256 rewards);
    event FeaturesChanged(
        bool importEnabled,
        bool stakingEnabled,
        bool amendEnabled,
        bool withdrawEnabled,
        bool rewardsEnabled,
        bool forceExtendOnAmend
    );

    uint256 public constant REWARDS_RATE_PRECISION = 1e18;
    uint256 public constant TOKEN_DECIMAL_PRECISION = 1e18; // == 1 whole LOOM token
    uint256 private constant _MAX_UINT256 = ~uint256(0);

    uint256[4] public LOCKUP_PERIOD = [
        1209600, // 2 weeks == 14 days
        7884000, // 3 months == 91.25 days
        15768000, // 6 months == 182.5 days
        31536000 // 1 year == 365 days
    ];
    uint16[4] public BONUS_NUMERATOR = [100, 150, 200, 400]; // == x1, x1.5, x2, x4
    uint16 public constant BONUS_DENOMINATOR = 100;

    struct Stake {
        uint8 period;
        uint64 unlockOn; // timestamp indicating expiration of lockup period
        uint128 amount; // whole token amount (no fractional part)
    }

    struct UnpackedStake {
        uint8 period;
        uint256 unlockOn; // timestamp indicating expiration of lockup period
        uint256 amount; // 18 decimal precision
    }

    struct Stakeholder {
        uint256 lastClaimedAt; // last time rewards were claimed
        // unlocked balance that can be withdrawn at any time, earns rewards at the base rate,
        // 18 decimal precision
        uint256 balance;
        Stake[] stakes; // unsorted
    }

    struct UnpackedStakeholder {
        uint256 lastClaimedAt;
        uint256 balance;
        UnpackedStake[] stakes;
    }

    struct ExportedAccount {
        uint128 balance; // whole token amount (no fractional part)
        Stake[] stakes;
    }

    mapping(address => Stakeholder) private _stakeholderMap;

    IERC20 public stakingToken;
    // total amount currently staked (including the unlocked balance of all stakeholders)
    uint256 public totalStaked;
    // total rewards claimed by all stakeholder to date
    uint256 public totalRewardsClaimed;
    // number of stakeholders with non-zero balance or some staked amount
    uint256 public numStakeholders;
    // annual reward rate with 18 decimal precision
    uint256 public annualBaseRewardsRate;
    // max number of stakes a stakeholder can have at any point in time
    // setting this to zero disables the limit enforcement
    uint256 public maxStakesPerAccount;

    // the time from which rewards will begin accumulating on imported stakes
    uint64 public migrationStartTime;

    struct Features {
        bool importEnabled;
        bool stakingEnabled;
        bool amendEnabled;
        bool withdrawEnabled;
        bool rewardsEnabled;
        bool forceExtendOnAmend;
    }
    Features private _features;

    struct Stats {
        uint256 totalStaked;
        uint256 totalRewardsClaimed;
        uint256 numStakeholders;
        uint256 annualBaseRewardsRate;
    }

    /**
     * @dev Reverts if the msg.sender isn't an existing stakeholder.
     */
    modifier onlyStakeholder() {
        Stakeholder storage _stakeholder = _stakeholderMap[msg.sender];
        require(
            _stakeholder.balance != 0 || _stakeholder.stakes.length != 0,
            "SP: account doesn't exist"
        );
        _;
    }

    /**
     * @dev Reverts if the staking feature is disabled.
     */
    modifier whenStakingEnabled() {
        require(_features.stakingEnabled, "SP: staking disabled");
        _;
    }

    /**
     * @dev Reverts if the amend feature is disabled.
     */
    modifier whenAmendEnabled() {
        require(_features.amendEnabled, "SP: amend disabled");
        _;
    }

    /**
     * @dev Reverts if the withdraw feature is disabled.
     */
    modifier whenWithdrawEnabled() {
        require(_features.withdrawEnabled, "SP: withdraw disabled");
        _;
    }

    constructor(
        address _token,
        uint256 _rewardsRate,
        uint64 _migrationStartTime
    ) {
        stakingToken = IERC20(_token);
        annualBaseRewardsRate = _rewardsRate;
        migrationStartTime = _migrationStartTime;
        _features.importEnabled = true;
        maxStakesPerAccount = 10;
    }

    function getStats() public view returns (Stats memory stats) {
        stats.totalStaked = totalStaked;
        stats.totalRewardsClaimed = totalRewardsClaimed;
        stats.numStakeholders = numStakeholders;
        stats.annualBaseRewardsRate = annualBaseRewardsRate;
    }

    function getStakeholder(address _stakeholder)
        public
        view
        returns (UnpackedStakeholder memory holder)
    {
        Stakeholder storage account = _stakeholderMap[_stakeholder];
        holder.lastClaimedAt = account.lastClaimedAt;
        holder.balance = account.balance;
        holder.stakes = new UnpackedStake[](account.stakes.length);
        for (uint256 i = 0; i < account.stakes.length; i++) {
            holder.stakes[i] = _unpackStake(account.stakes[i]);
        }
    }

    function getFeatures() public view returns (Features memory) {
        return _features;
    }

    function setFeatures(Features calldata _f) external onlyOwner {
        _features = _f;
        emit FeaturesChanged(
            _f.importEnabled,
            _f.stakingEnabled,
            _f.amendEnabled,
            _f.withdrawEnabled,
            _f.rewardsEnabled,
            _f.forceExtendOnAmend
        );
    }

    function setBaseRewardsRate(uint256 _rate) external onlyOwner {
        // TODO: basic validation
        annualBaseRewardsRate = _rate;
    }

    function setMaxStakesPerAccount(uint256 _maxStakes) external onlyOwner {
        maxStakesPerAccount = _maxStakes;
    }

    /**
     * @notice Stake the given amount of tokens from an Ethereum account.
     * @dev The caller must approve the StakingPool contract to transfer the amount being staked
     *      (via ERC20.approve on the stakingToken) before this function is called.
     */
    function stake(uint256 _amount, uint8 _period) external whenStakingEnabled {
        // Since the fractional part of the amount will be discarded make sure that the amount is
        // at least 1 LOOM, otherwise there'll be literally nothing left to stake.
        require(_amount >= TOKEN_DECIMAL_PRECISION, "StakingPool: amount too small");
        require(_period < 4, "StakingPool: invalid lockup period");

        Stakeholder storage stakeholder = _stakeholderMap[msg.sender];
        bool isNewStakeholder = stakeholder.balance == 0 && stakeholder.stakes.length == 0;

        require(
            (maxStakesPerAccount == 0) || (stakeholder.stakes.length < maxStakesPerAccount),
            "SP: account has too many stakes"
        );

        // drop the fractional part
        uint256 stakeAmount = _amount.div(TOKEN_DECIMAL_PRECISION).mul(TOKEN_DECIMAL_PRECISION);
        _addStake(stakeholder.stakes, stakeAmount, _period);

        totalStaked = totalStaked.add(stakeAmount);

        if (isNewStakeholder) {
            numStakeholders++;
            stakeholder.lastClaimedAt = block.timestamp;
            emit AccountOpened(msg.sender);
        }

        require(
            stakingToken.transferFrom(msg.sender, address(this), stakeAmount),
            "StakingPool: failed to stake due to failed token transfer"
        );
    }

    /**
     * @notice Restake the given amount of tokens from the unlocked balance.
     * @param _amount Amount of tokens to restake, or _MAX_UINT256 to restake the entire unlocked balance.
     * @param _period Period tokens should be restaked for.
     * @param _claim Set to `true` in order to claim rewards before tokens are restaked, this makes
     *               it possible to claim & restake in one go (cheaper than doing so separately).
     */
    function restake(
        uint256 _amount,
        uint8 _period,
        bool _claim
    ) external whenStakingEnabled onlyStakeholder {
        if (_claim) {
            _claimRewards();
        }

        Stakeholder storage stakeholder = _stakeholderMap[msg.sender];
        require(
            (maxStakesPerAccount == 0) || (stakeholder.stakes.length < maxStakesPerAccount),
            "SP: account has too many stakes"
        );

        if (_amount == _MAX_UINT256) {
            _amount = stakeholder.balance;
        } else {
            require(
                _amount <= stakeholder.balance,
                "StakingPool: amount exceeds available balance"
            );
        }
        // Since the fractional part of the amount will be discarded make sure that the amount is
        // at least 1 LOOM, otherwise there'll be literally nothing left to stake.
        require(_amount >= TOKEN_DECIMAL_PRECISION, "StakingPool: amount too small");

        // drop the fractional part
        uint256 stakeAmount = _amount.div(TOKEN_DECIMAL_PRECISION).mul(TOKEN_DECIMAL_PRECISION);
        _addStake(stakeholder.stakes, stakeAmount, _period);

        stakeholder.balance = stakeholder.balance.sub(stakeAmount);
        // NOTE: totalStaked doesn't change since it includes the unlocked balance from which the
        //       stake amount comes from.
    }

    /**
     * @notice Increase the amount of the most recently created stake (matching the given lockup
     *         period), and optionally extend its lockup period. If no such stake exists yet this
     *         function will revert.
     *
     *         The amount by which the stake is increased can either come from the stakeholder's
     *         Ethereum wallet, or their unlocked balance, or both.
     *
     *         Rewards will be automatically claimed before the stake is updated.
     *
     *         If a 3-month stake is amended one month later with `_extend == true` then its unlock
     *         time will be updated to 3 months out, so the stakeholder will have to wait another
     *         3 months for their stake to be unlocked instead of just 2 months.
     *
     * @param _amountFromWallet Amount to add to the stake from the Ethereum wallet, if zero then
     *                          only the unlocked balance will be used.
     * @param _amountFromBalance Amount to add to the stake from the unlocked balance,
     *                           or _MAX_UINT256 to add the entire unlocked balance.
     * @param _extend If `true` then the amended stake's unlock time will be extended, otherwise the
     *                original unlock time will remain unchanged.
     */
    function amend(
        uint256 _amountFromWallet,
        uint256 _amountFromBalance,
        uint8 _period,
        bool _extend
    ) external whenAmendEnabled onlyStakeholder {
        require(_extend || !_features.forceExtendOnAmend, "SP: must extend lockup");

        // After a stake is amended its total amount will be X + Y, where X is the original amount,
        // and Y is the amount added by _amendStake(). The currently pending rewards must be
        // distributed before updating the existing stake in order to ensure that amount Y only
        // starts earning rewards from this point on (rather than retroactively).
        Stakeholder storage stakeholder = _stakeholderMap[msg.sender];
        if (stakeholder.lastClaimedAt != block.timestamp) {
            _claimRewards();
        }

        if (_amountFromBalance == _MAX_UINT256) {
            _amountFromBalance = stakeholder.balance;
        } else {
            require(
                _amountFromBalance <= stakeholder.balance,
                "SP: amount exceeds available balance"
            );
        }

        uint256 stakeAmount =
            _amountFromWallet.add(_amountFromBalance).div(TOKEN_DECIMAL_PRECISION).mul(
                TOKEN_DECIMAL_PRECISION
            ); // drop the fractional part

        require(stakeAmount >= TOKEN_DECIMAL_PRECISION, "SP: amount too small");

        _amendStake(stakeholder.stakes, stakeAmount, _period, _extend);

        stakeholder.balance = stakeholder.balance.sub(stakeAmount.sub(_amountFromWallet));

        if (_amountFromWallet > 0) {
            totalStaked = totalStaked.add(_amountFromWallet);

            require(
                stakingToken.transferFrom(msg.sender, address(this), _amountFromWallet),
                "SP: token transfer failed"
            );
        }
    }

    /**
     * @dev Withdraws the given amount of tokens from the caller's unlocked staking balance.
     * @param _amount Amount of tokens to withdraw, or _MAX_UINT256 to withdraw the entire unlocked balance.
     * @param _claim Set to `true` in order to claim rewards before tokens are withdrawn, this makes
     *               it possible to claim & withdraw in one go (cheaper than doing so separately).
     */
    function withdraw(uint256 _amount, bool _claim) external whenWithdrawEnabled onlyStakeholder {
        require(_amount > 0, "SP: invalid amount");

        if (_claim) {
            _claimRewards();
        }

        Stakeholder storage stakeholder = _stakeholderMap[msg.sender];
        require(stakeholder.balance > 0, "StakingPool: nothing to withdraw");

        if (_amount == _MAX_UINT256) {
            _amount = stakeholder.balance;
        } else {
            require(
                _amount <= stakeholder.balance,
                "StakingPool: amount exceeds available balance"
            );
        }

        totalStaked = totalStaked.sub(_amount);
        stakeholder.balance = stakeholder.balance.sub(_amount);

        if (stakeholder.balance == 0 && stakeholder.stakes.length == 0) {
            numStakeholders--;
            delete _stakeholderMap[msg.sender];
            emit AccountClosed(msg.sender);
        }

        require(
            stakingToken.transfer(msg.sender, _amount),
            "StakingPool: withdraw failed due to failed token transfer"
        );

        emit Withdrawn(msg.sender, _amount);
    }

    /**
     * @notice Computes the rewards earned by the caller for their stake and credits them to the
     *         caller's unlocked balance, any stakes whose lockup period has expired will be removed
     *         and their amounts will be credited to the unlocked balance.
     *
     *         NOTE: Both restake() and withdraw() can claim rewards, which is more gas
     *         efficient because stakeholders can claim & restake, or claim & withdraw all in one tx.
     */
    function claimRewards() external onlyStakeholder {
        _claimRewards();
    }

    /**
     * @notice Computes the rewards earned by a stakeholder on their staked amounts since the last claim.
     * @param _stakeholder Address of the stakeholder.
     * @param _asAt Timestamp representing the end of the period for which rewards should be computed.
     * @return rewardsEarned Amount of tokens earned by the caller for staking since the last claim.
     * @return stakeUnlocked Total amount currently staked in expired lockups (that will be released
     *         next time rewards are claimed).
     */
    function pendingRewards(address _stakeholder, uint256 _asAt)
        external
        view
        returns (uint256 rewardsEarned, uint256 stakeUnlocked)
    {
        Stakeholder storage stakeholder = _stakeholderMap[_stakeholder];
        for (uint256 i = 0; i < stakeholder.stakes.length; i++) {
            UnpackedStake memory stk = _unpackStake(stakeholder.stakes[i]);
            // if the stake was created after the last rewards claim it should only earn rewards
            // from the time it was created
            uint256 bonusStart =
                Math.max(stakeholder.lastClaimedAt, stk.unlockOn.sub(LOCKUP_PERIOD[stk.period]));
            uint256 bonusEnd = Math.min(_asAt, stk.unlockOn);
            require(bonusEnd >= bonusStart, "StakingPool: invalid bonus period");
            rewardsEarned = rewardsEarned.add(
                stk.amount
                    .mul(BONUS_NUMERATOR[stk.period]).div(BONUS_DENOMINATOR)
                    .mul(annualBaseRewardsRate).div(REWARDS_RATE_PRECISION)
                    .mul(bonusEnd.sub(bonusStart)).div(365 days)
            );

            // after the initial stake lockup period has expired the staked amount should earn
            // rewards at the base rate
            if (_asAt > stk.unlockOn) {
                rewardsEarned = rewardsEarned.add(
                    stk.amount
                        .mul(annualBaseRewardsRate).div(REWARDS_RATE_PRECISION)
                        .mul(_asAt.sub(stk.unlockOn)).div(365 days)
                );
            }

            if (_asAt >= stk.unlockOn) {
                stakeUnlocked = stakeUnlocked.add(stk.amount);
            }
        }

        // the unlocked balance should earn rewards at the base rate
        if (_asAt > stakeholder.lastClaimedAt) {
            rewardsEarned = rewardsEarned.add(
                stakeholder.balance
                    .mul(annualBaseRewardsRate).div(REWARDS_RATE_PRECISION)
                    .mul(_asAt.sub(stakeholder.lastClaimedAt)).div(365 days)
            );
        }
    }

    /**
     * @dev Computes and claims rewards earned by the msg.sender since the last claim time.
     */
    function _claimRewards() private {
        require(_features.rewardsEnabled, "StakingPool: rewards disabled");

        Stakeholder storage stakeholder = _stakeholderMap[msg.sender];
        uint256 rewardsEarned;
        uint256 stakeUnlocked;
        if (stakeholder.stakes.length > 0) {
            // iterate through the stakes back to front, this ensures any swap & pop only shifts
            // stakes that have been iterated through already, so the loop processes every stake
            uint256 lastIdx = stakeholder.stakes.length - 1;
            for (int256 i = int256(lastIdx); i >= 0; i--) {
                uint256 curIdx = uint256(i);
                UnpackedStake memory stk = _unpackStake(stakeholder.stakes[curIdx]);
                // if the stake was created after the last rewards claim it should only earn rewards
                // from the time it was created
                uint256 bonusStart =
                    Math.max(
                        stakeholder.lastClaimedAt,
                        stk.unlockOn.sub(LOCKUP_PERIOD[stk.period])
                    );
                uint256 bonusEnd = Math.min(block.timestamp, stk.unlockOn);
                require(bonusEnd >= bonusStart, "StakingPool: invalid bonus period");
                rewardsEarned = rewardsEarned.add(
                    stk.amount
                        .mul(BONUS_NUMERATOR[stk.period]).div(BONUS_DENOMINATOR)
                        .mul(annualBaseRewardsRate).div(REWARDS_RATE_PRECISION)
                        .mul(bonusEnd.sub(bonusStart)).div(365 days)
                );

                // after the initial stake lockup period has expired the staked amount should earn
                // rewards at the base rate
                if (block.timestamp > stk.unlockOn) {
                    rewardsEarned = rewardsEarned.add(
                        stk.amount
                            .mul(annualBaseRewardsRate).div(REWARDS_RATE_PRECISION)
                            .mul(block.timestamp.sub(stk.unlockOn)).div(365 days)
                    );
                }

                // remove any stake whose original lockup period has expired
                if (block.timestamp >= stk.unlockOn) {
                    stakeUnlocked = stakeUnlocked.add(stk.amount);

                    emit Unstaked(msg.sender, stk.amount, stk.period, stk.unlockOn);

                    // swap & pop
                    if (curIdx < lastIdx) {
                        stakeholder.stakes[curIdx] = stakeholder.stakes[lastIdx];
                    }
                    stakeholder.stakes.pop();
                    lastIdx--;
                }
            }
        }

        // the unlocked balance should earn rewards at the base rate
        uint256 unlockedBalance = stakeholder.balance;
        if (block.timestamp > stakeholder.lastClaimedAt) {
            rewardsEarned = rewardsEarned.add(
                unlockedBalance
                    .mul(annualBaseRewardsRate).div(REWARDS_RATE_PRECISION)
                    .mul(block.timestamp.sub(stakeholder.lastClaimedAt)).div(365 days)
            );
        }

        if (rewardsEarned > 0) {
            unlockedBalance = unlockedBalance.add(rewardsEarned);
            totalStaked = totalStaked.add(rewardsEarned);
            totalRewardsClaimed = totalRewardsClaimed.add(rewardsEarned);

            emit RewardsClaimed(msg.sender, rewardsEarned);
        }

        stakeholder.balance = unlockedBalance.add(stakeUnlocked);
        stakeholder.lastClaimedAt = block.timestamp;
    }

    function _unpackStake(Stake storage _packedStake)
        private
        view
        returns (UnpackedStake memory stk)
    {
        stk.period = _packedStake.period;
        stk.unlockOn = _packedStake.unlockOn;
        stk.amount = uint256(_packedStake.amount).mul(TOKEN_DECIMAL_PRECISION);
    }

    function _addStake(
        Stake[] storage _stakes,
        uint256 _amount,
        uint8 _period
    ) private {
        uint256 unlockOn = block.timestamp.add(LOCKUP_PERIOD[_period]);
        Stake memory stk;
        stk.period = _period;
        stk.unlockOn = unlockOn.toUint64();
        stk.amount = _amount.div(TOKEN_DECIMAL_PRECISION).toUint128(); // discard fractional part
        _stakes.push(stk);

        emit Staked(msg.sender, _amount, _period, unlockOn);
    }

    function _amendStake(
        Stake[] storage _stakes,
        uint256 _amount,
        uint8 _period,
        bool _extend
    ) private {
        Stake storage stk = _findMostRecentStake(_stakes, _period);
        uint256 unlockOn = stk.unlockOn;
        uint256 oldAmount = uint256(stk.amount).mul(TOKEN_DECIMAL_PRECISION);
        uint256 newAmount = oldAmount.add(_amount);

        emit Unstaked(msg.sender, oldAmount, _period, unlockOn);

        stk.amount = newAmount.div(TOKEN_DECIMAL_PRECISION).toUint128();
        if (_extend) {
            unlockOn = block.timestamp.add(LOCKUP_PERIOD[_period]);
            stk.unlockOn = unlockOn.toUint64();
        }

        emit Staked(msg.sender, newAmount, _period, unlockOn);
    }

    function _findMostRecentStake(Stake[] storage _stakes, uint8 _period)
        private
        view
        returns (Stake storage)
    {
        uint64 maxUnlockTime;
        uint256 stakeIdx;
        for (uint256 i = 0; i < _stakes.length; i++) {
            if (
                (_stakes[i].period == _period) &&
                (_stakes[i].unlockOn > block.timestamp) && // ignore expired lockups
                (_stakes[i].unlockOn > maxUnlockTime)
            ) {
                maxUnlockTime = _stakes[i].unlockOn;
                stakeIdx = i + 1;
            }
        }

        require(stakeIdx != 0, "SP: stake not found");
        return _stakes[stakeIdx - 1];
    }

    function batchImportAccounts(
        address[] calldata _stakeholders,
        ExportedAccount[] calldata _accounts
    ) external onlyOwner {
        require(
            _stakeholders.length == _accounts.length,
            "StakingPool: mismatched array lengths on import"
        );
        require(_features.importEnabled, "StakingPool: import not allowed");

        uint256 importedStakeTotal;
        for (uint256 i = 0; i < _stakeholders.length; i++) {
            ExportedAccount calldata account = _accounts[i];
            Stakeholder storage stakeholder = _stakeholderMap[_stakeholders[i]];
            require(
                stakeholder.balance == 0 && stakeholder.stakes.length == 0,
                "StakingPool: account already exists"
            );

            stakeholder.balance = uint256(account.balance).mul(TOKEN_DECIMAL_PRECISION);
            stakeholder.lastClaimedAt = migrationStartTime;

            importedStakeTotal = importedStakeTotal.add(stakeholder.balance);
            for (uint256 j = 0; j < account.stakes.length; j++) {
                Stake memory stk;
                stk.period = account.stakes[j].period;
                stk.unlockOn = account.stakes[j].unlockOn;
                stk.amount = account.stakes[j].amount;
                stakeholder.stakes.push(stk);
                importedStakeTotal = importedStakeTotal.add(
                    uint256(stk.amount).mul(TOKEN_DECIMAL_PRECISION)
                );
            }
        }
        numStakeholders += _stakeholders.length;
        totalStaked = totalStaked.add(importedStakeTotal);
    }
}
