# @send-fun/sdk

TypeScript SDK for the send.fun programs on Solana. It uses `@solana/kit`.

- `launchpad`: token creation, bonding curve trades, migration.
- `dex`: AMM trades after migration.
- `nexus`: staking and partner fees.

The SDK builds instructions, decodes accounts and events, and calculates quotes.
It does not send transactions.

## Install

```sh
pnpm add @send-fun/sdk @solana/kit
```

`@solana/kit` is the only peer dependency: 6.x from 6.10.0, 7.x or 8.x. The SDK
imports `@solana/program-client-core` through `@solana/kit/program-client-core`.
Do not install `@solana/program-client-core` for the SDK.

That subpath needs `package.json` `exports` support: TypeScript
`moduleResolution` set to `node16`, `nodenext` or `bundler`, and Metro 0.82 or
later on React Native.

## Rules

- To trade, read `platformConfig` from the bonding curve or the pool.
- To create a token, get your platform key with
  `platform.findPlatformAddress(slug)`.
- A partner other than `constants.DEFAULT_PARTNER` must sign.
- Each trade and migrate builder takes a `MintInfo` for the base mint and a
  `MintInfo` for the quote mint. Read both in one call:
  `utils.fetchMintInfo(rpc, { baseMint, quoteMint })`. A create builder takes
  only `quoteMintInfo`. Refresh a `MintInfo` on a timer, like any account. A
  builder quotes each transfer fee at the epoch of the read. Read the mint
  again when the epoch changes. For WSOL and USDC, you can also use
  `constants.WSOL_MINT_INFO` and `constants.USDC_MINT_INFO`.
- The `generated` modules come from the program IDLs. Do not edit them.

## Documentation

<https://docs.send.fun>

## License

[MIT](LICENSE)
