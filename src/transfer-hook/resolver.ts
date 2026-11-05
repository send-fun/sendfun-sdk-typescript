// Resolves the Token-2022 transfer-hook accounts of an instruction from
// accounts that you fetch, as SPL's resolver does. Rust
// `sendfun_sdk::transfer_hook`.
// Parses every byte by hand, as SPL reads it: the list's TLV envelope
// (`unpackList`), each extra's address config (`decodeConfig`), the signer and
// writable flags (`screenExtra`) and the mint (`decodeMintState`).
// `@solana-program/token-2022` reads some of them differently.
//
// The programs resolve nothing. Each Token-2022 transfer CPI forwards the
// whole trailing list. Token-2022 finds the hook program, the validation
// account and each extra by key.
//
// The resolver refuses what no resolver can resolve before the instruction
// runs, and a list with a seed on the transfer amount (`Unresolvable`).

import {
	AccountRole,
	getAddressDecoder,
	getAddressEncoder,
	getProgramDerivedAddress,
	isSolanaError,
	isWritableRole,
	SOLANA_ERROR__ADDRESSES__FAILED_TO_FIND_VIABLE_PDA_BUMP_SEED,
	SOLANA_ERROR__ADDRESSES__MAX_NUMBER_OF_PDA_SEEDS_EXCEEDED,
	SOLANA_ERROR__ADDRESSES__MAX_PDA_SEED_LENGTH_EXCEEDED,
	type AccountMeta,
	type Address,
	type ReadonlyUint8Array,
} from '@solana/kit';

import {
	TOKEN_2022_PROGRAM_ADDRESS,
	TOKEN_PROGRAM_ADDRESS,
} from '../constants.js';
import {
	checkSplTokenMint,
	decodeTransferFeeValue,
	mintDecimals,
	mintExtension,
	mintTlv,
	TRANSFER_FEE_CONFIG,
	type ExtensionLayout,
	type TransferFeeConfig,
} from '../utils/mint-extensions.js';

/** Discriminator of the hook's `Execute` instruction. Also the TLV type of the entry that holds the
 *  account list. */
export const EXECUTE_DISCRIMINATOR: ReadonlyUint8Array = new Uint8Array([
	105, 37, 101, 197, 75, 251, 102, 26,
]);

/** Seeds of the validation account: `["extra-account-metas", mint]`, under the hook program. */
export const VALIDATION_SEED = 'extra-account-metas';

/** A fetched account: the program that owns it and its data. */
export interface AccountView {
	readonly owner: Address;
	readonly data: ReadonlyUint8Array;
}

/** Rust `Fetched`: what a lookup knows of an account. `null` is a missing account, `undefined` one
 *  not fetched yet. */
export type AccountLookup = (
	address: Address,
) => AccountView | null | undefined;

/** Rust `MintState`. */
export interface MintState {
	/** The program that owns the mint. */
	readonly tokenProgram: Address;
	/** Fixed when the mint is created. */
	readonly decimals: number;
	/** `null` when the mint has no `TransferFeeConfig` extension. `feeScheduleOf` turns it into a
	 *  `FeeSchedule`. */
	readonly transferFee: TransferFeeConfig | null;
	/** The hook program. Token-2022 calls it on every transfer, and the instruction must carry its
	 *  accounts. `null` when the mint has no `TransferHook` extension or its `program_id` is
	 *  unset. */
	readonly hookProgram: Address | null;
}

/** Each string is the `Debug` output of the Rust enum value of the same name. */
export type Unresolvable =
	| 'MalformedList'
	| 'NoExecuteEntry'
	/** An extra is at an account index above 255. */
	| 'ListTooLong'
	| 'MalformedExtra'
	| 'MalformedSeed'
	/** A PDA has more than 15 seeds. The bump is the 16th. */
	| 'TooManySeeds'
	| 'SeedTooLong'
	/** SPL's resolver fails on an extra: a read past the end of an account's data, or of a missing
	 *  account, or seeds no address takes. */
	| 'ExtraUnresolved'
	/** A seed reads the transfer amount. */
	| 'ReadsTransferAmount'
	/** An extra reads past byte 16 of the `Execute` data: the discriminator, then the amount. */
	| 'ReadsPastInstructionData'
	/** An extra names an account at its own index or later. */
	| 'NamesUnresolvedAccount'
	/** An extra reads data that changes before the hook runs. This is data
	 *  past the mint and owner of a token account that the instruction moves,
	 *  or an account that it writes first. */
	| 'ReadsSwapTimeData';

export type HookError =
	/** The mint, its hook's list or an account a list reads was not fetched. */
	| 'NotLoaded'
	/** The validation account is missing, or the hook program does not own it. Token-2022 still
	 *  calls the hook, and the transfer fails. */
	| 'NoList'
	/** The account at a leg's mint is no mint that a token program owns, or its extensions do not
	 *  decode. Whether it runs a hook is unknown. */
	| 'MalformedMint'
	| `Unresolvable(${Unresolvable})`;

