// Decodes the transfer fee of a mint. `utils/mint-extensions.ts` reads the TLV
// entries.

import type { Address } from '@solana/kit';

import {
	TOKEN_2022_PROGRAM_ADDRESS,
	TOKEN_PROGRAM_ADDRESS,
} from './constants.js';
import type { MintFee } from './math/amm.js';
import {
	checkSplTokenMint,
	decodeTransferFeeValue,
	feeScheduleOf,
	mintExtension,
	mintTlv,
	TRANSFER_FEE_CONFIG,
	type FeeSchedule,
} from './utils/mint-extensions.js';

export type { FeeSchedule } from './utils/mint-extensions.js';

/** Decodes the transfer fee of a mint read at `readEpoch`. `owner` is the program that owns the
 *  account. Returns `null` if the mint has no `TransferFeeConfig`. Throws `RangeError` if `owner`
 *  is not a token program or `data` is not an initialized mint. */
export function decodeFeeSchedule(
	data: Uint8Array,
	owner: Address,
	readEpoch: bigint,
): FeeSchedule | null {
	// An SPL Token mint has no extensions.
	if (owner === TOKEN_PROGRAM_ADDRESS) {
		checkSplTokenMint('decodeFeeSchedule', data);
		return null;
	}
	if (owner !== TOKEN_2022_PROGRAM_ADDRESS) {
		throw new RangeError(
			`decodeFeeSchedule: ${owner} is not a token program`,
		);
	}
	const value = mintExtension(
		'decodeFeeSchedule',
		mintTlv('decodeFeeSchedule', data),
		TRANSFER_FEE_CONFIG,
	);
	return value === undefined
		? null
		: feeScheduleOf(decodeTransferFeeValue(value), readEpoch);
}

/** Returns the fee at `epoch`, as SPL `get_epoch_fee` does: `newer` from `newerEpoch` on, else
 *  `older`. The builders pass `schedule.readEpoch`. */
export function feeAt(schedule: FeeSchedule, epoch: bigint): MintFee {
	return epoch >= schedule.newerEpoch ? schedule.newer : schedule.older;
}
