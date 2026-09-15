/**
 * CommonJS consumer entry: `require` loads the SDK's `dist/index.cjs` and
 * kit's CommonJS build, then hands both to the shared ESM checks. The module
 * types come from logic.ts so both entries pass the same parameter types.
 */
const { runCompat }: typeof import('./logic.ts') = require('./logic.ts');
const sdk: import('./logic.ts').Sdk = require('@send-fun/sdk');
const kit: import('./logic.ts').Kit = require('@solana/kit');

runCompat(sdk, kit).then(
	(snapshot) => {
		const report = {
			sdkEntry: require.resolve('@send-fun/sdk'),
			kitEntry: require.resolve('@solana/kit'),
			snapshot,
		};
		process.stdout.write(`${JSON.stringify(report)}\n`);
	},
	(error: unknown) => {
		process.exitCode = 1;
		console.error(error);
	},
);
