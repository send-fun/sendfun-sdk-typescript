# @send-fun/sdk

TypeScript SDK for the send.fun programs on Solana. It uses `@solana/kit`.

- `launchpad`: token creation, bonding curve trades, migration.
- `dex`: AMM trades after migration.
- `nexus`: staking and partner fees.

The SDK builds instructions, decodes accounts and events, and calculates quotes.
It does not send transactions.

## Install

```sh
pnpm add @send-fun/sdk
```

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
