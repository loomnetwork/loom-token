import * as hre from "hardhat";
import { ContractTransaction, ethers } from 'ethers';

const decimalAdj = ethers.BigNumber.from(10).pow(18);
const HOUR_SECONDS = 60 * 60;
const YEAR_SECONDS = HOUR_SECONDS * 24 * 365;

interface Stake {
    period: ethers.BigNumber;
    amount: ethers.BigNumber;
}

/**
 * @brief Sets the timestamp of the next block that will be produced the test network.
 * @note This only works on the Hardhat test network at the moment, not Ganache, nor Rinkeby.
 * @param timestamp Seconds since the UNIX epoch.
 */
async function setNextBlockTimestamp(timestamp: number) {
    await hre.ethers.provider.send("evm_setNextBlockTimestamp", [timestamp]);
}

async function main() {
    const accounts = await hre.ethers.getSigners();
    const deployerAddr = await accounts[0].getAddress();
    console.log(`Deploying contracts from account ${deployerAddr} to ${hre.network.name} network`);

    let tokenFactory = await hre.ethers.getContractFactory("TestToken");
    const oldToken = await tokenFactory.deploy();
    const swapContractFactory = await hre.ethers.getContractFactory("TokenSwap");
    const tokenSwapContract = await swapContractFactory.deploy(oldToken.address);
    tokenFactory = await hre.ethers.getContractFactory("LoomToken");
    const newToken = await tokenFactory.deploy(tokenSwapContract.address);
    await newToken.deployed();
    console.log(`LoomToken deployed at ${newToken.address} by tx ${newToken.deployTransaction.hash}`);
    await newToken.grantRole(ethers.utils.id("MINTER"), await accounts[0].getAddress());
    
    const stakingContractFactory = await hre.ethers.getContractFactory("StakingPool");
    const rewardsRate = ethers.BigNumber.from(5).mul(decimalAdj).div(100); // 5%
    const MIGRATION_START_TIME = ethers.BigNumber.from(Date.now()).div(1000);
    const stakingContract = await stakingContractFactory.deploy(
        newToken.address, rewardsRate, MIGRATION_START_TIME
    );
    await stakingContract.deployed();
    console.log(`StakingPool deployed at ${stakingContract.address} by tx ${stakingContract.deployTransaction.hash}`);
    await stakingContract.setFeatures({
        importEnabled: false,
        stakingEnabled: true,
        amendEnabled: true,
        withdrawEnabled: true,
        rewardsEnabled: true
    });
    await stakingContract.setMaxStakesPerAccount(100);
    
    const stakesPerRun = [1, 5, 10, 20, 40, 50, 100];
    const generatedStakes = stakesPerRun.map(numStakes => generateStakes(numStakes));

    // create a new stake every time
    console.log("Creating a new stake each time...");
    for (let n = 0; n < generatedStakes.length; n++) {
        const account = accounts[n+1];
        const addr = await account.getAddress();
        await newToken.mint(addr, ethers.BigNumber.from(1000000).mul(decimalAdj));
        await newToken
            .connect(account)
            .approve(stakingContract.address, ethers.BigNumber.from(1000000).mul(decimalAdj));
        const gasPerTx = [];
        const stakes = generatedStakes[n];
        let totalGasUsed = ethers.constants.Zero;
        const lockupStartTime = (await hre.ethers.provider.getBlock("latest")).timestamp + 10;
        await setNextBlockTimestamp(lockupStartTime);
        for (let i = 0; i < stakes.length; i++) {
            const txResponse = await stakingContract
                .connect(account)
                .stake(stakes[i].amount, stakes[i].period);
            const txReceipt = await txResponse.wait();
            gasPerTx.push(txReceipt.gasUsed);
            totalGasUsed = totalGasUsed.add(txReceipt.gasUsed);
        }
        
        console.log("---");
        console.log(`Used ${totalGasUsed} gas to create ${stakes.length} stakes`);
        console.log(`Gas per tx - Min: ${Math.min(...gasPerTx)} Max: ${Math.max(...gasPerTx)} Avg: ${totalGasUsed.div(stakes.length)}`);

        // fast forward time by 366 days (all lockups should expire by then)
        await setNextBlockTimestamp(lockupStartTime + (YEAR_SECONDS + HOUR_SECONDS * 24));
        //await setNextBlockTimestamp(lockupStartTime + (HOUR_SECONDS * 24 * 30));
        
        const txResponse = await stakingContract
            .connect(account)
            .claimRewards();
        const txReceipt = await txResponse.wait();
        console.log(`Used ${txReceipt.gasUsed} gas to claim rewards from ${stakes.length} stakes`);
    }

    // amend stakes
    console.log("Amending stakes whenever possible...");
    const numActualStakes = [];
    for (let n = 0; n < generatedStakes.length; n++) {
        const account = accounts[n+1];
        const addr = await account.getAddress();
        await newToken.mint(addr, ethers.BigNumber.from(1000000).mul(decimalAdj));
        await newToken
            .connect(account)
            .approve(stakingContract.address, ethers.BigNumber.from(1000000).mul(decimalAdj));
        const gasPerTx = [];
        const stakes = generatedStakes[n];
        let totalGasUsed = ethers.constants.Zero;
        const lockupStartTime = (await hre.ethers.provider.getBlock("latest")).timestamp + 10;
        await setNextBlockTimestamp(lockupStartTime);
        for (let i = 0; i < stakes.length; i++) {
            let txResponse: ContractTransaction;
            if (!stakeExistForPeriod(stakes, i, stakes[i].period)) {
                txResponse = await stakingContract
                    .connect(account)
                    .stake(stakes[i].amount, stakes[i].period);
            } else {
                txResponse = await stakingContract
                    .connect(account)
                    .amend(stakes[i].amount, ethers.constants.Zero, stakes[i].period, true);
            }
            const txReceipt = await txResponse.wait();
            gasPerTx.push(txReceipt.gasUsed);
            totalGasUsed = totalGasUsed.add(txReceipt.gasUsed);
        }
        numActualStakes.push((await stakingContract.getStakeholder(addr)).stakes.length);
        
        console.log("---");
        console.log(`Used ${totalGasUsed} gas to create ${stakes.length} stakes`);
        console.log(`${numActualStakes[n]} stakes created, ${stakes.length - numActualStakes[n]} stakes amended`);
        console.log(`Gas per tx - Min: ${Math.min(...gasPerTx)} Max: ${Math.max(...gasPerTx)} Avg: ${totalGasUsed.div(stakes.length)}`);
         // fast forward time by 366 days (all lockups should expire by then)
        await setNextBlockTimestamp(lockupStartTime + (YEAR_SECONDS + HOUR_SECONDS * 24));
        //await setNextBlockTimestamp(lockupStartTime + (HOUR_SECONDS * 24 * 30));
        
        const txResponse = await stakingContract
            .connect(account)
            .claimRewards();
        const txReceipt = await txResponse.wait();
        console.log(`Used ${txReceipt.gasUsed} gas to claim rewards from ${stakes.length} stakes`);
    }
}

function stakeExistForPeriod(stakes: Stake[], endIdx: number, period: ethers.BigNumber): boolean {
    for (let i = 0; i < endIdx; i++) {
        if (stakes[i].period.eq(period)) {
            return true;
        }
    }
    return false;
}

function generateStakes(numStakes: number): Stake[] {
    let stakes = [];
    for (let i = 0; i < numStakes; i++) {
        stakes.push({
            period: ethers.BigNumber.from(Math.floor(Math.random() * 4)),
            amount: ethers.BigNumber.from(1 + Math.floor(Math.random() * 10000)).mul(decimalAdj),
        })
    }
    return stakes;
}

main()
.then(() => process.exit(0))
.catch((error) => {
    console.error(error);
    process.exit(1);
});
  