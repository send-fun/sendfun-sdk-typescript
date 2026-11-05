# Changelog

## 3.0.0

### Features

- launchpad, dex: Add `accRemainder` to `RewardAccrual`.
- utils: Add `MintInfo`, `MintInfoResult`, `fetchMintInfo`, `plainMintInfo` and `launchMintInfo`.
- utils: Add `tradeFees`. It returns the transfer fees that the trade builders use.
- transferFee: Add `FeeSchedule`, `decodeFeeSchedule` and `feeAt`. `FeeSchedule` holds the fee authority, both entries and the epoch of the read.
- constants: Add `WSOL_MINT_INFO` and `USDC_MINT_INFO`.
- transferHook: Add the namespace, with `TransferHookError` and the types `AccountView`, `HookError`, `HookState` and `Unresolvable`.
- launchpad, dex: The trade, create-and-buy and migrate builders append the transfer-hook accounts.

### Fixes

- math: `amm.buyExactOut` over `baseReserveCap` quotes the amount the program sends.

### Breaking

- launchpad, dex: Decrease `reserved` in `RewardAccrual` from 64 to 56 bytes.
- nexus: Add `launchpadRewardAccrual` and `dexRewardAccrual` to `staking.WithdrawFeesAccounts`. `withdraw_fees` requires them. `staking.buildWithdrawFeesAccounts` derives them from the reward mint.
- launchpad, dex: The trade builders take `baseMintInfo` and `quoteMintInfo` in place of `baseMint`, `quoteMint`, `quoteTokenProgram`, `quoteFee` and `baseFee`.
- launchpad, dex: The trade and migrate builders throw `RangeError` for a base mint that is not a Token-2022 mint.
- launchpad: `create.buildCreateTokenInstruction` and `create.buildCreateAndBuyInstructions` take `quoteMintInfo` in place of `quoteMint`, `quoteTokenProgram` and `quoteFee`.
- launchpad, dex: The trade, create-and-buy and migrate builders throw `RangeError` for a `MintInfo` with a `hookProgram` and a null `hook`.
- launchpad: `migrate.buildMigrateInstruction` takes `baseMintInfo` and `quoteMintInfo` in place of `baseMint`, `quoteMint` and `quoteTokenProgram`.
- utils, transferFee: Remove `fetchQuoteMintInfo`, `fetchQuoteMintInfos`, `QuoteMintInfo` and `fetchMintFees`. Use `utils.fetchMintInfo`.
- transferFee: Remove `decodeTransferFeeConfig`, `transferFeeAtEpoch`, `mintFeeAtEpoch`, `TransferFeeConfig` and `TransferFeeEntry`. Use `decodeFeeSchedule` and `feeAt`.
- transferFee: `FeeSchedule` replaces `TransferFeeConfig`. It uses `bps` in place of `basisPoints` and `newerEpoch` in place of `newer.epoch`. Its `authority` is `null`, not `undefined`, when no one can set a new fee.
- transferFee: `decodeFeeSchedule` replaces `decodeTransferFeeConfig`. It takes the read epoch and returns `null` for a mint with no transfer fee. It throws `RangeError` for data that is not an initialized mint of either token program.

## 2.0.0

### Features

- launchpad: Add `creatorFeeMode`, `creatorFeeBps` and `dexCreatorFeeBps` to `BondingCurve`.
- dex: Add `creatorFeeMode` and `creatorFeeBps` to `Pool`.
- nexus: Add `allowedCreatorFeeModes` to `PartnerConfig`.
- launchpad, dex: Add `pda.findCreatorFeeConfigPda`.
- launchpad, dex: Add `creatorFeeMode` and `creatorFeeBps` to `TradeEvent`, `TokenCreateEvent` and `PoolCreateEvent`.
- launchpad: Add `dexCreatorFeeBps` to `TokenCreateEvent`.
- launchpad, dex, nexus: Add the errors `*__CREATOR_FEE_TOO_HIGH` and `*__CREATOR_FEE_MODE_NOT_ALLOWED`.
- launchpad, dex: Make `creatorFeeConfig` optional in `ClaimCreatorFeesAsyncInput` and `MigrateAsyncInput`.

### Breaking

- launchpad: Remove `creatorPlatform` and `creatorId` from `CreateTokenParams`.
- launchpad: Add `creatorFeeMode`, `creatorFeeBps` and `dexCreatorFeeBps` to `CreateTokenParams`.
- launchpad: Remove `creatorPlatform`, `creatorId` and `creatorHash` from the `createToken` instruction.
- launchpad: Add `creatorFeeMode`, `creatorFeeBps` and `dexCreatorFeeBps` to the `createToken` instruction.
- launchpad: Remove `creatorFeeConfig` from `MigrateParams`.
- launchpad: Add the `dexCreatorFeeConfig` account to `migrate`.
- launchpad, dex: Change the `creatorFeeConfig` account to the PDA from `pda.findCreatorFeeConfigPda`.
- launchpad, dex: Make `creatorFeeConfig` writable in `claimCreatorFees` and `migrate`.
- launchpad, dex: Replace `creatorFeeConfig` with `padding0` in `BondingCurve`, `Pool` and the events.
- launchpad, dex: Remove `creatorPlatform` and `creatorId` from `TokenCreateEvent`.
- launchpad: Increase `getBondingCurveSize()` from 421 to 618.
- dex: Increase `getPoolSize()` from 389 to 584.
- nexus: Increase `getPartnerConfigSize()` from 173 to 399.
- nexus: Increase `getUserRewardDebtSize()` from 182 to 214.
- nexus: Increase `getUserStakePositionSize()` from 120 to 216.
- nexus: Increase `reserved` in `FeePreset` from 32 to 64 bytes.
- nexus: Rename `creatorFeeBps` to `maxCreatorFeeBps` in `LaunchpadFees` and `DexFees`.
- nexus: Add the `creatorFeeBps` argument to `feeHelpers.effectiveFeeBps`.
- nexus: Remove the `CreatorFeeConfig` account, `CallerType` and `pda.findCreatorFeeConfigPda`.
- utils: Remove `creatorHashFromId`, `encodeCreatorId` and `decodeCreatorId`.
- launchpad, dex, nexus: Rename `*__INVALID_CREATOR_ID` to `*__UNUSED7012`.
- dex: Rename `SEND_DEX_ERROR__INVALID_CREATOR_HASH` to `SEND_DEX_ERROR__INVALID_COIN_CREATOR`.
