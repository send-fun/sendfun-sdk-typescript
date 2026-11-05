// Runs of the builders in `./hook-free-cases.ts` against hook states: lists
// armed on a case's hook mint, the RPC that serves a state, the mint infos a
// caller reads from it, the reads a caller adds when a build names more, and
// what a build appends after its fixed accounts.

import assert from 'node:assert/strict';
import {
	AccountRole,
	getBase64Encoder,
	type AccountMeta,
	type Address,
	type GetAccountInfoApi,
	type GetMultipleAccountsApi,
	type Instruction,
	type Rpc,
	type Slot,
} from '@solana/kit';

import {
	TransferHookError,
	type AccountView,
	type HookLeg,
	type HookLegs,
	type HookState,
} from '../../src/transfer-hook/resolver.js';
import { fetchMintInfo, type MintInfo } from '../../src/utils/mint-info.js';
import { fakeRpc, type FakeAccount, type RpcCall } from './fake-rpc.js';
import type { CaseInfos, HookFreeCase } from './hook-free-cases.js';
import { mintInfoOf } from './mint-infos.js';
import {
	hookedMintData,
	hookFreeState,
	probeAccountsOf,
	probeList,
	PROBE_PROGRAM,
} from './probe-hook.js';
import { list } from './extra-metas.js';

export function readonlyMeta(address: Address): AccountMeta {
	return { address, role: AccountRole.READONLY };
}

export function writableMeta(address: Address): AccountMeta {
	return { address, role: AccountRole.WRITABLE };
}

/** An RPC that serves the accounts `state` holds, at `slot`. A `null` entry is a missing
 *  account. */
export function rpcOver(
	state: HookState,
	slot?: number,
): {
	readonly rpc: Rpc<GetAccountInfoApi & GetMultipleAccountsApi>;
	readonly calls: readonly RpcCall[];
} {
	const accounts = new Map<Address, FakeAccount>();
	for (const [address, account] of state.accounts) {
		if (account !== null) {
			accounts.set(address, {
				owner: account.owner,
				data: new Uint8Array(account.data),
			});
		}
	}
	return fakeRpc(accounts, slot);
}

/** The infos of `testCase`'s mints, made from `state` by `mintInfoOf`: a hooked mint reads its hook
 *  from all of `hook`, by default `state`. */
export function caseInfos(
	testCase: HookFreeCase,
	state: HookState,
	hook: HookState = state,
): CaseInfos {
	const [first, second] = testCase.mints;
	if (second === undefined) {
		return { quoteMintInfo: mintInfoOf(state, first, hook) };
	}
	return {
		baseMintInfo: mintInfoOf(state, first, hook),
		quoteMintInfo: mintInfoOf(state, second, hook),
	};
}

/** `testCase` built from the infos of `state`. */
export function buildFrom(
	testCase: HookFreeCase,
	state: HookState,
): Promise<readonly Instruction[]> {
	return testCase.build(caseInfos(testCase, state));
}

/** What a caller reads for `testCase` and passes to every build: `fetchMintInfo` of a market, or
 *  of the quote mint alone. */
export function fetchCaseInfos(
	rpc: Rpc<GetMultipleAccountsApi>,
	testCase: HookFreeCase,
): Promise<CaseInfos> {
	const [first, second] = testCase.mints;
	return second === undefined
		? fetchMintInfo(rpc, { quoteMint: first })
		: fetchMintInfo(rpc, { baseMint: first, quoteMint: second });
}

/** The infos of `testCase` read from an RPC that serves `chain` at `slot`, and the RPC's calls.
 *  `calls` also records each later read. */
export async function filledFrom(
	chain: HookState,
	testCase: HookFreeCase,
	slot?: number,
): Promise<{
	readonly filled: CaseInfos;
	readonly calls: readonly RpcCall[];
}> {
	const { rpc, calls } = rpcOver(chain, slot);
	return { filled: await fetchCaseInfos(rpc, testCase), calls };
}

