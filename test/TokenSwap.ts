import { ethers } from "hardhat";
import { Signer } from "ethers";
import { expect } from "chai";

const DECIMAL_ADJ = ethers.BigNumber.from(10).pow(18);

describe("TokenSwap", function () {
  let contractFactory;
  let oldToken, newToken;
  let accounts: Signer[];
  let owner: Signer;
  let swapper: Signer;
  let recipient: Signer;
  let ownerAddress: string;
  let swapperAddress: string;
  let recipientAddress: string;
  let contract: any;

  beforeEach(async function () {
    accounts = await ethers.getSigners();

    owner = accounts[0];
    swapper = accounts[1];
    recipient = accounts[2];
    ownerAddress = await owner.getAddress();
    swapperAddress = await swapper.getAddress();
    recipientAddress = await recipient.getAddress();

    contractFactory = await ethers.getContractFactory("TokenSwap");
    let tokenFactory = await ethers.getContractFactory("TestToken");
    oldToken = await tokenFactory.deploy();
    contract = await contractFactory.deploy(oldToken.address);
    await contract.deployed();
    tokenFactory = await ethers.getContractFactory("LoomToken");
    newToken = await tokenFactory.deploy(contract.address);
  });

  describe("constructor", function () {
    it("Should set owner and LOOM contracts", async function () {
      expect(await contract.owner(), "owner should be set").to.equal(
        await accounts[0].getAddress()
      );
      expect(await contract.oldToken(), "old token should be set").to.equal(oldToken.address);
      expect(await contract.paused()).to.equal(true);
    });
  });

  describe("setNewLoomToken", function () {
    it("Should set new LOOM contract address and unpause swap", async function () {
      expect(await contract.paused()).to.equal(true);
      await contract.setNewLoomToken(newToken.address);
      expect(await contract.newToken()).to.equal(newToken.address);
      expect(await contract.paused()).to.equal(false);
    });

    it("Should revert if new LOOM contract address already set", async function () {
      expect(await contract.newToken()).to.equal(ethers.constants.AddressZero);
      await contract.setNewLoomToken(newToken.address);
      expect(await contract.newToken()).to.equal(newToken.address);
      await expect(contract.setNewLoomToken(newToken.address)).to.be.revertedWith(
        "TokenSwap: new token already set"
      );
    });
  });

  describe("pause / unpause", function () {
    it("Should change state", async function () {
      await contract.setNewLoomToken(newToken.address);
      expect(await contract.paused()).to.equal(false);
      await contract.pause();
      expect(await contract.paused()).to.equal(true);
      await contract.unpause();
      expect(await contract.paused()).to.equal(false);
    });
  });

  describe("swap", function () {
    beforeEach(async function () {
      await contract.setNewLoomToken(newToken.address);
    });

    it("Should revert when swap is paused", async function () {
      await contract.pause();
      await expect(contract.swap()).to.be.revertedWith("TokenSwap: paused");
    });

    it("Should revert when caller has no old LOOM tokens", async function () {
      await expect(contract.connect(swapper).swap()).to.be.revertedWith(
        "TokenSwap: invalid old LOOM amount"
      );
    });

    it("Should revert if contract doesn't have enough new LOOM for the swap", async function () {
      // drain new LOOM from the swap contract
      await contract.withdrawTo(ownerAddress, await newToken.balanceOf(contract.address));
      const amount = ethers.BigNumber.from(100).mul(DECIMAL_ADJ);
      await oldToken.transfer(swapperAddress, amount);
      await oldToken.connect(swapper).approve(contract.address, amount);
      await expect(contract.connect(swapper).swap()).to.be.revertedWith(
        "ERC20: transfer amount exceeds balance"
      );
    });

    it("Should swap entire old LOOM balance of caller", async function () {
      const contractOldLoomBalBefore = await oldToken.balanceOf(contract.address);
      const contractNewLoomBalBefore = await newToken.balanceOf(contract.address);
      const amount = ethers.BigNumber.from(100).mul(DECIMAL_ADJ);
      // give some old loom to the account that will request the swap
      await oldToken.transfer(swapperAddress, amount);
      // swapper has to approve the amount being swapped
      await oldToken.connect(swapper).approve(contract.address, amount);
      expect(
        await oldToken.balanceOf(swapperAddress),
        "swapper should have some old LOOM"
      ).to.equal(amount);
      expect(
        await newToken.balanceOf(swapperAddress),
        "swapper shouldn't have any new LOOM"
      ).to.equal(ethers.BigNumber.from(0));
      await expect(contract.connect(swapper).swap())
        .to.emit(oldToken, "Transfer")
        .withArgs(swapperAddress, contract.address, amount)
        .to.emit(newToken, "Transfer")
        .withArgs(contract.address, swapperAddress, amount);
      expect(await oldToken.balanceOf(swapperAddress), "swapper should have no old LOOM").to.equal(
        ethers.BigNumber.from(0)
      );
      expect(
        await newToken.balanceOf(swapperAddress),
        "swapper should have some new LOOM"
      ).to.equal(amount);
      expect(await oldToken.balanceOf(contract.address)).to.equal(
        contractOldLoomBalBefore.add(amount)
      );
      expect(await newToken.balanceOf(contract.address)).to.equal(
        contractNewLoomBalBefore.sub(amount)
      );
    });
  });

  describe("swapFor", function () {
    beforeEach(async function () {
      await contract.setNewLoomToken(newToken.address);
    });

    it("Should revert when caller has no old LOOM tokens", async function () {
      const amount = ethers.BigNumber.from(100).mul(DECIMAL_ADJ);
      await expect(contract.connect(swapper).swapFor(recipientAddress, amount)).to.be.revertedWith(
        "ERC20: transfer amount exceeds balance"
      );
    });

    it("Should revert if contract doesn't have enough new LOOM for the swap", async function () {
      // drain new LOOM from the swap contract
      await contract.withdrawTo(ownerAddress, await newToken.balanceOf(contract.address));
      const amount = ethers.BigNumber.from(100).mul(DECIMAL_ADJ);
      await oldToken.transfer(swapperAddress, amount);
      await oldToken.connect(swapper).approve(contract.address, amount);
      await expect(contract.connect(swapper).swapFor(recipientAddress, amount)).to.be.revertedWith(
        "ERC20: transfer amount exceeds balance"
      );
    });

    it("Should transfer new LOOM to recipient", async function () {
      const contractOldLoomBalBefore = await oldToken.balanceOf(contract.address);
      const contractNewLoomBalBefore = await newToken.balanceOf(contract.address);
      const amount = ethers.BigNumber.from(100).mul(DECIMAL_ADJ);
      // give some old loom to the account that will request the swap
      await oldToken.transfer(swapperAddress, amount);
      // swapper has to approve the amount being swapped
      await oldToken.connect(swapper).approve(contract.address, amount);
      expect(await oldToken.balanceOf(swapperAddress)).to.equal(amount);
      expect(await newToken.balanceOf(recipientAddress)).to.equal(ethers.constants.Zero);
      await expect(contract.connect(swapper).swapFor(recipientAddress, amount))
        .to.emit(oldToken, "Transfer")
        .withArgs(swapperAddress, contract.address, amount)
        .to.emit(newToken, "Transfer")
        .withArgs(contract.address, recipientAddress, amount);
      expect(await oldToken.balanceOf(swapperAddress)).to.equal(ethers.constants.Zero);
      expect(await newToken.balanceOf(recipientAddress)).to.equal(amount);
      expect(await oldToken.balanceOf(contract.address)).to.equal(
        contractOldLoomBalBefore.add(amount)
      );
      expect(await newToken.balanceOf(contract.address)).to.equal(
        contractNewLoomBalBefore.sub(amount)
      );
    });
  });

  describe("withdrawTo", function () {
    beforeEach(async function () {
      await contract.setNewLoomToken(newToken.address);
    });

    it("Should revert if caller isn't the owner", async function () {
      const amount = ethers.BigNumber.from(100).mul(DECIMAL_ADJ);
      await expect(
        contract.connect(swapper).withdrawTo(recipientAddress, amount)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("Should transfer new LOOM to recipient", async function () {
      const contractNewLoomBalBefore = await newToken.balanceOf(contract.address);
      const amount = ethers.BigNumber.from(100).mul(DECIMAL_ADJ);
      expect(await newToken.balanceOf(recipientAddress)).to.equal(ethers.constants.Zero);
      await expect(contract.connect(owner).withdrawTo(recipientAddress, amount))
        .to.emit(newToken, "Transfer")
        .withArgs(contract.address, recipientAddress, amount);
      expect(await newToken.balanceOf(recipientAddress)).to.equal(amount);
      expect(await newToken.balanceOf(contract.address)).to.equal(
        contractNewLoomBalBefore.sub(amount)
      );
    });
  });
});
