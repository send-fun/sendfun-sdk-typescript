import type { Address } from '@solana/kit';

import { TOKEN_2022_PROGRAM_ADDRESS, TOKEN_DECIMALS } from '../constants.js';
import type { MintInfo } from './mint-info.js';
import { plainMintInfo } from './plain-mint-info.js';

/** A mint that the launchpad or the DEX created: Token-2022, `TOKEN_DECIMALS`, no fee, no hook. */
export function launchMintInfo(address: Address): MintInfo {
	return plainMintInfo(address, TOKEN_2022_PROGRAM_ADDRESS, TOKEN_DECIMALS);
}
