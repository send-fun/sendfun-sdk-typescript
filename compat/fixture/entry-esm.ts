/**
 * ESM consumer entry, run by Node's type stripping inside each temp project.
 * Relative imports keep their `.ts` extension because Node runs this file
 * without a bundler or loader.
 */
import * as sdk from '@send-fun/sdk';
import * as kit from '@solana/kit';
import { fileURLToPath } from 'node:url';
import { packageVersion, runCompat } from './logic.ts';

const sdkEntry = fileURLToPath(import.meta.resolve('@send-fun/sdk'));
const kitEntry = fileURLToPath(import.meta.resolve('@solana/kit'));
const report = {
	sdkEntry,
	sdkVersion: packageVersion(sdkEntry, '@send-fun/sdk'),
	kitEntry,
	kitVersion: packageVersion(kitEntry, '@solana/kit'),
	snapshot: await runCompat(sdk, kit),
};
process.stdout.write(`${JSON.stringify(report)}\n`);
