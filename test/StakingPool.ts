import { ethers } from "hardhat";
import { Signer } from "ethers";
import { expect } from "chai";
import { MINTER_ROLE } from "./LoomToken";

const HOUR_SECONDS = 60 * 60;
const YEAR_SECONDS = HOUR_SECONDS * 24 * 365;
const LOCKUP_PERIOD = [
  1209600, // 2 weeks == 14 days
  7884000, // 3 months == 91.25 days
  15768000, // 6 months == 182.5 days
  31536000, // 1 year == 365 days
];

// Since everything is computed with BigNumber integers the rate is scaled up by 1e18 before
// being scaled back down the final result, so all rate computation effectively happens with
// 18 decimal points of precision.
const decimalAdj = ethers.BigNumber.from(10).pow(18);

/**
 * @brief Sets the timestamp of the next block that will be produced the test network.
 * @note This only works on the Hardhat test network at the moment, not Ganache, nor Rinkeby.
 * @param timestamp Seconds since the UNIX epoch.
 */
async function setNextBlockTimestamp(timestamp: number) {
  await ethers.provider.send("evm_setNextBlockTimestamp", [timestamp]);
}

interface IFeatures {
  importEnabled: boolean;
  stakingEnabled: boolean;
  amendEnabled: boolean;
  withdrawEnabled: boolean;
  rewardsEnabled: boolean;
  forceExtendOnAmend: boolean;
}

function allFeatures(state: boolean): IFeatures {
  return {
    importEnabled: state,
    stakingEnabled: state,
    amendEnabled: state,
    withdrawEnabled: state,
    rewardsEnabled: state,
    forceExtendOnAmend: state,
  };
}

