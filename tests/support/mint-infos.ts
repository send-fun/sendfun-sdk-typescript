// The mint infos the builders take, made from a hook state or by hand.

import type { Address } from '@solana/kit';

import { TOKEN_2022_PROGRAM_ADDRESS } from '../../src/constants.js';
import {
	decodeMintState,
	type HookState,
} from '../../src/transfer-hook/resolver.js';
import type { MintFee } from '../../src/math/amm.js';
import type { FeeSchedule } from '../../src/transfer-fee.js';
import { feeScheduleOf } from '../../src/utils/mint-extensions.js';
import type { MintInfo } from '../../src/utils/mint-info.js';

/** `mint` as `state` holds it, read at epoch 0. A mint with a hook program reads its hook from
 *  `hook`, by default all of `state`. Throws when `state` holds no account at `mint`. */
export function mintInfoOf(
	state: HookState,
	mint: Address,
	hook: HookState = state,
): MintInfo {
	const account = state.accounts.get(mint);
	if (account === undefined || account === null) {
		throw new Error(`the state holds no mint at ${mint}`);
	}
	const decoded = decodeMintState(account);
	return {
		address: mint,
		tokenProgram: decoded.tokenProgram,
		decimals: decoded.decimals,
		transferFee:
			decoded.transferFee === null
				? null
				: feeScheduleOf(decoded.transferFee, 0n),
		hookProgram: decoded.hookProgram,
		hook: decoded.hookProgram === null ? null : hook,
	};
}

/** A mint with no fee and no hook. */
export function plainMintInfo(
	address: Address,
	tokenProgram: Address = TOKEN_2022_PROGRAM_ADDRESS,
): MintInfo {
	return {
		address,
		tokenProgram,
		decimals: 0,
		transferFee: null,
		hookProgram: null,
		hook: null,
	};
}

/** A schedule that charges `fee` at every epoch, read at epoch 0. */
export function steadyFee(fee: MintFee): FeeSchedule {
	return {
		authority: null,
		older: fee,
		newer: fee,
		newerEpoch: 0n,
		readEpoch: 0n,
	};
}

/** A transfer fee of `bps` with no cap. */
export function flatFee(bps: number): MintFee {
	return { bps, maximumFee: 18_446_744_073_709_551_615n };
}
