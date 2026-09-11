import type { Address, Instruction, TransactionSigner } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '../constants.js';
import { findAssociatedTokenPda } from '../utils/pda.js';
import { findPoolPda } from '../dex/generated/pdas/pool.js';
import { findLpMintPda } from '../dex/generated/pdas/lpMint.js';
import { getMigrateInstructionAsync } from './generated/instructions/migrate.js';

export interface MigrateParams {
	caller: TransactionSigner;
	baseMint: Address;
	quoteMint: Address;
	/** `bondingCurve.creatorFeeConfig`; `migrate` rejects any other address. */
	creatorFeeConfig: Address;
	quoteTokenProgram: Address;
}

export async function buildMigrateInstruction(
	params: MigrateParams,
): Promise<Instruction> {
	const { quoteTokenProgram } = params;

	const [[pool], [lpMint]] = await Promise.all([
		findPoolPda({
			baseMint: params.baseMint,
			quoteMint: params.quoteMint,
		}),
		findLpMintPda({
			baseMint: params.baseMint,
			quoteMint: params.quoteMint,
		}),
	]);

	const [[poolBaseVault], [poolQuoteVault], [poolLpAccount]] =
		await Promise.all([
			findAssociatedTokenPda(
				pool,
				params.baseMint,
				TOKEN_2022_PROGRAM_ADDRESS,
			),
			findAssociatedTokenPda(pool, params.quoteMint, quoteTokenProgram),
			findAssociatedTokenPda(pool, lpMint, TOKEN_2022_PROGRAM_ADDRESS),
		]);

	return getMigrateInstructionAsync({
		caller: params.caller,
		baseMint: params.baseMint,
		quoteMint: params.quoteMint,
		creatorFeeConfig: params.creatorFeeConfig,
		poolBaseVault,
		poolQuoteVault,
		poolLpAccount,
		quoteTokenProgram,
	});
}
