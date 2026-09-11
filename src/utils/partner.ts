import type { TransactionSigner } from '@solana/kit';
import type { DEFAULT_PARTNER } from '../constants.js';

/** Non-default partners must sign; only `DEFAULT_PARTNER` is valid as a bare address. */
export type PartnerInput = TransactionSigner | typeof DEFAULT_PARTNER;
