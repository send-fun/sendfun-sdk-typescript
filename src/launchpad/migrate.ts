import type { Instruction, TransactionSigner } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '../constants.js';
import { appendHookAccounts } from '../transfer-hook/fetch.js';
import type { HookLegs } from '../transfer-hook/resolver.js';
import {
	checkBaseMint,
	hookStateOf,
	type MintInfo,
} from '../utils/mint-info.js';
import { findAssociatedTokenPda } from '../utils/pda.js';
import { findCreatorFeeConfigPda as findDexCreatorFeeConfigPda } from '../dex/generated/pdas/creatorFeeConfig.js';
import { findPoolPda } from '../dex/generated/pdas/pool.js';
import { findLpMintPda } from '../dex/generated/pdas/lpMint.js';
import {
	getMigrateInstructionAsync,
	parseMigrateInstruction,
} from './generated/instructions/migrate.js';

export interface MigrateParams {
	caller: TransactionSigner;
	/** From `utils.fetchMintInfo`. */
	baseMintInfo: MintInfo;
	/** From `utils.fetchMintInfo`. */
	quoteMintInfo: MintInfo;
}

export async function buildMigrateInstruction(
	params: MigrateParams,
): Promise<Instruction> {
	const { baseMintInfo, quoteMintInfo } = params;
	checkBaseMint('launchpad.migrate', baseMintInfo);
	const baseMint = baseMintInfo.address;
	const quoteMint = quoteMintInfo.address;
	const quoteTokenProgram = quoteMintInfo.tokenProgram;

	const [[pool], [lpMint], [dexCreatorFeeConfig]] = await Promise.all([
		findPoolPda({
			baseMint,
			quoteMint,
		}),
		findLpMintPda({
			baseMint,
			quoteMint,
		}),
		findDexCreatorFeeConfigPda({
			baseMint,
			quoteMint,
		}),
	]);

	const [[poolBaseVault], [poolQuoteVault], [poolLpAccount]] =
		await Promise.all([
			findAssociatedTokenPda(pool, baseMint, TOKEN_2022_PROGRAM_ADDRESS),
			findAssociatedTokenPda(pool, quoteMint, quoteTokenProgram),
			findAssociatedTokenPda(pool, lpMint, TOKEN_2022_PROGRAM_ADDRESS),
		]);

	const instruction = await getMigrateInstructionAsync({
		caller: params.caller,
		baseMint,
		quoteMint,
		dexCreatorFeeConfig,
		poolBaseVault,
		poolQuoteVault,
		poolLpAccount,
		quoteTokenProgram,
	});
	return appendHookAccounts(
		instruction,
		migrateLegs(instruction),
		hookStateOf([baseMintInfo, quoteMintInfo]),
	);
}

// The legs of the `migrate` this module built, read by name with the generated
// parser. Nothing a list can read is written before the transfers.
function migrateLegs(
	instruction: Awaited<ReturnType<typeof getMigrateInstructionAsync>>,
): HookLegs {
	const { accounts } = parseMigrateInstruction(instruction);
	return {
		legs: [
			{
				source: accounts.quoteVault.address,
				mint: accounts.quoteMint.address,
				destination: accounts.poolQuoteVault.address,
				authority: accounts.bondingCurve.address,
				destinationOwner: accounts.pool.address,
			},
			{
				source: accounts.baseVault.address,
				mint: accounts.baseMint.address,
				destination: accounts.poolBaseVault.address,
				authority: accounts.bondingCurve.address,
				destinationOwner: accounts.pool.address,
			},
		],
		written: [],
	};
}
