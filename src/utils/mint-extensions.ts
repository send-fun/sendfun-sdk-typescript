// Reads a Token-2022 mint's extensions by hand, as SPL's
// `PodStateWithExtensions::<PodMint>::unpack` does. It skips unknown extension
// types.
// Rust `mint_extensions` and `extension` in `sendfun_sdk::transfer_fee`.

import {
	getAddressDecoder,
	type Address,
	type ReadonlyUint8Array,
} from '@solana/kit';

import type { MintFee } from '../math/amm.js';

// Both token programs use the same base mint: the 36-byte `COption<Pubkey>`
// mint authority, the u64 supply, the decimals, then `is_initialized`.
const MINT_BASE_LENGTH = 82;

const MINT_DECIMALS = 44;

// Token-2022 refuses this length for any account with extensions.
const MULTISIG_LENGTH = 355;

const MINT_IS_INITIALIZED = 45;

// Token-2022 pads the base mint with zeros to 165 bytes, the token-account
// length. The account-type byte follows, then the TLV entries.
const ACCOUNT_TYPE_OFFSET = 165;

const ACCOUNT_TYPE_MINT = 1;

const TLV_START = 166;

// A mint TLV entry header: the u16 type, then the u16 length.
const EXTENSION_TYPE_LENGTH = 2;
const EXTENSION_HEADER_LENGTH = 4;

const UNINITIALIZED_EXTENSION = 0;

const PUBKEY_LENGTH = 32;

// Config authority, withdraw authority, `withheld_amount` u64, then older and
// newer `TransferFee` (epoch u64, maximum_fee u64, bps u16).
const OLDER_FEE = 72;
const NEWER_FEE = 90;

const FEE_MAXIMUM = 8;
const FEE_BASIS_POINTS = 16;

const addressDecoder = getAddressDecoder();

export interface ExtensionLayout {
	readonly type: number;
	readonly length: number;
}

export const TRANSFER_FEE_CONFIG: ExtensionLayout = { type: 1, length: 108 };

export interface TransferFeeEntry {
	readonly epoch: bigint;
	readonly maximumFee: bigint;
	readonly basisPoints: number;
}

export interface TransferFeeConfig {
	/** `undefined` if the config has no authority. Then the schedule cannot change. */
	readonly authority: Address | undefined;
	readonly older: TransferFeeEntry;
	readonly newer: TransferFeeEntry;
}

function readU16(data: ReadonlyUint8Array, offset: number): number {
	return data[offset] | (data[offset + 1] << 8);
}

function isZero(data: ReadonlyUint8Array, start: number, end: number): boolean {
	return data.subarray(start, end).every((byte) => byte === 0);
}

/** Rust `spl_token_mint` in `sendfun_sdk::transfer_fee`. Throws `RangeError`,
 *  prefixed with `caller`, unless `data` is an initialized SPL Token mint: the
 *  82-byte base mint alone. */
export function checkSplTokenMint(
	caller: string,
	data: ReadonlyUint8Array,
): void {
	if (data.length !== MINT_BASE_LENGTH) {
		throw new RangeError(
			`${caller}: an SPL Token mint holds ${data.length} bytes, expected ${MINT_BASE_LENGTH}`,
		);
	}
	if (data[MINT_IS_INITIALIZED] === 0) {
		throw new RangeError(`${caller}: the mint is not initialized`);
	}
}

/** The decimals of a mint that `checkSplTokenMint` or `mintTlv` checked. */
export function mintDecimals(data: ReadonlyUint8Array): number {
	return data[MINT_DECIMALS];
}

/** The TLV entries of a Token-2022 mint. Throws `RangeError`, prefixed with `caller`, if `data` is
 *  not a valid mint. */
export function mintTlv(
	caller: string,
	data: ReadonlyUint8Array,
): ReadonlyUint8Array {
	if (data.length === MULTISIG_LENGTH || data.length < MINT_BASE_LENGTH) {
		throw new RangeError(
			`${caller}: a Token-2022 mint cannot hold ${data.length} bytes`,
		);
	}
	if (data[MINT_IS_INITIALIZED] === 0) {
		throw new RangeError(`${caller}: the mint is not initialized`);
	}
	// A Token-2022 mint with no extensions is 82 bytes.
	if (data.length === MINT_BASE_LENGTH) return new Uint8Array();
	if (data.length < TLV_START) {
		throw new RangeError(
			`${caller}: a Token-2022 mint holds ${data.length} bytes, expected ${MINT_BASE_LENGTH} or at least ${TLV_START}`,
		);
	}
	if (!isZero(data, MINT_BASE_LENGTH, ACCOUNT_TYPE_OFFSET)) {
		throw new RangeError(
			`${caller}: the padding after the base mint is not zero`,
		);
	}
	// Token accounts use the same TLV layout.
	if (data[ACCOUNT_TYPE_OFFSET] !== ACCOUNT_TYPE_MINT) {
		throw new RangeError(
			`${caller}: account type ${data[ACCOUNT_TYPE_OFFSET]} is not a mint`,
		);
	}
	return data.subarray(TLV_START);
}

