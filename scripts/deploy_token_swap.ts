// This script deploys the TokenSwap contract.
// The address of the new token contract for the swap must be specified via the
import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying contract with the account: ${await deployer.getAddress()}`);

  const contractFactory = await ethers.getContractFactory("TokenSwap");
  const contract = await contractFactory.deploy();
  await contract.deployed();
  console.log(
    `TokenSwap contract deployed at ${contract.address} by tx ${contract.deployTransaction.hash}`
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