/** The infos `fetchMintInfo` reads for `testCase` from `chain`: each mint with a hook program holds
 *  the accounts of `chain` at `own` in its hook. */
export function fetchedInfos(
	testCase: HookFreeCase,
	chain: HookState,
	own: readonly Address[],
): CaseInfos {
	return caseInfos(testCase, chain, {
		accounts: new Map(
			own.map((address) => [
				address,
				chain.accounts.get(address) ?? null,
			]),
		),
	});
}

/** The hook map of the info of `mint` in `infos`. Throws when the info has none. */
export function hookOf(infos: CaseInfos, mint: Address): HookState {
	const info = [infos.baseMintInfo, infos.quoteMintInfo].find(
		(candidate) => candidate?.address === mint,
	);
	if (info?.hook === undefined || info.hook === null) {
		throw new Error(`no hook for ${mint}`);
	}
	return info.hook;
}

/** `infos`, with the hook of the info of `mint` replaced by `hook`. */
export function withHook(
	infos: CaseInfos,
	mint: Address,
	hook: HookState | null,
): CaseInfos {
	const replace = (info: MintInfo): MintInfo =>
		info.address === mint ? { ...info, hook } : info;
	return mapInfos(infos, replace);
}

/** `infos`, each with `hook: null`. */
export function withoutHooks(infos: CaseInfos): CaseInfos {
	return mapInfos(infos, (info) => ({ ...info, hook: null }));
}

function mapInfos(
	infos: CaseInfos,
	map: (info: MintInfo) => MintInfo,
): CaseInfos {
	const { baseMintInfo, quoteMintInfo } = infos;
	return {
		...(baseMintInfo !== undefined && {
			baseMintInfo: map(baseMintInfo),
		}),
		quoteMintInfo: map(quoteMintInfo),
	};
}

/** The state where `mint` runs the probe program over `extras`, `hookFree` run no hook, and
 *  `more` holds what the list reads. */
export async function armedState(
	mint: Address,
	extras: readonly Uint8Array[],
	hookFree: readonly Address[] = [],
	more: readonly (readonly [Address, AccountView | null])[] = [],
): Promise<HookState> {
	return {
		accounts: new Map<Address, AccountView | null>([
			...hookFreeState(hookFree).accounts,
			...(await probeAccountsOf(mint, list(extras))),
			...more,
		]),
	};
}

/** A Token-2022 mint whose `TransferHook` names `program`, paused by its `PausableConfig`. */
export function pausedHookedMintData(program: Address): Uint8Array {
	const hooked = hookedMintData(program);
	const data = new Uint8Array(hooked.length + 4 + 33);
	data.set(hooked);
	// `PausableConfig`: type 26, 33 bytes, the authority, then `paused`.
	data.set([26, 0, 33, 0], hooked.length);
	data.fill(4, hooked.length + 4, hooked.length + 36);
	data[hooked.length + 36] = 1;
	return data;
}

/** The accounts that arm the probe on `mint`, paused. */
export async function pausedProbeAccountsOf(
	mint: Address,
): Promise<[Address, AccountView][]> {
	const [[, mintView], [validation, listView]] = await probeAccountsOf(
		mint,
		probeList(),
	);
	return [
		[
			mint,
			{
				owner: mintView.owner,
				data: pausedHookedMintData(PROBE_PROGRAM),
			},
		],
		[validation, listView],
	];
}

/** A case's hook-free build, the legs of its last instruction, and the one leg that moves its
 *  hook mint. */
export interface CaseRun {
	readonly hookFree: readonly Instruction[];
	readonly last: Instruction;
	readonly legs: HookLegs;
	readonly leg: HookLeg;
	/** The case's mints but its hook mint. */
	readonly others: readonly Address[];
}

