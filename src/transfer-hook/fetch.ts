// Fetches what the offline resolver in `./resolver.ts` reads, and appends its
// output to an instruction. The builders read nothing.

import {
	address,
	getBase64Encoder,
	type Address,
	type GetMultipleAccountsApi,
	type Instruction,
	type Rpc,
	type Slot,
} from '@solana/kit';

import { fetchInChunks } from '../utils/chunk.js';
import {
	resolveHookAccounts,
	type AccountView,
	type HookLegs,
	type HookState,
} from './resolver.js';

const base64Encoder = getBase64Encoder();

export const CLOCK_ADDRESS: Address = address(
	'SysvarC1ock11111111111111111111111111111111',
);

// The epoch is the third u64 of `Clock`.
const CLOCK_EPOCH_OFFSET = 16;

const SYSVAR_PROGRAM_ADDRESS: Address = address(
	'Sysvar1111111111111111111111111111111111111',
);

// One `getMultipleAccounts` per 100 addresses, each at `minContextSlot` or
// later when given. Returns the views and the latest slot read.
export async function fetchAccountViews(
	rpc: Rpc<GetMultipleAccountsApi>,
	addresses: readonly Address[],
	minContextSlot: Slot | undefined,
): Promise<{
	readonly slot: Slot | undefined;
	readonly views: (AccountView | null)[];
}> {
	let slot = minContextSlot;
	const views = await fetchInChunks(addresses, async (chunk) => {
		const { context, value } = await rpc
			.getMultipleAccounts(chunk, {
				encoding: 'base64',
				...(minContextSlot !== undefined && { minContextSlot }),
			})
			.send();
		if (slot === undefined || context.slot > slot) slot = context.slot;
		return chunk.map((_, index) => {
			const account = value.at(index);
			return account
				? {
						owner: account.owner,
						data: new Uint8Array(
							base64Encoder.encode(account.data[0]),
						),
					}
				: null;
		});
	});
	return { slot, views };
}

// Reads the accounts that `next` names into `accounts` until `next` names
// none. Each read is at `slot` or later, because a node that is behind can
// miss a new hook list.
export async function fill(
	rpc: Rpc<GetMultipleAccountsApi>,
	accounts: Map<Address, AccountView | null>,
	slot: Slot | undefined,
	next: (state: HookState) => Promise<readonly Address[]>,
): Promise<void> {
	let minContextSlot = slot;
	for (;;) {
		const addresses = await next({ accounts });
		if (addresses.length === 0) return;
		const read = await fetchAccountViews(rpc, addresses, minContextSlot);
		minContextSlot = read.slot;
		addresses.forEach((key, index) => {
			accounts.set(key, read.views.at(index) ?? null);
		});
	}
}

/** Appends the hook accounts of `legs`, from `state`, after all accounts of `instruction`. Reads
 *  no account. Rejects with `TransferHookError`. */
export async function appendHookAccounts(
	instruction: Instruction,
	legs: HookLegs,
	state: HookState,
): Promise<Instruction> {
	const accounts = await resolveHookAccounts(legs, state);
	if (accounts.length === 0) return instruction;
	return Object.freeze({
		...instruction,
		accounts: [...(instruction.accounts ?? []), ...accounts],
	});
}

export function clockEpoch(
	caller: string,
	clock: AccountView | null | undefined,
): bigint {
	if (
		clock === null ||
		clock === undefined ||
		clock.owner !== SYSVAR_PROGRAM_ADDRESS ||
		clock.data.length < CLOCK_EPOCH_OFFSET + 8
	) {
		throw new Error(`${caller}: no clock`);
	}
	const { data } = clock;
	return new DataView(
		data.buffer,
		data.byteOffset,
		data.byteLength,
	).getBigUint64(CLOCK_EPOCH_OFFSET, true);
}
