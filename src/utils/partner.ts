import type { TransactionSigner } from '@solana/kit';
import type { DEFAULT_PARTNER } from '../constants.js';

/** A partner signer, or `DEFAULT_PARTNER` as a bare address. Any other partner must sign. */
export type PartnerInput = TransactionSigner | typeof DEFAULT_PARTNER;
