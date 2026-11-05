import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	AccountRole,
	getAddressDecoder,
	getAddressEncoder,
	getProgramDerivedAddress,
	type AccountMeta,
	type Address,
	type Instruction,
	type ReadonlyUint8Array,
} from '@solana/kit';

import {
	SEND_LAUNCHPAD_PROGRAM_ADDRESS,
	TOKEN_2022_PROGRAM_ADDRESS,
	TOKEN_PROGRAM_ADDRESS,
	USDC_MINT,
	USDC_MINT_INFO,
	WSOL_MINT,
	WSOL_MINT_INFO,
} from '../src/constants.js';
import type { FeeSchedule } from '../src/transfer-fee.js';
import { appendHookAccounts } from '../src/transfer-hook/fetch.js';
import {
	EXECUTE_DISCRIMINATOR,
	findValidationAddress,
	missingHookAccounts,
	resolveHookAccounts,
	type AccountView,
	type HookLeg,
	type HookLegs,
	type HookState,
} from '../src/transfer-hook/resolver.js';
import {
	fetchMintInfo,
	hookStateOf,
	type MintInfo,
} from '../src/utils/mint-info.js';
import {
	accountData,
	accountKey,
	fixed,
	instructionData,
	list,
	literal,
	pda,
	pubkeyData,
} from './support/extra-metas.js';
import {
	clockAccount,
	CLOCK,
	fakeRpc,
	type FakeAccount,
} from './support/fake-rpc.js';
import { rpcOver } from './support/hook-runs.js';
import {
	AUX,
	BASE_MINT,
	TKALSHI_MINT,
	USER,
} from './support/hook-free-cases.js';
import {
	hookFreeState,
	PROBE_PROGRAM,
	probeAccounts,
	probeList,
	probeState,
} from './support/probe-hook.js';

const addressDecoder = getAddressDecoder();
const addressEncoder = getAddressEncoder();

const DECIMALS = 44;
const IS_INITIALIZED = 45;
const SPL_DECIMALS = 9;
const TOKEN_2022_DECIMALS = 6;
const ACCOUNT_TYPE_MINT = 1;
const TRANSFER_HOOK_TYPE = 14;
const TRANSFER_HOOK_LENGTH = 64;

/** The address of 32 copies of `byte`. */
function key(byte: number): Address {
	return addressDecoder.decode(new Uint8Array(32).fill(byte));
}

function baseMint(decimals: number): Uint8Array {
	const data = new Uint8Array(82);
	data[DECIMALS] = decimals;
	data[IS_INITIALIZED] = 1;
	return data;
}

/** An initialized Token-2022 mint cut between the base and its first extension. */
function truncatedMint(): Uint8Array {
	const data = new Uint8Array(100);
	data[IS_INITIALIZED] = 1;
	return data;
}

// A Token-2022 mint whose only extension is `TransferHook`, its authority
// unset. `program` `undefined` leaves `program_id` unset.
function hookedMint(program: Address | undefined): Uint8Array {
	const data = new Uint8Array(166 + 4 + TRANSFER_HOOK_LENGTH);
	data[DECIMALS] = TOKEN_2022_DECIMALS;
	data[IS_INITIALIZED] = 1;
	data[165] = ACCOUNT_TYPE_MINT;
	data.set([TRANSFER_HOOK_TYPE, 0, TRANSFER_HOOK_LENGTH, 0], 166);
	if (program !== undefined) {
		data.set(addressEncoder.encode(program), 166 + 4 + 32);
	}
	return data;
}

const CLASSIC_MINT: FakeAccount = {
	owner: TOKEN_PROGRAM_ADDRESS,
	data: baseMint(SPL_DECIMALS),
};
const PLAIN_TOKEN_2022_MINT: FakeAccount = {
	owner: TOKEN_2022_PROGRAM_ADDRESS,
	data: baseMint(TOKEN_2022_DECIMALS),
};
const UNSET_HOOK_MINT: FakeAccount = {
	owner: TOKEN_2022_PROGRAM_ADDRESS,
	data: hookedMint(undefined),
};
const UNSET_HOOK = key(71);
// An SPL Token mint that `fetchMintInfo` must read: not WSOL or USDC.
const CLASSIC = key(72);
const PROBE_MINT: FakeAccount = {
	owner: TOKEN_2022_PROGRAM_ADDRESS,
	data: hookedMint(PROBE_PROGRAM),
};

// The config on the wire: kit's client adds its default commitment.
const DEFAULT_CONFIG = { commitment: 'confirmed', encoding: 'base64' } as const;

// The slot the fake RPC answers at. Tests check that a later read asks for it.
const SLOT = 4_242;

const AT_SLOT = { ...DEFAULT_CONFIG, minContextSlot: BigInt(SLOT) } as const;

// `["extra-account-metas", TKALSHI_MINT]` under the probe program.
const VALIDATION = await findValidationAddress(TKALSHI_MINT, PROBE_PROGRAM);
const BASE_VALIDATION = await findValidationAddress(BASE_MINT, PROBE_PROGRAM);

function probeValidation(data: Uint8Array = probeList()): FakeAccount {
	return { owner: PROBE_PROGRAM, data };
}

function stateOf(
	entries: readonly (readonly [Address, AccountView | null])[],
): HookState {
	return { accounts: new Map(entries) };
}

/** A buy's quote leg: the user pays a hooked mint into the vault. */
const QUOTE_LEG: HookLeg = {
	source: key(23),
	mint: TKALSHI_MINT,
	destination: key(24),
	authority: USER,
	destinationOwner: key(6),
};

/** A buy's base leg: the vault pays the user. */
const BASE_LEG: HookLeg = {
	source: key(25),
	mint: BASE_MINT,
	destination: key(26),
	authority: key(6),
	destinationOwner: USER,
};

