import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from 'fs';
import { ethers } from 'ethers';

// Address of the StakingPool contract
const stakingContractAddress = {
    rinkeby: '0xE208580494a4672B0b6F3Ab2Aa1E5a30Ec0F51aC',
    mainnet: undefined
}

const decimalAdj = ethers.BigNumber.from(10).pow(18);

// Imports stakeholder into the StakingPool contract.
export async function importBasechainStakes(hre: HardhatRuntimeEnvironment, importDataPath: string, estimateOnly: boolean) {
    if (importDataPath === "") {
        throw new Error('Import data path not specified');
    }

    let stakingContract: ethers.Contract;
    const [deployer] = await hre.ethers.getSigners();
    const deployerAddr = await deployer.getAddress();
    // redeploy relevant contracts when running on the test network
    if (hre.network.name === "hardhat") {
        console.log(`Deploying contracts from account ${deployerAddr} to ${hre.network.name} network`);
        const tokenContractFactory = await hre.ethers.getContractFactory("LoomToken");
        const tokenContract = await tokenContractFactory.deploy();
        await tokenContract.deployed();
        console.log(`LoomToken deployed at ${tokenContract.address} by tx ${tokenContract.deployTransaction.hash}`);

        const stakingContractFactory = await hre.ethers.getContractFactory("StakingPool");
        const rewardsRate = ethers.BigNumber.from(5).mul(decimalAdj).div(100); // 5%
        const MIGRATION_START_TIME = ethers.BigNumber.from(Date.now()).div(1000);
        stakingContract = await stakingContractFactory.deploy(
            tokenContract.address, rewardsRate, MIGRATION_START_TIME);
        await stakingContract.deployed();
        console.log(`StakingPool deployed at ${stakingContract.address} by tx ${stakingContract.deployTransaction.hash}`);
    } else {
        const contractAddress = stakingContractAddress[hre.network.name];
        if (contractAddress === undefined) {
            throw new Error('StakingPool contract address not provided');
        }
        console.log(`Importing into StakingPool contract at ${contractAddress} on ${hre.network.name} network with account ${deployerAddr}`);
        const stakingContractFactory = await hre.ethers.getContractFactory("StakingPool");
        stakingContract = stakingContractFactory.attach(contractAddress);
    }

    const importData = JSON.parse(fs.readFileSync(importDataPath).toString());
    const stakeholderAddresses = [];
    const stakeholderData = [];
    for (let stakeholder of importData) {
        stakeholderAddresses.push(stakeholder[0]);
        const stakes = stakeholder[1].stakes?.map(stake => ({
            period: stake.period,
            // drop the fractional part of the amount
            amount: ethers.utils.parseEther(stake.amount).div(decimalAdj),
            unlockOn: stake.unlockOn
        }))
        stakeholderData.push({
            // drop the fractional part of the balance
            balance: ethers.utils.parseEther(stakeholder[1].balance).div(decimalAdj),
            stakes: stakes ? stakes : [] // can't leave it undefined, or ethers.js throws an error
        });
    }

    const batches = batchStakingData(stakeholderAddresses, stakeholderData, 110);
    if (estimateOnly) {
        await estimateStakingDataImportGasCost(stakingContract, batches);
    } else {
        await importStakingData(stakingContract, batches);
    }
}

interface Stake {
    period: number;
    unlockOn: typeof ethers.constants.Zero; //ethers.BigNumber;
    amount: typeof ethers.constants.Zero; //ethers.BigNumber;
}

interface ExportedAccount {
    balance: typeof ethers.constants.Zero; //ethers.BigNumber;
    stakes: Stake[];
}

interface Batch {
    stakeholders: string[];
    accounts: ExportedAccount[];
    size: number;
    numStakes: number;
}

function batchStakingData(stakeholders: string[], accounts: ExportedAccount[], maxBatchSize: number) {
    const batches: Batch[] = [];
    let batch: Batch = { stakeholders: [], accounts: [], size: 0, numStakes: 0 };
    for (let i = 0; i < accounts.length; i++) {
        // each stakeholder takes up some storage (i.e. unlocked balance) even if they have no stakes
        const accountSize = 1 + accounts[i].stakes.length;
        if ((batch.size + accountSize) > maxBatchSize) {
            batches.push(batch);
            batch = { stakeholders: [], accounts: [], size: 0, numStakes: 0 };
        }
        batch.stakeholders.push(stakeholders[i]);
        batch.accounts.push(accounts[i]);
        batch.size += accountSize;
        batch.numStakes += accounts[i].stakes.length;
    }
    if (batch.size > 0) {
        batches.push(batch);
    }
    return batches;
}

async function estimateStakingDataImportGasCost(stakingContract: any, batches: Batch[]) {
    const gasEstimates = [];
    let totalGasEstimate = ethers.constants.Zero;
    let numStakeholders = 0;
    let totalStakes = 0;
    for (let batch of batches) {
        numStakeholders += batch.stakeholders.length;
        totalStakes += batch.numStakes;
        console.log(`Estimating gas usage for importing ${batch.stakeholders.length} stakeholders with ${batch.numStakes} stakes in total...`)

        const gasEstimate = await stakingContract.estimateGas.batchImportAccounts(
            batch.stakeholders,
            batch.accounts
        );
        console.log(`Gas estimate: ${gasEstimate}`);
        gasEstimates.push(gasEstimates);
        totalGasEstimate = totalGasEstimate.add(gasEstimate);
    }
    console.log(`Total gas estimate: ${totalGasEstimate} over ${batches.length} txs to import ${numStakeholders} accounts with ${totalStakes} stakes`);
}

async function importStakingData(stakingContract: any, batches: Batch[]) {
    let totalGasUsed = ethers.constants.Zero;
    let numStakeholders = 0;
    let totalStakes = 0;
    for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        console.log(`Importing batch ${i} (${batch.stakeholders.length} accounts, ${batch.numStakes} stakes)...`)

        const txResponse = await stakingContract.batchImportAccounts(
            batch.stakeholders,
            batch.accounts
        );
        const txReceipt = await txResponse.wait();
        console.log(`Tx ${txReceipt.transactionHash} used ${txReceipt.gasUsed} gas`);

        totalGasUsed = totalGasUsed.add(txReceipt.gasUsed);
        numStakeholders += batch.stakeholders.length;
        totalStakes += batch.numStakes;
    }
    console.log(`Used ${totalGasUsed} gas over ${batches.length} txs to import ${numStakeholders} accounts with ${totalStakes} stakes`);
}
