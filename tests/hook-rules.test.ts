// What a hook's list can do through the builders:
// - SPL de-escalation: an extra is read-only where its own transfer's
//   `Execute` holds its account read-only, and never a signer;
// - an extra can name any account of the instruction, writable;
// - the account data a list reads: the mint, the authority and earlier extras
//   from the hook state, and a moved token account's mint and owner with no
//   read, but nothing the instruction changes first
//   (`Unresolvable(ReadsSwapTimeData)`) and no data of a missing account
//   (`Unresolvable(ExtraUnresolved)`);
// - no seed on the transfer amount (`Unresolvable(ReadsTransferAmount)`).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	createNoopSigner,
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
} from '../src/constants.js';
import * as dex from '../src/dex/index.js';
import * as launchpad from '../src/launchpad/index.js';
import { appendHookAccounts } from '../src/transfer-hook/fetch.js';
import {
	type AccountView,
	type HookError,
	type HookState,
} from '../src/transfer-hook/index.js';
import { fetchMintInfo } from '../src/utils/index.js';
import { findValidationAddress } from '../src/transfer-hook/resolver.js';
import {
	accountData,
	fixed,
	instructionData,
	list,
	literal,
	pda,
	pubkeyData,
	raw,
} from './support/extra-metas.js';
import { CLOCK } from './support/fake-rpc.js';
import {
	BASE_MINT,
	HOOK_FREE_CASES,
	PAYER,
	parts,
	PLATFORM,
	TKALSHI_MINT,
	USER,
	type HookFreeCase,
} from './support/hook-free-cases.js';
import {
	armedState,
	buildFrom,
	buildWithReads,
	caseRun,
	fetchedInfos,
	filledFrom,
	readonlyMeta,
	rpcOver,
	trailing,
	trailingOf,
	writableMeta,
	type CaseRun,
} from './support/hook-runs.js';
import { mintInfoOf, plainMintInfo } from './support/mint-infos.js';
import {
	hookedMintData,
	hookFreeState,
	probeAccountsOf,
	PROBE_PROGRAM,
} from './support/probe-hook.js';

const addressEncoder = getAddressEncoder();

/** The address of 32 copies of `byte`. */
function key(byte: number): Address {
	return getAddressDecoder().decode(new Uint8Array(32).fill(byte));
}

const user = createNoopSigner(USER);
const payer = createNoopSigner(PAYER);

function refusal(error: HookError) {
	return { name: 'TransferHookError', error };
}

function notLoaded(addresses: readonly Address[]) {
	return { name: 'TransferHookError', error: 'NotLoaded', addresses };
}

const SWAP_TIME_DATA = refusal('Unresolvable(ReadsSwapTimeData)');
const EXTRA_UNRESOLVED = refusal('Unresolvable(ExtraUnresolved)');

function validationOf(mint: Address): Promise<Address> {
	return findValidationAddress(mint, PROBE_PROGRAM);
}

/** The probe program and the validation account of `mint`, after a list's extras. */
async function hookTail(mint: Address): Promise<AccountMeta[]> {
	return [
		readonlyMeta(PROBE_PROGRAM),
		readonlyMeta(await validationOf(mint)),
	];
}

async function probePda(
	...seeds: readonly ReadonlyUint8Array[]
): Promise<Address> {
	const [address] = await getProgramDerivedAddress({
		programAddress: PROBE_PROGRAM,
		seeds: [...seeds],
	});
	return address;
}

/** `testCase`'s hook mint armed with `extras`, its other mints hook-free, and `more`. */
function armed(
	testCase: HookFreeCase,
	run: CaseRun,
	extras: readonly Uint8Array[],
	more: readonly (readonly [Address, AccountView | null])[] = [],
): Promise<HookState> {
	return armedState(testCase.hookMint, extras, run.others, more);
}

