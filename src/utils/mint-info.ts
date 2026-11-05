import type { Address, GetMultipleAccountsApi, Rpc } from '@solana/kit';

import {
	TOKEN_2022_PROGRAM_ADDRESS,
	USDC_MINT_INFO,
	WSOL_MINT_INFO,
} from '../constants.js';
import type { MintFee } from '../math/amm.js';
import { feeAt, type FeeSchedule } from '../transfer-fee.js';
import { feeScheduleOf } from './mint-extensions.js';
import {
	clockEpoch,
	CLOCK_ADDRESS,
	fetchAccountViews,
	fill,
} from '../transfer-hook/fetch.js';
import {
	decodeMintState,
	missingHookAccounts,
	type AccountView,
	type HookState,
	type MintState,
} from '../transfer-hook/resolver.js';

/** A mint as the builders take it. Get it from `fetchMintInfo`, and refresh it on a timer, like
 *  any account. A builder quotes each transfer fee at the epoch of the read. Read the mint again
 *  when the epoch changes. */
export interface MintInfo {
	readonly address: Address;
	readonly tokenProgram: Address;
	readonly decimals: number;
	/** `null` when the mint has no transfer fee. `transferFee.feeAt` gives the fee at any epoch. At
	 *  `readEpoch`, it is the fee that the builders quote with. */
	readonly transferFee: FeeSchedule | null;
	/** The hook program. `null` when the mint has no transfer hook. */
	readonly hookProgram: Address | null;
	/** `null` when the mint has no transfer hook. */
	readonly hook: HookState | null;
}

/** `{ baseMint }` gives `{ baseMintInfo }`. */
export type MintInfoResult<K extends string> = {
	readonly [P in K as `${P}Info`]: MintInfo;
};

function infoOf(
	address: Address,
	state: MintState,
	epoch: bigint,
	hook: HookState | null,
): MintInfo {
	return {
		address,
		tokenProgram: state.tokenProgram,
		decimals: state.decimals,
		transferFee:
			state.transferFee === null
				? null
				: feeScheduleOf(state.transferFee, epoch),
		hookProgram: state.hookProgram,
		hook,
	};
}

/** Reads each mint. `{ baseMint, quoteMint }` gives `{ baseMintInfo, quoteMintInfo }`. A list of
 *  addresses gives a map. WSOL and USDC give their constant infos and need no read. Throws if a
 *  mint does not exist, and `RangeError` if an account is not an initialized mint of a token
 *  program. */
export function fetchMintInfo<const K extends string>(
	rpc: Rpc<GetMultipleAccountsApi>,
	mints: Readonly<Record<K, Address>>,
): Promise<MintInfoResult<K>>;
export function fetchMintInfo(
	rpc: Rpc<GetMultipleAccountsApi>,
	mints: readonly Address[],
): Promise<ReadonlyMap<Address, MintInfo>>;
// The overloads type the result. `Object.fromEntries` gives a record.
export async function fetchMintInfo(
	rpc: Rpc<GetMultipleAccountsApi>,
	mints: Readonly<Record<string, Address>> | readonly Address[],
): Promise<
	Readonly<Record<string, MintInfo>> | ReadonlyMap<Address, MintInfo>
> {
	if (isAddressList(mints)) {
		const distinct = [...new Set(mints)];
		const infos = await readMintInfos(rpc, distinct);
		return new Map(distinct.map((mint, index) => [mint, infos[index]]));
	}
	const entries = Object.entries(mints);
	const distinct = [...new Set(entries.map(([, mint]) => mint))];
	const infos = await readMintInfos(rpc, distinct);
	return Object.fromEntries(
		entries.map(([key, mint]) => [
			`${key}Info`,
			infos[distinct.indexOf(mint)],
		]),
	);
}

function isAddressList(
	mints: Readonly<Record<string, Address>> | readonly Address[],
): mints is readonly Address[] {
	return Array.isArray(mints);
}

// An SPL Token mint has no extensions, so these infos never change.
const CONSTANT_INFOS: ReadonlyMap<Address, MintInfo> = new Map(
	[WSOL_MINT_INFO, USDC_MINT_INFO].map((info) => [info.address, info]),
);

/** The info of each of `distinct`, in its order. */
async function readMintInfos(
	rpc: Rpc<GetMultipleAccountsApi>,
	distinct: readonly Address[],
): Promise<MintInfo[]> {
	const unread = distinct.filter((mint) => !CONSTANT_INFOS.has(mint));
	const read = await readMints(rpc, unread);
	return distinct.map(
		(mint) => CONSTANT_INFOS.get(mint) ?? read[unread.indexOf(mint)],
	);
}

/** Reads each of `distinct`, in its order. */
async function readMints(
	rpc: Rpc<GetMultipleAccountsApi>,
	distinct: readonly Address[],
): Promise<MintInfo[]> {
	if (distinct.length === 0) return [];
	// The clock in the same read gives the epoch of the mint data.
	const first = await fetchAccountViews(
		rpc,
		[...distinct, CLOCK_ADDRESS],
		undefined,
	);
	const epoch = clockEpoch('fetchMintInfo', first.views.at(-1));
	return Promise.all(
		distinct.map(async (mint, index) => {
			const account = first.views.at(index) ?? null;
			if (account === null) {
				throw new Error(`fetchMintInfo: no account at ${mint}`);
			}
			const decoded = decodeMintState(account);
			if (decoded.hookProgram === null) {
				return infoOf(mint, decoded, epoch, null);
			}
			const accounts = new Map<Address, AccountView | null>([
				[mint, account],
			]);
			await fill(rpc, accounts, first.slot, (state) =>
				missingHookAccounts(state, [mint]),
			);
			return infoOf(mint, decoded, epoch, { accounts });
		}),
	);
}

/** The transfer fees that the trade builders quote with. `null` for a mint with no transfer fee. */
export interface TradeFees {
	readonly baseFee: MintFee | null;
	readonly quoteFee: MintFee | null;
}

/** Each mint's fee at the epoch of its read. */
export function tradeFees(params: {
	readonly baseMintInfo: MintInfo;
	readonly quoteMintInfo: MintInfo;
}): TradeFees {
	return {
		baseFee: feeOf(params.baseMintInfo),
		quoteFee: feeOf(params.quoteMintInfo),
	};
}

function feeOf({ transferFee }: MintInfo): MintFee | null {
	return transferFee === null
		? null
		: feeAt(transferFee, transferFee.readEpoch);
}

export function checkBaseMint(caller: string, baseMintInfo: MintInfo): void {
	if (baseMintInfo.tokenProgram !== TOKEN_2022_PROGRAM_ADDRESS) {
		throw new RangeError(
			`${caller}: the base mint ${baseMintInfo.address} is not a Token-2022 mint`,
		);
	}
}

// The resolver reads a missing mint as hook-free. Another mint's hook can
// hold the real account, which then wins.
export function hookStateOf(infos: readonly MintInfo[]): HookState {
	for (const { address, hookProgram, hook } of infos) {
		if (hookProgram !== null && hook === null) {
			throw new RangeError(
				`the mint ${address} has a hook program and no hook. Read it with fetchMintInfo`,
			);
		}
	}
	const accounts = new Map<Address, AccountView | null>();
	for (const { hook } of infos) {
		for (const [address, account] of hook?.accounts ?? []) {
			accounts.set(address, account);
		}
	}
	for (const info of infos) {
		if (info.hook === null && !accounts.has(info.address)) {
			accounts.set(info.address, null);
		}
	}
	return { accounts };
}