const LEGS: HookLegs = { legs: [QUOTE_LEG, BASE_LEG], written: [] };

async function probePda(
	...seeds: readonly ReadonlyUint8Array[]
): Promise<Address> {
	const [address] = await getProgramDerivedAddress({
		programAddress: PROBE_PROGRAM,
		seeds: [...seeds],
	});
	return address;
}

const NO_LIST = { name: 'TransferHookError', error: 'NoList' } as const;

const PROBE_TAIL: readonly AccountMeta[] = [
	{ address: PROBE_PROGRAM, role: AccountRole.READONLY },
	{ address: VALIDATION, role: AccountRole.READONLY },
];

interface FeeEntry {
	readonly epoch: bigint;
	readonly maximumFee: bigint;
	readonly basisPoints: number;
}

const TRANSFER_FEE_CONFIG_TYPE = 1;
const TRANSFER_FEE_CONFIG_LENGTH = 108;
const PAUSABLE_CONFIG_TYPE = 26;
const PAUSABLE_CONFIG_LENGTH = 33;
// The older entry starts after the authorities and the withheld amount.
const OLDER_OFFSET = 72;
const FEE_ENTRY_LENGTH = 18;

/** A Token-2022 mint with only a `TransferFeeConfig` of `older` and `newer`. */
function feeMint(older: FeeEntry, newer: FeeEntry): Uint8Array {
	const data = new Uint8Array(166 + 4 + TRANSFER_FEE_CONFIG_LENGTH);
	data[DECIMALS] = TOKEN_2022_DECIMALS;
	data[IS_INITIALIZED] = 1;
	data[165] = ACCOUNT_TYPE_MINT;
	data.set([TRANSFER_FEE_CONFIG_TYPE, 0, TRANSFER_FEE_CONFIG_LENGTH, 0], 166);
	const view = new DataView(data.buffer);
	for (const [index, entry] of [older, newer].entries()) {
		const at = 166 + 4 + OLDER_OFFSET + index * FEE_ENTRY_LENGTH;
		view.setBigUint64(at, entry.epoch, true);
		view.setBigUint64(at + 8, entry.maximumFee, true);
		view.setUint16(at + 16, entry.basisPoints, true);
	}
	return data;
}

/** A probe list whose extras then read `AUX`, a key from `AUX`'s data and that key's data. */
function chainedList(): Uint8Array {
	return list([fixed(AUX), pubkeyData(5, 0), pda([accountData(6, 0, 4)])]);
}

const CHAINED = key(70);

const AUX_ACCOUNT: FakeAccount = {
	owner: key(0),
	data: addressEncoder.encode(CHAINED).slice(),
};
const CHAINED_ACCOUNT: FakeAccount = {
	owner: key(0),
	data: new Uint8Array([1, 2, 3, 4, 5]),
};

function notLoaded(addresses: readonly Address[]) {
	return {
		name: 'TransferHookError',
		error: 'NotLoaded',
		message: `transfer hook accounts not loaded: fetch ${addresses.join(', ')}`,
		addresses,
	};
}

/** A Token-2022 mint whose only extension is `PausableConfig`, paused. */
function pausedMint(): Uint8Array {
	const data = new Uint8Array(166 + 4 + PAUSABLE_CONFIG_LENGTH);
	data[DECIMALS] = TOKEN_2022_DECIMALS;
	data[IS_INITIALIZED] = 1;
	data[165] = ACCOUNT_TYPE_MINT;
	data.set([PAUSABLE_CONFIG_TYPE, 0, PAUSABLE_CONFIG_LENGTH, 0], 166);
	// The authority, then `paused`.
	data.fill(4, 170, 202);
	data[202] = 1;
	return data;
}

/** What `fetchMintInfo` decodes of a mint, but its address and its hook. */
type MintFields = Pick<MintInfo, 'tokenProgram' | 'decimals' | 'transferFee'>;

const TOKEN_2022_FIELDS: MintFields = {
	tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
	decimals: TOKEN_2022_DECIMALS,
	transferFee: null,
};

const CLASSIC_FIELDS: MintFields = {
	tokenProgram: TOKEN_PROGRAM_ADDRESS,
	decimals: SPL_DECIMALS,
	transferFee: null,
};

// Every hooked mint here runs the probe.
function infoOf(
	address: Address,
	fields: MintFields,
	hook: HookState | null,
): MintInfo {
	return {
		address,
		...fields,
		hookProgram: hook === null ? null : PROBE_PROGRAM,
		hook,
	};
}

/** The probe on `TKALSHI_MINT` over `data`, and `more`: the quote mint's hook. */
function quoteHook(
	data: Uint8Array = probeList(),
	more: readonly (readonly [Address, AccountView | null])[] = [],
): HookState {
	return stateOf([
		[TKALSHI_MINT, PROBE_MINT],
		[VALIDATION, probeValidation(data)],
		...more,
	]);
}

const MARKET = { baseMint: BASE_MINT, quoteMint: TKALSHI_MINT } as const;

/** The hook state a market's builders resolve from `infos`. */
function marketHooks(infos: {
	readonly baseMintInfo: MintInfo;
	readonly quoteMintInfo: MintInfo;
}): HookState {
	return hookStateOf([infos.baseMintInfo, infos.quoteMintInfo]);
}

/** The schedule of `feeMint` at 100 bps from epoch 5 and 250 bps from epoch 7, read at
 *  `readEpoch`. */
function schedule(readEpoch: bigint): FeeSchedule {
	return {
		authority: null,
		older: { bps: 100, maximumFee: 1_000n },
		newer: { bps: 250, maximumFee: 900n },
		newerEpoch: 7n,
		readEpoch,
	};
}

