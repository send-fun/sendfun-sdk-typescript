// Parses Token-2022 mint data by hand. The SDK does not depend on
// `@solana-program/token-2022`.

import {
	getAddressDecoder,
	getBase64Encoder,
	type Address,
	type Commitment,
	type GetEpochInfoApi,
	type GetMultipleAccountsApi,
	type Rpc,
} from '@solana/kit';

import {
	TOKEN_2022_PROGRAM_ADDRESS,
	TOKEN_PROGRAM_ADDRESS,
} from './constants.js';
import type { MintFee } from './math/amm.js';
import { fetchInChunks } from './utils/chunk.js';

const MINT_BASE_LENGTH = 82;

// Token-2022 pads the base mint to 165 bytes, the token-account length. The
// account-type byte follows, then the TLV entries.
const ACCOUNT_TYPE_OFFSET = 165;

const ACCOUNT_TYPE_MINT = 1;

const TLV_START = 166;

const TLV_TYPE = 2;

const TLV_HEADER = 4;

const TRANSFER_FEE_CONFIG_TYPE = 1;

const UNINITIALIZED_TYPE = 0;

// Config authority, withdraw authority, `withheld_amount` u64, then older and
// newer `TransferFee` (epoch u64, maximum_fee u64, bps u16).
const TRANSFER_FEE_CONFIG_LENGTH = 108;

const PUBKEY_LENGTH = 32;

const OLDER_FEE = 72;
const NEWER_FEE = 90;

const FEE_MAXIMUM = 8;
const FEE_BASIS_POINTS = 16;

const addressDecoder = getAddressDecoder();
const base64Encoder = getBase64Encoder();

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

// `OptionalNonZeroPubkey` has no tag byte: all zeros is `None`.
function readAuthority(data: Uint8Array, start: number): Address | undefined {
	const bytes = data.subarray(start, start + PUBKEY_LENGTH);
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

/** Decodes the `TransferFeeConfig` extension of a mint. `owner` is the program that owns the account.
 *  Returns `undefined` if the mint has no such extension. Throws `RangeError` if `owner` is not a
 *  token program or `data` is not a valid mint. */
export function decodeTransferFeeConfig(
	data: Uint8Array,
	owner: Address,
): TransferFeeConfig | undefined {
	// Classic SPL mints have no extensions.
	if (owner === TOKEN_PROGRAM_ADDRESS) return undefined;
	if (owner !== TOKEN_2022_PROGRAM_ADDRESS) {
		throw new RangeError(
			`decodeTransferFeeConfig: ${owner} is not a token program`,
		);
	}

	// A Token-2022 mint with no extensions is 82 bytes.
	if (data.length === MINT_BASE_LENGTH) return undefined;
	if (data.length < TLV_START) {
		throw new RangeError(
			`decodeTransferFeeConfig: a Token-2022 mint holds ${data.length} bytes, expected ${MINT_BASE_LENGTH} or at least ${TLV_START}`,
		);
	}
	// Token accounts use the same TLV layout.
	if (data[ACCOUNT_TYPE_OFFSET] !== ACCOUNT_TYPE_MINT) {
		throw new RangeError(
			`decodeTransferFeeConfig: account type ${data[ACCOUNT_TYPE_OFFSET]} is not a mint`,
		);
	}

	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

	let offset = TLV_START;
	while (offset < data.length) {
		// SPL reads a tail too short for a type, or a zero type, as the end of the list.
		if (offset + TLV_TYPE > data.length) return undefined;
		const extensionType = view.getUint16(offset, true);
		if (extensionType === UNINITIALIZED_TYPE) return undefined;

		if (offset + TLV_HEADER > data.length) {
			throw new RangeError(
				'decodeTransferFeeConfig: a TLV entry header runs past the end of the account',
			);
		}

		const length = view.getUint16(offset + 2, true);
		const payload = offset + TLV_HEADER;
		const next = payload + length;
		if (next > data.length) {
			throw new RangeError(
				'decodeTransferFeeConfig: a TLV entry runs past the end of the account',
			);
		}

		if (extensionType === TRANSFER_FEE_CONFIG_TYPE) {
			// The extension is always 108 bytes.
			if (length !== TRANSFER_FEE_CONFIG_LENGTH) {
				throw new RangeError(
					`decodeTransferFeeConfig: TransferFeeConfig holds ${length} bytes, expected ${TRANSFER_FEE_CONFIG_LENGTH}`,
				);
			}
			return {
				authority: readAuthority(data, payload),
				older: readEntry(view, payload + OLDER_FEE),
				newer: readEntry(view, payload + NEWER_FEE),
			};
		}

		offset = next;
	}

	return undefined;
}

/** Returns the fee for `epoch`, as SPL `get_epoch_fee` does. The newer entry applies from its own epoch on. */
export function transferFeeAtEpoch(
	config: TransferFeeConfig,
	epoch: bigint,
): MintFee {
	const entry = epoch >= config.newer.epoch ? config.newer : config.older;
	return { bps: entry.basisPoints, maximumFee: entry.maximumFee };
}

export function mintFeeAtEpoch(
	data: Uint8Array,
	owner: Address,
	epoch: bigint,
): MintFee | undefined {
	const config = decodeTransferFeeConfig(data, owner);
	return config === undefined ? undefined : transferFeeAtEpoch(config, epoch);
}

// Omit the config, not `{ commitment: undefined }`. Kit deletes an undefined key, so the
// server default `finalized` applies. With no config, the client default applies.
function currentEpoch(
	rpc: Rpc<GetEpochInfoApi>,
	commitment: Commitment | undefined,
): Promise<bigint> {
	return rpc
		.getEpochInfo(commitment === undefined ? undefined : { commitment })
		.send()
		.then((info) => info.epoch);
}

/** Reads the transfer fee of each mint for `epoch`. The result is valid only for that epoch.
 *  `epoch` defaults to the current cluster epoch, read with `getEpochInfo`. A mint without a
 *  transfer fee maps to `undefined`. Throws if a mint account is missing or does not decode. */
export async function fetchMintFees(
	rpc: Rpc<GetMultipleAccountsApi & GetEpochInfoApi>,
	mints: readonly Address[],
	options?: { epoch?: bigint; commitment?: Commitment },
): Promise<Map<Address, MintFee | undefined>> {
	const commitment = options?.commitment;

	const [epoch, accounts] = await Promise.all([
		options?.epoch ?? currentEpoch(rpc, commitment),
		fetchInChunks(mints, (chunk) =>
			rpc
				.getMultipleAccounts(
					chunk,
					commitment === undefined
						? { encoding: 'base64' }
						: { commitment, encoding: 'base64' },
				)
				.send()
				.then(({ value }) => value),
		),
	]);

	const fees = new Map<Address, MintFee | undefined>();
	for (const [index, mint] of mints.entries()) {
		const account = accounts.at(index);
		if (!account) {
			throw new Error(`fetchMintFees: no account at ${mint}`);
		}
		const data = new Uint8Array(base64Encoder.encode(account.data[0]));
		fees.set(mint, mintFeeAtEpoch(data, account.owner, epoch));
	}
	return fees;
}
