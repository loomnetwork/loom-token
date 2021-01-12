// This script deploys the StakingPool contract.

import { ethers } from "hardhat";
import * as hre from "hardhat";

// Address of the new LOOM token contract
const loomContractAddress = {
    rinkeby: '0xF0265F31D8Ec34Eb32a2928288a5F12a284eA822',
    mainnet: undefined
}

async function main() {
    console.log(`Deploying StakingPool contract to network ${hre.network.name}`);
    const tokenContractAddress = loomContractAddress[hre.network.name];
    if (loomContractAddress === undefined) {
        throw new Error('LOOM token contract address not provided');
    }
    
    const [deployer] = await ethers.getSigners();
    console.log(`Deploying the contracts with the account: ${await deployer.getAddress()}`);

    const stakingContractFactory = await ethers.getContractFactory("StakingPool");
    const decimalAdj = ethers.BigNumber.from(10).pow(18);
    const rewardsRate = ethers.BigNumber.from(5).mul(decimalAdj).div(100); // 5%
    const migrationStartTime = ethers.BigNumber.from(Date.now()).div(1000);
    const stakingContract = await stakingContractFactory.deploy(
        tokenContractAddress, rewardsRate, migrationStartTime
    );
    await stakingContract.deployed();
    console.log(`StakingPool deployed at ${stakingContract.address} by tx ${stakingContract.deployTransaction.hash}`);
}

main()
.then(() => process.exit(0))
.catch((error) => {
    console.error(error);
    process.exit(1);
});
  