describe("StakingPool", function () {
  let contractFactory;
  let tokenContract;
  let accounts: Signer[];
  let owner: Signer;
  let ownerAddress: string;

  const REWARDS_RATE = ethers.BigNumber.from(5).mul(decimalAdj).div(100); // 5%
  const MIGRATION_START_TIME = ethers.BigNumber.from(Date.now()).div(1000);

  beforeEach(async function () {
    accounts = await ethers.getSigners();
    owner = accounts[0];
    ownerAddress = await owner.getAddress();
    contractFactory = await ethers.getContractFactory("StakingPool");
    let tokenFactory = await ethers.getContractFactory("TestToken");
    const oldToken = await tokenFactory.deploy();
    const swapContractFactory = await ethers.getContractFactory("TokenSwap");
    const tokenSwapContract = await swapContractFactory.deploy(oldToken.address);
    tokenFactory = await ethers.getContractFactory("LoomToken");
    tokenContract = await tokenFactory.deploy(tokenSwapContract.address);
    // give out some tokens to stake with
    await tokenContract.grantRole(MINTER_ROLE, ownerAddress);
    await tokenContract.mint(ownerAddress, ethers.BigNumber.from(50000).mul(decimalAdj));
    await tokenContract.mint(
      await accounts[1].getAddress(),
      ethers.BigNumber.from(50000).mul(decimalAdj)
    );
  });

  describe("constructor", function () {
    it("Should set members", async function () {
      const contract = await contractFactory.deploy(
        tokenContract.address,
        REWARDS_RATE,
        MIGRATION_START_TIME
      );
      await contract.deployed();
      expect(await contract.owner(), "owner should be set").to.equal(ownerAddress);
      expect(await contract.stakingToken(), "staking token should be set").to.equal(
        tokenContract.address
      );
      expect(await contract.annualBaseRewardsRate(), "rewards rate should be set").to.equal(
        REWARDS_RATE
      );
      const stats = await contract.getStats();
      expect(stats.annualBaseRewardsRate).to.equal(REWARDS_RATE);
      expect(await contract.migrationStartTime(), "rewards rate should be set").to.equal(
        MIGRATION_START_TIME
      );
      const features = await contract.getFeatures();
      expect(features.importEnabled, "import feature should be enabled by default").to.equal(true);
      expect(
        await contract.maxStakesPerAccount(),
        "max stakes per account should be set"
      ).to.equal(10);
    });
  });

  describe("setFeatures", function () {
    let contract;

    beforeEach(async function () {
      contract = await contractFactory.deploy(
        tokenContract.address,
        REWARDS_RATE,
        MIGRATION_START_TIME
      );
      await contract.deployed();
    });

    it("Should only be callable by the owner", async function () {
      await expect(
        contract.connect(accounts[1]).setFeatures({ importEnabled: true })
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("Should toggle features", async function () {
      let features = await contract.getFeatures();
      expect(features.importEnabled).to.equal(true);
      expect(features.stakingEnabled).to.equal(false);
      expect(features.amendEnabled).to.equal(false);
      expect(features.withdrawEnabled).to.equal(false);
      expect(features.rewardsEnabled).to.equal(false);
      expect(features.forceExtendOnAmend).to.equal(false);
      await expect(
        contract.setFeatures({
          importEnabled: false,
          stakingEnabled: true,
          amendEnabled: false,
          withdrawEnabled: false,
          rewardsEnabled: true,
          forceExtendOnAmend: true,
        })
      )
        .to.emit(contract, "FeaturesChanged")
        .withArgs(false, true, false, false, true, true);
      features = await contract.getFeatures();
      expect(features.importEnabled).to.equal(false);
      expect(features.stakingEnabled).to.equal(true);
      expect(features.amendEnabled).to.equal(false);
      expect(features.withdrawEnabled).to.equal(false);
      expect(features.rewardsEnabled).to.equal(true);
      expect(features.forceExtendOnAmend).to.equal(true);
    });
  });

  describe("setBaseRewardsRate", function () {
    it("Should only be callable by the owner", async function () {
      const contract = await contractFactory.deploy(
        tokenContract.address,
        REWARDS_RATE,
        MIGRATION_START_TIME
      );
      await contract.deployed();
      await expect(
        contract.connect(accounts[1]).setBaseRewardsRate(ethers.BigNumber.from(500))
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("Should change the state", async function () {
      const contract = await contractFactory.deploy(
        tokenContract.address,
        REWARDS_RATE,
        MIGRATION_START_TIME
      );
      await contract.deployed();
      const currentRate = await contract.annualBaseRewardsRate();
      const newRate = currentRate.add(1);
      await contract.setBaseRewardsRate(newRate);
      expect(await contract.annualBaseRewardsRate()).to.equal(newRate);
    });
  });

  describe("setMaxStakesPerAccount", function () {
    it("Should only be callable by the owner", async function () {
      const contract = await contractFactory.deploy(
        tokenContract.address,
        REWARDS_RATE,
        MIGRATION_START_TIME
      );
      await contract.deployed();
      await expect(
        contract.connect(accounts[1]).setMaxStakesPerAccount(ethers.BigNumber.from(500))
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("Should change the state", async function () {
      const contract = await contractFactory.deploy(
        tokenContract.address,
        REWARDS_RATE,
        MIGRATION_START_TIME
      );
      await contract.deployed();
      const currentLimit = await contract.maxStakesPerAccount();
      const newLimit = currentLimit.add(10);
      await contract.setMaxStakesPerAccount(newLimit);
      expect(await contract.maxStakesPerAccount()).to.equal(newLimit);
    });
  });

  describe("getStats", function () {
    it("Should return expected data", async function () {
      const contract = await contractFactory.deploy(
        tokenContract.address,
        REWARDS_RATE,
        MIGRATION_START_TIME
      );
      await contract.deployed();
      await contract.setFeatures(Object.assign(allFeatures(true), { importEnabled: false }));
      await tokenContract.approve(contract.address, ethers.BigNumber.from(10000).mul(decimalAdj));
      const lockupStartTime = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(lockupStartTime);
      await contract.stake(ethers.BigNumber.from(7300).mul(decimalAdj), 0);
      let stats = await contract.getStats();
      expect(await contract.numStakeholders()).to.equal(stats.numStakeholders);
      // fast forward time by 14 days
      await setNextBlockTimestamp(lockupStartTime + HOUR_SECONDS * 24 * 14);
      await contract.claimRewards();

      stats = await contract.getStats();
      expect(await contract.totalStaked()).to.equal(stats.totalStaked);
      expect(await contract.totalRewardsClaimed()).to.equal(stats.totalRewardsClaimed);
      expect(await contract.annualBaseRewardsRate()).to.equal(stats.annualBaseRewardsRate);
      expect(await contract.numStakeholders()).to.equal(stats.numStakeholders);
    });
  });

  describe("stake", function () {
    let contract;

    beforeEach(async function () {
      contract = await contractFactory.deploy(
        tokenContract.address,
        REWARDS_RATE,
        MIGRATION_START_TIME
      );
      await contract.deployed();
      await contract.setFeatures(Object.assign(allFeatures(true)));
    });

    it("Should revert if staking is disabled", async function () {
      await contract.setFeatures(
        Object.assign(allFeatures(true), {
          stakingEnabled: false,
          rewardsEnabled: false,
        })
      );
      const amount = ethers.BigNumber.from(500).mul(decimalAdj);
      await tokenContract.approve(contract.address, amount);
      await expect(contract.stake(amount, 0)).to.be.revertedWith("SP: staking disabled");
    });

    it("Should allow a user to create a single stake for 2-weeks", async function () {
      const stakeholderAddress = ownerAddress;
      const amount = ethers.BigNumber.from(500).mul(decimalAdj);
      await tokenContract.approve(contract.address, amount);
      const period = ethers.BigNumber.from(3);
      const lockupStartTime = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(lockupStartTime);
      const unlockOn = lockupStartTime + LOCKUP_PERIOD[3];

      await expect(contract.stake(amount, period))
        .to.emit(contract, "Staked")
        .withArgs(stakeholderAddress, amount, period, unlockOn)
        .to.emit(contract, "AccountOpened")
        .withArgs(stakeholderAddress);
      expect(await contract.numStakeholders()).to.equal(1);

      const stakeholder = await contract.getStakeholder(stakeholderAddress);
      expect(await stakeholder.balance).to.equal(0);
      const stakes = stakeholder.stakes;
      expect(stakes.length).to.equal(1);
      expect(stakes[0].period).to.equal(period);
      expect(stakes[0].amount).to.equal(amount);
    });

    it("Should revert if token transfer fails", async function () {
      const amount = ethers.BigNumber.from(500).mul(decimalAdj);
      await expect(contract.stake(amount, 0)).to.be.revertedWith(
        "ERC20: transfer amount exceeds allowance"
      );
    });

    it("Should allow a user to create multiple stakes", async function () {
      const stakes = [
        {
          amount: ethers.BigNumber.from(500).mul(decimalAdj),
          period: 0,
        },
        {
          amount: ethers.BigNumber.from(700).mul(decimalAdj),
          period: 1,
        },
        {
          amount: ethers.BigNumber.from(900).mul(decimalAdj),
          period: 2,
        },
        {
          amount: ethers.BigNumber.from(1200).mul(decimalAdj),
          period: 3,
        },
      ];
      await tokenContract.approve(contract.address, ethers.BigNumber.from(10000).mul(decimalAdj));
      for (let i = 0; i < stakes.length; i++) {
        await contract.stake(stakes[i].amount, stakes[i].period);
      }
      expect(await contract.numStakeholders()).to.equal(1);

      const stakes2 = (await contract.getStakeholder(ownerAddress)).stakes;
      expect(stakes2.length).to.equal(stakes.length);
      expect(await contract.totalStaked()).to.equal(
        ethers.BigNumber.from(500 + 700 + 900 + 1200).mul(decimalAdj)
      );
    });

    it("Should revert if user tries to create too many stakes", async function () {
      await contract.setMaxStakesPerAccount(2);
      const stakes = [
        {
          amount: ethers.BigNumber.from(500).mul(decimalAdj),
          period: 0,
        },
        {
          amount: ethers.BigNumber.from(700).mul(decimalAdj),
          period: 1,
        },
        {
          amount: ethers.BigNumber.from(900).mul(decimalAdj),
          period: 2,
        },
      ];
      await tokenContract.approve(contract.address, ethers.BigNumber.from(10000).mul(decimalAdj));
      await contract.stake(stakes[0].amount, stakes[0].period);
      await contract.stake(stakes[1].amount, stakes[1].period);
      await expect(contract.stake(stakes[2].amount, stakes[2].period)).to.be.revertedWith(
        "SP: account has too many stakes"
      );
      await contract.setMaxStakesPerAccount(0); // disable the limit
      contract.stake(stakes[2].amount, stakes[2].period);
    });

    it("Should allow multiple users to stake", async function () {
      const contract2 = await contract.connect(accounts[1]);
      const stakeAmount1 = ethers.BigNumber.from(500).mul(decimalAdj);
      const stakeAmount2 = ethers.BigNumber.from(900).mul(decimalAdj);
      await tokenContract.approve(contract.address, stakeAmount1);
      await tokenContract.connect(accounts[1]).approve(contract.address, stakeAmount2);
      await contract.stake(stakeAmount1, 0);
      await contract2.stake(stakeAmount2, 0);

      expect(await contract.numStakeholders()).to.equal(2);
      const stakeholderAddress1 = ownerAddress;
      const stakeholder1 = await contract.getStakeholder(stakeholderAddress1);
      expect(stakeholder1.balance).to.equal(0);
      const stakes1 = stakeholder1.stakes;
      expect(stakes1.length).to.equal(1);
      expect(stakes1[0].period).to.equal(ethers.BigNumber.from(0));
      expect(stakes1[0].amount).to.equal(stakeAmount1);
      const stakeholderAddress2 = await accounts[1].getAddress();
      const stakeholder2 = await contract.getStakeholder(stakeholderAddress2);
      expect(stakeholder2.balance).to.equal(0);
      const stakes2 = stakeholder2.stakes;
      expect(stakes2.length).to.equal(1);
      expect(stakes2[0].period).to.equal(ethers.BigNumber.from(0));
      expect(stakes2[0].amount).to.equal(stakeAmount2);
      expect(await contract.totalStaked()).to.equal(stakeAmount1.add(stakeAmount2));
    });
  });

  describe("restake", function () {
    let contract;

    beforeEach(async function () {
      contract = await contractFactory.deploy(
        tokenContract.address,
        REWARDS_RATE,
        MIGRATION_START_TIME
      );
      await contract.deployed();
      await contract.setFeatures(allFeatures(true));
    });

    it("Should revert if staking is disabled", async function () {
      await tokenContract.approve(contract.address, ethers.BigNumber.from(10000).mul(decimalAdj));
      // stake for 2-weeks
      const stakeAmount = ethers.BigNumber.from(7300).mul(decimalAdj);
      const lockupStartTime = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(lockupStartTime);
      await contract.stake(stakeAmount, 0);
      // fast forward time by 14 days
      await setNextBlockTimestamp(lockupStartTime + HOUR_SECONDS * 24 * 14);
      await contract.setFeatures(Object.assign(allFeatures(false), { importEnabled: true }));
      await expect(contract.restake(ethers.constants.Zero, 0, false)).to.be.revertedWith(
        "SP: staking disabled"
      );
    });

    it("Should allow a user to restake entire unlocked balance", async function () {
      await tokenContract.approve(contract.address, ethers.BigNumber.from(10000).mul(decimalAdj));
      // stake for 2-weeks
      const stakeAmount = ethers.BigNumber.from(7300).mul(decimalAdj);
      const lockupStartTime = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(lockupStartTime);
      await contract.stake(stakeAmount, 0);
      // fast forward time by 14 days
      await setNextBlockTimestamp(lockupStartTime + HOUR_SECONDS * 24 * 14);
      const stakeholderAddress = ownerAddress;
      // base rewards rate is 5%, 7300 is staked so 365 tokens should be awarded per year, which
      // comes out to 1 token per day, so after 14 days should have earned 14 tokens
      const expectedRewards = ethers.BigNumber.from(14).mul(decimalAdj);
      const totalStakedBefore = await contract.totalStaked();
      // claim rewards & restake
      await contract.restake(ethers.constants.MaxUint256, 0, true);
      const totalStakedAfter = await contract.totalStaked();
      expect(
        totalStakedAfter.sub(expectedRewards),
        "total staked should include rewards"
      ).to.equal(totalStakedBefore);
      const stakeholder = await contract.getStakeholder(stakeholderAddress);
      expect(stakeholder.stakes.length, "new lockup should replace old one").to.equal(1);
      expect(stakeholder.balance).to.equal(0);
    });

    it("Should allow a user to restake part of the unlocked balance", async function () {
      await tokenContract.approve(contract.address, ethers.BigNumber.from(10000).mul(decimalAdj));
      // stake for 2-weeks
      const stakeAmount = ethers.BigNumber.from(7300).mul(decimalAdj);
      const lockupStartTime = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(lockupStartTime);
      await contract.stake(stakeAmount, 0);
      // fast forward time by 14 days
      await setNextBlockTimestamp(lockupStartTime + HOUR_SECONDS * 24 * 14);
      const stakeholderAddress = ownerAddress;
      // base rewards rate is 5%, 7300 is staked so 365 tokens should be awarded per year, which
      // comes out to 1 token per day, so after 14 days should have earned 14 tokens
      const expectedRewards = ethers.BigNumber.from(14).mul(decimalAdj);
      await expect(contract.claimRewards())
        .to.emit(contract, "RewardsClaimed")
        .withArgs(stakeholderAddress, expectedRewards);
      const totalStakedBefore = await contract.totalStaked();
      await contract.restake(stakeAmount, 0, false);
      const totalStakedAfter = await contract.totalStaked();
      expect(totalStakedAfter, "total staked should be the same").to.equal(totalStakedBefore);
      const stakeholder = await contract.getStakeholder(stakeholderAddress);
      expect(stakeholder.stakes.length, "one new lockup should exist").to.equal(1);
      expect(stakeholder.balance, "unlocked balance shouldn't include restaked amount").to.equal(
        expectedRewards
      );
    });

    it("Should revert if user tries to create too many stakes", async function () {
      await tokenContract.approve(contract.address, ethers.BigNumber.from(20000).mul(decimalAdj));
      // stake for 2-weeks
      const stakeAmount = ethers.BigNumber.from(7300).mul(decimalAdj);
      const lockupStartTime = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(lockupStartTime);
      await contract.stake(stakeAmount, 0);
      // stake for 3-months
      await contract.stake(stakeAmount, 1);
      // fast forward time by 14 days
      await setNextBlockTimestamp(lockupStartTime + HOUR_SECONDS * 24 * 14);
      // at this point the 2-week lockup has expired and can be restaked
      await contract.setMaxStakesPerAccount(1);
      await expect(contract.restake(stakeAmount, 0, true)).to.be.revertedWith(
        "SP: account has too many stakes"
      );
      await contract.setMaxStakesPerAccount(2);
      await contract.restake(stakeAmount, 0, true);
    });
  });

  describe("amend", function () {
    let contract;

    beforeEach(async function () {
      contract = await contractFactory.deploy(
        tokenContract.address,
        REWARDS_RATE,
        MIGRATION_START_TIME
      );
      await contract.deployed();
      await contract.setFeatures(Object.assign(allFeatures(true), { forceExtendOnAmend: false }));
    });

    it("Should revert if amend feature is disabled", async function () {
      await contract.setFeatures(Object.assign(allFeatures(true), { amendEnabled: false }));
      await tokenContract.approve(contract.address, ethers.BigNumber.from(10000).mul(decimalAdj));
      const stakeAmount = ethers.BigNumber.from(7300).mul(decimalAdj);
      const lockupStartTime = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(lockupStartTime);
      await contract.stake(stakeAmount, 1);
      // disable amend
      await contract.setFeatures(allFeatures(false));

      await expect(
        contract.amend(stakeAmount, ethers.constants.Zero, 1, false)
      ).to.be.revertedWith("SP: amend disabled");
    });

    it("Should revert if can't amend without extending the lockup", async function () {
      await contract.setFeatures(allFeatures(true));
      await tokenContract.approve(contract.address, ethers.BigNumber.from(10000).mul(decimalAdj));
      const stakeAmount = ethers.BigNumber.from(7300).mul(decimalAdj);
      const lockupStartTime = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(lockupStartTime);
      await contract.stake(stakeAmount, 1);

      await expect(
        contract.amend(stakeAmount, ethers.constants.Zero, 1, false)
      ).to.be.revertedWith("SP: must extend lockup");
    });

    it("Should revert if called by someone who is not a stakeholder", async function () {
      const stakeAmount = ethers.BigNumber.from(7300).mul(decimalAdj);
      await expect(
        contract.amend(stakeAmount, ethers.constants.Zero, 1, false)
      ).to.be.revertedWith("SP: account doesn't exist");
    });

    it("Should revert if there's no suitable stake to amend", async function () {
      await tokenContract.approve(contract.address, ethers.BigNumber.from(10000).mul(decimalAdj));
      // stake for 2-weeks
      const stakeAmount = ethers.BigNumber.from(7300).mul(decimalAdj);
      const lockupStartTime = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(lockupStartTime);
      await contract.stake(stakeAmount, 0);
      // fast forward time by 14 days and claim rewards, this will delete the 2-week stake
      await setNextBlockTimestamp(lockupStartTime + HOUR_SECONDS * 24 * 14);
      await contract.claimRewards();

      // now there should be no stake left to amend
      await expect(
        contract.amend(stakeAmount, ethers.constants.Zero, 0, false)
      ).to.be.revertedWith("SP: stake not found");
    });

    it("Should allow a user to use their entire unlocked balance", async function () {
      await tokenContract.approve(contract.address, ethers.BigNumber.from(10000).mul(decimalAdj));
      // stake for 2-weeks
      const stakeAmount = ethers.BigNumber.from(7300).mul(decimalAdj);
      const lockupStartTime = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(lockupStartTime);
      await contract.stake(stakeAmount, 0);
      // fast forward time by 14 days
      await setNextBlockTimestamp(lockupStartTime + HOUR_SECONDS * 24 * 14);
      // restake the original amount for 3 months
      await contract.restake(stakeAmount, 1, true);
      const totalStakedBefore = await contract.totalStaked();
      const stakeholderAddr = ownerAddress;
      const stakeholderBefore = await contract.getStakeholder(stakeholderAddr);
      // add the previously earned rewards to the 3-month stake
      // stake amount should be original 7300 + 14 from rewards
      const newStakeAmount = stakeAmount.add(ethers.BigNumber.from(14).mul(decimalAdj));

      await expect(contract.amend(ethers.constants.Zero, ethers.constants.MaxUint256, 1, false))
        .to.emit(contract, "RewardsClaimed")
        .to.emit(contract, "Unstaked")
        .withArgs(stakeholderAddr, stakeAmount, 1, stakeholderBefore.stakes[0].unlockOn)
        .to.emit(contract, "Staked")
        .withArgs(stakeholderAddr, newStakeAmount, 1, stakeholderBefore.stakes[0].unlockOn);

      // staked total should only differ by a small fractional amount (from the claimed rewards)
      expect((await contract.totalStaked()).div(decimalAdj)).to.equal(
        totalStakedBefore.div(decimalAdj)
      );
      const stakeholderAfter = await contract.getStakeholder(stakeholderAddr);
      expect(stakeholderAfter.stakes.length).to.equal(stakeholderBefore.stakes.length);
      expect(stakeholderAfter.stakes[0].period).to.equal(stakeholderBefore.stakes[0].period);
      expect(stakeholderAfter.stakes[0].amount).to.equal(newStakeAmount);
      expect(stakeholderAfter.stakes[0].unlockOn).to.equal(stakeholderBefore.stakes[0].unlockOn);
      // since only whole token amounts can be added to a stake there's some fractional amount
      // left in the unlocked balance
      expect(stakeholderAfter.balance.div(decimalAdj)).to.equal(0);
    });

    it("Should allow a stake lockup to be extended", async function () {
      await tokenContract.approve(contract.address, ethers.BigNumber.from(10000).mul(decimalAdj));
      // stake for 2-weeks
      const stakeAmount = ethers.BigNumber.from(7300).mul(decimalAdj);
      const lockupStartTime = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(lockupStartTime);
      await contract.stake(stakeAmount, 0);
      // fast forward time by 14 days
      await setNextBlockTimestamp(lockupStartTime + HOUR_SECONDS * 24 * 14);
      // restake the original amount for 3 months
      await contract.restake(stakeAmount, 1, true);
      const totalStakedBefore = await contract.totalStaked();
      const stakeholderAddr = ownerAddress;
      const stakeholderBefore = await contract.getStakeholder(stakeholderAddr);
      const amendedLockupStartTime = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(amendedLockupStartTime);
      // add the previously earned rewards to the 3-month stake
      // stake amount should be original 7300 + 14 from rewards
      const newStakeAmount = stakeAmount.add(ethers.BigNumber.from(14).mul(decimalAdj));
      const newUnlockTime = amendedLockupStartTime + LOCKUP_PERIOD[1];

      await expect(contract.amend(ethers.constants.Zero, ethers.constants.MaxUint256, 1, true))
        .to.emit(contract, "RewardsClaimed")
        .to.emit(contract, "Unstaked")
        .withArgs(stakeholderAddr, stakeAmount, 1, stakeholderBefore.stakes[0].unlockOn)
        .to.emit(contract, "Staked")
        .withArgs(stakeholderAddr, newStakeAmount, 1, newUnlockTime);

      // staked total should only differ by a small fractional amount (from the claimed rewards)
      expect((await contract.totalStaked()).div(decimalAdj)).to.equal(
        totalStakedBefore.div(decimalAdj)
      );
      const stakeholderAfter = await contract.getStakeholder(stakeholderAddr);
      expect(stakeholderAfter.stakes.length).to.equal(stakeholderBefore.stakes.length);
      expect(stakeholderAfter.stakes[0].period).to.equal(stakeholderBefore.stakes[0].period);
      expect(stakeholderAfter.stakes[0].amount).to.equal(newStakeAmount);
      expect(stakeholderAfter.stakes[0].unlockOn).to.equal(newUnlockTime);
      // since only whole token amounts can be added to a stake there's some fractional amount
      // left in the unlocked balance
      expect(stakeholderAfter.balance.div(decimalAdj)).to.equal(0);
    });

    it("Should allow a user to use part of their unlocked balance", async function () {
      await tokenContract.approve(contract.address, ethers.BigNumber.from(10000).mul(decimalAdj));
      // stake for 2-weeks
      const stakeAmount = ethers.BigNumber.from(7300).mul(decimalAdj);
      const lockupStartTime = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(lockupStartTime);
      await contract.stake(stakeAmount, 0);
      // fast forward time by 14 days
      await setNextBlockTimestamp(lockupStartTime + HOUR_SECONDS * 24 * 14);
      // restake the original amount for 3 months
      await contract.restake(stakeAmount, 1, true);
      const totalStakedBefore = await contract.totalStaked();
      const stakeholderAddr = ownerAddress;
      const stakeholderBefore = await contract.getStakeholder(stakeholderAddr);
      // add some of the previously earned rewards to the 3-month stake
      // stake amount should be original 7300 + 7 from rewards
      const extraAmount = ethers.BigNumber.from(7).mul(decimalAdj);
      const newStakeAmount = stakeAmount.add(extraAmount);

      await expect(contract.amend(ethers.constants.Zero, extraAmount, 1, false))
        .to.emit(contract, "RewardsClaimed")
        .to.emit(contract, "Unstaked")
        .withArgs(stakeholderAddr, stakeAmount, 1, stakeholderBefore.stakes[0].unlockOn)
        .to.emit(contract, "Staked")
        .withArgs(stakeholderAddr, newStakeAmount, 1, stakeholderBefore.stakes[0].unlockOn);

      // staked total should only differ by a small fractional amount (from the claimed rewards)
      expect((await contract.totalStaked()).div(decimalAdj)).to.equal(
        totalStakedBefore.div(decimalAdj)
      );
      const stakeholderAfter = await contract.getStakeholder(stakeholderAddr);
      expect(stakeholderAfter.stakes.length).to.equal(stakeholderBefore.stakes.length);
      expect(stakeholderAfter.stakes[0].period).to.equal(stakeholderBefore.stakes[0].period);
      expect(stakeholderAfter.stakes[0].amount).to.equal(newStakeAmount);
      expect(stakeholderAfter.stakes[0].unlockOn).to.equal(stakeholderBefore.stakes[0].unlockOn);
      // 14 was earned in rewards from the original 2-week stake, 7 was added to the 3-month stake,
      // so 7 should remain in the unlocked balance
      expect(stakeholderAfter.balance.div(decimalAdj)).to.equal(7);
    });

    it("Should allow a user to use only their wallet balance", async function () {
      await tokenContract.approve(contract.address, ethers.BigNumber.from(10000).mul(decimalAdj));
      // stake for 3-months
      const stakeAmount = ethers.BigNumber.from(7300).mul(decimalAdj);
      const lockupStartTime = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(lockupStartTime);
      await contract.stake(stakeAmount, 1);
      const totalStakedBefore = await contract.totalStaked();
      const stakeholderAddr = ownerAddress;
      const stakeholderBefore = await contract.getStakeholder(stakeholderAddr);
      const extraAmount = ethers.BigNumber.from(10).mul(decimalAdj);
      const newStakeAmount = stakeAmount.add(extraAmount);

      await expect(contract.amend(extraAmount, ethers.constants.Zero, 1, false))
        .to.emit(contract, "RewardsClaimed")
        .to.emit(contract, "Unstaked")
        .withArgs(stakeholderAddr, stakeAmount, 1, stakeholderBefore.stakes[0].unlockOn)
        .to.emit(contract, "Staked")
        .withArgs(stakeholderAddr, newStakeAmount, 1, stakeholderBefore.stakes[0].unlockOn);

      expect((await contract.totalStaked()).div(decimalAdj)).to.equal(
        totalStakedBefore.add(extraAmount).div(decimalAdj)
      );
      const stakeholderAfter = await contract.getStakeholder(stakeholderAddr);
      expect(stakeholderAfter.stakes.length).to.equal(stakeholderBefore.stakes.length);
      expect(stakeholderAfter.stakes[0].period).to.equal(stakeholderBefore.stakes[0].period);
      expect(stakeholderAfter.stakes[0].amount).to.equal(newStakeAmount);
      expect(stakeholderAfter.stakes[0].unlockOn).to.equal(stakeholderBefore.stakes[0].unlockOn);
      expect(stakeholderAfter.balance.div(decimalAdj)).to.equal(
        stakeholderBefore.balance.div(decimalAdj)
      );
    });

    it("Should allow a user to use both their wallet balance and unlocked balance", async function () {
      await tokenContract.approve(contract.address, ethers.BigNumber.from(10000).mul(decimalAdj));
      // stake for 2 weeks
      const stakeAmount = ethers.BigNumber.from(7300).mul(decimalAdj);
      const lockupStartTime = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(lockupStartTime);
      await contract.stake(stakeAmount, 0);
      // fast forward time by 14 days
      await setNextBlockTimestamp(lockupStartTime + HOUR_SECONDS * 24 * 14);
      // claim 14 tokens in rewards and restake the original amount for 3 months
      await contract.restake(stakeAmount, 1, true);
      const totalStakedBefore = await contract.totalStaked();
      const stakeholderAddr = ownerAddress;
      const stakeholderBefore = await contract.getStakeholder(stakeholderAddr);
      const extraAmountFromWallet = ethers.BigNumber.from(10).mul(decimalAdj);
      const extraAmountFromRewards = ethers.BigNumber.from(5).mul(decimalAdj);
      const newStakeAmount = stakeAmount.add(extraAmountFromWallet).add(extraAmountFromRewards);

      await expect(contract.amend(extraAmountFromWallet, extraAmountFromRewards, 1, false))
        .to.emit(contract, "RewardsClaimed")
        .to.emit(contract, "Unstaked")
        .withArgs(stakeholderAddr, stakeAmount, 1, stakeholderBefore.stakes[0].unlockOn)
        .to.emit(contract, "Staked")
        .withArgs(stakeholderAddr, newStakeAmount, 1, stakeholderBefore.stakes[0].unlockOn);

      expect((await contract.totalStaked()).div(decimalAdj)).to.equal(
        totalStakedBefore.add(extraAmountFromWallet).div(decimalAdj)
      );
      const stakeholderAfter = await contract.getStakeholder(stakeholderAddr);
      expect(stakeholderAfter.stakes.length).to.equal(stakeholderBefore.stakes.length);
      expect(stakeholderAfter.stakes[0].period).to.equal(stakeholderBefore.stakes[0].period);
      expect(stakeholderAfter.stakes[0].amount).to.equal(newStakeAmount);
      expect(stakeholderAfter.stakes[0].unlockOn).to.equal(stakeholderBefore.stakes[0].unlockOn);
      expect(stakeholderAfter.balance.div(decimalAdj)).to.equal(
        stakeholderBefore.balance.sub(extraAmountFromRewards).div(decimalAdj)
      );
    });

    it("Should update only the most recent stake", async function () {
      await tokenContract.approve(contract.address, ethers.BigNumber.from(10000).mul(decimalAdj));
      const stakeAmounts = [
        ethers.BigNumber.from(100).mul(decimalAdj),
        ethers.BigNumber.from(200).mul(decimalAdj),
        ethers.BigNumber.from(300).mul(decimalAdj),
      ];
      const lockupStartTime = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(lockupStartTime);
      await contract.stake(stakeAmounts[0], 2);
      await contract.stake(stakeAmounts[1], 2);
      await contract.stake(stakeAmounts[2], 2);
      const totalStakedBefore = await contract.totalStaked();
      const stakeholderAddr = ownerAddress;
      const stakeholderBefore = await contract.getStakeholder(stakeholderAddr);
      const extraAmount = ethers.BigNumber.from(50).mul(decimalAdj);
      const newStakeAmount = stakeAmounts[2].add(extraAmount);

      await expect(contract.amend(extraAmount, ethers.constants.Zero, 2, false))
        .to.emit(contract, "RewardsClaimed")
        .to.emit(contract, "Unstaked")
        .withArgs(stakeholderAddr, stakeAmounts[2], 2, stakeholderBefore.stakes[2].unlockOn)
        .to.emit(contract, "Staked")
        .withArgs(stakeholderAddr, newStakeAmount, 2, stakeholderBefore.stakes[2].unlockOn);

      expect((await contract.totalStaked()).div(decimalAdj)).to.equal(
        totalStakedBefore.add(extraAmount).div(decimalAdj)
      );
      const stakeholderAfter = await contract.getStakeholder(stakeholderAddr);
      expect(stakeholderAfter.stakes.length).to.equal(stakeholderBefore.stakes.length);
      expect(stakeholderAfter.stakes[2].period).to.equal(stakeholderBefore.stakes[2].period);
      expect(stakeholderAfter.stakes[2].amount).to.equal(newStakeAmount);
      expect(stakeholderAfter.stakes[2].unlockOn).to.equal(stakeholderBefore.stakes[2].unlockOn);
      expect(stakeholderAfter.balance.div(decimalAdj)).to.equal(
        stakeholderBefore.balance.div(decimalAdj)
      );
    });
  });

  describe("pendingRewards", function () {
    it("Should not revert if no time has passed since stake was created", async function () {
      const contract = await contractFactory.deploy(
        tokenContract.address,
        REWARDS_RATE,
        MIGRATION_START_TIME
      );
      await contract.deployed();
      await contract.setFeatures(allFeatures(true));
      await tokenContract.approve(contract.address, ethers.BigNumber.from(10000).mul(decimalAdj));
      const stakeAmount = ethers.BigNumber.from(7300).mul(decimalAdj);
      const lockupStartTime = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(lockupStartTime);
      await contract.stake(stakeAmount, 0);
      const stakeholderAddress = ownerAddress;
      const [rewardsEarned, stakeUnlocked] = await contract.pendingRewards(
        stakeholderAddress,
        lockupStartTime
      );
      expect(rewardsEarned).to.equal(ethers.constants.Zero);
      expect(stakeUnlocked).to.equal(ethers.constants.Zero);
    });
  });

  describe("claimRewards", function () {
    let contract;

    beforeEach(async function () {
      contract = await contractFactory.deploy(
        tokenContract.address,
        REWARDS_RATE,
        MIGRATION_START_TIME
      );
      await contract.deployed();
      await contract.setFeatures(allFeatures(true));
    });

    it("Should revert if rewards are disabled", async function () {
      await contract.setFeatures(Object.assign(allFeatures(true), { rewardsEnabled: false }));
      await tokenContract.approve(contract.address, ethers.BigNumber.from(10000).mul(decimalAdj));
      const stakeAmount = ethers.BigNumber.from(7300).mul(decimalAdj);
      const lockupStartTime = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(lockupStartTime);
      await contract.stake(stakeAmount, 0);

      await expect(contract.claimRewards()).to.be.revertedWith("StakingPool: rewards disabled");
    });

    it("Should compute rewards for 2-week lockup", async function () {
      await tokenContract.approve(contract.address, ethers.BigNumber.from(10000).mul(decimalAdj));
      const stakeAmount = ethers.BigNumber.from(7300).mul(decimalAdj);
      const lockupStartTime = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(lockupStartTime);
      await contract.stake(stakeAmount, 0);
      // fast forward time by 14 days
      await setNextBlockTimestamp(lockupStartTime + HOUR_SECONDS * 24 * 14);
      const stakeholderAddress = ownerAddress;
      // base rewards rate is 5%, 7300 is staked so 365 tokens should be awarded per year, which
      // comes out to 1 token per day, so after 14 days should have earned 14 tokens
      const expectedRewards = ethers.BigNumber.from(14).mul(decimalAdj);
      await expect(contract.claimRewards())
        .to.emit(contract, "RewardsClaimed")
        .withArgs(stakeholderAddress, expectedRewards);
      expect(await contract.totalRewardsClaimed()).to.equal(expectedRewards);
      const stakeholder = await contract.getStakeholder(stakeholderAddress);
      expect(stakeholder.balance).to.equal(stakeAmount.add(expectedRewards));
      const totalStaked = await contract.totalStaked();
      expect(stakeholder.balance, "stakeholder balance should be same as total stake").to.equal(
        totalStaked
      );
      expect(stakeholder.stakes.length, "expired lockup should be removed").to.equal(0);
    });

    it("Should compute rewards for 3-month lockup (after expiry)", async function () {
      await tokenContract.approve(contract.address, ethers.BigNumber.from(10000).mul(decimalAdj));
      const stakeAmount = ethers.BigNumber.from(7300).mul(decimalAdj);
      const lockupStartTime = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(lockupStartTime);
      await contract.stake(stakeAmount, 1);
      // fast forward time by 91.25 days
      await setNextBlockTimestamp(lockupStartTime + (HOUR_SECONDS * 24 * 365) / 4);
      const stakeholderAddress = ownerAddress;
      // base rewards rate is 5%, 7300 is staked for 3 months so 1.5x bonus applies, so 547.5 tokens
      // should be awarded per year, which comes out to 1.5 tokens per day. After 91.25 days should
      // have earned 136.875 tokens
      const expectedRewards = ethers.BigNumber.from(136875).mul(decimalAdj).div(1000);
      await expect(contract.claimRewards())
        .to.emit(contract, "RewardsClaimed")
        .withArgs(stakeholderAddress, expectedRewards);
      const stakeholder = await contract.getStakeholder(stakeholderAddress);
      expect(stakeholder.balance).to.equal(stakeAmount.add(expectedRewards));
      const totalStaked = await contract.totalStaked();
      expect(stakeholder.balance, "stakeholder balance should be same as total stake").to.equal(
        totalStaked
      );
      expect(stakeholder.stakes.length, "expired lockup should be removed").to.equal(0);
    });

    it("Should compute rewards for 3-month lockup (before expiry)", async function () {
      await tokenContract.approve(contract.address, ethers.BigNumber.from(10000).mul(decimalAdj));
      const stakeAmount = ethers.BigNumber.from(7300).mul(decimalAdj);
      const lockupStartTime = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(lockupStartTime);
      await contract.stake(stakeAmount, 1);
      const stakeholderAddress = ownerAddress;
      // fast forward time by 30 days
      await setNextBlockTimestamp(lockupStartTime + HOUR_SECONDS * 24 * 30);
      // base rewards rate is 5%, 7300 is staked for 3 months so 1.5x bonus applies, so 547.5 tokens
      // should be awarded per year, which comes out to 1.5 tokens per day. After 30 days should
      // have earned 45 tokens
      let expectedRewards = ethers.BigNumber.from(45).mul(decimalAdj);
      await contract.claimRewards();
      expect(await contract.totalStaked(), "expected rewards earned after 30 days").to.equal(
        stakeAmount.add(expectedRewards)
      );
      // fast forward time by 30 days
      await setNextBlockTimestamp(lockupStartTime + HOUR_SECONDS * 24 * 60);
      expectedRewards = expectedRewards.add(ethers.BigNumber.from(45).mul(decimalAdj)).add(
        expectedRewards
          .mul(REWARDS_RATE)
          .div(decimalAdj)
          .mul(HOUR_SECONDS * 24 * 30)
          .div(YEAR_SECONDS)
      );
      await contract.claimRewards();
      expect(await contract.totalStaked(), "rewards earned in the next 30 days").to.equal(
        stakeAmount.add(expectedRewards)
      );
      // fast forward time by 30 days
      await setNextBlockTimestamp(lockupStartTime + HOUR_SECONDS * 24 * 90);
      expectedRewards = expectedRewards.add(ethers.BigNumber.from(45).mul(decimalAdj)).add(
        expectedRewards
          .mul(REWARDS_RATE)
          .div(decimalAdj)
          .mul(HOUR_SECONDS * 24 * 30)
          .div(YEAR_SECONDS)
      );
      await contract.claimRewards();
      expect(await contract.totalStaked(), "rewards earned in the last 30 days").to.equal(
        stakeAmount.add(expectedRewards)
      );
      // fast forward time by another 1.25 days
      //ethers.provider.send("evm_increaseTime", [HOUR_SECONDS * 30]);
      await setNextBlockTimestamp(lockupStartTime + HOUR_SECONDS * 24 * 91.25);
      await contract.claimRewards();
      // after 91.25 days should have earned 136.875 tokens (see the after expiry test case),
      // but since multiple claims were made during that period the rewards credited to the unlocked
      // balance after each claim have also earned a small reward
      expect(await contract.totalStaked(), "rewards are cumulative").to.be.gt(
        stakeAmount.add(ethers.BigNumber.from(136875).mul(decimalAdj).div(1000))
      );

      const stakeholder = await contract.getStakeholder(stakeholderAddress);
      const totalStaked = await contract.totalStaked();
      expect(stakeholder.balance, "stakeholder balance should be same as total stake").to.equal(
        totalStaked
      );
      expect(stakeholder.stakes.length, "expired lockup should be removed").to.equal(0);
    });

    it("Should compute rewards for 6-month lockup", async function () {
      await tokenContract.approve(contract.address, ethers.BigNumber.from(10000).mul(decimalAdj));
      const stakeAmount = ethers.BigNumber.from(7300).mul(decimalAdj);
      const lockupStartTime = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(lockupStartTime);
      await contract.stake(stakeAmount, 2);
      // fast forward time by 182.5 days
      await setNextBlockTimestamp(lockupStartTime + (HOUR_SECONDS * 24 * 365) / 2);
      const stakeholderAddress = ownerAddress;
      // base rewards rate is 5%, 7300 is staked for 6 months so 2x bonus applies, so 730 tokens
      // should be awarded per year, which comes out to 2 tokens per day. After 182.5 days should
      // have earned 365 tokens
      const expectedRewards = ethers.BigNumber.from(365).mul(decimalAdj);
      await expect(contract.claimRewards())
        .to.emit(contract, "RewardsClaimed")
        .withArgs(stakeholderAddress, expectedRewards);
      const stakeholder = await contract.getStakeholder(stakeholderAddress);
      expect(stakeholder.balance).to.equal(stakeAmount.add(expectedRewards));
      const totalStaked = await contract.totalStaked();
      expect(stakeholder.balance, "stakeholder balance should be same as total stake").to.equal(
        totalStaked
      );
      expect(stakeholder.stakes.length, "expired lockup should be removed").to.equal(0);
    });

    it("Should compute rewards for 12-month lockup", async function () {
      await tokenContract.approve(contract.address, ethers.BigNumber.from(10000).mul(decimalAdj));
      const stakeAmount = ethers.BigNumber.from(7300).mul(decimalAdj);
      const lockupStartTime = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(lockupStartTime);
      await contract.stake(stakeAmount, 3);
      // fast forward time by 365 days
      await setNextBlockTimestamp(lockupStartTime + HOUR_SECONDS * 24 * 365);
      const stakeholderAddress = ownerAddress;
      // base rewards rate is 5%, 7300 is staked for 12 months so 4x bonus applies, so 1,460 tokens
      // should be awarded per year
      const expectedRewards = ethers.BigNumber.from(1460).mul(decimalAdj);
      await expect(contract.claimRewards())
        .to.emit(contract, "RewardsClaimed")
        .withArgs(stakeholderAddress, expectedRewards);
      const stakeholder = await contract.getStakeholder(stakeholderAddress);
      expect(stakeholder.balance).to.equal(stakeAmount.add(expectedRewards));
      const totalStaked = await contract.totalStaked();
      expect(stakeholder.balance, "stakeholder balance should be same as total stake").to.equal(
        totalStaked
      );
      expect(stakeholder.stakes.length, "expired lockup should be removed").to.equal(0);
    });

    it("Should compute rewards for multiple stakes", async function () {
      await tokenContract.approve(contract.address, ethers.BigNumber.from(100000).mul(decimalAdj));
      const stakeAmount1 = ethers.BigNumber.from(7300).mul(decimalAdj);
      const stakeAmount2 = stakeAmount1.mul(2);
      const stakeAmount3 = stakeAmount1.mul(3);
      const lockupStartTime1 = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(lockupStartTime1);
      await contract.stake(stakeAmount1, 0);
      const lockupStartTime2 = lockupStartTime1 + 10;
      await setNextBlockTimestamp(lockupStartTime2);
      await contract.stake(stakeAmount2, 0);
      const lockupStartTime3 = lockupStartTime2 + 10;
      await setNextBlockTimestamp(lockupStartTime3);
      await contract.stake(stakeAmount3, 0);
      // fast forward time by 14 days
      await setNextBlockTimestamp(lockupStartTime1 + HOUR_SECONDS * 24 * 14);
      const stakeholderAddress = ownerAddress;
      // 1st stake should get unlocked and removed
      await contract.claimRewards();
      let stakeholder = await contract.getStakeholder(stakeholderAddress);
      let stakes = stakeholder.stakes;
      expect(stakes.length, "1st expired lockup should be removed").to.equal(2);
      expect(stakes[1].amount, "2nd stake should be at index 1").to.equal(stakeAmount2);
      expect(stakes[0].amount, "3rd stake should be at index 0").to.equal(stakeAmount3);
      let expectedRewards = ethers.BigNumber.from(14).mul(decimalAdj);
      expect(stakeholder.balance).to.be.gt(stakeAmount1.add(expectedRewards));

      await setNextBlockTimestamp(lockupStartTime2 + HOUR_SECONDS * 24 * 14);
      // 2nd stake should get unlocked and removed
      await contract.claimRewards();
      stakeholder = await contract.getStakeholder(stakeholderAddress);
      stakes = stakeholder.stakes;
      expect(stakes.length, "2nd expired lockup should be removed").to.equal(1);
      expect(stakes[0].amount, "3rd stake should be at index 0").to.equal(stakeAmount3);
      expectedRewards = ethers.BigNumber.from(42).mul(decimalAdj);
      expect(stakeholder.balance).to.be.gt(stakeAmount1.add(stakeAmount2).add(expectedRewards));

      await setNextBlockTimestamp(lockupStartTime3 + HOUR_SECONDS * 24 * 14);
      // 3rd stake should get unlocked and removed
      await contract.claimRewards();
      stakeholder = await contract.getStakeholder(stakeholderAddress);
      expect(stakeholder.stakes.length, "3rd expired lockup should be removed").to.equal(0);
      // actual rewards earned will be slightly over 84 tokens because the first 2 stakes will earn
      // slightly more rewards on account of the fact that they've been around longer
      expectedRewards = ethers.BigNumber.from(84).mul(decimalAdj);
      expect(stakeholder.balance).to.be.gt(
        stakeAmount1.add(stakeAmount2).add(stakeAmount3).add(expectedRewards)
      );
      const totalStaked = await contract.totalStaked();
      expect(stakeholder.balance, "total stake should match unlocked balance").to.equal(
        totalStaked
      );
    });

    it("Should compute rewards for multiple stakeholders", async function () {
      const contract2 = await contract.connect(accounts[1]);
      await tokenContract.approve(contract.address, ethers.BigNumber.from(10000).mul(decimalAdj));
      await tokenContract
        .connect(accounts[1])
        .approve(contract.address, ethers.BigNumber.from(50000).mul(decimalAdj));
      const stakeAmount1 = ethers.BigNumber.from(7300).mul(decimalAdj);
      const stakeAmount2 = ethers.BigNumber.from(14600).mul(decimalAdj);
      const lockupStartTime = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(lockupStartTime);
      await contract.stake(stakeAmount1, 0);
      await contract2.stake(stakeAmount2, 0);

      // fast forward time by 14 days
      await setNextBlockTimestamp(lockupStartTime + HOUR_SECONDS * 24 * 14);
      const stakeholderAddress1 = ownerAddress;
      const stakeholderAddress2 = await accounts[1].getAddress();
      // base rewards rate is 5%, 7300 is staked so 365 tokens should be awarded per year, which
      // comes out to 1 token per day, so after 14 days should have earned 14 tokens
      const expectedRewards1 = ethers.BigNumber.from(14).mul(decimalAdj);
      await expect(
        contract.claimRewards(),
        "RewardsClaimed event should be emitted for stakeholder 1"
      )
        .to.emit(contract, "RewardsClaimed")
        .withArgs(stakeholderAddress1, expectedRewards1);
      const stakeholder1 = await contract.getStakeholder(stakeholderAddress1);
      expect(
        stakeholder1.balance,
        "stakeholder 1 balance should consist of original stake + rewards"
      ).to.equal(stakeAmount1.add(expectedRewards1));
      expect(
        stakeholder1.stakes.length,
        "stakeholder 1 expired lockup should be removed"
      ).to.equal(0);
      let stakeholder2 = await contract.getStakeholder(stakeholderAddress2);
      expect(stakeholder2.stakes.length, "stakeholder 2 lockup should still exist").to.equal(1);

      // The test network puts each transaction into its own block, so it's not possible to claim
      // rewards for both stakeholders in the same block. To work around this set the next block time
      // to be just 1 second after the previous block, with the stake amount used in this test the
      // rewards earned in one second are too small to notice.
      await setNextBlockTimestamp(lockupStartTime + (HOUR_SECONDS * 24 * 14 + 1));
      // second stake is twice as large so should earn 28 tokens in rewards for the 14 day period
      const expectedRewards2 = ethers.BigNumber.from(28).mul(decimalAdj);
      await expect(
        contract2.claimRewards(),
        "RewardsClaimed event should be emitted for stakeholder 2"
      )
        .to.emit(contract2, "RewardsClaimed")
        .withArgs(stakeholderAddress2, expectedRewards2);
      stakeholder2 = await contract.getStakeholder(stakeholderAddress2);
      expect(
        stakeholder2.balance,
        "stakeholder 1 balance should consist of original stake + rewards"
      ).to.equal(stakeAmount2.add(expectedRewards2));

      expect(
        await contract.totalRewardsClaimed(),
        "total rewards claimed should match amounts paid to stakeholders"
      ).to.equal(expectedRewards1.add(expectedRewards2));
      let totalStaked = await contract.totalStaked();
      expect(
        stakeholder1.balance.add(stakeholder2.balance),
        "stakeholder balance should be same as total stake"
      ).to.equal(totalStaked);
      expect(
        stakeholder2.stakes.length,
        "stakeholder 2 expired lockup should be removed"
      ).to.equal(0);
    });
  });

  describe("withdraw", function () {
    let contract;

    beforeEach(async function () {
      contract = await contractFactory.deploy(
        tokenContract.address,
        REWARDS_RATE,
        MIGRATION_START_TIME
      );
      await contract.deployed();
      await contract.setFeatures(allFeatures(true));
    });

    it("Should revert if withdraw is disabled", async function () {
      await contract.setFeatures(Object.assign(allFeatures(true), { withdrawEnabled: false }));
      const stakeAmount = ethers.BigNumber.from(7300).mul(decimalAdj);
      await tokenContract.approve(contract.address, stakeAmount);
      const lockupStartTime = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(lockupStartTime);
      await contract.stake(stakeAmount, 0);
      // fast forward 7 days
      await setNextBlockTimestamp(lockupStartTime + HOUR_SECONDS * 24 * 7);
      // attempt to claim and withdraw all rewards
      await expect(contract.withdraw(ethers.constants.Zero, true)).to.be.revertedWith(
        "SP: withdraw disabled"
      );
    });

    it("Should revert if rewards are disabled", async function () {
      await contract.setFeatures(Object.assign(allFeatures(true), { rewardsEnabled: false }));
      const stakeAmount = ethers.BigNumber.from(7300).mul(decimalAdj);
      await tokenContract.approve(contract.address, stakeAmount);
      const lockupStartTime = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(lockupStartTime);
      await contract.stake(stakeAmount, 0);
      // fast forward 7 days
      await setNextBlockTimestamp(lockupStartTime + HOUR_SECONDS * 24 * 7);
      // attempt to claim and withdraw all rewards
      await expect(contract.withdraw(ethers.constants.MaxUint256, true)).to.be.revertedWith(
        "StakingPool: rewards disabled"
      );
    });

    it("Should revert when there's nothing to withdraw", async function () {
      const stakeAmount = ethers.BigNumber.from(7300).mul(decimalAdj);
      await tokenContract.approve(contract.address, stakeAmount);
      const lockupStartTime = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(lockupStartTime);
      // stake for 2 weeks
      await contract.stake(stakeAmount, 0);
      // fast forward 14 days
      await setNextBlockTimestamp(lockupStartTime + HOUR_SECONDS * 24 * 14);
      // claim and restake all rewards
      await contract.restake(ethers.constants.MaxUint256, 0, true);
      // attempt to withdraw entire unlocked balance
      await expect(contract.withdraw(ethers.constants.MaxUint256, false)).to.be.revertedWith(
        "StakingPool: nothing to withdraw"
      );
    });

    it("Should revert when there's insufficient unlocked balance", async function () {
      const stakeAmount = ethers.BigNumber.from(7300).mul(decimalAdj);
      await tokenContract.approve(contract.address, stakeAmount);
      const lockupStartTime = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(lockupStartTime);
      await contract.stake(stakeAmount, 0);
      // fast forward 7 days
      await setNextBlockTimestamp(lockupStartTime + HOUR_SECONDS * 24 * 7);
      await contract.claimRewards(); // credit rewards to stakeholder's unlocked balance
      await expect(contract.withdraw(stakeAmount, false)).to.be.revertedWith(
        "StakingPool: amount exceeds available balance"
      );
    });

    it("Should transfer full unlocked balance when amount is MaxUint256", async function () {
      // fund staking pool so it can pay out the earned rewards
      await tokenContract.transfer(contract.address, ethers.BigNumber.from(10000).mul(decimalAdj));
      // approve transfer from stakeholder to staking pool
      await tokenContract.approve(contract.address, ethers.BigNumber.from(10000).mul(decimalAdj));
      const stakeAmount = ethers.BigNumber.from(7300).mul(decimalAdj);
      const lockupStartTime = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(lockupStartTime);
      await contract.stake(stakeAmount, 0);
      // fast forward 14 days
      await setNextBlockTimestamp(lockupStartTime + HOUR_SECONDS * 24 * 14);
      await contract.claimRewards();
      const stakeholderAddress = ownerAddress;
      let stakeholder = await contract.getStakeholder(stakeholderAddress);
      expect(stakeholder.balance).to.be.gt(0);
      const prevBalance = await tokenContract.balanceOf(stakeholderAddress);
      await expect(contract.withdraw(ethers.constants.MaxUint256, false))
        .to.emit(contract, "AccountClosed")
        .withArgs(stakeholderAddress)
        .to.emit(contract, "Withdrawn")
        .withArgs(stakeholderAddress, stakeholder.balance);
      expect(await tokenContract.balanceOf(stakeholderAddress)).to.be.gt(prevBalance);
      stakeholder = await contract.getStakeholder(stakeholderAddress);
      expect(stakeholder.balance).to.equal(0);
      expect(stakeholder.stakes.length, "stakeholder should have no stakes left").to.equal(0);
      expect(await contract.numStakeholders()).to.equal(0);
      expect(await contract.totalStaked()).to.equal(0);
    });

    it("Should transfer non-zero amount", async function () {
      // fund staking pool so it can pay out the earned rewards
      await tokenContract.transfer(contract.address, ethers.BigNumber.from(10000).mul(decimalAdj));
      // approve transfer from stakeholder to staking pool
      await tokenContract.approve(contract.address, ethers.BigNumber.from(10000).mul(decimalAdj));
      const stakeAmount = ethers.BigNumber.from(7300).mul(decimalAdj);
      const lockupStartTime = (await ethers.provider.getBlock("latest")).timestamp + 10;
      await setNextBlockTimestamp(lockupStartTime);
      await contract.stake(stakeAmount, 0);
      // fast forward 14 days
      await setNextBlockTimestamp(lockupStartTime + HOUR_SECONDS * 24 * 14);
      await contract.claimRewards();
      const stakeholderAddress = ownerAddress;
      let stakeholder = await contract.getStakeholder(stakeholderAddress);
      expect(stakeholder.balance).to.be.gt(0);
      const prevBalance = stakeholder.balance;
      const totalStaked = await contract.totalStaked();
      // fast forward 1 second
      await setNextBlockTimestamp(lockupStartTime + HOUR_SECONDS * 24 * 14 + 1);
      const withdrawAmount = ethers.BigNumber.from(300).mul(decimalAdj);
      await expect(contract.withdraw(withdrawAmount, false))
        .to.emit(contract, "Withdrawn")
        .withArgs(stakeholderAddress, withdrawAmount);
      stakeholder = await contract.getStakeholder(stakeholderAddress);
      expect(stakeholder.balance, "stakeholder balance should be updated").to.equal(
        prevBalance.sub(withdrawAmount)
      );
      expect(stakeholder.stakes.length, "stakeholder should have no stakes left").to.equal(0);
      expect(await contract.numStakeholders()).to.equal(1);
      expect(await contract.totalStaked(), "total staked should be updated").to.equal(
        totalStaked.sub(withdrawAmount)
      );
    });

    it.skip("Should revert if token transfer fails", async function () {});
  });

  describe("batchImportAccounts", function () {
    let contract;

    beforeEach(async function () {
      contract = await contractFactory.deploy(
        tokenContract.address,
        REWARDS_RATE,
        MIGRATION_START_TIME
      );
      await contract.deployed();
    });

    it("Should revert when called with mismatched stakeholder counts", async function () {
      await expect(
        contract.batchImportAccounts(
          [],
          [
            {
              balance: ethers.BigNumber.from(1),
              stakes: [
                {
                  period: 0,
                  amount: ethers.BigNumber.from(5),
                  unlockOn: ethers.BigNumber.from(Date.now())
                    .div(1000)
                    .add(HOUR_SECONDS * 24),
                },
              ],
            },
          ]
        )
      ).to.be.revertedWith("StakingPool: mismatched array lengths on import");
    });

    it("Should revert when attempting to import the same stakeholder again", async function () {
      const stakeholderAddress = ownerAddress;
      await contract.batchImportAccounts(
        [stakeholderAddress],
        [
          {
            balance: ethers.BigNumber.from(1),
            stakes: [
              {
                period: 0,
                amount: ethers.BigNumber.from(5),
                unlockOn: ethers.BigNumber.from(Date.now())
                  .div(1000)
                  .add(HOUR_SECONDS * 24),
              },
            ],
          },
        ]
      );
      await expect(
        contract.batchImportAccounts(
          [stakeholderAddress],
          [
            {
              balance: ethers.BigNumber.from(1),
              stakes: [
                {
                  period: 0,
                  amount: ethers.BigNumber.from(5),
                  unlockOn: ethers.BigNumber.from(Date.now())
                    .div(1000)
                    .add(HOUR_SECONDS * 24),
                },
              ],
            },
          ]
        )
      ).to.be.revertedWith("StakingPool: account already exists");
    });

    it("Should revert when import feature is disabled", async function () {
      await contract.setFeatures(allFeatures(false));
      const stakeholderAddress = ownerAddress;
      await expect(
        contract.batchImportAccounts(
          [stakeholderAddress],
          [
            {
              balance: ethers.BigNumber.from(1),
              stakes: [
                {
                  period: 0,
                  amount: ethers.BigNumber.from(5),
                  unlockOn: ethers.BigNumber.from(Date.now())
                    .div(1000)
                    .add(HOUR_SECONDS * 24),
                },
              ],
            },
          ]
        )
      ).to.be.revertedWith("StakingPool: import not allowed");
      await contract.setFeatures(Object.assign(allFeatures(false), { importEnabled: true }));
      await contract.batchImportAccounts(
        [stakeholderAddress],
        [
          {
            balance: ethers.BigNumber.from(1),
            stakes: [
              {
                period: 0,
                amount: ethers.BigNumber.from(5),
                unlockOn: ethers.BigNumber.from(Date.now())
                  .div(1000)
                  .add(HOUR_SECONDS * 24),
              },
            ],
          },
        ]
      );
    });

    it("Should import data for a single stakeholder", async function () {
      const stakeholderAddress = ownerAddress;
      // NOTE: All amounts should be whole token amounts because so we don't have to waste bits to
      //       represent 18 decimal places.
      const balance = ethers.BigNumber.from(124);
      const stakes = [
        {
          period: 1,
          amount: ethers.BigNumber.from(2500),
          unlockOn: 1608725123,
        },
        {
          period: 2,
          amount: ethers.BigNumber.from(8168),
          unlockOn: 1613570335,
        },
        {
          period: 2,
          amount: ethers.BigNumber.from(9758),
          unlockOn: 1614556800,
        },
        {
          period: 3,
          amount: ethers.BigNumber.from(2561),
          unlockOn: 1612725128,
        },
        {
          period: 3,
          amount: ethers.BigNumber.from(100),
          unlockOn: 1614556800,
        },
      ];
      await contract.batchImportAccounts([stakeholderAddress], [{ balance, stakes }]);
      const stakeholder = await contract.getStakeholder(stakeholderAddress);
      expect(stakeholder.balance).to.equal(balance.mul(decimalAdj));
      const importedStakes = stakeholder.stakes;
      expect(importedStakes.length, "all stakes should've been imported").to.equal(stakes.length);
      let expectedTotalStaked = balance.mul(decimalAdj);
      for (let i = 0; i < stakes.length; i++) {
        expect(importedStakes[i].period, `stake ${i} period should match`).to.equal(
          stakes[i].period
        );
        expect(importedStakes[i].unlockOn, `stake ${i} unlock time should match`).to.equal(
          stakes[i].unlockOn
        );
        expect(importedStakes[i].amount, `stake ${i} amount should match`).to.equal(
          stakes[i].amount.mul(decimalAdj)
        );
        expectedTotalStaked = expectedTotalStaked.add(stakes[i].amount.mul(decimalAdj));
      }
      expect(stakeholder.lastClaimedAt).to.equal(MIGRATION_START_TIME);
      expect(
        await contract.numStakeholders(),
        "number of stakeholders should be correct"
      ).to.equal(1);
      expect(await contract.totalStaked(), "total staked should be correct").to.equal(
        expectedTotalStaked
      );
    });
  });
});
