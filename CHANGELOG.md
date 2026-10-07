# Changelog

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
