// This script deploys the TokenSwap and LoomToken contracts.

import { ethers } from "hardhat";
import * as hre from "hardhat";

const oldLoomContractAddress = {
    rinkeby: '0x493640B5BEFB0962CE0932653987C41aA3608bd0',
    mainnet: '0xA4e8C3Ec456107eA67d3075bF9e3DF3A75823DB0'
}

async function main() {
    console.log(`Deploying contracts to network ${hre.network.name}`);
    const oldTokenContractAddress = oldLoomContractAddress[hre.network.name];
    if (oldLoomContractAddress === undefined) {
        throw new Error('Old LOOM token contract address not provided');
    }
    
    const [deployer] = await ethers.getSigners();
    console.log(`Deploying the contracts with the account: ${await deployer.getAddress()}`);

    const swapContractFactory = await ethers.getContractFactory("TokenSwap");
    const swapContract = await swapContractFactory.deploy(oldTokenContractAddress);
    await swapContract.deployed();
    console.log(`TokenSwap contract deployed at ${swapContract.address} by tx ${swapContract.deployTransaction.hash}`);

    const tokenContractFactory = await ethers.getContractFactory("LoomToken");
    const tokenContract = await tokenContractFactory.deploy(swapContract.address);
    await tokenContract.deployed();
    console.log(`LoomToken deployed at ${tokenContract.address} by tx ${tokenContract.deployTransaction.hash}`);

    console.log("Finishing initialization of TokenSwap contract...");
    await swapContract.setNewLoomToken(tokenContract.address);
}

main()
.then(() => process.exit(0))
.catch((error) => {
    console.error(error);
    process.exit(1);
});
  