describe('fetchMintInfo', () => {
	it('reads a market’s mints and the clock in one call, and no more for hook-free mints', async () => {
		const { rpc, calls } = fakeRpc(
			new Map([
				[BASE_MINT, UNSET_HOOK_MINT],
				[CLASSIC, CLASSIC_MINT],
			]),
		);
		assert.deepEqual(
			await fetchMintInfo(rpc, {
				baseMint: BASE_MINT,
				quoteMint: CLASSIC,
			}),
			{
				baseMintInfo: infoOf(BASE_MINT, TOKEN_2022_FIELDS, null),
				quoteMintInfo: infoOf(CLASSIC, CLASSIC_FIELDS, null),
			},
		);
		assert.deepEqual(calls, [
			{
				method: 'getMultipleAccounts',
				params: [[BASE_MINT, CLASSIC, CLOCK], DEFAULT_CONFIG],
			},
		]);
	});

	it('gives WSOL and USDC their constant infos, and reads nothing', async () => {
		const { rpc, calls } = fakeRpc(new Map());
		const read = await fetchMintInfo(rpc, {
			baseMint: WSOL_MINT,
			quoteMint: USDC_MINT,
		});
		assert.equal(read.baseMintInfo, WSOL_MINT_INFO);
		assert.equal(read.quoteMintInfo, USDC_MINT_INFO);
		assert.deepEqual(calls, []);
	});

	it('reads only the mints that are not WSOL or USDC, in list order', async () => {
		const { rpc, calls } = fakeRpc(
			new Map([[BASE_MINT, PLAIN_TOKEN_2022_MINT]]),
		);
		const read = await fetchMintInfo(rpc, [
			USDC_MINT,
			BASE_MINT,
			WSOL_MINT,
		]);
		assert.deepEqual(
			[...read],
			[
				[USDC_MINT, USDC_MINT_INFO],
				[BASE_MINT, infoOf(BASE_MINT, TOKEN_2022_FIELDS, null)],
				[WSOL_MINT, WSOL_MINT_INFO],
			],
		);
		assert.deepEqual(calls, [
			{
				method: 'getMultipleAccounts',
				params: [[BASE_MINT, CLOCK], DEFAULT_CONFIG],
			},
		]);
	});

	it('reads one mint, as `mintInfo`', async () => {
		const { rpc, calls } = fakeRpc(
			new Map([[TKALSHI_MINT, PLAIN_TOKEN_2022_MINT]]),
		);
		assert.deepEqual(await fetchMintInfo(rpc, { mint: TKALSHI_MINT }), {
			mintInfo: infoOf(TKALSHI_MINT, TOKEN_2022_FIELDS, null),
		});
		assert.deepEqual(calls, [
			{
				method: 'getMultipleAccounts',
				params: [[TKALSHI_MINT, CLOCK], DEFAULT_CONFIG],
			},
		]);
	});

	it('reads in key order, and an address two keys name once', async () => {
		const { rpc, calls } = fakeRpc(
			new Map([
				[BASE_MINT, PLAIN_TOKEN_2022_MINT],
				[TKALSHI_MINT, PROBE_MINT],
				[VALIDATION, probeValidation()],
			]),
			SLOT,
		);
		const read = await fetchMintInfo(rpc, {
			quoteMint: TKALSHI_MINT,
			baseMint: BASE_MINT,
			otherMint: TKALSHI_MINT,
		});
		assert.deepEqual(read, {
			quoteMintInfo: infoOf(TKALSHI_MINT, TOKEN_2022_FIELDS, quoteHook()),
			baseMintInfo: infoOf(BASE_MINT, TOKEN_2022_FIELDS, null),
			otherMintInfo: infoOf(TKALSHI_MINT, TOKEN_2022_FIELDS, quoteHook()),
		});
		assert.equal(read.otherMintInfo, read.quoteMintInfo);
		assert.deepEqual(calls, [
			{
				method: 'getMultipleAccounts',
				params: [[TKALSHI_MINT, BASE_MINT, CLOCK], DEFAULT_CONFIG],
			},
			{ method: 'getMultipleAccounts', params: [[VALIDATION], AT_SLOT] },
		]);
	});

	it('reads a hooked mint’s list with a second call, at the first call’s slot or later', async () => {
		const { rpc, calls } = fakeRpc(
			new Map([
				[BASE_MINT, PLAIN_TOKEN_2022_MINT],
				[TKALSHI_MINT, PROBE_MINT],
				[VALIDATION, probeValidation()],
			]),
			SLOT,
		);
		const read = await fetchMintInfo(rpc, MARKET);
		assert.deepEqual(read, {
			baseMintInfo: infoOf(BASE_MINT, TOKEN_2022_FIELDS, null),
			quoteMintInfo: infoOf(TKALSHI_MINT, TOKEN_2022_FIELDS, quoteHook()),
		});
		const config = DEFAULT_CONFIG;
		assert.deepEqual(calls, [
			{
				method: 'getMultipleAccounts',
				params: [[BASE_MINT, TKALSHI_MINT, CLOCK], config],
			},
			{
				method: 'getMultipleAccounts',
				params: [
					[VALIDATION],
					{ ...config, minContextSlot: BigInt(SLOT) },
				],
			},
		]);
		// The infos resolve the probe with no more reads.
		assert.deepEqual(
			await resolveHookAccounts(LEGS, marketHooks(read)),
			await probeAccounts(QUOTE_LEG),
		);
		assert.equal(calls.length, 2);
	});

	it('gives each of two hooked mints its own accounts', async () => {
		const { rpc, calls } = fakeRpc(
			new Map([
				[BASE_MINT, PROBE_MINT],
				[TKALSHI_MINT, PROBE_MINT],
				[BASE_VALIDATION, probeValidation()],
				[VALIDATION, probeValidation()],
			]),
			SLOT,
		);
		assert.deepEqual(await fetchMintInfo(rpc, MARKET), {
			baseMintInfo: infoOf(
				BASE_MINT,
				TOKEN_2022_FIELDS,
				stateOf([
					[BASE_MINT, PROBE_MINT],
					[BASE_VALIDATION, probeValidation()],
				]),
			),
			quoteMintInfo: infoOf(TKALSHI_MINT, TOKEN_2022_FIELDS, quoteHook()),
		});
		assert.deepEqual(calls, [
			{
				method: 'getMultipleAccounts',
				params: [[BASE_MINT, TKALSHI_MINT, CLOCK], DEFAULT_CONFIG],
			},
			{
				method: 'getMultipleAccounts',
				params: [[BASE_VALIDATION], AT_SLOT],
			},
			{ method: 'getMultipleAccounts', params: [[VALIDATION], AT_SLOT] },
		]);
	});

	it('holds a missing list as null, which a resolution refuses', async () => {
		const { rpc } = fakeRpc(
			new Map([
				[BASE_MINT, PLAIN_TOKEN_2022_MINT],
				[TKALSHI_MINT, PROBE_MINT],
			]),
		);
		const read = await fetchMintInfo(rpc, MARKET);
		assert.deepEqual(
			read.quoteMintInfo.hook,
			stateOf([
				[TKALSHI_MINT, PROBE_MINT],
				[VALIDATION, null],
			]),
		);
		await assert.rejects(
			resolveHookAccounts(LEGS, marketHooks(read)),
			NO_LIST,
		);
	});

	it('counts a list the hook program does not own as missing', async () => {
		const squatted: FakeAccount = {
			owner: TOKEN_2022_PROGRAM_ADDRESS,
			data: probeList(),
		};
		const { rpc } = fakeRpc(
			new Map([
				[BASE_MINT, PLAIN_TOKEN_2022_MINT],
				[TKALSHI_MINT, PROBE_MINT],
				[VALIDATION, squatted],
			]),
		);
		const read = await fetchMintInfo(rpc, MARKET);
		// The hook holds the account as read.
		assert.deepEqual(
			read.quoteMintInfo.hook?.accounts.get(VALIDATION),
			squatted,
		);
		await assert.rejects(
			resolveHookAccounts(LEGS, marketHooks(read)),
			NO_LIST,
		);
	});

	it('throws for a missing mint account, and names it', async () => {
		const { rpc } = fakeRpc(new Map([[BASE_MINT, PLAIN_TOKEN_2022_MINT]]));
		await assert.rejects(
			fetchMintInfo(rpc, { baseMint: BASE_MINT, quoteMint: CLASSIC }),
			{ message: `fetchMintInfo: no account at ${CLASSIC}` },
		);
		await assert.rejects(
			fetchMintInfo(fakeRpc(new Map()).rpc, { mint: TKALSHI_MINT }),
			{ message: `fetchMintInfo: no account at ${TKALSHI_MINT}` },
		);
	});

	it('reads nothing for no mints', async () => {
		const { rpc, calls } = fakeRpc(new Map());
		assert.deepEqual(await fetchMintInfo(rpc, {}), {});
		assert.deepEqual(calls, []);
	});

	it('gives a map for a list of addresses, in list order, each mint read once', async () => {
		const { rpc, calls } = fakeRpc(
			new Map([
				[BASE_MINT, PLAIN_TOKEN_2022_MINT],
				[TKALSHI_MINT, PLAIN_TOKEN_2022_MINT],
			]),
		);
		const read = await fetchMintInfo(rpc, [
			TKALSHI_MINT,
			BASE_MINT,
			TKALSHI_MINT,
		]);
		assert.deepEqual(
			[...read],
			[
				[TKALSHI_MINT, infoOf(TKALSHI_MINT, TOKEN_2022_FIELDS, null)],
				[BASE_MINT, infoOf(BASE_MINT, TOKEN_2022_FIELDS, null)],
			],
		);
		assert.deepEqual(calls, [
			{
				method: 'getMultipleAccounts',
				params: [[TKALSHI_MINT, BASE_MINT, CLOCK], DEFAULT_CONFIG],
			},
		]);
	});

	it('reads nothing for an empty list', async () => {
		const { rpc, calls } = fakeRpc(new Map());
		assert.deepEqual(await fetchMintInfo(rpc, []), new Map());
		assert.deepEqual(calls, []);
	});

	it('throws for a clock that is short, or that the Sysvar program does not own', async () => {
		const { owner, data } = clockAccount(5n);
		for (const clock of [
			{ owner, data: data.subarray(0, 23) },
			{ owner: key(0), data },
		]) {
			const { rpc } = fakeRpc(
				new Map([
					[TKALSHI_MINT, PLAIN_TOKEN_2022_MINT],
					[CLOCK, clock],
				]),
			);
			await assert.rejects(fetchMintInfo(rpc, { mint: TKALSHI_MINT }), {
				message: 'fetchMintInfo: no clock',
			});
		}
	});

	it('reads a paused mint as any other mint', async () => {
		const { rpc } = fakeRpc(
			new Map([
				[
					TKALSHI_MINT,
					{ owner: TOKEN_2022_PROGRAM_ADDRESS, data: pausedMint() },
				],
			]),
		);
		assert.deepEqual(await fetchMintInfo(rpc, { mint: TKALSHI_MINT }), {
			mintInfo: infoOf(TKALSHI_MINT, TOKEN_2022_FIELDS, null),
		});
	});

	it('names the hook program of a hooked mint, and none for a hook-free one', async () => {
		const { rpc } = fakeRpc(
			new Map([
				[BASE_MINT, PLAIN_TOKEN_2022_MINT],
				[TKALSHI_MINT, PROBE_MINT],
				[VALIDATION, probeValidation()],
				[CLASSIC, CLASSIC_MINT],
				[UNSET_HOOK, UNSET_HOOK_MINT],
			]),
			SLOT,
		);
		const read = await fetchMintInfo(rpc, {
			hooked: TKALSHI_MINT,
			plain: BASE_MINT,
			classic: CLASSIC,
			unset: UNSET_HOOK,
		});
		assert.equal(read.hookedInfo.hookProgram, PROBE_PROGRAM);
		assert.equal(read.plainInfo.hookProgram, null);
		assert.equal(read.classicInfo.hookProgram, null);
		assert.equal(read.unsetInfo.hookProgram, null);
	});

	describe('the fee schedule, and the epoch of the clock', () => {
		const older = { epoch: 5n, maximumFee: 1_000n, basisPoints: 100 };
		const newer = { epoch: 7n, maximumFee: 900n, basisPoints: 250 };
		for (const epoch of [5n, 6n, 7n, 9n]) {
			it(`at epoch ${epoch}`, async () => {
				const { rpc, calls } = fakeRpc(
					new Map([
						[BASE_MINT, CLASSIC_MINT],
						[
							TKALSHI_MINT,
							{
								owner: TOKEN_2022_PROGRAM_ADDRESS,
								data: feeMint(older, newer),
							},
						],
					]),
					0,
					epoch,
				);
				assert.deepEqual(await fetchMintInfo(rpc, MARKET), {
					baseMintInfo: infoOf(BASE_MINT, CLASSIC_FIELDS, null),
					quoteMintInfo: infoOf(
						TKALSHI_MINT,
						{ ...TOKEN_2022_FIELDS, transferFee: schedule(epoch) },
						null,
					),
				});
				assert.deepEqual(calls, [
					{
						method: 'getMultipleAccounts',
						params: [
							[BASE_MINT, TKALSHI_MINT, CLOCK],
							DEFAULT_CONFIG,
						],
					},
				]);
			});
		}

		it('reads the epoch of the clock account', async () => {
			const { rpc } = fakeRpc(
				new Map([
					[
						TKALSHI_MINT,
						{
							owner: TOKEN_2022_PROGRAM_ADDRESS,
							data: feeMint(older, newer),
						},
					],
					[CLOCK, clockAccount(9n)],
				]),
			);
			const { mintInfo } = await fetchMintInfo(rpc, {
				mint: TKALSHI_MINT,
			});
			assert.deepEqual(mintInfo.transferFee, schedule(9n));
		});

		it('gives a schedule for a 0 bps config', async () => {
			const zero = { maximumFee: 0n, basisPoints: 0 };
			const { rpc } = fakeRpc(
				new Map([
					[
						TKALSHI_MINT,
						{
							owner: TOKEN_2022_PROGRAM_ADDRESS,
							data: feeMint(
								{ ...zero, epoch: 0n },
								{ ...zero, epoch: 0n },
							),
						},
					],
				]),
				0,
				3n,
			);
			const { mintInfo } = await fetchMintInfo(rpc, {
				mint: TKALSHI_MINT,
			});
			assert.deepEqual(mintInfo.transferFee, {
				authority: null,
				older: { bps: 0, maximumFee: 0n },
				newer: { bps: 0, maximumFee: 0n },
				newerEpoch: 0n,
				readEpoch: 3n,
			} satisfies FeeSchedule);
		});
	});
});

