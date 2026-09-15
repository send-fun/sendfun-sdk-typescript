/**
 * ESM consumer entry, run by Node's type stripping inside each temp project.
 * Relative imports keep their `.ts` extension because Node runs this file
 * without a bundler or loader.
 */
import * as sdk from '@send-fun/sdk';
import * as kit from '@solana/kit';
import { fileURLToPath } from 'node:url';
import { runCompat } from './logic.ts';

const report = {
	sdkEntry: fileURLToPath(import.meta.resolve('@send-fun/sdk')),
	kitEntry: fileURLToPath(import.meta.resolve('@solana/kit')),
	snapshot: await runCompat(sdk, kit),
};
process.stdout.write(`${JSON.stringify(report)}\n`);
