import type { Address } from '@solana/kit';

import type { MintInfo } from './mint-info.js';

/** A mint with no transfer fee and no transfer hook. */
export function plainMintInfo(
	address: Address,
	tokenProgram: Address,
	decimals: number,
): MintInfo {
	return {
		address,
		tokenProgram,
		decimals,
		transferFee: null,
		hookProgram: null,
		hook: null,
	};
}