// `true` if every entry is whole, as SPL walks the entries: up to the end, a
// tail too short for a type, or a zero type.
function extensionsEndCleanly(tlv: ReadonlyUint8Array): boolean {
	let start = 0;
	while (
		tlv.length >= start + EXTENSION_TYPE_LENGTH &&
		readU16(tlv, start) !== UNINITIALIZED_EXTENSION
	) {
		if (tlv.length < start + EXTENSION_HEADER_LENGTH) return false;
		start +=
			EXTENSION_HEADER_LENGTH +
			readU16(tlv, start + EXTENSION_TYPE_LENGTH);
		if (start > tlv.length) return false;
	}
	return true;
}

/** Rust `extension`: the value of the `layout` extension in `tlv`, from
 *  `mintTlv`. `undefined` when the mint does not have it. Throws `RangeError`,
 *  prefixed with `caller`, for a malformed entry. */
export function mintExtension(
	caller: string,
	tlv: ReadonlyUint8Array,
	layout: ExtensionLayout,
): ReadonlyUint8Array | undefined {
	let start = 0;
	while (start < tlv.length) {
		if (tlv.length < start + EXTENSION_HEADER_LENGTH) break;
		const extensionType = readU16(tlv, start);
		const valueStart = start + EXTENSION_HEADER_LENGTH;
		const valueEnd =
			valueStart + readU16(tlv, start + EXTENSION_TYPE_LENGTH);
		if (extensionType === layout.type) {
			if (valueEnd > tlv.length) break;
			if (valueEnd - valueStart !== layout.length) {
				throw new RangeError(
					`${caller}: extension ${layout.type} holds ${valueEnd - valueStart} bytes, expected ${layout.length}`,
				);
			}
			return tlv.subarray(valueStart, valueEnd);
		}
		if (extensionType === UNINITIALIZED_EXTENSION) return undefined;
		start = valueEnd;
	}
	if (extensionsEndCleanly(tlv)) return undefined;
	throw new RangeError(
		`${caller}: a TLV entry runs past the end of the account`,
	);
}

// `OptionalNonZeroPubkey` has no tag byte: all zeros is `None`.
function readAuthority(
	value: ReadonlyUint8Array,
	start: number,
): Address | undefined {
	const bytes = value.subarray(start, start + PUBKEY_LENGTH);
	return bytes.some((byte) => byte !== 0)
		? addressDecoder.decode(bytes)
		: undefined;
}

function readEntry(view: DataView, start: number): TransferFeeEntry {
	return {
		epoch: view.getBigUint64(start, true),
		maximumFee: view.getBigUint64(start + FEE_MAXIMUM, true),
		basisPoints: view.getUint16(start + FEE_BASIS_POINTS, true),
	};
}

/** The transfer fee of a mint: both entries of its `TransferFeeConfig`, and the epoch of the
 *  read. */
export interface FeeSchedule {
	/** `null` when no one can set a new fee while the mint exists. `newer` is still in effect
	 *  from `newerEpoch`. The builders do not read this field. */
	readonly authority: Address | null;
	readonly older: MintFee;
	readonly newer: MintFee;
	/** The first epoch of `newer`. */
	readonly newerEpoch: bigint;
	/** The epoch the mint was read at. */
	readonly readEpoch: bigint;
}

/** The schedule of `config`, read at `readEpoch`. */
export function feeScheduleOf(
	config: TransferFeeConfig,
	readEpoch: bigint,
): FeeSchedule {
	const { older, newer } = config;
	return {
		authority: config.authority ?? null,
		older: { bps: older.basisPoints, maximumFee: older.maximumFee },
		newer: { bps: newer.basisPoints, maximumFee: newer.maximumFee },
		newerEpoch: newer.epoch,
		readEpoch,
	};
}

/** Decodes the value of a `TransferFeeConfig` extension, from `mintExtension`. */
export function decodeTransferFeeValue(
	value: ReadonlyUint8Array,
): TransferFeeConfig {
	const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
	return {
		authority: readAuthority(value, 0),
		older: readEntry(view, OLDER_FEE),
		newer: readEntry(view, NEWER_FEE),
	};
}
