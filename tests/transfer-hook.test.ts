import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import {
	getAddressEncoder,
	getProgramDerivedAddress,
	type AccountMeta,
	type Address,
	type ReadonlyUint8Array,
} from '@solana/kit';
import { getMintDecoder } from '@solana-program/token-2022';
import {
	TOKEN_2022_PROGRAM_ADDRESS,
	TOKEN_PROGRAM_ADDRESS,
} from '../src/constants.js';
import {
	EXECUTE_DISCRIMINATOR,
	TransferHookError,
	VALIDATION_SEED,
	checkHook,
	decodeMintState,
	describeHookError,
	findValidationAddress,
	hookAccounts,
	loadHook,
	resolveHookAccounts,
	resolveHookStep,
	type AccountLookup,
	type AccountView,
	type Hook,
	type HookError,
	type HookLeg,
	type HookLegs,
	type HookResolution,
	type MintState,
	type Unresolvable,
} from '../src/transfer-hook/resolver.js';
import { decodeFeeSchedule } from '../src/transfer-fee.js';
import { feeScheduleOf } from '../src/utils/mint-extensions.js';
import {
	accountData,
	accountKey,
	externalPda,
	fixed,
	instructionData,
	LIST_HEADER,
	list,
	literal,
	META_LENGTH,
	pda,
	pubkeyData,
	raw,
	u32,
	type SeedBytes,
} from './support/extra-metas.js';
import {
	HOOK_FREE_MINT,
	PROBE_PROGRAM,
	hookedMintData,
	hookFreeState,
	probeAccounts,
	probeState,
} from './support/probe-hook.js';
import {
	DESTINATION,
	HOOK_ACCOUNTS,
	HOOK_PROGRAM,
	MARKET,
	METADATA,
	MINT,
	POINTER,
	PROGRAM,
	RENT,
	SOURCE,
	TOKEN_2022_DECIMALS,
	USER,
	USER_LEG,
	VALIDATION,
	VAULT_LEG,
	concat,
	hookExtension,
	hookPda,
	key,
	programsTestAccounts,
	programsTestList,
	readonlyMeta,
	token2022Mint,
	writableMeta,
} from './support/resolver-fixtures.js';

const addressEncoder = getAddressEncoder();

const OTHER_MINT = key(8);

// The decimals of `splMint`.
const SPL_DECIMALS = 9;

/** A hook PDA whose last seed, `seed`, is one byte short at the end of the config. A literal
 *  fills the bytes before it. */
function cutOff(seed: SeedBytes): Uint8Array {
	const start = 32 - (seed.length - 1);
	const filler = new Uint8Array(start - 2).fill(7);
	return pda([[1, filler.length, ...filler], seed.slice(0, -1)]);
}

function mintState(hookProgram: Address | null): MintState {
	return {
		tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
		decimals: TOKEN_2022_DECIMALS,
		transferFee: null,
		hookProgram,
	};
}

function lookupOf(
	accounts: ReadonlyMap<Address, AccountView | null>,
): AccountLookup {
	return (address) => accounts.get(address);
}

/** A lookup that has fetched nothing. */
const NOTHING_FETCHED: AccountLookup = () => undefined;

/** The hook of `MINT` under `PROGRAM`, its list loaded from a validation account that holds
 *  `data`. */
async function loaded(data: Uint8Array): Promise<Hook> {
	const hook = await loadHook(
		MINT,
		mintState(PROGRAM),
		lookupOf(new Map([[VALIDATION, { owner: PROGRAM, data }]])),
	);
	assert.ok(hook);
	return hook;
}

/** The hook of `MINT` with `data` as its list, as is: `loadHook` copies the bytes. */
function listHook(data: ReadonlyUint8Array): Hook {
	return {
		mint: MINT,
		program: PROGRAM,
		validation: VALIDATION,
		list: { kind: 'Loaded', data },
	};
}

function legsOf(...legs: readonly HookLeg[]): HookLegs {
	return { legs, written: [] };
}

function accountsIn(resolution: HookResolution): AccountMeta[] {
	if (resolution.kind === 'Fetch') {
		assert.fail(
			`expected accounts, got a fetch of ${resolution.addresses.join(', ')}`,
		);
	}
	return resolution.accounts;
}

/** `hookAccounts` of `hook` on `leg` alone. */
async function resolveOne(
	hook: Hook,
	leg: HookLeg,
	lookup: AccountLookup = NOTHING_FETCHED,
): Promise<AccountMeta[]> {
	return accountsIn(await hookAccounts([hook], legsOf(leg), lookup));
}

function hookError(
	error: HookError,
	message: string,
	addresses: readonly Address[] = [],
) {
	return { name: 'TransferHookError', error, message, addresses };
}

function notLoaded(addresses: readonly Address[]) {
	return hookError(
		'NotLoaded',
		`transfer hook accounts not loaded: fetch ${addresses.join(', ')}`,
		addresses,
	);
}

const NO_LIST = hookError(
	'NoList',
	'transfer hook has no ExtraAccountMetaList',
);

const REASONS: Readonly<Record<Unresolvable, string>> = {
	MalformedList: 'malformed list',
	NoExecuteEntry: 'no Execute entry in the list',
	ListTooLong: 'list too long',
	MalformedExtra: 'malformed extra',
	MalformedSeed: 'malformed seed',
	TooManySeeds: 'a PDA has more seeds than an address allows',
	SeedTooLong: 'seed longer than 32 bytes',
	ExtraUnresolved: 'an extra does not resolve',
	ReadsTransferAmount: 'a seed reads the transfer amount',
	ReadsPastInstructionData:
		"an extra reads past the end of the hook's instruction data",
	NamesUnresolvedAccount: 'an extra names an account not yet resolved',
	ReadsSwapTimeData:
		'an extra reads account data the instruction changes first',
};

function isReason(value: string): value is Unresolvable {
	return Object.hasOwn(REASONS, value);
}

function refusal(reason: Unresolvable) {
	return hookError(
		`Unresolvable(${reason})`,
		`transfer hook cannot be resolved ahead of the instruction: ${REASONS[reason]}`,
	);
}

const UNRESOLVED = refusal('ExtraUnresolved');
const SWAP_TIME = refusal('ReadsSwapTimeData');

/** A transfer of `OTHER_MINT` between accounts no other leg touches. */
const OTHER_LEG: HookLeg = {
	source: key(30),
	mint: OTHER_MINT,
	destination: key(31),
	authority: key(32),
	destinationOwner: key(33),
};

/** Resolves `data` for each of `legs`. transfer-hook-oracle.test.ts resolves each case with
 *  `@solana-program/token-2022` to the same accounts. `served` holds the accounts the list reads
 *  that no leg moves. */
async function assertResolves(
	data: Uint8Array,
	expected: (leg: HookLeg) => Promise<readonly AccountMeta[]>,
	served: ReadonlyMap<Address, AccountView> = new Map(),
	legs: readonly HookLeg[] = [USER_LEG, VAULT_LEG],
): Promise<void> {
	const hook = await loaded(data);
	for (const leg of legs) {
		assert.deepEqual(
			await resolveOne(hook, leg, lookupOf(served)),
			await expected(leg),
		);
	}
}

describe('findValidationAddress', () => {
	it('derives ["extra-account-metas", mint] under the hook program', async () => {
		assert.equal(
			VALIDATION,
			await hookPda('extra-account-metas', addressEncoder.encode(MINT)),
		);
	});

	it('derives with VALIDATION_SEED', async () => {
		const [expected] = await getProgramDerivedAddress({
			programAddress: PROGRAM,
			seeds: [VALIDATION_SEED, addressEncoder.encode(MINT)],
		});
		assert.equal(await findValidationAddress(MINT, PROGRAM), expected);
	});
});