/** What a build of `testCase` appends with its hook mint armed with `extras`. */
async function appended(
	testCase: HookFreeCase,
	run: CaseRun,
	extras: readonly Uint8Array[],
	more: readonly (readonly [Address, AccountView | null])[] = [],
): Promise<AccountMeta[]> {
	return trailing(testCase, run, await armed(testCase, run, extras, more));
}

const EXTRA = key(90);
const OTHER_EXTRA = key(91);
/** An account a list names, and its data. */
const NAMED = key(93);
const NAMED_DATA = Uint8Array.from([7, 7, 7, 7, 9]);
/** The data of a transfer's authority, which holds `NAMED` at offset 8. */
const AUTHORITY_DATA = Uint8Array.from(
	{ length: 618 },
	(_, index) => index % 251,
);
AUTHORITY_DATA.set(addressEncoder.encode(NAMED), 8);
/** A token account no leg moves. */
const TOKEN_ACCOUNT = key(94);
const TOKEN_OWNER = key(95);
const MISSING = key(96);

function tokenAccountData(): Uint8Array {
	const data = new Uint8Array(165);
	data.set(addressEncoder.encode(TKALSHI_MINT));
	data.set(addressEncoder.encode(TOKEN_OWNER), 32);
	data.fill(3, 64);
	return data;
}

function view(owner: Address, data: Uint8Array): AccountView {
	return { owner, data };
}

/** The hooked mint's `TransferHook` authority: 32 bytes of 9. */
const HOOK_AUTHORITY = hookedMintData(PROBE_PROGRAM).subarray(170, 202);

describe('SPL de-escalation: an extra its own Execute holds read-only is read-only', () => {
	for (const testCase of HOOK_FREE_CASES) {
		it(testCase.name, async () => {
			const run = await caseRun(testCase);
			const { leg } = run;
			const mint = testCase.hookMint;
			const validation = await validationOf(mint);
			const tail = await hookTail(mint);
			for (const [name, extras, expected] of [
				[
					'the validation account',
					[fixed(validation, true)],
					[readonlyMeta(validation), readonlyMeta(PROBE_PROGRAM)],
				],
				[
					'the source',
					[fixed(leg.source, true)],
					[readonlyMeta(leg.source), ...tail],
				],
				[
					"the source's mint",
					[pubkeyData(0, 0, true)],
					[readonlyMeta(mint), ...tail],
				],
				[
					'the destination',
					[fixed(leg.destination, true)],
					[readonlyMeta(leg.destination), ...tail],
				],
				[
					"the source's owner, the authority",
					[pubkeyData(0, 32, true)],
					[readonlyMeta(leg.authority), ...tail],
				],
				[
					'an earlier read-only extra',
					[fixed(EXTRA), fixed(EXTRA, true)],
					[readonlyMeta(EXTRA), ...tail],
				],
				// No account of the `Execute`: it stays writable.
				[
					"the destination's owner",
					[pubkeyData(2, 32, true)],
					[writableMeta(leg.destinationOwner), ...tail],
				],
				// Each address once, writable if any extra wants it writable.
				[
					'an earlier writable extra',
					[fixed(EXTRA, true), fixed(EXTRA)],
					[writableMeta(EXTRA), ...tail],
				],
			] as const) {
				assert.deepEqual(
					await appended(testCase, run, extras),
					expected,
					name,
				);
			}
		});
	}

	it('migrate: the quote vault is read-only for the quote leg that pays out of it', async () => {
		const testCase = caseNamed('launchpad buildMigrateInstruction');
		const run = await caseRun(testCase);
		const quoteVault = run.leg.source;
		assert.deepEqual(
			await appended(testCase, run, [fixed(quoteVault, true)]),
			[readonlyMeta(quoteVault), ...(await hookTail(TKALSHI_MINT))],
		);
	});

	it('dex buy: the quote vault is read-only for the quote leg that pays into it, writable for the base leg', async () => {
		const testCase = caseNamed(
			'dex buildBuyExactInInstruction, Token-2022 quote',
		);
		const run = await caseRun(testCase);
		const quoteVault = run.leg.destination;
		const extras = [fixed(quoteVault, true)];
		assert.deepEqual(await appended(testCase, run, extras), [
			readonlyMeta(quoteVault),
			...(await hookTail(TKALSHI_MINT)),
		]);
		assert.deepEqual(
			await trailing(
				testCase,
				run,
				await armedState(BASE_MINT, extras, [TKALSHI_MINT]),
			),
			[writableMeta(quoteVault), ...(await hookTail(BASE_MINT))],
		);
		// Both: one entry, writable, where the quote leg names it first.
		assert.deepEqual(
			await trailing(testCase, run, {
				accounts: new Map([
					...(await probeAccountsOf(TKALSHI_MINT, list(extras))),
					...(await probeAccountsOf(BASE_MINT, list(extras))),
				]),
			}),
			[
				writableMeta(quoteVault),
				readonlyMeta(PROBE_PROGRAM),
				readonlyMeta(await validationOf(TKALSHI_MINT)),
				readonlyMeta(await validationOf(BASE_MINT)),
			],
		);
	});
});

