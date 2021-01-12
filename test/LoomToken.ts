import { ethers } from "hardhat";
import { Signer } from "ethers";
import { expect } from "chai";

const DECIMAL_ADJ = ethers.BigNumber.from(10).pow(18);
const INITIAL_SUPPLY = ethers.BigNumber.from(1000000000).mul(DECIMAL_ADJ); // 1 billion
const ADMIN_ROLE = ethers.constants.HashZero;
export const MINTER_ROLE = ethers.utils.id("MINTER"); // == keccak256("MINTER");

describe("LoomToken", function () {
  let contractFactory;
  let tokenSwap;
  let accounts: Signer[];
  let owner: Signer;
  let minter: Signer;
  let bob: Signer;
  let ownerAddress: string;
  let minterAddress: string;
  let bobAddress: string;

  beforeEach(async function () {
    contractFactory = await ethers.getContractFactory("LoomToken");
    const tokenFactory = await ethers.getContractFactory("TestToken");
    const oldToken = await tokenFactory.deploy();
    const swapContractFactory = await ethers.getContractFactory("TokenSwap");
    tokenSwap = await swapContractFactory.deploy(oldToken.address);

    accounts = await ethers.getSigners();
    owner = accounts[0];
    minter = accounts[1];
    bob = accounts[2];
    ownerAddress = await owner.getAddress();
    minterAddress = await minter.getAddress();
    bobAddress = await bob.getAddress();
  });

  describe("constructor", function () {
    it("Should revert if token swap contract address is invalid", async function () {
      await expect(contractFactory.deploy(bobAddress)).to.be.revertedWith(
        "LoomToken: invalid contract address"
      );
    });

    it("Should set admin role and fund token swap", async function () {
      const contract = await contractFactory.deploy(tokenSwap.address);
      await contract.deployed();
      expect(await contract.hasRole(ADMIN_ROLE, ownerAddress), "owner should be admin").to.equal(
        true
      );
      expect(
        await contract.hasRole(MINTER_ROLE, ownerAddress),
        "owner shouldn't be minter"
      ).to.equal(false);
      expect(
        await contract.getRoleMemberCount(ADMIN_ROLE),
        "there should be only one admin"
      ).to.equal(1);
      expect(
        await contract.getRoleMemberCount(MINTER_ROLE),
        "there should be no minters"
      ).to.equal(0);
      expect(await contract.totalSupply()).to.equal(INITIAL_SUPPLY);
      expect(
        await contract.balanceOf(tokenSwap.address),
        "swap contract should have entire token supply"
      ).to.equal(INITIAL_SUPPLY);
    });
  });

  describe("mint", function () {
    const amount = ethers.BigNumber.from(55).mul(DECIMAL_ADJ);
    let contract;

    beforeEach(async function () {
      contract = await contractFactory.deploy(tokenSwap.address);
    });

    it("Should allow authorized account to mint", async function () {
      await contract.grantRole(MINTER_ROLE, minterAddress);
      expect(await contract.balanceOf(bobAddress)).to.equal(ethers.constants.Zero);
      await contract.connect(minter).mint(bobAddress, amount);
      expect(await contract.balanceOf(bobAddress)).to.equal(amount);
      expect(await contract.totalSupply()).to.equal(INITIAL_SUPPLY.add(amount));
    });

    it("Should revert if caller is not authorized to mint", async function () {
      await expect(contract.connect(minter).mint(bobAddress, amount)).to.be.revertedWith(
        "LoomToken: not authorized"
      );
    });

    it("Should revert if former minter attempts to mint", async function () {
      await contract.grantRole(MINTER_ROLE, minterAddress);
      await contract.connect(minter).mint(bobAddress, amount);
      await contract.revokeRole(MINTER_ROLE, minterAddress);
      await expect(contract.connect(minter).mint(bobAddress, amount)).to.be.revertedWith(
        "LoomToken: not authorized"
      );
    });
  });
});