describe('loadHook', () => {
	it('is null for a mint that runs no hook, and reads nothing', async () => {
		assert.equal(
			await loadHook(MINT, mintState(null), () =>
				assert.fail('read an account'),
			),
			null,
		);
	});

	it('reads the list at the validation address alone', async () => {
		const data = list([fixed(RENT)]);
		const asked: Address[] = [];
		const hook = await loadHook(MINT, mintState(PROGRAM), (address) => {
			asked.push(address);
			return { owner: PROGRAM, data };
		});
		assert.deepEqual(asked, [VALIDATION]);
		assert.deepEqual(hook, {
			mint: MINT,
			program: PROGRAM,
			validation: VALIDATION,
			list: { kind: 'Loaded', data },
		});
	});

	it('leaves a list not fetched NotFetched, and a missing one Missing', async () => {
		for (const [lookup, kind] of [
			[NOTHING_FETCHED, 'NotFetched'],
			[() => null, 'Missing'],
		] as const) {
			assert.deepEqual(await loadHook(MINT, mintState(PROGRAM), lookup), {
				mint: MINT,
				program: PROGRAM,
				validation: VALIDATION,
				list: { kind },
			});
		}
	});

	it('reads a list the hook program does not own as missing', async () => {
		const squatted = await loadHook(MINT, mintState(PROGRAM), () => ({
			owner: key(0),
			data: list([fixed(RENT)]),
		}));
		assert.deepEqual(squatted?.list, { kind: 'Missing' });
		assert.ok(squatted);
		await assert.rejects(resolveOne(squatted, USER_LEG), NO_LIST);
	});

	it('keeps a copy of the list bytes', async () => {
		const data = list([fixed(RENT)]);
		const hook = await loaded(data);
		data.fill(0);
		assert.deepEqual(hook.list, {
			kind: 'Loaded',
			data: list([fixed(RENT)]),
		});
		assert.deepEqual(await resolveOne(hook, USER_LEG), [
			readonlyMeta(RENT),
			...HOOK_ACCOUNTS,
		]);
	});
});

describe('hookAccounts', () => {
	it('resolves a literal extra', async () => {
		await assertResolves(list([fixed(RENT)]), () =>
			Promise.resolve([readonlyMeta(RENT), ...HOOK_ACCOUNTS]),
		);
	});

	it('resolves a hook-program PDA from Literal, AccountKey and InstructionData seeds', async () => {
		await assertResolves(
			list([
				pda(
					[
						literal('ledger'),
						accountKey(0),
						accountKey(3),
						instructionData(0, 8),
						instructionData(2, 3),
					],
					true,
				),
			]),
			async (leg) => [
				writableMeta(
					await hookPda(
						'ledger',
						addressEncoder.encode(leg.source),
						addressEncoder.encode(leg.authority),
						new Uint8Array(EXECUTE_DISCRIMINATOR),
						new Uint8Array([101, 197, 75]),
					),
				),
				...HOOK_ACCOUNTS,
			],
		);
	});

	it('reads the mint and owner of the source and of the destination', async () => {
		await assertResolves(
			list([
				pda([
					literal('source'),
					accountData(0, 0, 32),
					accountData(0, 32, 32),
				]),
				pda([accountData(2, 32, 32)]),
				pda([accountData(2, 0, 32), accountData(0, 60, 4)]),
			]),
			async (leg) => {
				const mint = addressEncoder.encode(leg.mint);
				const owner = addressEncoder.encode(leg.authority);
				return [
					readonlyMeta(await hookPda('source', mint, owner)),
					readonlyMeta(
						await hookPda(
							addressEncoder.encode(leg.destinationOwner),
						),
					),
					readonlyMeta(await hookPda(mint, owner.subarray(28, 32))),
					...HOOK_ACCOUNTS,
				];
			},
		);
	});

	it('resolves the programs test hook on both legs', async () => {
		await assertResolves(programsTestList(), programsTestAccounts);
	});

	it('resolves an external-program PDA from a prior extra', async () => {
		await assertResolves(
			list([
				pda([accountKey(2)]),
				externalPda(5, [accountData(2, 32, 32), instructionData(0, 8)]),
				pda([accountData(4, 0, 8)]),
			]),
			async (leg) => {
				const first = await hookPda(
					addressEncoder.encode(leg.destination),
				);
				const [external] = await getProgramDerivedAddress({
					programAddress: first,
					seeds: [
						addressEncoder.encode(leg.destinationOwner),
						new Uint8Array(EXECUTE_DISCRIMINATOR),
					],
				});
				return [
					readonlyMeta(first),
					readonlyMeta(external),
					// The first 8 bytes of the list: its `Execute` type.
					readonlyMeta(
						await hookPda(new Uint8Array(EXECUTE_DISCRIMINATOR)),
					),
					...HOOK_ACCOUNTS,
				];
			},
		);
	});

	it('resolves PubkeyData from a token account prefix and from the list', async () => {
		// The address config of the first meta starts at byte 17 of the list.
		const stored = key(30);
		const data = list([
			fixed(stored),
			pubkeyData(0, 32),
			pubkeyData(2, 0),
			pubkeyData(4, 17),
		]);
		const hook = await loaded(data);
		for (const leg of [USER_LEG, VAULT_LEG]) {
			// The resolver merges the repeat of `stored` into its first place.
			assert.deepEqual(await resolveOne(hook, leg), [
				readonlyMeta(stored),
				readonlyMeta(leg.authority),
				readonlyMeta(leg.mint),
				...HOOK_ACCOUNTS,
			]);
		}
	});

	it('resolves prior extras, data and external programs', async () => {
		const hook = await loaded(
			list([
				pda([accountKey(2)]),
				externalPda(5, [accountData(2, 32, 32), instructionData(0, 8)]),
				pubkeyData(2, 0),
				pda([accountData(4, 0, 8)]),
			]),
		);
		const first = await hookPda(addressEncoder.encode(DESTINATION));
		const [external] = await getProgramDerivedAddress({
			programAddress: first,
			seeds: [
				addressEncoder.encode(MARKET),
				new Uint8Array(EXECUTE_DISCRIMINATOR),
			],
		});
		assert.deepEqual(await resolveOne(hook, USER_LEG), [
			readonlyMeta(first),
			readonlyMeta(external),
			readonlyMeta(MINT),
			readonlyMeta(await hookPda(new Uint8Array(EXECUTE_DISCRIMINATOR))),
			...HOOK_ACCOUNTS,
		]);
	});

	it('resolves 15 seeds, the most an address takes with its bump', async () => {
		const hook = await loaded(
			list([pda(Array.from({ length: 15 }, () => accountKey(0)))]),
		);
		const source = addressEncoder.encode(SOURCE);
		assert.deepEqual(await resolveOne(hook, USER_LEG), [
			readonlyMeta(
				await hookPda(
					...Array.from({ length: 15 }, () => new Uint8Array(source)),
				),
			),
			...HOOK_ACCOUNTS,
		]);
	});

	it('finds the Execute entry among others', async () => {
		const hook = await loaded(
			concat(
				new Uint8Array(8).fill(1),
				u32(3),
				[0, 0, 0],
				list([fixed(RENT, true)]),
				new Uint8Array(40),
			),
		);
		assert.deepEqual(await resolveOne(hook, USER_LEG), [
			writableMeta(RENT),
			...HOOK_ACCOUNTS,
		]);
	});

	it('screens the list on every resolution', async () => {
		const source = addressEncoder.encode(SOURCE);
		const cases: readonly (readonly [Uint8Array, Unresolvable])[] = [
			[new Uint8Array(), 'MalformedList'],
			[
				list(Array.from({ length: 252 }, () => fixed(RENT))),
				'ListTooLong',
			],
			[list([pda([accountKey(9)])]), 'NamesUnresolvedAccount'],
			[list([externalPda(9, [])]), 'NamesUnresolvedAccount'],
			// Bytes 40 to 72 of the source: past its mint and owner.
			[list([pubkeyData(0, 40)]), 'ReadsSwapTimeData'],
			[list([raw(2, [1, 0])]), 'ReadsPastInstructionData'],
			[list([raw(3, source)]), 'MalformedExtra'],
			[list([raw(1, [9])]), 'MalformedSeed'],
			[
				list([pda(Array.from({ length: 16 }, () => accountKey(0)))]),
				'TooManySeeds',
			],
		];
		for (const [data, reason] of cases) {
			await assert.rejects(
				resolveOne(listHook(data), USER_LEG),
				refusal(reason),
			);
		}
		// A list that passes resolves as loaded.
		assert.deepEqual(
			await resolveOne(listHook(programsTestList()), USER_LEG),
			await programsTestAccounts(USER_LEG),
		);
	});

	it('refuses a list not fetched as NotLoaded, naming its validation account', async () => {
		const unfetched = await loadHook(
			MINT,
			mintState(PROGRAM),
			NOTHING_FETCHED,
		);
		assert.ok(unfetched);
		await assert.rejects(
			resolveOne(unfetched, USER_LEG),
			notLoaded([VALIDATION]),
		);
		assert.throws(() => checkHook(unfetched), notLoaded([VALIDATION]));
	});

	it('refuses a missing or unsupported list', async () => {
		const missing: Hook = {
			...listHook(new Uint8Array()),
			list: { kind: 'Missing' },
		};
		await assert.rejects(resolveOne(missing, USER_LEG), NO_LIST);
		assert.throws(() => checkHook(missing), NO_LIST);
		const unsupported = await loaded(list([pda([accountKey(9)])]));
		await assert.rejects(
			resolveOne(unsupported, USER_LEG),
			refusal('NamesUnresolvedAccount'),
		);
	});

	it('refuses a list read past its end as ExtraUnresolved', async () => {
		// The screen admits a read of the list at any offset. Past its end, it
		// fails here, as on-chain.
		for (const extra of [
			pda([accountData(4, 200, 8)]),
			pubkeyData(4, 20),
		]) {
			const hook = await loaded(list([extra]));
			checkHook(hook);
			await assert.rejects(resolveOne(hook, USER_LEG), UNRESOLVED);
		}
		// The last 8 bytes of a one-meta list resolve.
		const data = list([pda([accountData(4, 43, 8)])]);
		assert.deepEqual(await resolveOne(await loaded(data), USER_LEG), [
			readonlyMeta(await hookPda(data.subarray(43))),
			...HOOK_ACCOUNTS,
		]);
	});

	it('refuses seeds no address takes as ExtraUnresolved', async (t) => {
		const hook = await loaded(list([pda([accountKey(0)])]));
		// Every hash is the ed25519 base point, on the curve: no bump works.
		const basePoint = new Uint8Array(32).fill(0x66);
		basePoint[0] = 0x58;
		mockDigest(t, () => Promise.resolve(basePoint.buffer));
		await assert.rejects(resolveOne(hook, USER_LEG), UNRESOLVED);
	});

	it('passes on an error that is not a PDA derivation failure', async (t) => {
		const hook = await loaded(list([pda([accountKey(0)])]));
		mockDigest(t, () => Promise.reject(new Error('digest unavailable')));
		await assert.rejects(resolveOne(hook, USER_LEG), {
			name: 'Error',
			message: 'digest unavailable',
		});
	});

	it('adds nothing for a leg whose mint has no hook among hooks', async () => {
		const hook = await loaded(programsTestList());
		for (const [hooks, legs] of [
			[[hook], legsOf({ ...USER_LEG, mint: OTHER_MINT })],
			[[], legsOf(USER_LEG)],
			[[hook], legsOf()],
		] as const) {
			assert.deepEqual(await hookAccounts(hooks, legs, NOTHING_FETCHED), {
				kind: 'Accounts',
				accounts: [],
			});
		}
	});
});