describe('a signer extra is appended as a non-signer', () => {
	const extras = [
		raw(0, addressEncoder.encode(EXTRA), true),
		raw(0, addressEncoder.encode(OTHER_EXTRA), true, true),
		// The user signs the instruction itself.
		raw(0, addressEncoder.encode(USER), true, true),
	];

	for (const testCase of HOOK_FREE_CASES) {
		it(testCase.name, async () => {
			const run = await caseRun(testCase);
			// Read-only where the leg's `Execute` holds the user: it signs the
			// transfer.
			const userMeta =
				run.leg.authority === USER
					? readonlyMeta(USER)
					: writableMeta(USER);
			assert.deepEqual(await appended(testCase, run, extras), [
				readonlyMeta(EXTRA),
				writableMeta(OTHER_EXTRA),
				userMeta,
				...(await hookTail(testCase.hookMint)),
			]);
		});
	}
});

/** One builder and the leg of its hooked mint. */
interface SlotCase {
	readonly name: string;
	readonly hookMint: Address;
	/** The build from the infos of the market's mints in `state`. */
	build(state: HookState): Promise<Instruction>;
	/** The instruction's slots, in order. */
	slots(instruction: Instruction): readonly (readonly [string, Address])[];
	/** The slots of the hooked transfer's source, mint, destination and authority. */
	readonly execute: readonly string[];
}

function slotsOf(accounts: object): (readonly [string, Address])[] {
	return Object.entries(accounts).map(
		([name, meta]: [string, AccountMeta]) => [name, meta.address],
	);
}

const MARKET = [BASE_MINT, TKALSHI_MINT];

const TRADE = {
	user,
	payer,
	partner: createNoopSigner(key(92)),
	platformConfig: PLATFORM,
	amountIn: 1_000_000_000n,
	minAmountOut: 1n,
} as const;

/** A trade of the market's mints in `state`. */
function trade(state: HookState) {
	return {
		...TRADE,
		baseMintInfo: mintInfoOf(state, BASE_MINT),
		quoteMintInfo: mintInfoOf(state, TKALSHI_MINT),
	};
}

/** A migrate of a hook-free base mint and the quote mint in `state`. */
function migrate(state: HookState) {
	return launchpad.migrate.buildMigrateInstruction({
		caller: user,
		baseMintInfo: plainMintInfo(BASE_MINT),
		quoteMintInfo: mintInfoOf(state, TKALSHI_MINT),
	});
}

const migrateSlots = (instruction: Instruction) =>
	slotsOf(
		launchpad.instructions.parseMigrateInstruction(parts(instruction))
			.accounts,
	);