const UNRESOLVABLE_MESSAGES: Record<Unresolvable, string> = {
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

function isUnresolvable(value: string): value is Unresolvable {
	return Object.hasOwn(UNRESOLVABLE_MESSAGES, value);
}

/** The Rust `Display` text of `error`. */
export function describeHookError(error: HookError): string {
	if (error === 'NotLoaded') return 'transfer hook accounts not loaded';
	if (error === 'NoList') return 'transfer hook has no ExtraAccountMetaList';
	if (error === 'MalformedMint') {
		return "a transfer's mint does not decode as a mint";
	}
	const reason = error.slice('Unresolvable('.length, -1);
	return `transfer hook cannot be resolved ahead of the instruction: ${
		isUnresolvable(reason) ? UNRESOLVABLE_MESSAGES[reason] : reason
	}`;
}

/** Thrown when a build cannot resolve a transfer hook. `error` names the
 *  reason. On `NotLoaded`, fetch the accounts at `addresses`. Add them to
 *  `hook.accounts` in a copy of each mint info whose `hook` is not `null`, and
 *  build again. */
export class TransferHookError extends Error {
	readonly error: HookError;
	readonly addresses: readonly Address[];

	constructor(error: HookError, addresses: readonly Address[] = []) {
		const message = describeHookError(error);
		super(
			addresses.length === 0
				? message
				: `${message}: fetch ${addresses.join(', ')}`,
		);
		this.name = 'TransferHookError';
		this.error = error;
		this.addresses = Object.freeze([...addresses]);
	}
}

function unresolvable(reason: Unresolvable): TransferHookError {
	return new TransferHookError(`Unresolvable(${reason})`);
}

/** The state of a hook's `ExtraAccountMetaList`. */
export type HookList =
	| { readonly kind: 'NotFetched' }
	| { readonly kind: 'Missing' }
	| { readonly kind: 'Loaded'; readonly data: ReadonlyUint8Array };

/** A mint's armed hook and the state of its list. Rust `Hook`. Build it with `loadHook`. */
export interface Hook {
	readonly mint: Address;
	readonly program: Address;
	readonly validation: Address;
	readonly list: HookList;
}

/** The hooks of a market's two mints. `null` is a hook-free mint. */
export interface MarketHooks {
	readonly base: Hook | null;
	readonly quote: Hook | null;
}

/** One Token-2022 transfer an instruction makes. */
export interface HookLeg {
	readonly source: Address;
	readonly mint: Address;
	readonly destination: Address;
	/** Signs the transfer and owns `source`. */
	readonly authority: Address;
	readonly destinationOwner: Address;
}

/** The transfers of one instruction, in the order the program makes them. */
export interface HookLegs {
	readonly legs: readonly HookLeg[];
	/** Accounts the instruction writes before its transfers. A list that reads one does not
	 *  resolve. */
	readonly written: readonly Address[];
}

/** Rust `Resolution`. */
export type HookResolution =
	/** The hook accounts of every leg, merged. Append them after every account of the
	 *  instruction. Empty when no leg's mint runs a hook. */
	| { readonly kind: 'Accounts'; readonly accounts: AccountMeta[] }
	/** The accounts to fetch: a leg's mint, a hook's list or an account a list
	 *  reads. Fetch them and resolve again: their data can name more. */
	| { readonly kind: 'Fetch'; readonly addresses: Address[] };

const addressDecoder = getAddressDecoder();
const addressEncoder = getAddressEncoder();

// The parser's own copy. A consumer can write to the exported array.
const EXECUTE: ReadonlyUint8Array = new Uint8Array(EXECUTE_DISCRIMINATOR);

// What `getProgramDerivedAddress` throws for seeds no address takes. Anything
// else, such as a missing `crypto.subtle`, is not a property of the list.
const PDA_DERIVATION_ERRORS = [
	SOLANA_ERROR__ADDRESSES__FAILED_TO_FIND_VIABLE_PDA_BUMP_SEED,
	SOLANA_ERROR__ADDRESSES__MAX_NUMBER_OF_PDA_SEEDS_EXCEEDED,
	SOLANA_ERROR__ADDRESSES__MAX_PDA_SEED_LENGTH_EXCEEDED,
] as const;

// `Execute` accounts: source, mint, destination, authority, validation account.
const VALIDATION_INDEX = 4;
const EXECUTE_ACCOUNTS = 5;

// The `Execute` data: the discriminator, then the amount as a little-endian u64.
const EXECUTE_DATA_LENGTH = 16;

// Mint and owner: the token-account bytes that no transfer changes.
const TOKEN_ACCOUNT_KNOWN_LENGTH = 64;

const PUBKEY_LENGTH = 32;

// An extra's account index is a `u8`.
const MAX_ACCOUNT_INDEX = 255;

// With the bump. `find_program_address` panics past it.
const MAX_SEEDS = 16;

// SPL `ExtraAccountMeta` discriminators. 3 to 127 are none. 128 and above: a
// PDA of the program at index `discriminator - 128`.
const META_LITERAL = 0;
const META_HOOK_PDA = 1;
const META_PUBKEY_DATA = 2;
const META_EXTERNAL_PDA = 128;

// SPL `Seed` kinds. A zero kind ends the seeds.
const SEED_LITERAL = 1;
const SEED_INSTRUCTION_DATA = 2;
const SEED_ACCOUNT_KEY = 3;
const SEED_ACCOUNT_DATA = 4;

// SPL `PubkeyData` kinds.
const PUBKEY_DATA_INSTRUCTION_DATA = 1;
const PUBKEY_DATA_ACCOUNT_DATA = 2;

// `ExtraAccountMetaList` TLV entries: an 8-byte type, a u32 length, the value.
const LIST_TYPE_LENGTH = 8;
const LIST_HEADER_LENGTH = 12;

// The `Execute` value: a u32 count, then the metas. A meta is a u8
// discriminator, a 32-byte address config, then the signer and writable bools.
const LIST_COUNT_LENGTH = 4;
const META_LENGTH = 35;
const META_DISCRIMINATOR = 0;
const META_CONFIG = 1;
const META_SIGNER = 33;
const META_WRITABLE = 34;

// Authority, then `program_id`. An all-zero key is unset.
const TRANSFER_HOOK: ExtensionLayout = { type: 14, length: 64 };
const HOOK_PROGRAM_OFFSET = 32;

/** SPL `Seed`. None is `Uninitialized`: the seeds end there. */
type Seed =
	| { readonly __kind: 'Literal'; readonly bytes: ReadonlyUint8Array }
	| {
			readonly __kind: 'InstructionData';
			readonly index: number;
			readonly length: number;
	  }
	| { readonly __kind: 'AccountKey'; readonly index: number }
	| {
			readonly __kind: 'AccountData';
			readonly accountIndex: number;
			readonly dataIndex: number;
			readonly length: number;
	  };

/** SPL `PubkeyData`. None is `Uninitialized`: no extra resolves it. */
type PubkeyData =
	| { readonly __kind: 'InstructionData'; readonly index: number }
	| {
			readonly __kind: 'AccountData';
			readonly accountIndex: number;
			readonly dataIndex: number;
	  };

/** An extra's discriminator and 32-byte address config. */
type AddressConfig =
	| { readonly __kind: 'Literal'; readonly address: Address }
	| { readonly __kind: 'ProgramPda'; readonly seeds: readonly Seed[] }
	| {
			readonly __kind: 'AccountPda';
			readonly accountIndex: number;
			readonly seeds: readonly Seed[];
	  }
	| { readonly __kind: 'PubkeyData'; readonly pubkeyData: PubkeyData };

/** An SPL `ExtraAccountMeta` that passed the screen. */
interface ScreenedExtra {
	readonly config: AddressConfig;
	readonly isSigner: boolean;
	readonly isWritable: boolean;
}

type ListUnpack =
	| {
			readonly ok: true;
			/** The 35 bytes of each meta, in list order. */
			readonly metas: readonly ReadonlyUint8Array[];
	  }
	| {
			readonly ok: false;
			readonly reason: 'MalformedList' | 'NoExecuteEntry';
	  };

/** An `Execute` account, as SPL's resolver sees it: its key and the data it can read, if any. */
interface ExecuteAccount {
	readonly key: Address;
	readonly data: ReadonlyUint8Array | undefined;
}

function readU32(data: ReadonlyUint8Array, offset: number): number {
	return (
		(data[offset] |
			(data[offset + 1] << 8) |
			(data[offset + 2] << 16) |
			(data[offset + 3] << 24)) >>>
		0
	);
}

function isZero(data: ReadonlyUint8Array, start: number, end: number): boolean {
	return data.subarray(start, end).every((byte) => byte === 0);
}

function isExecuteType(data: ReadonlyUint8Array, start: number): boolean {
	return EXECUTE.every((byte, index) => data[start + index] === byte);
}

/** `length` bytes at `start`, or `undefined` past the end, as SPL's resolver reads data. */
function slice(
	data: ReadonlyUint8Array,
	start: number,
	length: number,
): ReadonlyUint8Array | undefined {
	const end = start + length;
	return end > data.length ? undefined : data.subarray(start, end);
}

// SPL `TlvStateBorrowed::unpack`: every entry is whole, up to the end or a
// zero type. A tail too short for a type must be zero.
function listEntriesWhole(data: ReadonlyUint8Array): boolean {
	let start = 0;
	while (start < data.length) {
		if (data.length < start + LIST_TYPE_LENGTH) {
			return isZero(data, start, data.length);
		}
		if (isZero(data, start, start + LIST_TYPE_LENGTH)) return true;
		if (data.length < start + LIST_HEADER_LENGTH) return false;
		const end =
			start +
			LIST_HEADER_LENGTH +
			readU32(data, start + LIST_TYPE_LENGTH);
		if (end > data.length) return false;
		start = end;
	}
	return true;
}

// SPL `get_first_bytes::<Execute>`. A zero type before the entry is
// `TypeNotFound`. A walk off the end, before or inside the entry, is
// malformed.
function executeEntry(
	data: ReadonlyUint8Array,
): ReadonlyUint8Array | 'MalformedList' | 'NoExecuteEntry' {
	let start = 0;
	while (start < data.length) {
		if (data.length < start + LIST_HEADER_LENGTH) return 'MalformedList';
		const valueStart = start + LIST_HEADER_LENGTH;
		const valueEnd = valueStart + readU32(data, start + LIST_TYPE_LENGTH);
		if (isExecuteType(data, start)) {
			return valueEnd > data.length
				? 'MalformedList'
				: data.subarray(valueStart, valueEnd);
		}
		if (isZero(data, start, start + LIST_TYPE_LENGTH)) {
			return 'NoExecuteEntry';
		}
		start = valueEnd;
	}
	return 'MalformedList';
}

// Rust `unpack_list`: `TypeNotFound` is `NoExecuteEntry`, any other error is
// `MalformedList`. Do not use the library's list decoder: it checks neither
// the type nor the length of an entry, and it does not find an `Execute` entry
// after a foreign entry.
function unpackList(data: ReadonlyUint8Array): ListUnpack {
	if (!listEntriesWhole(data)) return { ok: false, reason: 'MalformedList' };
	const entry = executeEntry(data);
	if (typeof entry === 'string') return { ok: false, reason: entry };
	// spl-list-view `ListView::unpack`: whole metas after the count, at least
	// `count` of them.
	const body = entry.length - LIST_COUNT_LENGTH;
	if (body < 0 || body % META_LENGTH !== 0) {
		return { ok: false, reason: 'MalformedList' };
	}
	const count = readU32(entry, 0);
	if (count > body / META_LENGTH) {
		return { ok: false, reason: 'MalformedList' };
	}
	const metas = Array.from({ length: count }, (_, index) =>
		entry.subarray(
			LIST_COUNT_LENGTH + index * META_LENGTH,
			LIST_COUNT_LENGTH + (index + 1) * META_LENGTH,
		),
	);
	return { ok: true, metas };
}

// SPL `ExtraAccountMeta::resolve`'s reading of the address config.
// `undefined` for one that SPL's resolver fails on too.
function decodeConfig(meta: ReadonlyUint8Array): AddressConfig | undefined {
	const discriminator = meta[META_DISCRIMINATOR];
	const config = meta.subarray(META_CONFIG, META_SIGNER);
	if (discriminator === META_LITERAL) {
		return { __kind: 'Literal', address: addressDecoder.decode(config) };
	}
	if (discriminator === META_PUBKEY_DATA) {
		const pubkeyData = unpackPubkeyData(config);
		return pubkeyData === undefined
			? undefined
			: { __kind: 'PubkeyData', pubkeyData };
	}
	if (discriminator !== META_HOOK_PDA && discriminator < META_EXTERNAL_PDA) {
		return undefined;
	}
	const seeds = unpackSeeds(config);
	if (seeds === undefined) return undefined;
	return discriminator === META_HOOK_PDA
		? { __kind: 'ProgramPda', seeds }
		: {
				__kind: 'AccountPda',
				accountIndex: discriminator - META_EXTERNAL_PDA,
				seeds,
			};
}

// SPL `Seed::unpack_address_config`: seeds up to the end of the config or a
// zero kind. The bytes after a zero kind are ignored.
function unpackSeeds(config: ReadonlyUint8Array): Seed[] | undefined {
	const seeds: Seed[] = [];
	let start = 0;
	while (start < config.length && config[start] !== 0) {
		const seed = unpackSeed(config, start);
		if (seed === undefined) return undefined;
		seeds.push(seed);
		start += seedSize(seed);
	}
	return seeds;
}

// SPL `Seed::unpack`: a kind, then its fields. `undefined` for an unknown
// kind or a seed that runs past the config.
function unpackSeed(
	config: ReadonlyUint8Array,
	start: number,
): Seed | undefined {
	const fields = config.subarray(start + 1);
	switch (config[start]) {
		case SEED_LITERAL: {
			// A length, then that many bytes.
			if (fields.length === 0) return undefined;
			const bytes = fields.subarray(1, 1 + fields[0]);
			return bytes.length < fields[0]
				? undefined
				: { __kind: 'Literal', bytes };
		}
		case SEED_INSTRUCTION_DATA:
			return fields.length < 2
				? undefined
				: {
						__kind: 'InstructionData',
						index: fields[0],
						length: fields[1],
					};
		case SEED_ACCOUNT_KEY:
			return fields.length < 1
				? undefined
				: { __kind: 'AccountKey', index: fields[0] };
		case SEED_ACCOUNT_DATA:
			return fields.length < 3
				? undefined
				: {
						__kind: 'AccountData',
						accountIndex: fields[0],
						dataIndex: fields[1],
						length: fields[2],
					};
		default:
			return undefined;
	}
}

// SPL `Seed::tlv_size`: the kind and its fields.
function seedSize(seed: Seed): number {
	switch (seed.__kind) {
		case 'Literal':
			return 2 + seed.bytes.length;
		case 'InstructionData':
			return 3;
		case 'AccountKey':
			return 2;
		case 'AccountData':
			return 4;
	}
}

// SPL `PubkeyData::unpack`, which ignores the bytes after the fields.
// `undefined` for any other kind. SPL unpacks a zero kind as `Uninitialized`
// and fails to resolve it.
function unpackPubkeyData(config: ReadonlyUint8Array): PubkeyData | undefined {
	switch (config[0]) {
		case PUBKEY_DATA_INSTRUCTION_DATA:
			return { __kind: 'InstructionData', index: config[1] };
		case PUBKEY_DATA_ACCOUNT_DATA:
			return {
				__kind: 'AccountData',
				accountIndex: config[1],
				dataIndex: config[2],
			};
		default:
			return undefined;
	}
}

// Rust `screen_list`: refuses a list that SPL's resolver fails or panics on,
// whatever the transfer, and a list that reads the transfer amount.
function screenList(data: ReadonlyUint8Array): ScreenedExtra[] {
	const list = unpackList(data);
	if (!list.ok) throw unresolvable(list.reason);
	const extras: ScreenedExtra[] = [];
	for (const [index, meta] of list.metas.entries()) {
		const position = index + EXECUTE_ACCOUNTS;
		if (position > MAX_ACCOUNT_INDEX) throw unresolvable('ListTooLong');
		extras.push(screenExtra(meta, position));
	}
	if (readsAmount(extras)) throw unresolvable('ReadsTransferAmount');
	return extras;
}

// One 35-byte meta. The flags are read by hand, as SPL `PodBool`: any
// non-zero byte is true, where the library reads only 1 as true.
function screenExtra(
	meta: ReadonlyUint8Array,
	position: number,
): ScreenedExtra {
	const config = decodeConfig(meta);
	if (config === undefined) {
		throw unresolvable(undecodable(meta[META_DISCRIMINATOR], position));
	}
	const reason = screenConfig(config, position);
	if (reason !== undefined) throw unresolvable(reason);
	return {
		config,
		isSigner: meta[META_SIGNER] !== 0,
		isWritable: meta[META_WRITABLE] !== 0,
	};
}

// Rust `screen_extra`'s error for a config that does not decode. Each
// discriminator selects one unpacker, so it names what failed. An external
// PDA names its program before its seeds are read.
function undecodable(discriminator: number, position: number): Unresolvable {
	if (discriminator === META_HOOK_PDA) return 'MalformedSeed';
	if (discriminator >= META_EXTERNAL_PDA) {
		return (
			prior(discriminator - META_EXTERNAL_PDA, position) ??
			'MalformedSeed'
		);
	}
	// `PubkeyData` of an unknown kind, `Uninitialized` included, or a
	// discriminator from 3 to 127.
	return 'MalformedExtra';
}

function screenConfig(
	config: AddressConfig,
	position: number,
): Unresolvable | undefined {
	switch (config.__kind) {
		case 'Literal':
			return undefined;
		case 'ProgramPda':
			return screenSeeds(config.seeds, position);
		case 'AccountPda':
			return (
				prior(config.accountIndex, position) ??
				screenSeeds(config.seeds, position)
			);
		case 'PubkeyData':
			// A pubkey is 32 bytes. The `Execute` data is 16.
			return config.pubkeyData.__kind === 'AccountData'
				? prior(config.pubkeyData.accountIndex, position)
				: 'ReadsPastInstructionData';
	}
}

function screenSeeds(
	seeds: readonly Seed[],
	position: number,
): Unresolvable | undefined {
	// With the bump, this is above `MAX_SEEDS`: `find_program_address` panics.
	if (seeds.length >= MAX_SEEDS) return 'TooManySeeds';
	for (const seed of seeds) {
		const reason = screenSeed(seed, position);
		if (reason !== undefined) return reason;
	}
	return undefined;
}

function screenSeed(seed: Seed, position: number): Unresolvable | undefined {
	switch (seed.__kind) {
		// A literal fits in the 32-byte config. It is never too long.
		case 'Literal':
			return undefined;
		case 'InstructionData':
			return seed.index + seed.length > EXECUTE_DATA_LENGTH
				? 'ReadsPastInstructionData'
				: undefined;
		case 'AccountKey':
			return prior(seed.index, position);
		case 'AccountData':
			return seed.length > PUBKEY_LENGTH
				? 'SeedTooLong'
				: prior(seed.accountIndex, position);
	}
}

// `index` must name an account resolved before `position`, as on-chain.
function prior(index: number, position: number): Unresolvable | undefined {
	return index < position ? undefined : 'NamesUnresolvedAccount';
}

function seedsOf(config: AddressConfig): readonly Seed[] {
	return config.__kind === 'ProgramPda' || config.__kind === 'AccountPda'
		? config.seeds
		: [];
}

// Rust `reads_amount`: `true` if a seed reads bytes 8 to 16 of `Execute`, the
// transfer amount.
function readsAmount(extras: readonly ScreenedExtra[]): boolean {
	return extras.some(({ config }) =>
		seedsOf(config).some(
			(seed) =>
				seed.__kind === 'InstructionData' &&
				seed.length > 0 &&
				seed.index + seed.length > EXECUTE.length,
		),
	);
}

// The account index and end of each read of account data that `config` makes.
function dataReads(
	config: AddressConfig,
): { readonly account: number; readonly end: number }[] {
	if (config.__kind === 'PubkeyData') {
		return config.pubkeyData.__kind === 'AccountData'
			? [
					{
						account: config.pubkeyData.accountIndex,
						end: config.pubkeyData.dataIndex + PUBKEY_LENGTH,
					},
				]
			: [];
	}
	return seedsOf(config).flatMap((seed) =>
		seed.__kind === 'AccountData'
			? [
					{
						account: seed.accountIndex,
						end: seed.dataIndex + seed.length,
					},
				]
			: [],
	);
}

async function derive(
	programAddress: Address,
	seeds: ReadonlyUint8Array[],
): Promise<Address | undefined> {
	try {
		const [pda] = await getProgramDerivedAddress({ programAddress, seeds });
		return pda;
	} catch (error) {
		if (PDA_DERIVATION_ERRORS.some((code) => isSolanaError(error, code))) {
			return undefined;
		}
		throw error;
	}
}

function seedBytes(
	seed: Seed,
	data: ReadonlyUint8Array,
	account: (index: number) => ExecuteAccount | undefined,
): ReadonlyUint8Array | undefined {
	switch (seed.__kind) {
		case 'Literal':
			return seed.bytes;
		case 'InstructionData':
			return slice(data, seed.index, seed.length);
		case 'AccountKey': {
			const key = account(seed.index)?.key;
			return key === undefined ? undefined : addressEncoder.encode(key);
		}
		case 'AccountData': {
			const read = account(seed.accountIndex)?.data;
			return read === undefined
				? undefined
				: slice(read, seed.dataIndex, seed.length);
		}
	}
}

function pubkeyBytes(
	config: PubkeyData,
	data: ReadonlyUint8Array,
	account: (index: number) => ExecuteAccount | undefined,
): ReadonlyUint8Array | undefined {
	if (config.__kind === 'InstructionData') {
		return slice(data, config.index, PUBKEY_LENGTH);
	}
	const read = account(config.accountIndex)?.data;
	return read === undefined
		? undefined
		: slice(read, config.dataIndex, PUBKEY_LENGTH);
}

// SPL `ExtraAccountMeta::resolve` with the `Execute` data. `undefined` where
// SPL fails.
async function resolveExtra(
	config: AddressConfig,
	program: Address,
	data: ReadonlyUint8Array,
	account: (index: number) => ExecuteAccount | undefined,
): Promise<Address | undefined> {
	switch (config.__kind) {
		case 'Literal':
			return config.address;
		case 'PubkeyData': {
			const key = pubkeyBytes(config.pubkeyData, data, account);
			return key === undefined ? undefined : addressDecoder.decode(key);
		}
		case 'ProgramPda':
		case 'AccountPda': {
			const owner =
				config.__kind === 'ProgramPda'
					? program
					: account(config.accountIndex)?.key;
			if (owner === undefined) return undefined;
			const bytes: ReadonlyUint8Array[] = [];
			for (const seed of config.seeds) {
				const value = seedBytes(seed, data, account);
				if (value === undefined) return undefined;
				bytes.push(value);
			}
			return derive(owner, bytes);
		}
	}
}

function tokenAccountPrefix(mint: Address, owner: Address): Uint8Array {
	const prefix = new Uint8Array(TOKEN_ACCOUNT_KNOWN_LENGTH);
	prefix.set(addressEncoder.encode(mint));
	prefix.set(addressEncoder.encode(owner), PUBKEY_LENGTH);
	return prefix;
}

function readonlyMeta(account: Address): AccountMeta {
	return { address: account, role: AccountRole.READONLY };
}

// Rust `execute_data`: the discriminator, then a zero amount. No screened
// list reads the amount.
const EXECUTE_DATA: ReadonlyUint8Array = (() => {
	const data = new Uint8Array(EXECUTE_DATA_LENGTH);
	data.set(EXECUTE);
	return data;
})();

/** The validation account of `mint`: `["extra-account-metas", mint]` under `hookProgram`. */
export async function findValidationAddress(
	mint: Address,
	hookProgram: Address,
): Promise<Address> {
	const [validation] = await getProgramDerivedAddress({
		programAddress: hookProgram,
		seeds: [VALIDATION_SEED, addressEncoder.encode(mint)],
	});
	return validation;
}

/** Rust `MintState::load`. Throws `RangeError` if `mint.owner` is not a token
 *  program or `mint.data` is not an initialized mint. An SPL Token mint is the
 *  82-byte base mint alone, with no hook and no fee. */
export function decodeMintState(mint: AccountView): MintState {
	const caller = 'decodeMintState';
	const tokenProgram = mint.owner;
	if (tokenProgram === TOKEN_PROGRAM_ADDRESS) {
		checkSplTokenMint(caller, mint.data);
		return {
			tokenProgram,
			decimals: mintDecimals(mint.data),
			transferFee: null,
			hookProgram: null,
		};
	}
	if (tokenProgram !== TOKEN_2022_PROGRAM_ADDRESS) {
		throw new RangeError(
			`${caller}: ${tokenProgram} is not a token program`,
		);
	}
	const tlv = mintTlv(caller, mint.data);
	const fee = mintExtension(caller, tlv, TRANSFER_FEE_CONFIG);
	const hook = mintExtension(caller, tlv, TRANSFER_HOOK);
	const program = hook?.subarray(HOOK_PROGRAM_OFFSET);
	return {
		tokenProgram,
		decimals: mintDecimals(mint.data),
		transferFee: fee === undefined ? null : decodeTransferFeeValue(fee),
		// Token-2022 calls a hook only when `program_id` is set.
		hookProgram:
			program === undefined || isZero(program, 0, program.length)
				? null
				: addressDecoder.decode(program),
	};
}

/** Rust `Hook::load`. `null` for a mint that runs no hook. Reads the list at its validation address
 *  from `lookup`. A list that the hook program does not own is missing. */
export async function loadHook(
	mint: Address,
	state: MintState,
	lookup: AccountLookup,
): Promise<Hook | null> {
	const program = state.hookProgram;
	if (program === null) return null;
	const validation = await findValidationAddress(mint, program);
	const account = lookup(validation);
	let list: HookList;
	if (account === undefined) list = { kind: 'NotFetched' };
	else if (account === null || account.owner !== program) {
		list = { kind: 'Missing' };
	} else list = { kind: 'Loaded', data: new Uint8Array(account.data) };
	return { mint, program, validation, list };
}

// Rust `Hook::extras`.
function hookExtras(hook: Hook): ScreenedExtra[] {
	switch (hook.list.kind) {
		case 'NotFetched':
			throw new TransferHookError('NotLoaded', [hook.validation]);
		case 'Missing':
			throw new TransferHookError('NoList');
		case 'Loaded':
			return screenList(hook.list.data);
	}
}

/** Rust `Hook::check`. Throws `TransferHookError` unless the list is loaded and SPL's resolver can
 *  read every extra. A list that passes can still fail on one leg: see `hookAccounts`. */
export function checkHook(hook: Hook): void {
	hookExtras(hook);
}

// Rust `moved_accounts`: the token accounts the legs move, each with its mint
// and owner.
function movedAccounts(legs: HookLegs): Map<Address, Uint8Array> {
	const moved = new Map<Address, Uint8Array>();
	for (const leg of legs.legs) {
		for (const [account, owner] of [
			[leg.source, leg.authority],
			[leg.destination, leg.destinationOwner],
		] as const) {
			if (!moved.has(account)) {
				moved.set(account, tokenAccountPrefix(leg.mint, owner));
			}
		}
	}
	return moved;
}

const NO_DATA: ReadonlyUint8Array = new Uint8Array(0);

// Rust `Reader::read`: the data of `key` that a read up to byte `end` sees on
// chain, or `undefined` for an account not fetched.
function readData(
	key: Address,
	end: number,
	moved: ReadonlyMap<Address, Uint8Array>,
	legs: HookLegs,
	lookup: AccountLookup,
): ReadonlyUint8Array | undefined {
	const prefix = moved.get(key);
	if (prefix !== undefined) {
		// Past the mint and owner, the transfer changes the account.
		if (end > TOKEN_ACCOUNT_KNOWN_LENGTH) {
			throw unresolvable('ReadsSwapTimeData');
		}
		return prefix;
	}
	if (legs.written.includes(key)) throw unresolvable('ReadsSwapTimeData');
	const account = lookup(key);
	if (account === undefined) return undefined;
	// On chain a missing account has no data, and the read fails.
	return account === null ? NO_DATA : account.data;
}

type LegStep =
	| { readonly kind: 'Done'; readonly accounts: AccountMeta[] }
	| { readonly kind: 'Fetch'; readonly address: Address };

// Rust `resolve_leg`: SPL `ExtraAccountMetaList::add_to_instruction` for one
// transfer. The extras, then the hook program and the validation account.
async function resolveLeg(
	hook: Hook,
	leg: HookLeg,
	moved: ReadonlyMap<Address, Uint8Array>,
	legs: HookLegs,
	lookup: AccountLookup,
): Promise<LegStep> {
	const extras = hookExtras(hook);
	const list = hook.list.kind === 'Loaded' ? hook.list.data : NO_DATA;
	// Token-2022 passes the five `Execute` accounts read-only.
	const metas: AccountMeta[] = [
		leg.source,
		leg.mint,
		leg.destination,
		leg.authority,
		hook.validation,
	].map(readonlyMeta);
	for (const extra of extras) {
		const bytes = new Map<number, ReadonlyUint8Array>();
		for (const read of dataReads(extra.config)) {
			if (read.account === VALIDATION_INDEX) {
				bytes.set(read.account, list);
				continue;
			}
			// The screen let only earlier accounts be read.
			const key = metas[read.account].address;
			const value = readData(key, read.end, moved, legs, lookup);
			if (value === undefined) return { kind: 'Fetch', address: key };
			bytes.set(read.account, value);
		}
		const resolved = await resolveExtra(
			extra.config,
			hook.program,
			EXECUTE_DATA,
			(index) =>
				index < metas.length
					? { key: metas[index].address, data: bytes.get(index) }
					: undefined,
		);
		if (resolved === undefined) throw unresolvable('ExtraUnresolved');
		// `de_escalate_account_meta`: read-only when every earlier account of
		// the `Execute` that holds the key holds it read-only. Never a signer.
		const earlier = metas.filter((meta) => meta.address === resolved);
		const writable =
			extra.isWritable &&
			(earlier.length === 0 ||
				earlier.some((meta) => isWritableRole(meta.role)));
		metas.push({
			address: resolved,
			role: writable ? AccountRole.WRITABLE : AccountRole.READONLY,
		});
	}
	return {
		kind: 'Done',
		accounts: [
			...metas.slice(EXECUTE_ACCOUNTS),
			readonlyMeta(hook.program),
			readonlyMeta(hook.validation),
		],
	};
}

/** Rust `hook_accounts`: resolves the hook accounts of `legs`. `hooks` must hold the hook of each
 *  hooked mint the legs move: a leg whose mint has none is hook-free. `lookup` gives the data of
 *  each account that a list reads. Each extra resolves as SPL's resolver
 *  resolves it: from the transfer's `Execute` (source, mint, destination, authority and the
 *  validation account, all read-only). An extra is read-only when every earlier account of the
 *  `Execute` with its key is read-only. No extra signs. The hook program and the validation
 *  account follow the extras. The legs merge into one list. Each address occurs once, writable if
 *  any leg makes it writable.
 *
 *  A token account that a leg moves reads as its mint and owner, so it need not exist before the
 *  instruction.
 *  Throws `TransferHookError`: `NotLoaded` for a hook whose list was not fetched, `NoList`, or
 *  `Unresolvable(reason)`. */
export async function hookAccounts(
	hooks: readonly Hook[],
	legs: HookLegs,
	lookup: AccountLookup,
): Promise<HookResolution> {
	const moved = movedAccounts(legs);
	const resolved: AccountMeta[][] = [];
	const fetch: Address[] = [];
	for (const leg of legs.legs) {
		const hook = hooks.find((candidate) => candidate.mint === leg.mint);
		if (hook === undefined) continue;
		const step = await resolveLeg(hook, leg, moved, legs, lookup);
		// The other legs still name what they read.
		if (step.kind === 'Fetch') {
			if (!fetch.includes(step.address)) fetch.push(step.address);
		} else resolved.push(step.accounts);
	}
	if (fetch.length > 0) return { kind: 'Fetch', addresses: fetch };
	const merged: AccountMeta[] = [];
	for (const metas of resolved) {
		for (const meta of metas) {
			const index = merged.findIndex(
				(account) => account.address === meta.address,
			);
			if (index === -1) merged.push(meta);
			else if (isWritableRole(meta.role)) merged[index] = meta;
		}
	}
	return { kind: 'Accounts', accounts: merged };
}

/** A snapshot of the accounts that a builder resolves hook accounts from: the mints, their hooks'
 *  lists and the accounts the lists read. `null` is a missing account. An address the map does not
 *  hold was not fetched. `fetchMintInfo` fills one for each mint with a hook. A build that needs an
 *  account it lacks rejects with `NotLoaded` and names the account. A hook armed or changed after
 *  the fill makes the transaction fail in simulation. Read the mint again. */
export interface HookState {
	readonly accounts: ReadonlyMap<Address, AccountView | null>;
}

// Rust `key_reads`: the `Execute` account index of each key `config` reads,
// the program of an external PDA and each account-key seed.
function keyReads(config: AddressConfig): number[] {
	const program = config.__kind === 'AccountPda' ? [config.accountIndex] : [];
	return [
		...program,
		...seedsOf(config).flatMap((seed) =>
			seed.__kind === 'AccountKey' ? [seed.index] : [],
		),
	];
}

// Rust `HookState::fixed_reads`: the accounts at a fixed address whose data
// `hook`'s list reads, which `lookup` lacks.
async function fixedReads(
	hook: Hook,
	lookup: AccountLookup,
): Promise<Address[]> {
	let extras: ScreenedExtra[];
	try {
		extras = hookExtras(hook);
	} catch (error) {
		// A missing list, or one the screen refuses, reads nothing: a build
		// refuses it.
		if (error instanceof TransferHookError) return [];
		throw error;
	}
	const list = hook.list.kind === 'Loaded' ? hook.list.data : NO_DATA;
	// Each `Execute` account's address when no trade sets it: the mint and
	// the validation account, then each fixed extra.
	const fixed: (Address | null)[] = [
		null,
		hook.mint,
		null,
		null,
		hook.validation,
	];
	const fetch: Address[] = [];
	for (const extra of extras) {
		const bytes = new Map<number, ReadonlyUint8Array>();
		let known = true;
		for (const read of dataReads(extra.config)) {
			let value: ReadonlyUint8Array | undefined;
			if (read.account === VALIDATION_INDEX) value = list;
			else {
				const address = fixed.at(read.account) ?? null;
				// `null`: the trade sets the account.
				if (address !== null) {
					const account = lookup(address);
					if (account === undefined) {
						if (!fetch.includes(address)) fetch.push(address);
					} else {
						// On chain a missing account has no data.
						value = account === null ? NO_DATA : account.data;
					}
				}
			}
			if (value === undefined) known = false;
			else bytes.set(read.account, value);
		}
		const keyed = keyReads(extra.config).every(
			(index) => (fixed.at(index) ?? null) !== null,
		);
		let resolved: Address | undefined;
		if (known && keyed) {
			resolved = await resolveExtra(
				extra.config,
				hook.program,
				EXECUTE_DATA,
				(index) => {
					const key = fixed.at(index) ?? null;
					return key === null
						? undefined
						: { key, data: bytes.get(index) };
				},
			);
		}
		fixed.push(resolved ?? null);
	}
	return fetch;
}

/** Rust `HookState::missing`: the accounts to fetch next for a snapshot of `mints`: the mints, then
 *  each hook's list, then each account a list reads at a fixed address. Empty when `state` holds
 *  them all.
 *
 *  An address is fixed when no trade sets it: a fixed key, or a PDA or a key read from data whose
 *  inputs are literal seeds, the first 8 bytes of the `Execute` data (the discriminator), the mint,
 *  the validation account and earlier fixed extras. An extra that reads the source, the destination
 *  or the authority depends on the trade, and the snapshot holds none of its data.
 *
 *  A missing mint runs no hook. A missing list, or one no resolver can resolve, names nothing more:
 *  a build refuses it. Throws `TransferHookError('MalformedMint')` for a mint that does not
 *  decode. */
export async function missingHookAccounts(
	state: HookState,
	mints: readonly Address[],
): Promise<Address[]> {
	const lookup: AccountLookup = (account) => state.accounts.get(account);
	const distinct = [...new Set(mints)];
	const unread = distinct.filter((mint) => !state.accounts.has(mint));
	if (unread.length > 0) return unread;
	const hooks: Hook[] = [];
	const fetch: Address[] = [];
	for (const mint of distinct) {
		const account = lookup(mint);
		if (account === null || account === undefined) continue;
		const hook = await loadHook(mint, mintStateOf(account), lookup);
		if (hook === null) continue;
		if (hook.list.kind === 'NotFetched') fetch.push(hook.validation);
		else hooks.push(hook);
	}
	if (fetch.length > 0) return fetch;
	for (const hook of hooks) {
		for (const address of await fixedReads(hook, lookup)) {
			if (!fetch.includes(address)) fetch.push(address);
		}
	}
	return fetch;
}

/** `decodeMintState`. Throws `TransferHookError('MalformedMint')` for an
 *  account that does not decode. */
function mintStateOf(mint: AccountView): MintState {
	try {
		return decodeMintState(mint);
	} catch (error) {
		if (error instanceof RangeError) {
			throw new TransferHookError('MalformedMint');
		}
		throw error;
	}
}

/** The hook accounts of `legs`, or the accounts to fetch next. A mint that does
 *  not exist runs no hook. Throws as `hookAccounts` does, and
 *  `TransferHookError('MalformedMint')` for a mint that does not decode. */
export async function resolveHookStep(
	legs: HookLegs,
	lookup: AccountLookup,
): Promise<HookResolution> {
	const hooks: Hook[] = [];
	const fetch: Address[] = [];
	for (const mint of new Set(legs.legs.map((leg) => leg.mint))) {
		const account = lookup(mint);
		if (account === undefined) {
			fetch.push(mint);
			continue;
		}
		// No transfer of a missing mint lands. One created earlier in the
		// transaction, such as a launch's base mint, carries no hook.
		if (account === null) continue;
		const hook = await loadHook(mint, mintStateOf(account), lookup);
		if (hook === null) continue;
		if (hook.list.kind === 'NotFetched') fetch.push(hook.validation);
		else hooks.push(hook);
	}
	if (fetch.length > 0) return { kind: 'Fetch', addresses: fetch };
	return hookAccounts(hooks, legs, lookup);
}

/** The hook accounts of `legs`, from `state`. Throws as `resolveHookStep`
 *  does. Throws `TransferHookError('NotLoaded')` while `state` lacks a mint,
 *  a list or an account that a list reads. Its `addresses` name them. */
export async function resolveHookAccounts(
	legs: HookLegs,
	state: HookState,
): Promise<AccountMeta[]> {
	const step = await resolveHookStep(legs, (account) =>
		state.accounts.get(account),
	);
	if (step.kind === 'Fetch') {
		throw new TransferHookError('NotLoaded', step.addresses);
	}
	return step.accounts;
}