describe('appendHookAccounts', () => {
	const FIXED: AccountMeta = {
		address: BASE_MINT,
		role: AccountRole.WRITABLE,
	};
	const instruction: Instruction = Object.freeze({
		programAddress: SEND_LAUNCHPAD_PROGRAM_ADDRESS,
		accounts: [FIXED],
		data: new Uint8Array([1, 2, 3]),
	});

	it('returns the instruction itself for hook-free legs', async () => {
		assert.equal(
			await appendHookAccounts(
				instruction,
				LEGS,
				hookFreeState([TKALSHI_MINT, BASE_MINT]),
			),
			instruction,
		);
		const { rpc, calls } = fakeRpc(
			new Map([
				[TKALSHI_MINT, UNSET_HOOK_MINT],
				[BASE_MINT, CLASSIC_MINT],
			]),
		);
		const read = await fetchMintInfo(rpc, MARKET);
		assert.equal(
			await appendHookAccounts(instruction, LEGS, marketHooks(read)),
			instruction,
		);
		assert.equal(calls.length, 1);
		assert.equal(
			await appendHookAccounts(
				instruction,
				{ legs: [], written: [] },
				hookFreeState([]),
			),
			instruction,
		);
	});

	it('appends after every fixed account and keeps the rest', async () => {
		const appended = await appendHookAccounts(
			instruction,
			LEGS,
			await probeState([TKALSHI_MINT], [BASE_MINT]),
		);
		assert.deepEqual(appended, {
			programAddress: SEND_LAUNCHPAD_PROGRAM_ADDRESS,
			accounts: [FIXED, ...(await probeAccounts(QUOTE_LEG))],
			data: new Uint8Array([1, 2, 3]),
		});
		assert.equal(appended.data, instruction.data);
		assert.equal(Object.isFrozen(appended), true);
		assert.deepEqual(instruction.accounts, [FIXED]);
	});

	it('gives an instruction without accounts the hook accounts alone', async () => {
		const appended = await appendHookAccounts(
			{ programAddress: SEND_LAUNCHPAD_PROGRAM_ADDRESS },
			LEGS,
			await probeState([TKALSHI_MINT], [BASE_MINT]),
		);
		assert.deepEqual(appended.accounts, await probeAccounts(QUOTE_LEG));
	});

	it('resolves from what fetchMintInfo read, and reads nothing itself', async () => {
		const { rpc, calls } = fakeRpc(
			new Map([
				[TKALSHI_MINT, PROBE_MINT],
				[BASE_MINT, CLASSIC_MINT],
				[VALIDATION, probeValidation()],
			]),
			SLOT,
		);
		const read = await fetchMintInfo(rpc, {
			quoteMint: TKALSHI_MINT,
			baseMint: BASE_MINT,
		});
		const appended = await appendHookAccounts(
			instruction,
			LEGS,
			marketHooks(read),
		);
		assert.deepEqual(appended.accounts, [
			FIXED,
			...(await probeAccounts(QUOTE_LEG)),
		]);
		const config = DEFAULT_CONFIG;
		assert.deepEqual(calls, [
			{
				method: 'getMultipleAccounts',
				params: [[TKALSHI_MINT, BASE_MINT, CLOCK], config],
			},
			{
				method: 'getMultipleAccounts',
				params: [
					[VALIDATION],
					{ ...config, minContextSlot: BigInt(SLOT) },
				],
			},
		]);
	});

	it('rejects a state that lacks an account with NotLoaded, naming what to fetch', async () => {
		await assert.rejects(
			appendHookAccounts(instruction, LEGS, stateOf([])),
			notLoaded([TKALSHI_MINT, BASE_MINT]),
		);
		await assert.rejects(
			appendHookAccounts(
				instruction,
				LEGS,
				stateOf([
					[TKALSHI_MINT, PROBE_MINT],
					[BASE_MINT, CLASSIC_MINT],
				]),
			),
			notLoaded([VALIDATION]),
		);
		await assert.rejects(
			appendHookAccounts(
				instruction,
				LEGS,
				stateOf([
					[TKALSHI_MINT, PROBE_MINT],
					[BASE_MINT, CLASSIC_MINT],
					[VALIDATION, probeValidation(chainedList())],
					[AUX, AUX_ACCOUNT],
				]),
			),
			notLoaded([CHAINED]),
		);
	});
});