const SLOT_CASES: readonly SlotCase[] = [
	{
		name: 'launchpad buy_exact_in, quote hook',
		hookMint: TKALSHI_MINT,
		build: (state) =>
			launchpad.trade.buildBuyExactInInstruction(trade(state)),
		slots: (instruction) =>
			slotsOf(
				launchpad.instructions.parseBuyExactInInstruction(
					parts(instruction),
				).accounts,
			),
		execute: ['userQuoteAccount', 'quoteMint', 'quoteVault', 'user'],
	},
	{
		name: 'dex sell_exact_in, quote hook',
		hookMint: TKALSHI_MINT,
		build: (state) => dex.trade.buildSellExactInInstruction(trade(state)),
		slots: (instruction) =>
			slotsOf(
				dex.instructions.parseSellExactInInstruction(parts(instruction))
					.accounts,
			),
		execute: ['quoteVault', 'quoteMint', 'userQuoteAccount', 'pool'],
	},
	{
		name: 'launchpad migrate, quote hook',
		hookMint: TKALSHI_MINT,
		build: migrate,
		slots: migrateSlots,
		execute: ['quoteVault', 'quoteMint', 'poolQuoteVault', 'bondingCurve'],
	},
	// `migrate` above takes a hook-free base mint. A trade tests the base hook.
	{
		name: 'launchpad sell_exact_in, base hook',
		hookMint: BASE_MINT,
		build: (state) =>
			launchpad.trade.buildSellExactInInstruction(trade(state)),
		slots: (instruction) =>
			slotsOf(
				launchpad.instructions.parseSellExactInInstruction(
					parts(instruction),
				).accounts,
			),
		execute: ['userBaseAccount', 'baseMint', 'baseVault', 'user'],
	},
];

const HOOK_FREE_MARKET = hookFreeState(MARKET);

/** The accounts a build of `slotCase` from `state` appends after every account of its build from
 *  a hook-free market. */
async function builtHookAccounts(
	slotCase: SlotCase,
	state: HookState,
): Promise<AccountMeta[]> {
	const fixedAccounts =
		(await slotCase.build(HOOK_FREE_MARKET)).accounts ?? [];
	const accounts = (await slotCase.build(state)).accounts ?? [];
	assert.deepEqual(accounts.slice(0, fixedAccounts.length), fixedAccounts);
	return accounts.slice(fixedAccounts.length);
}

function caseNamed(name: string): HookFreeCase {
	const testCase = HOOK_FREE_CASES.find(
		(candidate) => candidate.name === name,
	);
	assert.ok(testCase !== undefined, name);
	return testCase;
}

