import { address } from '@solana/kit';
import type { Address } from '@solana/kit';
import { SEND_DEX_PROGRAM_ADDRESS } from './dex/generated/programs/index.js';
import { SEND_LAUNCHPAD_PROGRAM_ADDRESS } from './launchpad/generated/programs/index.js';
import { SEND_NEXUS_PROGRAM_ADDRESS } from './nexus/generated/programs/index.js';

export const TOKEN_DECIMALS = 6;

export { SEND_LAUNCHPAD_PROGRAM_ADDRESS };
export { SEND_DEX_PROGRAM_ADDRESS };
export { SEND_NEXUS_PROGRAM_ADDRESS };

export const SYSTEM_PROGRAM_ADDRESS: Address<'11111111111111111111111111111111'> =
	address('11111111111111111111111111111111');

export const TOKEN_PROGRAM_ADDRESS: Address<'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'> =
	address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

export const TOKEN_2022_PROGRAM_ADDRESS: Address<'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'> =
	address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

export const ASSOCIATED_TOKEN_PROGRAM_ADDRESS: Address<'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'> =
	address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

export const WSOL_MINT: Address = address(
	'So11111111111111111111111111111111111111112',
);

export const USDC_MINT: Address = address(
	'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
);

export const DEFAULT_PARTNER: Address<'11111111111111111111111111111111'> =
	SYSTEM_PROGRAM_ADDRESS;

export const PYTH_SOL_USD_PRICE_ACCOUNT: Address = address(
	'7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE',
);
