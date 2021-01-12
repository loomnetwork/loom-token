import { HardhatUserConfig, task, types } from "hardhat/config";
import "@nomiclabs/hardhat-waffle";
import "@nomiclabs/hardhat-ethers";
import { importBasechainStakes } from "./scripts/import_basechain_stakes";
import { toggleStakingFeatures, queryStakingFeatures } from "./scripts/toggle_staking_features";

// This is a sample Hardhat task. To learn how to create your own go to
// https://hardhat.org/guides/create-task.html
task("accounts", "Prints the list of accounts", async (args, hre) => {
  const accounts = await hre.ethers.getSigners();
  // TODO: make this work with process.env.MNEMONIC
  for (const account of accounts) {
    console.log(await account.address);
  }
});

interface SetStakingFeaturesParams {
  contractAddress: string;
  enableImport: boolean;
  enableStaking: boolean;
  enableAmend: boolean;
  enableWithdraw: boolean;
  enableRewards: boolean;
  forceExtendOnAmend: boolean;
}

interface QueryStakingFeaturesParams {
  contractAddress: string;
}
interface ImportBasechainDataParams {
  importDataPath: string;
  estimateOnly: boolean;
}

task(
  "toggle-staking-features",
  "Enable/disable features in a previously deployed StakingPool contract"
)
  .addPositionalParam(
    "contractAddress",
    "Address of a previously deployed contract",
    undefined,
    types.string
  )
  .addFlag("enableImport", "Enable batch import of accounts")
  .addFlag("enableStaking", "Enable stake / restake")
  .addFlag("enableAmend", "Enable amend")
  .addFlag("enableWithdraw", "Enable withdraw")
  .addFlag("enableRewards", "Enable reward claiming")
  .addFlag("forceExtendOnAmend", "Force lockup period to be extended when amending a stake")
  .setAction(async function (params: SetStakingFeaturesParams, hre) {
    const {
      contractAddress,
      enableImport,
      enableStaking,
      enableAmend,
      enableWithdraw,
      enableRewards,
      forceExtendOnAmend
    } = params;
    await toggleStakingFeatures(
      hre,
      contractAddress,
      enableImport,
      enableStaking,
      enableAmend,
      enableWithdraw,
      enableRewards,
      forceExtendOnAmend
    );
  });

task(
  "query-staking-features",
  "Enable/disable features in a previously deployed StakingPool contract"
)
  .addPositionalParam(
    "contractAddress",
    "Address of a previously deployed contract",
    undefined,
    types.string
  )
  .setAction(async function ({ contractAddress }: QueryStakingFeaturesParams, hre) {
    await queryStakingFeatures(hre, contractAddress);
  });

task("import-basechain-data", "Imports Basechain staking data into the StakingPool contract")
  .addPositionalParam(
    "importDataPath",
    "JSON file containing data to be imported",
    undefined,
    types.inputFile
  )
  .addFlag("estimateOnly", "Only estimates gas usage, doesn't send any txs")
  .setAction(async function ({ importDataPath, estimateOnly }: ImportBasechainDataParams, hre) {
    await importBasechainStakes(hre, importDataPath, estimateOnly);
  });

const config: HardhatUserConfig = {
  solidity: "0.7.6",
  networks: {
    rinkeby: {
      url: `https://rinkeby.infura.io/v3/${process.env.INFURA_API_KEY}`,
      accounts: { mnemonic: `${process.env.MNEMONIC}` },
    },
    mainnet: {
      url: `https://mainnet.infura.io/v3/${process.env.INFURA_API_KEY}`,
      accounts: { mnemonic: `${process.env.MNEMONIC}` },
    },
  },
};

export default config;