describe('an extra can name any account of the instruction, writable', () => {
	for (const slotCase of SLOT_CASES) {
		it(`${slotCase.name}: writable, but read-only where the leg's Execute holds it`, async () => {
			const others = MARKET.filter((mint) => mint !== slotCase.hookMint);
			const slots = slotCase.slots(
				await slotCase.build(HOOK_FREE_MARKET),
			);
			const names = slots.map(([name]) => name);
			for (const listed of slotCase.execute) {
				assert.ok(names.includes(listed), `${listed} is no slot`);
			}
			// Slots that share an address share an outcome here, so each
			// address has one expected role.
			const isExecute = (name: string) => slotCase.execute.includes(name);
			for (const [name, slot] of slots) {
				for (const [other, otherSlot] of slots) {
					if (slot === otherSlot) {
						assert.equal(isExecute(other), isExecute(name), other);
					}
				}
			}
			const tail = await hookTail(slotCase.hookMint);
			for (const [name, slot] of slots) {
				assert.deepEqual(
					await builtHookAccounts(
						slotCase,
						await armedState(
							slotCase.hookMint,
							[fixed(slot, true)],
							others,
						),
					),
					[
						isExecute(name)
							? readonlyMeta(slot)
							: writableMeta(slot),
						...tail,
					],
					name,
				);
			}
		});
	}

	it('a builder appends its market writable', async () => {
		for (const [name, market] of [
			// The curve is written before the transfers. Naming it reads nothing.
			[
				'launchpad buildBuyExactInInstruction, Token-2022 quote',
				(run: CaseRun) => run.legs.written[0],
			],
			[
				'dex buildBuyExactInInstruction, Token-2022 quote',
				(run: CaseRun) => run.leg.destinationOwner,
			],
		] as const) {
			const testCase = caseNamed(name);
			const run = await caseRun(testCase);
			const address = market(run);
			// The instruction holds it writable.
			assert.ok(
				run.last.accounts?.some(
					(meta) =>
						meta.address === address &&
						meta.role === writableMeta(address).role,
				),
			);
			assert.deepEqual(
				await appended(testCase, run, [fixed(address, true)]),
				[writableMeta(address), ...(await hookTail(testCase.hookMint))],
				name,
			);
		}
	});

	it('an account after the fixed ones, as the instruction’s own', async () => {
		const bypass = key(97);
		const { last, legs } = await caseRun(
			caseNamed('launchpad buildMigrateInstruction'),
		);
		const instruction = {
			...last,
			accounts: [...(last.accounts ?? []), writableMeta(bypass)],
		};
		const built = await appendHookAccounts(
			instruction,
			legs,
			await armedState(TKALSHI_MINT, [fixed(bypass, true)], [BASE_MINT]),
		);
		assert.deepEqual(built, {
			...instruction,
			accounts: [
				...instruction.accounts,
				writableMeta(bypass),
				...(await hookTail(TKALSHI_MINT)),
			],
		});
	});
});

/** Cases whose hooked leg's authority the instruction writes before its transfers: a launchpad
 *  curve that pays its hooked base out. */
const WRITES_AUTHORITY = new Set([
	'launchpad buildBuyExactInInstruction',
	'launchpad buildBuyExactOutInstruction',
	'launchpad buyExactIn',
	'launchpad buyExactOut',
]);