// Mocks the digest of every PDA derived from here on. The hook loads first, so
// its validation account derives with the real digest.
function mockDigest(t: TestContext, digest: () => Promise<ArrayBuffer>): void {
	t.mock.method(crypto.subtle, 'digest', digest);
}

describe('the Execute of each leg', () => {
	it('starts with the source, mint, destination, authority and validation account', async () => {
		await assertResolves(
			list([
				pda([
					accountKey(0),
					accountKey(1),
					accountKey(2),
					accountKey(3),
					accountKey(4),
				]),
			]),
			async (leg) => [
				readonlyMeta(
					await hookPda(
						addressEncoder.encode(leg.source),
						addressEncoder.encode(MINT),
						addressEncoder.encode(leg.destination),
						addressEncoder.encode(leg.authority),
						addressEncoder.encode(VALIDATION),
					),
				),
				...HOOK_ACCOUNTS,
			],
		);
	});
});

// SPL `de_escalate_account_meta`: an extra is read-only when every earlier
// account of its `Execute` with the same key is read-only, and never a signer.
// Token-2022 passes the five `Execute` accounts read-only.
describe('de-escalation', () => {
	it('makes an extra that names an Execute account writable read-only', async () => {
		for (const account of [SOURCE, MINT, DESTINATION, USER]) {
			await assertResolves(
				list([fixed(account, true)]),
				() =>
					Promise.resolve([readonlyMeta(account), ...HOOK_ACCOUNTS]),
				new Map(),
				[USER_LEG],
			);
		}
		// The source's mint, read from its data.
		await assertResolves(list([pubkeyData(0, 0, true)]), () =>
			Promise.resolve([readonlyMeta(MINT), ...HOOK_ACCOUNTS]),
		);
		// The validation account, which then merges with its own place.
		const validation = list([fixed(VALIDATION, true)]);
		assert.deepEqual(await resolveOne(await loaded(validation), USER_LEG), [
			readonlyMeta(VALIDATION),
			readonlyMeta(PROGRAM),
		]);
	});

	it("keeps an account writable that the leg's Execute does not hold", async () => {
		// The user owns the vault leg's destination: an `Execute` holds the
		// destination, not its owner.
		await assertResolves(
			list([fixed(USER, true)]),
			() => Promise.resolve([writableMeta(USER), ...HOOK_ACCOUNTS]),
			new Map(),
			[VAULT_LEG],
		);
		// Another transfer's account.
		await assertResolves(
			list([fixed(DESTINATION, true)]),
			() =>
				Promise.resolve([writableMeta(DESTINATION), ...HOOK_ACCOUNTS]),
			new Map(),
			[{ ...USER_LEG, source: key(30), destination: key(31) }],
		);
	});

	it('makes an extra read-only after a read-only repeat', async () => {
		const pdaTwice = list([
			pda([accountKey(0)]),
			pda([accountKey(0)], true),
		]);
		const sourcePda = await hookPda(addressEncoder.encode(SOURCE));
		assert.deepEqual(await resolveOne(await loaded(pdaTwice), USER_LEG), [
			readonlyMeta(sourcePda),
			...HOOK_ACCOUNTS,
		]);
		const rentTwice = list([fixed(RENT), fixed(RENT, true)]);
		assert.deepEqual(await resolveOne(await loaded(rentTwice), USER_LEG), [
			readonlyMeta(RENT),
			...HOOK_ACCOUNTS,
		]);
	});

	it('keeps an extra writable after a writable repeat, and merges a read-only one into it', async () => {
		for (const [extras, want] of [
			[[fixed(RENT, true), fixed(RENT, true)], [writableMeta(RENT)]],
			[[fixed(RENT, true), fixed(RENT)], [writableMeta(RENT)]],
			[
				[fixed(RENT, true), fixed(MARKET), fixed(RENT)],
				[writableMeta(RENT), readonlyMeta(MARKET)],
			],
		] as const) {
			const data = list(extras);
			assert.deepEqual(await resolveOne(await loaded(data), USER_LEG), [
				...want,
				...HOOK_ACCOUNTS,
			]);
		}
	});

	it('refuses no role: one list of every repeat resolves', async () => {
		const hook = await loaded(
			list([
				fixed(SOURCE, true),
				fixed(MINT),
				fixed(VALIDATION),
				fixed(RENT, true),
				fixed(RENT, true),
				fixed(MARKET),
				fixed(MARKET, true),
			]),
		);
		checkHook(hook);
		assert.deepEqual(await resolveOne(hook, USER_LEG), [
			readonlyMeta(SOURCE),
			readonlyMeta(MINT),
			readonlyMeta(VALIDATION),
			writableMeta(RENT),
			readonlyMeta(MARKET),
			readonlyMeta(PROGRAM),
		]);
	});

	it('clears the signer flag of every extra', async () => {
		for (const [extra, want] of [
			[raw(0, addressEncoder.encode(RENT), true), readonlyMeta(RENT)],
			[
				raw(0, addressEncoder.encode(RENT), true, true),
				writableMeta(RENT),
			],
			// The leg's authority signs the transfer. Its extra signs nothing.
			[
				raw(0, addressEncoder.encode(USER), true, true),
				readonlyMeta(USER),
			],
		] as const) {
			const hook = await loaded(list([extra]));
			checkHook(hook);
			assert.deepEqual(await resolveOne(hook, USER_LEG), [
				want,
				...HOOK_ACCOUNTS,
			]);
		}
		const signerPda = await loaded(list([raw(1, accountKey(0), true)]));
		assert.deepEqual(await resolveOne(signerPda, USER_LEG), [
			readonlyMeta(await hookPda(addressEncoder.encode(SOURCE))),
			...HOOK_ACCOUNTS,
		]);
	});
});