const CONFIG_SEED = new TextEncoder().encode('config');
const CONFIG_DATA = Uint8Array.from([1, 2, 3, 4, 5]);

/** A list whose first extra is `account`, at a fixed key, and whose second reads its data. */
function readsDataOf(account: Address): Uint8Array {
	return list([fixed(account), pda([accountData(5, 0, 4)])]);
}

/** A list whose first extra is `config`, a PDA of literal seeds, and whose second reads its data. */
function configList(): Uint8Array {
	return list([pda([literal('config')]), pda([accountData(5, 0, 4)])]);
}

const MINTS = [BASE_MINT, TKALSHI_MINT];

/** The mints of `LEGS` and `more`. The quote mint runs the probe over
 *  `data`. */
function listState(
	data: Uint8Array,
	more: readonly (readonly [Address, AccountView | null])[] = [],
): HookState {
	return stateOf([
		[BASE_MINT, PLAIN_TOKEN_2022_MINT],
		...quoteHook(data, more).accounts,
	]);
}

describe('fetchMintInfo reads every account a list reads at a fixed address', () => {
	it('reads the mints, the list, then a config account a later extra reads, and the infos resolve with no read', async () => {
		const config = await probePda(CONFIG_SEED);
		const more = [
			[config, { owner: PROBE_PROGRAM, data: CONFIG_DATA }],
		] as const;
		const { rpc, calls } = rpcOver(listState(configList(), more), SLOT);
		const read = await fetchMintInfo(rpc, MARKET);
		assert.equal(read.baseMintInfo.hook, null);
		assert.deepEqual(
			read.quoteMintInfo.hook,
			quoteHook(configList(), more),
		);
		const fill = [
			{
				method: 'getMultipleAccounts',
				params: [[BASE_MINT, TKALSHI_MINT, CLOCK], DEFAULT_CONFIG],
			},
			{ method: 'getMultipleAccounts', params: [[VALIDATION], AT_SLOT] },
			{ method: 'getMultipleAccounts', params: [[config], AT_SLOT] },
		];
		assert.deepEqual(calls, fill);
		assert.deepEqual(await resolveHookAccounts(LEGS, marketHooks(read)), [
			{ address: config, role: AccountRole.READONLY },
			{
				address: await probePda(CONFIG_DATA.subarray(0, 4)),
				role: AccountRole.READONLY,
			},
			...PROBE_TAIL,
		]);
		assert.deepEqual(calls, fill);
	});

	it('follows a chain of fixed reads, one round each', async () => {
		const more = [
			[AUX, AUX_ACCOUNT],
			[CHAINED, CHAINED_ACCOUNT],
		] as const;
		const { rpc, calls } = rpcOver(listState(chainedList(), more), SLOT);
		const read = await fetchMintInfo(rpc, MARKET);
		assert.deepEqual(
			read.quoteMintInfo.hook,
			quoteHook(chainedList(), more),
		);
		assert.deepEqual(calls, [
			{
				method: 'getMultipleAccounts',
				params: [[BASE_MINT, TKALSHI_MINT, CLOCK], DEFAULT_CONFIG],
			},
			{ method: 'getMultipleAccounts', params: [[VALIDATION], AT_SLOT] },
			{ method: 'getMultipleAccounts', params: [[AUX], AT_SLOT] },
			{ method: 'getMultipleAccounts', params: [[CHAINED], AT_SLOT] },
		]);
		assert.deepEqual(await resolveHookAccounts(LEGS, marketHooks(read)), [
			{ address: AUX, role: AccountRole.READONLY },
			{ address: CHAINED, role: AccountRole.READONLY },
			{
				address: await probePda(new Uint8Array([1, 2, 3, 4])),
				role: AccountRole.READONLY,
			},
			...PROBE_TAIL,
		]);
	});

	it('reads nothing the trade sets: a resolution names it as NotLoaded', async () => {
		const sourceList = list([
			pda([accountKey(0)]),
			pda([accountData(5, 0, 4)]),
		]);
		const { rpc, calls } = rpcOver(listState(sourceList), SLOT);
		const read = await fetchMintInfo(rpc, MARKET);
		assert.deepEqual(read.quoteMintInfo.hook, quoteHook(sourceList));
		assert.equal(calls.length, 2);
		await assert.rejects(
			resolveHookAccounts(LEGS, marketHooks(read)),
			notLoaded([
				await probePda(addressEncoder.encode(QUOTE_LEG.source)),
			]),
		);
	});

	it('keeps a list no resolver can resolve, which a resolution refuses', async () => {
		const malformed = new Uint8Array(20).fill(9);
		const { rpc, calls } = rpcOver(listState(malformed), SLOT);
		const read = await fetchMintInfo(rpc, MARKET);
		assert.deepEqual(read.quoteMintInfo.hook, quoteHook(malformed));
		assert.equal(calls.length, 2);
		await assert.rejects(resolveHookAccounts(LEGS, marketHooks(read)), {
			name: 'TransferHookError',
			error: 'Unresolvable(MalformedList)',
		});
	});

	it('throws for a mint that does not decode, after the first read', async () => {
		const { rpc, calls } = fakeRpc(
			new Map([
				[BASE_MINT, PLAIN_TOKEN_2022_MINT],
				[
					TKALSHI_MINT,
					{
						owner: TOKEN_2022_PROGRAM_ADDRESS,
						data: truncatedMint(),
					},
				],
			]),
		);
		await assert.rejects(fetchMintInfo(rpc, MARKET), {
			name: 'RangeError',
			message:
				'decodeMintState: a Token-2022 mint holds 100 bytes, expected 82 or at least 166',
		});
		assert.equal(calls.length, 1);
	});

	it('throws for a mint no token program owns, or an SPL Token mint SPL Token does not write', async () => {
		const uninitialized = baseMint(SPL_DECIMALS);
		uninitialized[IS_INITIALIZED] = 0;
		for (const [account, message] of [
			[
				{ owner: PROBE_PROGRAM, data: baseMint(SPL_DECIMALS) },
				`decodeMintState: ${PROBE_PROGRAM} is not a token program`,
			],
			[
				{ owner: TOKEN_PROGRAM_ADDRESS, data: new Uint8Array(81) },
				'decodeMintState: an SPL Token mint holds 81 bytes, expected 82',
			],
			[
				{ owner: TOKEN_PROGRAM_ADDRESS, data: uninitialized },
				'decodeMintState: the mint is not initialized',
			],
		] as const) {
			const { rpc, calls } = fakeRpc(
				new Map([
					[BASE_MINT, PLAIN_TOKEN_2022_MINT],
					[TKALSHI_MINT, account],
				]),
			);
			await assert.rejects(fetchMintInfo(rpc, MARKET), {
				name: 'RangeError',
				message,
			});
			assert.equal(calls.length, 1);
		}
	});

	it('reads one mint, its list, then an account at a fixed key', async () => {
		const chain = stateOf([
			[TKALSHI_MINT, PROBE_MINT],
			[VALIDATION, probeValidation(readsDataOf(AUX))],
			[AUX, AUX_ACCOUNT],
		]);
		const { rpc, calls } = rpcOver(chain, SLOT);
		const { mintInfo } = await fetchMintInfo(rpc, { mint: TKALSHI_MINT });
		assert.deepEqual(mintInfo.hook, chain);
		assert.deepEqual(calls, [
			{
				method: 'getMultipleAccounts',
				params: [[TKALSHI_MINT, CLOCK], DEFAULT_CONFIG],
			},
			{ method: 'getMultipleAccounts', params: [[VALIDATION], AT_SLOT] },
			{ method: 'getMultipleAccounts', params: [[AUX], AT_SLOT] },
		]);
	});
});

