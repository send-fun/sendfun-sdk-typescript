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
- The `generated` modules come from the program IDLs. Do not edit them.

## Documentation

<https://docs.send.fun>

## License

[MIT](LICENSE)
