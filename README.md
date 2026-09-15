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
uses the `@solana/program-client-core` that your kit release ships, through
`@solana/kit/program-client-core`, so do not install that package separately
for it.

That subpath needs `package.json` `exports` support: TypeScript
`moduleResolution` set to `node16`, `nodenext` or `bundler` (not `node10`), and
Metro 0.82 or later on React Native.

## Rules

- Read `platformConfig` from the bonding curve or the pool. Do not use your own
  platform key.
- A partner other than `constants.DEFAULT_PARTNER` must sign.
- Get a platform key with `platform.findPlatformAddress(slug)`.
- Do not edit the `generated` modules. They come from the program IDLs.

## Documentation

<https://docs.send.fun>

## License

[MIT](LICENSE)
