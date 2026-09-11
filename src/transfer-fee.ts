// Hand-parsed so consumers don't inherit `@solana-program/token-2022`. The programs
// price every leg on what lands after the mint's cut; a quote without it fails slippage.

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

// Token-2022 pads the base mint to the 165-byte token-account length so the two
// never share a prefix, then stamps the type byte; TLV entries follow it.
const ACCOUNT_TYPE_OFFSET = 165;

const ACCOUNT_TYPE_MINT = 1;

const TLV_START = 166;

const TLV_HEADER = 4;

const TRANSFER_FEE_CONFIG_TYPE = 1;

// Trailing rent slack reads as `ExtensionType::Uninitialized`, ending the list.
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
	/** `undefined` when the authority is unset: the schedule is frozen forever. */
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

/** `owner` is the account's program. `undefined` means no fee extension; anything
 *  unparseable throws `RangeError` rather than pricing a charging mint free. */
export function decodeTransferFeeConfig(
	data: Uint8Array,
	owner: Address,
): TransferFeeConfig | undefined {
	// Classic SPL can never gain an extension, so this result is permanent.
	if (owner === TOKEN_PROGRAM_ADDRESS) return undefined;
	if (owner !== TOKEN_2022_PROGRAM_ADDRESS) {
		throw new RangeError(
			`decodeTransferFeeConfig: ${owner} is not a token program`,
		);
	}

	// Token-2022 leaves a mint with no extensions unpadded at 82 bytes.
	if (data.length === MINT_BASE_LENGTH) return undefined;
	if (data.length < TLV_START) {
		throw new RangeError(
			`decodeTransferFeeConfig: a Token-2022 mint holds ${data.length} bytes, expected ${MINT_BASE_LENGTH} or at least ${TLV_START}`,
		);
	}
	// Token accounts share this TLV layout with different extension types.
	if (data[ACCOUNT_TYPE_OFFSET] !== ACCOUNT_TYPE_MINT) {
		throw new RangeError(
			`decodeTransferFeeConfig: account type ${data[ACCOUNT_TYPE_OFFSET]} is not a mint`,
		);
	}

	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

	let offset = TLV_START;
	while (offset < data.length) {
		if (offset + TLV_HEADER > data.length) {
			throw new RangeError(
				'decodeTransferFeeConfig: a TLV entry header runs past the end of the account',
			);
		}

		const extensionType = view.getUint16(offset, true);
		if (extensionType === UNINITIALIZED_TYPE) return undefined;

		const length = view.getUint16(offset + 2, true);
		const payload = offset + TLV_HEADER;
		const next = payload + length;
		if (next > data.length) {
			throw new RangeError(
				'decodeTransferFeeConfig: a TLV entry runs past the end of the account',
			);
		}

		if (extensionType === TRANSFER_FEE_CONFIG_TYPE) {
			// Exactly 108 or throw: the extension never writes a wider config.
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

/** Mirrors SPL `get_epoch_fee`: the newer entry is live from its own epoch on. */
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

// Omit the config, never `{ commitment: undefined }`: Kit strips the falsy key and
// the server's `finalized` wins, where an absent key gets the client's default.
function currentEpoch(
	rpc: Rpc<GetEpochInfoApi>,
	commitment: Commitment | undefined,
): Promise<bigint> {
	return rpc
		.getEpochInfo(commitment === undefined ? undefined : { commitment })
		.send()
		.then((info) => info.epoch);
}

/** A missing account throws, never reads as fee-free. Valid only for `epoch`, which defaults to
 *  the cluster's (a second call). */
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
