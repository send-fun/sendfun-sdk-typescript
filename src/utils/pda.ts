import { getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import type { Address, ProgramDerivedAddress } from '@solana/kit';
import {
	ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
	TOKEN_PROGRAM_ADDRESS,
} from '../constants.js';

const addressEncoder = getAddressEncoder();

/** Seed order is [wallet, tokenProgram, mint], not the parameter order. */
export async function findAssociatedTokenPda(
	wallet: Address,
	mint: Address,
	tokenProgram: Address = TOKEN_PROGRAM_ADDRESS,
): Promise<ProgramDerivedAddress> {
	return await getProgramDerivedAddress({
		programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
		seeds: [
			addressEncoder.encode(wallet),
			addressEncoder.encode(tokenProgram),
			addressEncoder.encode(mint),
		],
	});
}