const OTHER_PROGRAM = key(40);
const OTHER_VALIDATION = await findValidationAddress(OTHER_MINT, OTHER_PROGRAM);

describe('merging the legs', () => {
	function otherHook(data: Uint8Array): Hook {
		return {
			mint: OTHER_MINT,
			program: OTHER_PROGRAM,
			validation: OTHER_VALIDATION,
			list: { kind: 'Loaded', data },
		};
	}

	const OTHER_TAIL = [
		readonlyMeta(OTHER_PROGRAM),
		readonlyMeta(OTHER_VALIDATION),
	];

	it('gives each address once, in the order the legs name it', async () => {
		const hook = await loaded(programsTestList());
		assert.deepEqual(
			accountsIn(
				await hookAccounts(
					[hook],
					legsOf(USER_LEG, VAULT_LEG),
					NOTHING_FETCHED,
				),
			),
			[
				...(await programsTestAccounts(USER_LEG)),
				writableMeta(
					await hookPda('ledger', addressEncoder.encode(DESTINATION)),
				),
				readonlyMeta(
					await hookPda('owner', addressEncoder.encode(MARKET)),
				),
			],
		);
	});

	it('keeps a shared extra in its first place, writable if any leg wants it writable', async () => {
		const hook = await loaded(list([fixed(RENT), fixed(SOURCE)]));
		const other = otherHook(list([fixed(key(41)), fixed(RENT, true)]));
		const vaultLeg: HookLeg = { ...VAULT_LEG, mint: OTHER_MINT };
		assert.deepEqual(
			accountsIn(
				await hookAccounts(
					[hook, other],
					legsOf(USER_LEG, vaultLeg),
					NOTHING_FETCHED,
				),
			),
			[
				writableMeta(RENT),
				readonlyMeta(SOURCE),
				...HOOK_ACCOUNTS,
				readonlyMeta(key(41)),
				...OTHER_TAIL,
			],
		);
		// The legs in the other order: the other hook's accounts first.
		assert.deepEqual(
			accountsIn(
				await hookAccounts(
					[hook, other],
					legsOf(vaultLeg, USER_LEG),
					NOTHING_FETCHED,
				),
			),
			[
				readonlyMeta(key(41)),
				writableMeta(RENT),
				...OTHER_TAIL,
				readonlyMeta(SOURCE),
				...HOOK_ACCOUNTS,
			],
		);
	});

	it('adds nothing for a hook-free leg', async () => {
		const hook = await loaded(list([fixed(RENT), fixed(MARKET)]));
		assert.deepEqual(
			accountsIn(
				await hookAccounts(
					[hook],
					legsOf(USER_LEG, OTHER_LEG),
					NOTHING_FETCHED,
				),
			),
			[readonlyMeta(RENT), readonlyMeta(MARKET), ...HOOK_ACCOUNTS],
		);
	});

	it('merges one hook program armed on two mints', async () => {
		const hook = await loaded(list([fixed(RENT)]));
		const sameProgram: Hook = {
			...otherHook(list([fixed(RENT, true)])),
			program: PROGRAM,
			validation: await findValidationAddress(OTHER_MINT, PROGRAM),
		};
		assert.deepEqual(
			accountsIn(
				await hookAccounts(
					[hook, sameProgram],
					legsOf(USER_LEG, OTHER_LEG),
					NOTHING_FETCHED,
				),
			),
			[
				writableMeta(RENT),
				...HOOK_ACCOUNTS,
				readonlyMeta(sameProgram.validation),
			],
		);
	});

	it('throws the first error of the legs in order', async () => {
		const unfetched = await loadHook(
			MINT,
			mintState(PROGRAM),
			NOTHING_FETCHED,
		);
		assert.ok(unfetched);
		const missing: Hook = {
			...otherHook(new Uint8Array()),
			list: { kind: 'Missing' },
		};
		const hooks = [unfetched, missing];
		await assert.rejects(
			hookAccounts(hooks, legsOf(USER_LEG, OTHER_LEG), NOTHING_FETCHED),
			notLoaded([VALIDATION]),
		);
		await assert.rejects(
			hookAccounts(hooks, legsOf(OTHER_LEG, USER_LEG), NOTHING_FETCHED),
			NO_LIST,
		);
	});
});