/** Both mints run the probe, the base list over `readsDataOf(base)`, the quote list over
 *  `readsDataOf(quote)`. */
function bothReading(base: Address, quote: Address): HookState {
	return stateOf([
		[BASE_MINT, PROBE_MINT],
		[TKALSHI_MINT, PROBE_MINT],
		[BASE_VALIDATION, probeValidation(readsDataOf(base))],
		[VALIDATION, probeValidation(readsDataOf(quote))],
	]);
}

describe('missingHookAccounts', () => {
	it('names the mints an empty state lacks, each once', async () => {
		assert.deepEqual(
			await missingHookAccounts(stateOf([]), [
				BASE_MINT,
				TKALSHI_MINT,
				BASE_MINT,
			]),
			MINTS,
		);
		assert.deepEqual(
			await missingHookAccounts(
				stateOf([[BASE_MINT, CLASSIC_MINT]]),
				MINTS,
			),
			[TKALSHI_MINT],
		);
		assert.deepEqual(await missingHookAccounts(stateOf([]), []), []);
	});

	it('names the list of each hooked mint once the mints are read', async () => {
		assert.deepEqual(
			await missingHookAccounts(
				stateOf([
					[BASE_MINT, PROBE_MINT],
					[TKALSHI_MINT, PROBE_MINT],
				]),
				MINTS,
			),
			[BASE_VALIDATION, VALIDATION],
		);
		assert.deepEqual(
			await missingHookAccounts(
				stateOf([
					[BASE_MINT, CLASSIC_MINT],
					[TKALSHI_MINT, PROBE_MINT],
				]),
				MINTS,
			),
			[VALIDATION],
		);
		// No hook, or an unset one: the snapshot is complete.
		assert.deepEqual(
			await missingHookAccounts(
				stateOf([
					[BASE_MINT, CLASSIC_MINT],
					[TKALSHI_MINT, UNSET_HOOK_MINT],
				]),
				MINTS,
			),
			[],
		);
	});

	it('names nothing more for a list that reads only what the trade sets', async () => {
		assert.deepEqual(
			await missingHookAccounts(listState(probeList()), MINTS),
			[],
		);
	});

	it('names an account at a fixed key whose data an extra reads, then nothing', async () => {
		const fixedRead = readsDataOf(AUX);
		assert.deepEqual(
			await missingHookAccounts(listState(fixedRead), MINTS),
			[AUX],
		);
		assert.deepEqual(
			await missingHookAccounts(
				listState(fixedRead, [[AUX, AUX_ACCOUNT]]),
				MINTS,
			),
			[],
		);
		// A missing account has no data. It names nothing more.
		assert.deepEqual(
			await missingHookAccounts(
				listState(fixedRead, [[AUX, null]]),
				MINTS,
			),
			[],
		);
		// No extra reads the data of `AUX` here, so it needs no read.
		assert.deepEqual(
			await missingHookAccounts(listState(list([fixed(AUX)])), MINTS),
			[],
		);
	});

	it('names a PDA of literal seeds, the discriminator, the mint and the validation account', async () => {
		const seeded = list([
			pda([
				literal('config'),
				instructionData(0, 8),
				accountKey(1),
				accountKey(4),
			]),
			pda([accountData(5, 0, 4)]),
		]);
		assert.deepEqual(await missingHookAccounts(listState(seeded), MINTS), [
			await probePda(
				CONFIG_SEED,
				EXECUTE_DISCRIMINATOR,
				addressEncoder.encode(TKALSHI_MINT),
				addressEncoder.encode(VALIDATION),
			),
		]);
		assert.deepEqual(
			await missingHookAccounts(listState(configList()), MINTS),
			[await probePda(CONFIG_SEED)],
		);
	});

	it('follows a chain of fixed reads, one round at a time', async () => {
		assert.deepEqual(
			await missingHookAccounts(listState(chainedList()), MINTS),
			[AUX],
		);
		assert.deepEqual(
			await missingHookAccounts(
				listState(chainedList(), [[AUX, AUX_ACCOUNT]]),
				MINTS,
			),
			[CHAINED],
		);
		assert.deepEqual(
			await missingHookAccounts(
				listState(chainedList(), [
					[AUX, AUX_ACCOUNT],
					[CHAINED, CHAINED_ACCOUNT],
				]),
				MINTS,
			),
			[],
		);
	});

	it('names what the lists of both mints read at once, each address once', async () => {
		assert.deepEqual(
			await missingHookAccounts(bothReading(AUX, CHAINED), MINTS),
			[AUX, CHAINED],
		);
		assert.deepEqual(
			await missingHookAccounts(bothReading(AUX, AUX), MINTS),
			[AUX],
		);
	});

	it('reads the mint and the list from the state, with no fetch', async () => {
		assert.deepEqual(
			await missingHookAccounts(
				listState(
					list([
						pda([accountData(1, 170, 32)]),
						pda([accountData(4, 0, 8)]),
					]),
				),
				MINTS,
			),
			[],
		);
	});

	describe('never names an account the trade sets', () => {
		for (const [name, extras] of [
			[
				'a PDA of the source',
				[pda([accountKey(0)]), pda([accountData(5, 0, 4)])],
			],
			[
				'a PDA of the destination',
				[pda([accountKey(2)]), pda([accountData(5, 0, 4)])],
			],
			[
				'a PDA of the authority',
				[pda([accountKey(3)]), pda([accountData(5, 0, 4)])],
			],
			[
				'a PDA of the amount',
				[pda([instructionData(8, 8)]), pda([accountData(5, 0, 4)])],
			],
			[
				'a PDA of the whole Execute data, the amount included',
				[
					pda([literal('config'), instructionData(0, 16)]),
					pda([accountData(5, 0, 4)]),
				],
			],
			[
				'a key read from the authority’s data',
				[pubkeyData(3, 0), pda([accountData(5, 0, 4)])],
			],
			[
				'a PDA of an extra the trade sets',
				[
					pda([accountKey(0)]),
					pda([accountKey(5)]),
					pda([accountData(6, 0, 4)]),
				],
			],
			['the source’s data', [pda([accountData(0, 0, 32)])]],
			['the authority’s data', [pda([accountData(3, 0, 8)])]],
		] as const) {
			it(name, async () => {
				assert.deepEqual(
					await missingHookAccounts(listState(list(extras)), MINTS),
					[],
				);
			});
		}
	});

	it('refuses a mint that does not decode with MalformedMint', async () => {
		for (const mint of [
			{ owner: TOKEN_2022_PROGRAM_ADDRESS, data: truncatedMint() },
			{ owner: PROBE_PROGRAM, data: baseMint(0) },
			{ owner: TOKEN_PROGRAM_ADDRESS, data: new Uint8Array(82) },
		]) {
			await assert.rejects(
				missingHookAccounts(
					stateOf([
						[BASE_MINT, CLASSIC_MINT],
						[TKALSHI_MINT, mint],
					]),
					MINTS,
				),
				{
					name: 'TransferHookError',
					error: 'MalformedMint',
					message: "a transfer's mint does not decode as a mint",
					addresses: [],
				},
			);
		}
	});

	it('names nothing for a missing mint: it runs no hook', async () => {
		assert.deepEqual(
			await missingHookAccounts(
				stateOf([
					[BASE_MINT, CLASSIC_MINT],
					[TKALSHI_MINT, null],
				]),
				MINTS,
			),
			[],
		);
	});

	it('names nothing more for a missing list, a squatted one, or one no resolver can resolve', async () => {
		const reads = readsDataOf(AUX);
		for (const validation of [
			null,
			{ owner: TOKEN_2022_PROGRAM_ADDRESS, data: reads },
			probeValidation(new Uint8Array(20).fill(9)),
			// It reads an account at its own index.
			probeValidation(list([fixed(AUX), pda([accountData(6, 0, 4)])])),
		]) {
			assert.deepEqual(
				await missingHookAccounts(
					stateOf([
						[BASE_MINT, CLASSIC_MINT],
						[TKALSHI_MINT, PROBE_MINT],
						[VALIDATION, validation],
					]),
					MINTS,
				),
				[],
			);
		}
	});
});