describe('the account data a list reads', () => {
	for (const testCase of HOOK_FREE_CASES) {
		describe(testCase.name, () => {
			it('reads the mint from the hook state', async () => {
				const run = await caseRun(testCase);
				assert.deepEqual(
					await appended(testCase, run, [
						pda([literal('mint'), accountData(1, 170, 32)]),
					]),
					[
						readonlyMeta(
							await probePda(
								new TextEncoder().encode('mint'),
								HOOK_AUTHORITY,
							),
						),
						...(await hookTail(testCase.hookMint)),
					],
				);
			});

			it('reads the authority from the hook state, unless the instruction writes it first', async () => {
				const run = await caseRun(testCase);
				const { authority } = run.leg;
				const extras = [pda([accountData(3, 0, 8)])];
				const data: [Address, AccountView] = [
					authority,
					view(SEND_LAUNCHPAD_PROGRAM_ADDRESS, AUTHORITY_DATA),
				];
				assert.equal(
					run.legs.written.includes(authority),
					WRITES_AUTHORITY.has(testCase.name),
				);
				if (WRITES_AUTHORITY.has(testCase.name)) {
					await assert.rejects(
						buildFrom(
							testCase,
							await armed(testCase, run, extras, [data]),
						),
						SWAP_TIME_DATA,
					);
					return;
				}
				await assert.rejects(
					buildFrom(testCase, await armed(testCase, run, extras)),
					notLoaded([authority]),
				);
				assert.deepEqual(
					await appended(testCase, run, extras, [data]),
					[
						readonlyMeta(
							await probePda(AUTHORITY_DATA.subarray(0, 8)),
						),
						...(await hookTail(testCase.hookMint)),
					],
				);
			});

			it('reads an earlier extra from the hook state', async () => {
				const run = await caseRun(testCase);
				const extras = [fixed(NAMED), pda([accountData(5, 0, 4)])];
				await assert.rejects(
					buildFrom(testCase, await armed(testCase, run, extras)),
					notLoaded([NAMED]),
				);
				assert.deepEqual(
					await appended(testCase, run, extras, [
						[NAMED, view(PROBE_PROGRAM, NAMED_DATA)],
					]),
					[
						readonlyMeta(NAMED),
						readonlyMeta(await probePda(NAMED_DATA.subarray(0, 4))),
						...(await hookTail(testCase.hookMint)),
					],
				);
			});

			it('reads the mint and owner of a token account a leg moves, with no read', async () => {
				const run = await caseRun(testCase);
				const tail = await hookTail(testCase.hookMint);
				// The source's mint, and the destination's owner.
				assert.deepEqual(
					await appended(testCase, run, [
						pda([accountData(0, 0, 32), accountData(2, 32, 32)]),
					]),
					[
						readonlyMeta(
							await probePda(
								addressEncoder.encode(testCase.hookMint),
								addressEncoder.encode(run.leg.destinationOwner),
							),
						),
						...tail,
					],
				);
				// The other leg's source and its owner, which signs that leg.
				for (const other of run.legs.legs) {
					if (other === run.leg) continue;
					assert.deepEqual(
						await appended(testCase, run, [
							fixed(other.source),
							pda([accountData(5, 32, 32)]),
						]),
						[
							readonlyMeta(other.source),
							readonlyMeta(
								await probePda(
									addressEncoder.encode(other.authority),
								),
							),
							...tail,
						],
					);
				}
			});

			it('refuses a read past the mint and owner of a token account a leg moves', async () => {
				const run = await caseRun(testCase);
				const lists = [
					// The source.
					[pda([accountData(0, 64, 8)])],
					// The destination, from byte 60.
					[pda([accountData(2, 60, 8)])],
					// A key from byte 40 of the source.
					[pubkeyData(0, 40)],
					...run.legs.legs
						.filter((other) => other !== run.leg)
						.map((other) => [
							fixed(other.destination),
							pda([accountData(5, 64, 1)]),
						]),
				];
				for (const extras of lists) {
					await assert.rejects(
						buildFrom(testCase, await armed(testCase, run, extras)),
						SWAP_TIME_DATA,
					);
				}
			});
		});
	}

	describe('refuses a read of an account the instruction writes before its transfers', () => {
		it('launchpad buy_exact_in: the curve', async () => {
			const testCase = caseNamed(
				'launchpad buildBuyExactInInstruction, Token-2022 quote',
			);
			const run = await caseRun(testCase);
			const [curve] = run.legs.written;
			await assert.rejects(
				buildFrom(
					testCase,
					await armed(
						testCase,
						run,
						[fixed(curve), pda([accountData(5, 0, 1)])],
						[[curve, view(PROBE_PROGRAM, NAMED_DATA)]],
					),
				),
				SWAP_TIME_DATA,
			);
		});

		it('and reads the market of a dex trade and a migrate, which write it after', async () => {
			for (const [name, market] of [
				[
					'dex buildBuyExactInInstruction, Token-2022 quote',
					(run: CaseRun) => run.leg.destinationOwner,
				],
				[
					'launchpad buildMigrateInstruction',
					(run: CaseRun) => run.leg.authority,
				],
			] as const) {
				const testCase = caseNamed(name);
				const run = await caseRun(testCase);
				const address = market(run);
				assert.deepEqual(
					await appended(
						testCase,
						run,
						[fixed(address), pda([accountData(5, 0, 4)])],
						[[address, view(PROBE_PROGRAM, NAMED_DATA)]],
					),
					[
						readonlyMeta(address),
						readonlyMeta(await probePda(NAMED_DATA.subarray(0, 4))),
						...(await hookTail(TKALSHI_MINT)),
					],
					name,
				);
			}
		});
	});

	describe('on a migrate', () => {
		const testCase = caseNamed('launchpad buildMigrateInstruction');

		async function migrateRun() {
			return { testCase, run: await caseRun(testCase) };
		}

		it('reads past the mint and owner of a token account no leg moves', async () => {
			const { testCase: migrateCase, run } = await migrateRun();
			assert.deepEqual(
				await appended(
					migrateCase,
					run,
					[fixed(TOKEN_ACCOUNT), pda([accountData(5, 64, 8)])],
					[
						[
							TOKEN_ACCOUNT,
							view(
								TOKEN_2022_PROGRAM_ADDRESS,
								tokenAccountData(),
							),
						],
					],
				),
				[
					readonlyMeta(TOKEN_ACCOUNT),
					readonlyMeta(
						await probePda(tokenAccountData().subarray(64, 72)),
					),
					...(await hookTail(TKALSHI_MINT)),
				],
			);
		});

		it('reads an account a list wants writable', async () => {
			const { testCase: migrateCase, run } = await migrateRun();
			assert.deepEqual(
				await appended(
					migrateCase,
					run,
					[fixed(NAMED, true), pda([accountData(5, 0, 4)])],
					[[NAMED, view(PROBE_PROGRAM, NAMED_DATA)]],
				),
				[
					writableMeta(NAMED),
					readonlyMeta(await probePda(NAMED_DATA.subarray(0, 4))),
					...(await hookTail(TKALSHI_MINT)),
				],
			);
		});

		it('fails a read of a missing account, as the chain does, and reads no bytes of one', async () => {
			const { testCase: migrateCase, run } = await migrateRun();
			const missing: [Address, null] = [MISSING, null];
			await assert.rejects(
				buildFrom(
					migrateCase,
					await armed(
						migrateCase,
						run,
						[fixed(MISSING), pda([accountData(5, 0, 1)])],
						[missing],
					),
				),
				EXTRA_UNRESOLVED,
			);
			assert.deepEqual(
				await appended(
					migrateCase,
					run,
					[fixed(MISSING), pda([accountData(5, 0, 0)])],
					[missing],
				),
				[
					readonlyMeta(MISSING),
					readonlyMeta(await probePda(new Uint8Array(0))),
					...(await hookTail(TKALSHI_MINT)),
				],
			);
		});

		it('follows a key read from the authority to the account it names: the quote mint’s read lacks both, and the caller reads each as the build names it, at the first read’s slot or later', async () => {
			const { testCase: migrateCase, run } = await migrateRun();
			const curve = run.leg.authority;
			const slot = 77;
			const chain = await armedState(
				TKALSHI_MINT,
				[pubkeyData(3, 8), pda([accountData(5, 0, 4)])],
				[BASE_MINT],
				[
					[
						curve,
						view(SEND_LAUNCHPAD_PROGRAM_ADDRESS, AUTHORITY_DATA),
					],
					[NAMED, view(PROBE_PROGRAM, NAMED_DATA)],
				],
			);
			const expected = [
				readonlyMeta(NAMED),
				readonlyMeta(await probePda(NAMED_DATA.subarray(0, 4))),
				...(await hookTail(TKALSHI_MINT)),
			];
			assert.deepEqual(await trailing(migrateCase, run, chain), expected);
			const config = { encoding: 'base64', commitment: 'confirmed' };
			const later = { ...config, minContextSlot: BigInt(slot) };
			const validation = await validationOf(TKALSHI_MINT);
			// The mints' read, then the quote's list. The curve is the
			// authority, which the instruction sets.
			const { filled, calls } = await filledFrom(
				chain,
				migrateCase,
				slot,
			);
			const fill = [
				{
					method: 'getMultipleAccounts',
					params: [[BASE_MINT, TKALSHI_MINT, CLOCK], config],
				},
				{
					method: 'getMultipleAccounts',
					params: [[validation], later],
				},
			];
			assert.deepEqual(calls, fill);
			await assert.rejects(migrateCase.build(filled), notLoaded([curve]));
			assert.deepEqual(calls, fill);
			// The caller reads what each build names into a copy of the hook,
			// and builds again.
			const { rpc, calls: reads } = rpcOver(chain, slot);
			const { built, infos } = await buildWithReads(
				rpc,
				filled,
				(current) => migrateCase.build(current),
			);
			assert.deepEqual(
				infos,
				fetchedInfos(migrateCase, chain, [
					TKALSHI_MINT,
					validation,
					curve,
					NAMED,
				]),
			);
			assert.deepEqual(built, await migrateCase.build(infos));
			assert.deepEqual(reads, [
				{ method: 'getMultipleAccounts', params: [[curve], config] },
				{ method: 'getMultipleAccounts', params: [[NAMED], later] },
			]);
			assert.deepEqual(
				await trailingOf(migrateCase, run, infos),
				expected,
			);
		});
	});

	describe('on a trade where both mints run a hook', () => {
		const testCase = caseNamed(
			'dex buildBuyExactInInstruction, Token-2022 quote',
		);

		it('reads an account the other leg’s list wants writable', async () => {
			const run = await caseRun(testCase);
			// The quote list wants the base mint writable, and the base list
			// reads it.
			assert.deepEqual(
				await trailing(testCase, run, {
					accounts: new Map([
						...(await probeAccountsOf(
							TKALSHI_MINT,
							list([fixed(BASE_MINT, true)]),
						)),
						...(await probeAccountsOf(
							BASE_MINT,
							list([pda([accountData(1, 170, 32)])]),
						)),
					]),
				}),
				[
					writableMeta(BASE_MINT),
					readonlyMeta(PROBE_PROGRAM),
					readonlyMeta(await validationOf(TKALSHI_MINT)),
					readonlyMeta(await probePda(HOOK_AUTHORITY)),
					readonlyMeta(await validationOf(BASE_MINT)),
				],
			);
		});

		it('names what both legs read at once, quote first', async () => {
			const run = await caseRun(testCase);
			await assert.rejects(
				buildFrom(testCase, {
					accounts: new Map([
						...(await probeAccountsOf(
							TKALSHI_MINT,
							list([pda([accountData(3, 0, 8)])]),
						)),
						...(await probeAccountsOf(
							BASE_MINT,
							list([fixed(NAMED), pda([accountData(5, 0, 4)])]),
						)),
					]),
				}),
				notLoaded([run.leg.authority, NAMED]),
			);
		});
	});
});