export async function caseRun(testCase: HookFreeCase): Promise<CaseRun> {
	const hookFree = await buildFrom(testCase, hookFreeState(testCase.mints));
	const last = hookFree.at(-1);
	assert.ok(last !== undefined, 'empty build');
	const legs = testCase.legs(last);
	const hooked = legs.legs.filter((leg) => leg.mint === testCase.hookMint);
	assert.equal(hooked.length, 1, 'one leg moves the hook mint');
	const [leg] = hooked;
	return {
		hookFree,
		last,
		legs,
		leg,
		others: testCase.mints.filter((mint) => mint !== testCase.hookMint),
	};
}

/** The accounts a build from the infos of `state` appends after every account of the hook-free
 *  build, as `trailingOf` checks them. */
export function trailing(
	testCase: HookFreeCase,
	run: CaseRun,
	state: HookState,
): Promise<AccountMeta[]> {
	return trailingOf(testCase, run, caseInfos(testCase, state));
}

/** The accounts a build from `infos` appends after every account of the hook-free build. Asserts
 *  that the build keeps every other instruction and every fixed account as they were. */
export async function trailingOf(
	testCase: HookFreeCase,
	run: CaseRun,
	infos: CaseInfos,
): Promise<AccountMeta[]> {
	const built = await testCase.build(infos);
	assert.deepEqual(built.slice(0, -1), run.hookFree.slice(0, -1));
	const last = built.at(-1);
	assert.ok(last !== undefined);
	const fixed = run.last.accounts ?? [];
	const accounts = last.accounts ?? [];
	assert.deepEqual(accounts.slice(0, fixed.length), fixed);
	assert.equal(last.programAddress, run.last.programAddress);
	assert.deepEqual(last.data, run.last.data);
	return accounts.slice(fixed.length);
}

/** The unique mints of `legs`, in leg order. */
export function mintsOf(legs: HookLegs): Address[] {
	return [...new Set(legs.legs.map((leg) => leg.mint))];
}

const base64Encoder = getBase64Encoder();

// More rounds than any list here needs.
const MAX_READ_ROUNDS = 8;

/** The caller's pattern for every builder that takes mint infos: build from `infos`. On
 *  `NotLoaded`, read the accounts it names through `rpc` into a copy of each info's hook map, each
 *  read at the slot of the previous read or later, and build again. An info with no hook stays as
 *  it is. Returns the build and the infos it built from. */
export async function buildWithReads<T>(
	rpc: Rpc<GetMultipleAccountsApi>,
	infos: CaseInfos,
	build: (infos: CaseInfos) => Promise<T>,
): Promise<{ readonly built: T; readonly infos: CaseInfos }> {
	let current = infos;
	let slot: Slot | undefined;
	for (let round = 0; round < MAX_READ_ROUNDS; round += 1) {
		try {
			return { built: await build(current), infos: current };
		} catch (error) {
			if (
				!(error instanceof TransferHookError) ||
				error.error !== 'NotLoaded' ||
				[current.baseMintInfo, current.quoteMintInfo].every(
					(info) => info === undefined || info.hook === null,
				)
			) {
				throw error;
			}
			const { context, value } = await rpc
				.getMultipleAccounts(error.addresses, {
					encoding: 'base64',
					...(slot !== undefined && { minContextSlot: slot }),
				})
				.send();
			slot = context.slot;
			const read = error.addresses.map(
				(address, index): [Address, AccountView | null] => {
					const account = value.at(index);
					return [
						address,
						account
							? {
									owner: account.owner,
									data: new Uint8Array(
										base64Encoder.encode(account.data[0]),
									),
								}
							: null,
					];
				},
			);
			current = mapInfos(current, (info) =>
				info.hook === null
					? info
					: {
							...info,
							hook: {
								accounts: new Map([
									...info.hook.accounts,
									...read,
								]),
							},
						},
			);
		}
	}
	throw new Error(
		`the build still names accounts after ${MAX_READ_ROUNDS} reads`,
	);
}
