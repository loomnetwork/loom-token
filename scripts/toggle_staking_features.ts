import { HardhatRuntimeEnvironment } from "hardhat/types";

// Toggles the features of a previously deployed StakingPool contract.
export async function toggleStakingFeatures(
    hre: HardhatRuntimeEnvironment,
    contractAddress: string,
    enableImport: boolean,
    enableStaking: boolean,
    enableAmend: boolean,
    enableWithdraw: boolean,
    enableRewards: boolean,
    forceExtendOnAmend: boolean
) {
    const [deployer] = await hre.ethers.getSigners();
    const deployerAddr = await deployer.getAddress();
    console.log(`Toggling features on StakingPool contract at ${contractAddress} on ${hre.network.name} network with account ${deployerAddr}`);
    const stakingContractFactory = await hre.ethers.getContractFactory("StakingPool");
    const stakingContract = stakingContractFactory.attach(contractAddress);
    const txResponse = await stakingContract.setFeatures({
        importEnabled: enableImport,
        stakingEnabled: enableStaking,
        amendEnabled: enableAmend,
        withdrawEnabled: enableWithdraw,
        rewardsEnabled: enableRewards,
        forceExtendOnAmend
    });
    const txReceipt = await txResponse.wait();
    console.log(`Tx ${txReceipt.transactionHash} used ${txReceipt.gasUsed} gas`);
}

export async function queryStakingFeatures(hre: HardhatRuntimeEnvironment, contractAddress: string) {
    console.log(`Querying features of StakingPool contract at ${contractAddress} on ${hre.network.name} network`);
    const stakingContractFactory = await hre.ethers.getContractFactory("StakingPool");
    const stakingContract = stakingContractFactory.attach(contractAddress);
    const features = await stakingContract.getFeatures();
    const { importEnabled, stakingEnabled, withdrawEnabled, rewardsEnabled } = features;
    console.log(JSON.stringify({ importEnabled, stakingEnabled, withdrawEnabled, rewardsEnabled }, null, 2));
}