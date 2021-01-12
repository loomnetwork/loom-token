# loom-token2

This repo contains smart contracts for the new LOOM ERC20 token, token swap, and staking system.

## Contracts Overview

- `LoomToken.sol` - Implements a mintable & burnable ERC20 token, with 18 decimal precision, and
  1 billion supply (to match the old LOOM token). For the sake of brevity these tokens will be
  referred to as `zkLOOM` in this README.
- `TokenSwap.sol` - Swaps old LOOM ERC20 tokens for `zkLOOM` tokens. When the `LoomToken` contract
  is deployed it will mint the entire supply to this contract.
- `StakingPool.sol` - Implements staking of `zkLOOM` tokens.

## Staking Overview

- `zkLOOM` holders can stake their tokens via the `StakingPool` contract for 2-week, 3-month, 6-month
  and 12-month periods. Staked tokens are locked in the staking contract until their lockup period expires.
- Stakeholders earn rewards on all `zkLOOM` tokens they have in the staking contract. Longer lockup
  periods grant higher reward rates:
  - 2-week lockup - base rate (currently `5%` per year)
  - 3-month lockup - `1.5x` base rate (currently `7.5%` per year)
  - 6-month lockup - `2x` base rate (currently `10%` per year)
  - 12-month lockup - `4x` base rate (currently `20%` per year)
- Stakeholders can claim any rewards earned on their staked `zkLOOM` at any time.
- When rewards are claimed they are credited to the stakeholder's **unlocked balance**.
  The unlocked balance earns rewards at the base rate.
- Stakeholders can restake or withdraw any `zkLOOM` from their **unlocked balance** at any time.
- The number of active stakes a stakeholder can have at any one time is limited to ensure that
  reward claims don't require an excessive amounts of gas. The current limit is 10.
- Stakeholders can increase their total stake without creating new individual stakes by amending
  an existing stake. If there are multiple existing stakes with the same lockup period then the most
  recently created one will be amended. When a stake is amended its lockup expiry time can either
  remain unchanged, or it can be extended (though the owner can force the latter option).

## Develop

```bash
yarn install
```

After modifying any code run prettier to format it:
```bash
yarn run format
```

## Run Tests

```bash
npx hardhat test
```

## Deploy

The private key used to deploy the contracts is derived from a mnemonic that should be specified
via the `MNEMONIC` env var. The Infura API key must also be specified via the `INFURA_API_KEY` env var.

```bash
export MNEMONIC="..."
export INFURA_API_KEY="..."
```

To deploy to Rinkeby for testing:

```bash
npx hardhat run --network rinkeby scripts/deploy.ts
```

To deploy to mainnet:

```bash
npx hardhat run --network mainnet scripts/deploy.ts
```

## Toggling features on the StakingPool contract

The features of the staking contract can be toggled on and off by the owner.

To figure out which features are currently enabled run:

```bash
npx hardhat query-staking-features <0xContractAddress> --network (rinkeby|mainnet)
```

To enable all features run:

```bash
npx hardhat toggle-staking-features <0xContractAddress> --enable-import --enable-staking --enable-amend --enable-withdraw --enable-rewards --network (rinkeby|mainnet)
```

To enable withdrawals while disabling all the other features:

```bash
npx hardhat toggle-staking-features <0xContractAddress> --enable-withdraw --network (rinkeby|mainnet)
```

NOTE: If a flag for a feature is omitted the correspond feature will be disabled.

## Basechain Staking Data Migration

To estimate the gas cost of importing the staking data into the StakingPool contract run:

```bash
# run estimates on the local test network
npx hardhat import-basechain-data path/to/basechain_staking_data.json --estimate-only

# run estimates on the Rinkeby network
npx hardhat import-basechain-data path/to/basechain_staking_data.json --network rinkeby --estimate-only

# run estimates on the Mainnet network
npx hardhat import-basechain-data path/to/basechain_staking_data.json --network mainnet --estimate-only
```

To actually import the staking data into the StakingPool contract run:

```bash
# run import on local test network
npx hardhat import-basechain-data path/to/basechain_staking_data.json

# run import on Rinkeby network
npx hardhat import-basechain-data path/to/basechain_staking_data.json --network rinkeby

# run import on Mainnet network
npx hardhat import-basechain-data path/to/basechain_staking_data.json --network mainnet
```

When this command is executed without specifying the `--network` arg the StakingPool contract is
first deployed to the local test network, and then the data is imported into that contract instance.