const AMOUNT_SEED = [pda([instructionData(8, 8)])];
const AMOUNT_REFUSED = refusal('Unresolvable(ReadsTransferAmount)');

describe('a seed on the transfer amount', () => {
	for (const testCase of HOOK_FREE_CASES) {
		it(`${testCase.name}: refuses it`, async () => {
			const run = await caseRun(testCase);
			await assert.rejects(
				buildFrom(testCase, await armed(testCase, run, AMOUNT_SEED)),
				AMOUNT_REFUSED,
			);
		});
	}

	it('refuses it from the quote mint’s read, which takes the mint and the list', async () => {
		const { rpc, calls } = rpcOver(
			await armedState(TKALSHI_MINT, AMOUNT_SEED, [BASE_MINT]),
		);
		const { quoteMintInfo } = await fetchMintInfo(rpc, {
			quoteMint: TKALSHI_MINT,
		});
		assert.deepEqual(
			calls.map(({ params }) => params[0]),
			[[TKALSHI_MINT, CLOCK], [await validationOf(TKALSHI_MINT)]],
		);
		await assert.rejects(
			launchpad.migrate.buildMigrateInstruction({
				caller: user,
				baseMintInfo: plainMintInfo(BASE_MINT),
				quoteMintInfo,
			}),
			AMOUNT_REFUSED,
		);
		assert.equal(calls.length, 2);
	});
});