describe('data reads', () => {
	it('reads a token account any leg moves as its mint and owner, fetched or not', async () => {
		// The other leg's destination, then its mint and owner.
		const hook = await loaded(
			list([
				fixed(OTHER_LEG.destination),
				pubkeyData(5, 0),
				pubkeyData(5, 32),
			]),
		);
		const want = [
			readonlyMeta(OTHER_LEG.destination),
			readonlyMeta(OTHER_MINT),
			readonlyMeta(OTHER_LEG.destinationOwner),
			...HOOK_ACCOUNTS,
		];
		// The lookup is never asked, and data it holds is not read.
		const asked: Address[] = [];
		for (const lookup of [
			NOTHING_FETCHED,
			() => null,
			() => ({
				owner: TOKEN_2022_PROGRAM_ADDRESS,
				data: new Uint8Array(165).fill(9),
			}),
		] satisfies AccountLookup[]) {
			assert.deepEqual(
				accountsIn(
					await hookAccounts(
						[hook],
						legsOf(USER_LEG, OTHER_LEG),
						(address) => {
							asked.push(address);
							return lookup(address);
						},
					),
				),
				want,
			);
		}
		assert.deepEqual(asked, []);
	});

	it('refuses a read past byte 64 of a token account a leg moves', async () => {
		for (const [extras, legs] of [
			[[pda([accountData(0, 33, 32)])], legsOf(USER_LEG)],
			[[pubkeyData(2, 33)], legsOf(USER_LEG)],
			[[pda([accountData(2, 64, 1)])], legsOf(VAULT_LEG)],
			[
				[fixed(OTHER_LEG.source), pda([accountData(5, 40, 32)])],
				legsOf(USER_LEG, OTHER_LEG),
			],
		] as const) {
			const hook = await loaded(list(extras));
			// The screen cannot see it: it depends on the legs.
			checkHook(hook);
			await assert.rejects(
				hookAccounts([hook], legs, NOTHING_FETCHED),
				SWAP_TIME,
			);
		}
		// A read that ends at byte 64 resolves.
		const hook = await loaded(list([pda([accountData(2, 32, 32)])]));
		assert.deepEqual(await resolveOne(hook, USER_LEG), [
			readonlyMeta(await hookPda(addressEncoder.encode(MARKET))),
			...HOOK_ACCOUNTS,
		]);
	});

	it('refuses a read of an account the instruction writes first', async () => {
		const marketData: AccountView = {
			owner: key(0),
			data: new Uint8Array(64).fill(3),
		};
		const lookup = lookupOf(new Map([[MARKET, marketData]]));
		const written: HookLegs = { legs: [USER_LEG], written: [MARKET] };
		const readsMarket = await loaded(
			list([fixed(MARKET), pda([accountData(5, 0, 1)])]),
		);
		await assert.rejects(
			hookAccounts([readsMarket], written, lookup),
			SWAP_TIME,
		);
		// The vault leg's authority.
		const readsAuthority = await loaded(
			list([pda([accountData(3, 0, 1)])]),
		);
		await assert.rejects(
			hookAccounts(
				[readsAuthority],
				{ legs: [VAULT_LEG], written: [MARKET] },
				lookup,
			),
			SWAP_TIME,
		);
		// Unwritten, the read is the lookup's.
		assert.deepEqual(await resolveOne(readsMarket, USER_LEG, lookup), [
			readonlyMeta(MARKET),
			readonlyMeta(await hookPda(new Uint8Array([3]))),
			...HOOK_ACCOUNTS,
		]);
		// An extra can name it: only its data changes.
		const namesMarket = await loaded(
			list([fixed(MARKET, true), pda([accountKey(5)])]),
		);
		assert.deepEqual(
			accountsIn(
				await hookAccounts([namesMarket], written, NOTHING_FETCHED),
			),
			[
				writableMeta(MARKET),
				readonlyMeta(await hookPda(addressEncoder.encode(MARKET))),
				...HOOK_ACCOUNTS,
			],
		);
	});

	it('reads the validation account as the list, whatever the lookup holds', async () => {
		const data = list([pda([accountData(4, 0, 8)])]);
		const want = [
			readonlyMeta(await hookPda(new Uint8Array(EXECUTE_DISCRIMINATOR))),
			...HOOK_ACCOUNTS,
		];
		for (const lookup of [
			NOTHING_FETCHED,
			() => null,
			() => ({ owner: PROGRAM, data: new Uint8Array(8) }),
		] satisfies AccountLookup[]) {
			assert.deepEqual(
				await resolveOne(await loaded(data), USER_LEG, lookup),
				want,
			);
		}
	});

	it('reads the mint through the lookup', async () => {
		// A Token-2022 mint whose authority is `RENT`.
		const mint: AccountView = {
			owner: TOKEN_2022_PROGRAM_ADDRESS,
			data: concat(
				u32(1),
				addressEncoder.encode(RENT),
				new Uint8Array(46),
			),
		};
		const data = list([pubkeyData(1, 4)]);
		const hook = await loaded(data);
		assert.deepEqual(
			await hookAccounts([hook], legsOf(USER_LEG), NOTHING_FETCHED),
			{ kind: 'Fetch', addresses: [MINT] },
		);
		// On chain a missing account has no data, and the read fails.
		await assert.rejects(
			resolveOne(hook, USER_LEG, () => null),
			UNRESOLVED,
		);
		await assertResolves(
			data,
			() => Promise.resolve([readonlyMeta(RENT), ...HOOK_ACCOUNTS]),
			new Map([[MINT, mint]]),
		);
	});

	it("reads the leg's authority through the lookup", async () => {
		const data = list([pda([accountData(3, 0, 8)])]);
		const hook = await loaded(data);
		assert.deepEqual(
			await hookAccounts(
				[hook],
				legsOf(USER_LEG, VAULT_LEG),
				NOTHING_FETCHED,
			),
			{ kind: 'Fetch', addresses: [USER, MARKET] },
		);
		await assert.rejects(
			resolveOne(hook, USER_LEG, () => null),
			UNRESOLVED,
		);
		const wallet: AccountView = {
			owner: key(0),
			data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
		};
		await assertResolves(
			data,
			async () => [
				readonlyMeta(
					await hookPda(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
				),
				...HOOK_ACCOUNTS,
			],
			new Map([
				[USER, wallet],
				[MARKET, wallet],
			]),
		);
	});

	it('reads an earlier extra through the lookup', async () => {
		const data = list([fixed(RENT), pda([accountData(5, 2, 4)])]);
		const hook = await loaded(data);
		assert.deepEqual(
			await hookAccounts([hook], legsOf(USER_LEG), NOTHING_FETCHED),
			{ kind: 'Fetch', addresses: [RENT] },
		);
		await assert.rejects(
			resolveOne(hook, USER_LEG, () => null),
			UNRESOLVED,
		);
		// Data too short for the read fails it too.
		await assert.rejects(
			resolveOne(hook, USER_LEG, () => ({
				owner: key(0),
				data: new Uint8Array(5),
			})),
			UNRESOLVED,
		);
		await assertResolves(
			data,
			async () => [
				readonlyMeta(RENT),
				readonlyMeta(await hookPda(new Uint8Array([12, 13, 14, 15]))),
				...HOOK_ACCOUNTS,
			],
			new Map([
				[
					RENT,
					{
						owner: key(0),
						data: new Uint8Array([10, 11, 12, 13, 14, 15]),
					},
				],
			]),
		);
	});

	it('names the first unfetched read of each leg, once', async () => {
		// The authority's data first: the extras after it wait for it.
		const hook = await loaded(
			list([
				pda([accountData(3, 0, 1)]),
				fixed(RENT),
				pda([accountData(6, 0, 1)]),
			]),
		);
		assert.deepEqual(
			await hookAccounts(
				[hook],
				legsOf(USER_LEG, USER_LEG),
				NOTHING_FETCHED,
			),
			{ kind: 'Fetch', addresses: [USER] },
		);
		const authority: AccountView = {
			owner: key(0),
			data: new Uint8Array([1]),
		};
		assert.deepEqual(
			await hookAccounts(
				[hook],
				legsOf(USER_LEG, VAULT_LEG),
				lookupOf(new Map([[USER, authority]])),
			),
			{ kind: 'Fetch', addresses: [RENT, MARKET] },
		);
	});
});

describe('amount seeds', () => {
	it('refuse the list on every leg', async () => {
		const error = refusal('ReadsTransferAmount');
		for (const seed of [
			instructionData(8, 8),
			instructionData(7, 2),
			instructionData(0, 16),
		]) {
			const hook = await loaded(list([pda([seed])]));
			assert.throws(() => checkHook(hook), error);
			for (const leg of [USER_LEG, VAULT_LEG]) {
				await assert.rejects(resolveOne(hook, leg), error);
			}
		}
	});

	it('leave a seed that reads none of the amount to any leg', async () => {
		for (const [seed, bytes] of [
			[instructionData(0, 8), new Uint8Array(EXECUTE_DISCRIMINATOR)],
			[instructionData(8, 0), new Uint8Array()],
			[instructionData(16, 0), new Uint8Array()],
		] as const) {
			const hook = await loaded(list([pda([seed])]));
			assert.deepEqual(await resolveOne(hook, VAULT_LEG), [
				readonlyMeta(await hookPda(bytes)),
				...HOOK_ACCOUNTS,
			]);
		}
	});

	it('refuse a seed that reads past byte 16, whatever the leg', async () => {
		for (const seed of [
			instructionData(9, 8),
			instructionData(16, 1),
			instructionData(0, 17),
		]) {
			const hook = await loaded(list([pda([seed])]));
			const error = refusal('ReadsPastInstructionData');
			assert.throws(() => checkHook(hook), error);
			for (const leg of [USER_LEG, VAULT_LEG]) {
				await assert.rejects(resolveOne(hook, leg), error);
			}
		}
	});
});

describe('resolveHookStep', () => {
	const HOOKED_MINT: AccountView = {
		owner: TOKEN_2022_PROGRAM_ADDRESS,
		data: hookedMintData(PROGRAM),
	};

	it('asks for each mint the legs move, once', async () => {
		assert.deepEqual(
			await resolveHookStep(
				legsOf(USER_LEG, VAULT_LEG, OTHER_LEG),
				NOTHING_FETCHED,
			),
			{ kind: 'Fetch', addresses: [MINT, OTHER_MINT] },
		);
	});

	it("asks for a hooked mint's list with the mints still to fetch", async () => {
		assert.deepEqual(
			await resolveHookStep(
				legsOf(USER_LEG, OTHER_LEG),
				lookupOf(new Map([[MINT, HOOKED_MINT]])),
			),
			{ kind: 'Fetch', addresses: [VALIDATION, OTHER_MINT] },
		);
	});

	it('runs no hook for a missing or hook-free mint', async () => {
		for (const mint of [
			null,
			HOOK_FREE_MINT,
			{ owner: TOKEN_2022_PROGRAM_ADDRESS, data: hookedMintData(null) },
		]) {
			assert.deepEqual(
				await resolveHookStep(
					legsOf(USER_LEG, VAULT_LEG),
					lookupOf(new Map([[MINT, mint]])),
				),
				{ kind: 'Accounts', accounts: [] },
			);
		}
	});

	it('refuses a missing list', async () => {
		await assert.rejects(
			resolveHookStep(
				legsOf(USER_LEG),
				lookupOf(
					new Map([
						[MINT, HOOKED_MINT],
						[VALIDATION, null],
					]),
				),
			),
			NO_LIST,
		);
	});

	it('asks for an account a list reads, then resolves', async () => {
		const accounts = new Map<Address, AccountView | null>([
			[MINT, HOOKED_MINT],
			[
				VALIDATION,
				{
					owner: PROGRAM,
					data: list([fixed(RENT), pda([accountData(5, 0, 2)])]),
				},
			],
		]);
		assert.deepEqual(
			await resolveHookStep(legsOf(USER_LEG), lookupOf(accounts)),
			{ kind: 'Fetch', addresses: [RENT] },
		);
		accounts.set(RENT, { owner: key(0), data: new Uint8Array([4, 2]) });
		assert.deepEqual(
			await resolveHookStep(legsOf(USER_LEG), lookupOf(accounts)),
			{
				kind: 'Accounts',
				accounts: [
					readonlyMeta(RENT),
					readonlyMeta(await hookPda(new Uint8Array([4, 2]))),
					...HOOK_ACCOUNTS,
				],
			},
		);
	});

	it('refuses a mint that does not decode as MalformedMint', async () => {
		for (const mint of [
			{ owner: RENT, data: new Uint8Array(82) },
			{ owner: TOKEN_2022_PROGRAM_ADDRESS, data: new Uint8Array(82) },
		]) {
			await assert.rejects(
				resolveHookStep(
					legsOf(USER_LEG),
					lookupOf(new Map([[MINT, mint]])),
				),
				{
					name: 'TransferHookError',
					error: 'MalformedMint',
					message: "a transfer's mint does not decode as a mint",
				},
			);
		}
	});
});

describe('resolveHookAccounts', () => {
	it('resolves from the state', async () => {
		assert.deepEqual(
			await resolveHookAccounts(
				legsOf(USER_LEG, OTHER_LEG),
				await probeState([MINT], [OTHER_MINT]),
			),
			await probeAccounts(USER_LEG),
		);
		assert.deepEqual(
			await resolveHookAccounts(
				legsOf(USER_LEG, OTHER_LEG),
				hookFreeState([MINT, OTHER_MINT]),
			),
			[],
		);
	});

	it('refuses a state that lacks an account as NotLoaded, naming what to fetch', async () => {
		await assert.rejects(
			resolveHookAccounts(legsOf(USER_LEG, OTHER_LEG), {
				accounts: new Map(),
			}),
			notLoaded([MINT, OTHER_MINT]),
		);
		const validation = await findValidationAddress(MINT, PROBE_PROGRAM);
		const accounts = new Map((await probeState([MINT])).accounts);
		accounts.delete(validation);
		await assert.rejects(
			resolveHookAccounts(legsOf(USER_LEG), { accounts }),
			notLoaded([validation]),
		);
	});
});

describe('the exported constants', () => {
	it('do not change resolution when a consumer writes to the discriminator', async () => {
		const data = list([
			pda([literal('data'), instructionData(0, 8)]),
			pda([accountData(4, 0, 8)]),
		]);
		const discriminator = new Uint8Array(EXECUTE_DISCRIMINATOR);
		const expected = [
			readonlyMeta(await hookPda('data', discriminator)),
			readonlyMeta(await hookPda(discriminator)),
			...HOOK_ACCOUNTS,
		];
		const exported = new Uint8Array(
			EXECUTE_DISCRIMINATOR.buffer,
			EXECUTE_DISCRIMINATOR.byteOffset,
			EXECUTE_DISCRIMINATOR.length,
		);
		exported.fill(0);
		try {
			assert.deepEqual(
				await resolveOne(await loaded(data), USER_LEG),
				expected,
			);
		} finally {
			exported.set(discriminator);
		}
		assert.deepEqual(new Uint8Array(EXECUTE_DISCRIMINATOR), discriminator);
	});
});

describe('the screen', () => {
	const cases: readonly (readonly [Uint8Array, Unresolvable])[] = [
		[pda([accountKey(5)]), 'NamesUnresolvedAccount'],
		[externalPda(5, []), 'NamesUnresolvedAccount'],
		[pubkeyData(5, 0), 'NamesUnresolvedAccount'],
		// A pubkey is 32 bytes. The `Execute` data is 16.
		[raw(2, new Uint8Array(32).fill(1)), 'ReadsPastInstructionData'],
		[raw(3, new Uint8Array(32)), 'MalformedExtra'],
		[raw(127, new Uint8Array(32)), 'MalformedExtra'],
		[raw(2, new Uint8Array(32)), 'MalformedExtra'],
		[raw(2, [3]), 'MalformedExtra'],
		[raw(1, new Uint8Array(32).fill(9)), 'MalformedSeed'],
		[raw(128, [9]), 'MalformedSeed'],
		// An external PDA names its program before its seeds are read.
		[raw(128 + 9, [9]), 'NamesUnresolvedAccount'],
		// The signer flag changes no refusal.
		[raw(1, [9], true), 'MalformedSeed'],
		[raw(2, [3], true), 'MalformedExtra'],
		[raw(3, new Uint8Array(32), true), 'MalformedExtra'],
		// A literal longer than the bytes left in the config: SPL
		// `InvalidBytesForSeed`.
		[raw(1, [1, 31]), 'MalformedSeed'],
		// A seed cut off by the end of the config: SPL `InvalidBytesForSeed`.
		[
			raw(1, [
				...Array.from({ length: 15 }, () => accountKey(0)).flat(),
				2,
				0,
			]),
			'MalformedSeed',
		],
		// Each seed kind one byte short at the end of the config, a literal
		// with no length byte first: SPL `InvalidBytesForSeed`.
		...[
			[1, 0],
			literal('ab'),
			instructionData(0, 1),
			accountKey(0),
			accountData(0, 0, 1),
		].map((seed) => [cutOff(seed), 'MalformedSeed'] as const),
		// A seed or `PubkeyData` kind past the last: SPL `InvalidAccountData`.
		[pda([accountKey(0), [5]]), 'MalformedSeed'],
		[pda([accountKey(0), [255]]), 'MalformedSeed'],
		[externalPda(0, [[5]]), 'MalformedSeed'],
		[raw(2, [255]), 'MalformedExtra'],
		[pda([accountData(4, 0, 33)]), 'SeedTooLong'],
		[pda(Array.from({ length: 16 }, () => accountKey(0))), 'TooManySeeds'],
		[
			externalPda(
				0,
				Array.from({ length: 16 }, () => accountKey(0)),
			),
			'TooManySeeds',
		],
	];

	for (const [index, [extra, reason]] of cases.entries()) {
		it(`refuses extra ${index} as ${reason}`, async () => {
			const data = list([extra]);
			const hook = await loaded(data);
			// The list loads as it is. Each resolution screens it.
			assert.deepEqual(hook.list, { kind: 'Loaded', data });
			const error = refusal(reason);
			assert.throws(() => checkHook(hook), error);
			for (const leg of [USER_LEG, VAULT_LEG]) {
				await assert.rejects(resolveOne(hook, leg), error);
			}
		});
	}

	it('passes a literal that fills the config and bytes after the terminator', async () => {
		const filler = Array.from({ length: 30 }, (_, index) => index + 1);
		const hook = await loaded(
			list([raw(1, [1, 30, ...filler]), raw(1, [3, 0, 0, 9, 9, 9])]),
		);
		checkHook(hook);
		assert.deepEqual(await resolveOne(hook, USER_LEG), [
			readonlyMeta(await hookPda(new Uint8Array(filler))),
			readonlyMeta(await hookPda(addressEncoder.encode(SOURCE))),
			...HOOK_ACCOUNTS,
		]);
	});

	it('resolves an empty literal, a seed that ends the config and PubkeyData with bytes after it', async () => {
		const filler = Array.from({ length: 26 }, (_, index) => index + 1);
		await assertResolves(
			list([
				pda([[1, 0], accountKey(0)]),
				pda([[1, 26, ...filler], accountData(0, 32, 2)]),
				raw(2, [2, 0, 32, 9, 9, 9]),
			]),
			async (leg) => [
				readonlyMeta(
					await hookPda(
						new Uint8Array(),
						addressEncoder.encode(leg.source),
					),
				),
				readonlyMeta(
					await hookPda(
						new Uint8Array(filler),
						addressEncoder.encode(leg.authority).subarray(0, 2),
					),
				),
				readonlyMeta(leg.authority),
				...HOOK_ACCOUNTS,
			],
		);
	});

	it('reports the first refused extra', async () => {
		const hook = await loaded(
			list([
				fixed(RENT),
				pda([accountKey(9)]),
				raw(3, new Uint8Array(32)),
			]),
		);
		assert.throws(() => checkHook(hook), refusal('NamesUnresolvedAccount'));
	});

	it('refuses a list that does not unpack', async () => {
		const malformed = new Uint8Array(20).fill(9);
		const otherType = concat(new Uint8Array(8).fill(9), u32(0));
		const short = list([fixed(RENT)]).subarray(0, -1);
		const overcounted = list([fixed(RENT)]);
		overcounted[12] = 2;
		const partial = list([fixed(RENT)]);
		partial[8] += 1;
		const trailing = concat(
			list([fixed(RENT)]),
			new Uint8Array(8).fill(9),
			u32(100),
		);
		for (const data of [
			malformed,
			// SPL reports a missing type only at zeroed slack long enough for a header.
			otherType,
			concat(otherType, new Uint8Array(8)),
			// Empty data has no TLV state.
			new Uint8Array(),
			short,
			// A count above the stored metas.
			overcounted,
			// Metas that are not whole.
			concat(partial, [0]),
			// A malformed entry after a good `Execute` one still fails the list.
			trailing,
			// A tail too short for a type must be zero.
			concat(list([fixed(RENT)]), [0, 0, 1]),
		]) {
			assert.throws(
				() => checkHook(listHook(data)),
				refusal('MalformedList'),
			);
		}
		assert.throws(
			() => checkHook(listHook(concat(otherType, new Uint8Array(12)))),
			refusal('NoExecuteEntry'),
		);
		// Zero slack after the entries is not a malformed list.
		checkHook(listHook(concat(list([fixed(RENT)]), [0, 0, 0])));
	});

	it('refuses a list longer than an index can name', () => {
		const extras = Array.from({ length: 252 }, () => fixed(RENT));
		assert.throws(
			() => checkHook(listHook(list(extras))),
			refusal('ListTooLong'),
		);
		checkHook(listHook(list(extras.slice(0, 251))));
	});

	it('reads a list held in a SharedArrayBuffer', async () => {
		// A view that starts past the buffer's first byte, as shared memory
		// can hand over.
		const data = new Uint8Array(
			new SharedArrayBuffer(programsTestList().length + 1),
		).subarray(1);
		data.set(programsTestList());
		const expected = await programsTestAccounts(USER_LEG);
		assert.deepEqual(
			await resolveOne(await loaded(data), USER_LEG),
			expected,
		);
		assert.deepEqual(await resolveOne(listHook(data), USER_LEG), expected);
	});
});

function pausable(paused: boolean) {
	return [26, concat(new Uint8Array(32).fill(7), [paused ? 1 : 0])] as const;
}

/** An initialized classic SPL Token mint. */
function splMint(): Uint8Array {
	const data = new Uint8Array(82);
	// `decimals`, then `is_initialized`.
	data[44] = SPL_DECIMALS;
	data[45] = 1;
	return data;
}

function decode(data: Uint8Array, owner: Address = TOKEN_2022_PROGRAM_ADDRESS) {
	return decodeMintState({ owner, data });
}

function mintError(message: string) {
	return {
		name: 'RangeError',
		message: `decodeMintState: ${message}`,
	};
}

describe('decodeMintState', () => {
	it('reads a classic SPL mint as hook-free', () => {
		assert.deepEqual(decode(splMint(), TOKEN_PROGRAM_ADDRESS), {
			tokenProgram: TOKEN_PROGRAM_ADDRESS,
			decimals: SPL_DECIMALS,
			transferFee: null,
			hookProgram: null,
		});
	});

	it('reads a Token-2022 mint without extensions as hook-free', () => {
		const data = new Uint8Array(82);
		data[44] = TOKEN_2022_DECIMALS;
		data[45] = 1;
		assert.deepEqual(decode(data), mintState(null));
	});

	it('reads the decimals at byte 44 of the base mint, in both token programs', () => {
		for (const decimals of [0, 6, 9, 255]) {
			const spl = splMint();
			spl[44] = decimals;
			const token2022 = token2022Mint([POINTER, METADATA]);
			token2022[44] = decimals;
			for (const [data, owner] of [
				[spl, TOKEN_PROGRAM_ADDRESS],
				[token2022, TOKEN_2022_PROGRAM_ADDRESS],
			] as const) {
				assert.equal(decode(data, owner).decimals, decimals);
				assert.equal(getMintDecoder().decode(data).decimals, decimals);
			}
		}
	});

	it('reads a launchpad base mint as hook-free', () => {
		assert.deepEqual(
			decode(token2022Mint([POINTER, METADATA])),
			mintState(null),
		);
	});

	it('reads an unset hook program as no hook', () => {
		const data = token2022Mint([POINTER, hookExtension(null), METADATA]);
		assert.deepEqual(decode(data), mintState(null));
	});

	it('reads a set hook program', () => {
		const data = token2022Mint([
			POINTER,
			hookExtension(HOOK_PROGRAM),
			METADATA,
		]);
		assert.deepEqual(decode(data), mintState(HOOK_PROGRAM));
	});

	it('reads a paused or resumed mint as any other', () => {
		assert.deepEqual(
			decode(
				token2022Mint([hookExtension(HOOK_PROGRAM), pausable(true)]),
			),
			mintState(HOOK_PROGRAM),
		);
		assert.deepEqual(
			decode(token2022Mint([pausable(false)])),
			mintState(null),
		);
	});

	it('reads the transfer fee as transferFee.decodeFeeSchedule does', () => {
		const fee = new Uint8Array(108).fill(7);
		const data = token2022Mint([[1, fee], hookExtension(HOOK_PROGRAM)]);
		assert.deepEqual(decode(data), {
			tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
			decimals: TOKEN_2022_DECIMALS,
			transferFee: {
				authority: key(7),
				older: {
					epoch: 0x0707_0707_0707_0707n,
					maximumFee: 0x0707_0707_0707_0707n,
					basisPoints: 0x0707,
				},
				newer: {
					epoch: 0x0707_0707_0707_0707n,
					maximumFee: 0x0707_0707_0707_0707n,
					basisPoints: 0x0707,
				},
			},
			hookProgram: HOOK_PROGRAM,
		});
		const { transferFee } = decode(data);
		assert.ok(transferFee, 'the mint carries a TransferFeeConfig');
		assert.deepEqual(
			feeScheduleOf(transferFee, 5n),
			decodeFeeSchedule(data, TOKEN_2022_PROGRAM_ADDRESS, 5n),
		);
	});

	it('agrees with the oracle mint decoder', () => {
		for (const [extensions, hookProgram] of [
			[
				[hookExtension(null), pausable(false)],
				'11111111111111111111111111111111',
			],
			[[hookExtension(HOOK_PROGRAM), pausable(true)], HOOK_PROGRAM],
		] as const) {
			const data = token2022Mint(extensions);
			const decoded = getMintDecoder().decode(data).extensions;
			if (decoded.__option === 'None') assert.fail('no extensions');
			const programs = decoded.value.flatMap((extension) =>
				extension.__kind === 'TransferHook'
					? [extension.programId]
					: [],
			);
			assert.deepEqual(programs, [hookProgram]);
			// The oracle reads an unset program as the default address.
			assert.equal(
				decode(data).hookProgram ?? '11111111111111111111111111111111',
				hookProgram,
			);
		}
	});

	it('reads a future extension type as no extension', () => {
		assert.deepEqual(
			decode(token2022Mint([POINTER, [250, new Uint8Array(16)]])),
			mintState(null),
		);
	});

	it('reads zero slack after the entries as their end', () => {
		for (const tail of [[0], [0, 0], [0, 0, 0], [7], new Uint8Array(512)]) {
			assert.deepEqual(
				decode(concat(token2022Mint([POINTER, METADATA]), tail)),
				mintState(null),
			);
		}
	});

	it('refuses malformed data', () => {
		const cut = token2022Mint([hookExtension(HOOK_PROGRAM)]).subarray(
			0,
			-1,
		);
		const runsPast = mintError(
			'a TLV entry runs past the end of the account',
		);
		const cases: readonly (readonly [
			Uint8Array,
			ReturnType<typeof mintError>,
		])[] = [
			[cut, runsPast],
			// A walk for an extension the mint lacks reaches the cut entry.
			[
				concat(
					token2022Mint([hookExtension(HOOK_PROGRAM)]),
					[18, 0, 64, 0],
				),
				runsPast,
			],
			[concat(token2022Mint([POINTER]), [18, 0]), runsPast],
			[
				token2022Mint([[14, new Uint8Array(63)]]),
				mintError('extension 14 holds 63 bytes, expected 64'),
			],
			// Rust `MintState::load` reads the transfer fee too.
			[
				token2022Mint([[1, new Uint8Array(100)]]),
				mintError('extension 1 holds 100 bytes, expected 108'),
			],
			[
				new Uint8Array(81).fill(1),
				mintError('a Token-2022 mint cannot hold 81 bytes'),
			],
			[
				new Uint8Array(355).fill(1),
				mintError('a Token-2022 mint cannot hold 355 bytes'),
			],
			[new Uint8Array(82), mintError('the mint is not initialized')],
			[
				token2022Mint([]).subarray(0, 165),
				mintError(
					'a Token-2022 mint holds 165 bytes, expected 82 or at least 166',
				),
			],
		];
		for (const [data, error] of cases) {
			assert.throws(() => decode(data), error);
		}

		const padded = token2022Mint([]);
		padded[100] = 1;
		assert.throws(
			() => decode(padded),
			mintError('the padding after the base mint is not zero'),
		);
		const account = token2022Mint([]);
		account[165] = 2;
		assert.throws(
			() => decode(account),
			mintError('account type 2 is not a mint'),
		);
		assert.throws(
			() => decode(token2022Mint([]), MINT),
			mintError(`${MINT} is not a token program`),
		);
	});

	it('refuses a classic SPL mint that SPL Token does not write', () => {
		const uninitialized = splMint();
		uninitialized[45] = 0;
		assert.throws(
			() => decode(uninitialized, TOKEN_PROGRAM_ADDRESS),
			mintError('the mint is not initialized'),
		);
		// A token account is 165 bytes, a multisig 355.
		for (const length of [0, 44, 81, 83, 165, 355]) {
			const data = new Uint8Array(length);
			data.set(splMint().subarray(0, length));
			assert.throws(
				() => decode(data, TOKEN_PROGRAM_ADDRESS),
				mintError(
					`an SPL Token mint holds ${length} bytes, expected 82`,
				),
			);
		}
	});
});

// transfer-hook-oracle.test.ts asserts the library's own reading of each case.
describe('where the library reads bytes differently from Token-2022', () => {
	it('reads a writable byte above 1 as set, as SPL PodBool does', async () => {
		for (const byte of [2, 255]) {
			const writable = fixed(RENT);
			writable[34] = byte;
			assert.deepEqual(
				await resolveOne(await loaded(list([writable])), USER_LEG),
				[writableMeta(RENT), ...HOOK_ACCOUNTS],
			);
		}
	});

	it('clears the signer flag of an extra no earlier account holds', async () => {
		const data = list([raw(0, addressEncoder.encode(RENT), true)]);
		assert.deepEqual(await resolveOne(await loaded(data), USER_LEG), [
			readonlyMeta(RENT),
			...HOOK_ACCOUNTS,
		]);
	});

	it('finds the Execute entry after a foreign one', async () => {
		const data = concat(
			new Uint8Array(8).fill(1),
			u32(3),
			[0, 0, 0],
			list([fixed(RENT, true)]),
		);
		assert.deepEqual(await resolveOne(await loaded(data), USER_LEG), [
			writableMeta(RENT),
			...HOOK_ACCOUNTS,
		]);
	});

	it('bounds the count by the length of the entry', () => {
		// One meta in the entry, a count of 2, then zeroed slack.
		const overcounted = concat(
			list([fixed(RENT)]),
			new Uint8Array(META_LENGTH),
		);
		overcounted[LIST_HEADER] = 2;
		assert.throws(
			() => checkHook(listHook(overcounted)),
			refusal('MalformedList'),
		);
	});

	it('reads the metas of an Execute entry only', () => {
		const other = list([fixed(RENT)]);
		other.fill(9, 0, 8);
		const slack = concat(other, new Uint8Array(LIST_HEADER));
		assert.throws(
			() => checkHook(listHook(other)),
			refusal('MalformedList'),
		);
		assert.throws(
			() => checkHook(listHook(slack)),
			refusal('NoExecuteEntry'),
		);
	});

	it('skips a mint extension type it does not know', () => {
		for (const type of [250, 0xff_f0]) {
			const data = token2022Mint([
				POINTER,
				[type, new Uint8Array(16)],
				hookExtension(HOOK_PROGRAM),
			]);
			assert.deepEqual(decode(data), mintState(HOOK_PROGRAM));
		}
	});
});

describe('TransferHookError', () => {
	it('names every HookError', () => {
		const errors: readonly (readonly [HookError, string])[] = [
			['NotLoaded', 'transfer hook accounts not loaded'],
			['NoList', 'transfer hook has no ExtraAccountMetaList'],
			['MalformedMint', "a transfer's mint does not decode as a mint"],
			...Object.keys(REASONS)
				.filter(isReason)
				.map(
					(reason) =>
						[
							`Unresolvable(${reason})`,
							`transfer hook cannot be resolved ahead of the instruction: ${REASONS[reason]}`,
						] as const,
				),
		];
		assert.equal(errors.length, 15);
		for (const [error, message] of errors) {
			const thrown = new TransferHookError(error);
			assert.ok(thrown instanceof Error);
			assert.equal(thrown.name, 'TransferHookError');
			assert.equal(thrown.error, error);
			assert.equal(thrown.message, message);
			assert.deepEqual(thrown.addresses, []);
			assert.equal(describeHookError(error), message);
		}
	});

	it('names the accounts to fetch, in a frozen copy', () => {
		const addresses = [MINT, VALIDATION];
		const thrown = new TransferHookError('NotLoaded', addresses);
		assert.equal(
			thrown.message,
			`transfer hook accounts not loaded: fetch ${MINT}, ${VALIDATION}`,
		);
		addresses.push(RENT);
		assert.deepEqual(thrown.addresses, [MINT, VALIDATION]);
		assert.equal(Object.isFrozen(thrown.addresses), true);
	});
});
