import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { address, getBase64Encoder } from '@solana/kit';
import {
	SYSTEM_PROGRAM_ADDRESS,
	TOKEN_2022_PROGRAM_ADDRESS,
	TOKEN_PROGRAM_ADDRESS,
} from '../src/constants.js';
import type { MintFee } from '../src/math/amm.js';
import {
	decodeTransferFeeConfig,
	mintFeeAtEpoch,
	transferFeeAtEpoch,
	type TransferFeeConfig,
} from '../src/transfer-fee.js';

const U64_MAX = 18_446_744_073_709_551_615n;

// Mainnet `TKLSidmLVt3cqGaaodG8tyRzoANfQwoh67AccjmubeZ`, copied from
// tests/typescript/shared/mainnet-quote-mints.ts: this package must not import the
// repo test tree. TLV: `TransferFeeConfig`, `MetadataPointer`, `TokenMetadata`.
const TKALSHI_ACCOUNT =
	'AQAAAMkTzlIGLjVmlB0IsJQauejYr2X5R0n7FM50wPVcXvw7M7Fmv2oBAAAJAQEAAABkrtMna2+B2Qf13mxMlFRLHvbUBPzL//nfKbcA1Sg0uAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAbADJE85SBi41ZpQdCLCUGrno2K9l+UdJ+xTOdMD1XF78O0EX1CifzNXEbLWz9Jch2yG+N/0T8DipXQ1EMUGZjMh8v/QMAAAAAACaAwAAAAAAAP//////////FACaAwAAAAAAAP//////////FAASAEAAyRPOUgYuNWaUHQiwlBq56NivZflHSfsUznTA9Vxe/DsGvdUu+NR5pa3zhYIBetNbB8LCG6NMPaeuCKn9wNEFqhMAjgDJE85SBi41ZpQdCLCUGrno2K9l+UdJ+xTOdMD1XF78Owa91S741HmlrfOFggF601sHwsIbo0w9p64Iqf3A0QWqCAAAAFQtS2Fsc2hpBwAAAHRLYWxzaGkvAAAAaHR0cHM6Ly9jZG4udGVzc2VyYWxhYi5jby90ZXNzZXJhL3Qta2Fsc2hpLmpzb24AAAAA';

// Mainnet `XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp`, same source: eight
// extensions, none of them `TransferFeeConfig`.
const AAPLX_ACCOUNT =
	'AQAAAGVqQkIv6okUBqQZ0dHeCPQqhHlBtaGulevOYZrDFyk0sFT4HvwNAAAIAQEAAAD/3+wbzSzTg5PITaoIyRzA041nf/jQq3tdAz8A9zLMMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARIAQABD+fHuLje4B+pFy3TmAJcivsAJKWAm5ORVi0NeJKXpxgfooHtWzpJmuZKqX9ZEXDx3mLLrtzM8Hn7eBixrhgflDAAgAEP58e4uN7gH6kXLdOYAlyK+wAkpYCbk5FWLQ14kpenGBgABAAEZADgABm9ZIlHMR3R4JaWa0UIupDVz9SjaXe4q94ErMU+ZReNQdcef6QrwP4h4dmoAAAAABS7fzmMN8D8aACEA/9/sG80s04OTyE2qCMkcwNONZ3/40Kt7XQM/APcyzDAABABBAEP58e4uN7gH6kXLdOYAlyK+wAkpYCbk5FWLQ14kpenGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgBAAEP58e4uN7gH6kXLdOYAlyK+wAkpYCbk5FWLQ14kpenGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATAKUAQ/nx7i43uAfqRct05gCXIr7ACSlgJuTkVYtDXiSl6cYH6KB7Vs6SZrmSql/WRFw8d5iy67czPB5+3gYsa4YH5QwAAABBcHBsZSB4U3RvY2sFAAAAQUFQTHhEAAAAaHR0cHM6Ly94c3RvY2tzLW1ldGFkYXRhLmJhY2tlZC5maS90b2tlbnMvU29sYW5hL0FBUEx4L21ldGFkYXRhLmpzb24AAAAA';

const base64Encoder = getBase64Encoder();

function accountBytes(base64: string): Uint8Array {
	return new Uint8Array(base64Encoder.encode(base64));
}

const IS_INITIALIZED = 45;

function classicMintBytes(): Uint8Array {
	const data = new Uint8Array(82);
	data[IS_INITIALIZED] = 1;
	return data;
}

const ACCOUNT_TYPE_MINT = 1;
const ACCOUNT_TYPE_ACCOUNT = 2;

function token2022MintBytes(
	tlv: readonly number[],
	accountType: number = ACCOUNT_TYPE_MINT,
): Uint8Array {
	const data = new Uint8Array(166 + tlv.length);
	data[IS_INITIALIZED] = 1;
	data[165] = accountType;
	data.set(tlv, 166);
	return data;
}

function truncatedToken2022Bytes(length: number): Uint8Array {
	const data = new Uint8Array(length);
	data[IS_INITIALIZED] = 1;
	return data;
}

function zeros(length: number): number[] {
	return Array.from({ length }, () => 0);
}

function transferFeeConfigEntry(length: number): number[] {
	return [1, 0, length & 0xff, length >> 8, ...zeros(length)];
}

// Entries differ in rate AND cap, so picking the wrong one fails on either field.
const TWO_ENTRY_SCHEDULE: TransferFeeConfig = {
	authority: undefined,
	older: { epoch: 5n, maximumFee: 1_000n, basisPoints: 100 },
	newer: { epoch: 7n, maximumFee: 2_000n, basisPoints: 250 },
};

describe('decodeTransferFeeConfig', () => {
	it('reads both entries off the live tKalshi mint', () => {
		assert.deepEqual(
			decodeTransferFeeConfig(
				accountBytes(TKALSHI_ACCOUNT),
				TOKEN_2022_PROGRAM_ADDRESS,
			),
			{
				authority: address(
					'EXvTtxurWBUNNCtLojaN8ZBJFNJPZFSH3szoih9hh7YW',
				),
				older: { epoch: 922n, maximumFee: U64_MAX, basisPoints: 20 },
				newer: { epoch: 922n, maximumFee: U64_MAX, basisPoints: 20 },
			} satisfies TransferFeeConfig,
		);
	});

	it('clears a Token-2022 mint that carries other extensions', () => {
		assert.equal(
			decodeTransferFeeConfig(
				accountBytes(AAPLX_ACCOUNT),
				TOKEN_2022_PROGRAM_ADDRESS,
			),
			undefined,
		);
	});

	it('clears a classic SPL mint, which has no TLV region at all', () => {
		assert.equal(
			decodeTransferFeeConfig(classicMintBytes(), TOKEN_PROGRAM_ADDRESS),
			undefined,
		);
	});

	it('stops at the terminator that trailing rent slack reads as', () => {
		// A `MetadataPointer` entry, then 512 bytes of zeros.
		assert.equal(
			decodeTransferFeeConfig(
				token2022MintBytes([18, 0, 64, 0, ...zeros(64 + 512)]),
				TOKEN_2022_PROGRAM_ADDRESS,
			),
			undefined,
		);
	});

	it('rejects an owner that is neither token program', () => {
		assert.throws(
			() =>
				decodeTransferFeeConfig(
					classicMintBytes(),
					SYSTEM_PROGRAM_ADDRESS,
				),
			{
				name: 'RangeError',
				message:
					'decodeTransferFeeConfig: 11111111111111111111111111111111 is not a token program',
			},
		);
	});

	it('rejects a TLV header cut in half', () => {
		assert.throws(
			() =>
				decodeTransferFeeConfig(
					token2022MintBytes([1, 0]),
					TOKEN_2022_PROGRAM_ADDRESS,
				),
			{
				name: 'RangeError',
				message:
					'decodeTransferFeeConfig: a TLV entry header runs past the end of the account',
			},
		);
	});

	it('rejects an entry whose length runs past the account', () => {
		assert.throws(
			() =>
				decodeTransferFeeConfig(
					token2022MintBytes([18, 0, 0x0f, 0x27]),
					TOKEN_2022_PROGRAM_ADDRESS,
				),
			{
				name: 'RangeError',
				message:
					'decodeTransferFeeConfig: a TLV entry runs past the end of the account',
			},
		);
	});

	it('rejects a TransferFeeConfig payload short of 108 bytes', () => {
		assert.throws(
			() =>
				decodeTransferFeeConfig(
					token2022MintBytes(transferFeeConfigEntry(100)),
					TOKEN_2022_PROGRAM_ADDRESS,
				),
			{
				name: 'RangeError',
				message:
					'decodeTransferFeeConfig: TransferFeeConfig holds 100 bytes, expected 108',
			},
		);
	});

	it('rejects a TransferFeeConfig payload longer than 108 bytes', () => {
		assert.throws(
			() =>
				decodeTransferFeeConfig(
					token2022MintBytes(transferFeeConfigEntry(116)),
					TOKEN_2022_PROGRAM_ADDRESS,
				),
			{
				name: 'RangeError',
				message:
					'decodeTransferFeeConfig: TransferFeeConfig holds 116 bytes, expected 108',
			},
		);
	});

	it('clears a bare Token-2022 mint that stops at the 82-byte base', () => {
		assert.equal(
			decodeTransferFeeConfig(
				truncatedToken2022Bytes(82),
				TOKEN_2022_PROGRAM_ADDRESS,
			),
			undefined,
		);
	});

	it('rejects a Token-2022 mint that stops between the base and the first entry', () => {
		assert.throws(
			() =>
				decodeTransferFeeConfig(
					truncatedToken2022Bytes(120),
					TOKEN_2022_PROGRAM_ADDRESS,
				),
			{
				name: 'RangeError',
				message:
					'decodeTransferFeeConfig: a Token-2022 mint holds 120 bytes, expected 82 or at least 166',
			},
		);
	});

	it('rejects a token ACCOUNT, which walks the same region with other types', () => {
		assert.throws(
			() =>
				decodeTransferFeeConfig(
					token2022MintBytes(
						transferFeeConfigEntry(108),
						ACCOUNT_TYPE_ACCOUNT,
					),
					TOKEN_2022_PROGRAM_ADDRESS,
				),
			{
				name: 'RangeError',
				message:
					'decodeTransferFeeConfig: account type 2 is not a mint',
			},
		);
	});

	it('reads an all-zero authority as unset', () => {
		assert.deepEqual(
			decodeTransferFeeConfig(
				token2022MintBytes(transferFeeConfigEntry(108)),
				TOKEN_2022_PROGRAM_ADDRESS,
			),
			{
				authority: undefined,
				older: { epoch: 0n, maximumFee: 0n, basisPoints: 0 },
				newer: { epoch: 0n, maximumFee: 0n, basisPoints: 0 },
			} satisfies TransferFeeConfig,
		);
	});
});

describe('transferFeeAtEpoch', () => {
	it('holds the older entry until the newer one is live', () => {
		assert.deepEqual(transferFeeAtEpoch(TWO_ENTRY_SCHEDULE, 6n), {
			bps: 100,
			maximumFee: 1_000n,
		} satisfies MintFee);
	});

	it('takes the newer entry on the epoch it names', () => {
		assert.deepEqual(transferFeeAtEpoch(TWO_ENTRY_SCHEDULE, 7n), {
			bps: 250,
			maximumFee: 2_000n,
		} satisfies MintFee);
	});
});

describe('mintFeeAtEpoch', () => {
	it('prices the live tKalshi schedule', () => {
		assert.deepEqual(
			mintFeeAtEpoch(
				accountBytes(TKALSHI_ACCOUNT),
				TOKEN_2022_PROGRAM_ADDRESS,
				922n,
			),
			{ bps: 20, maximumFee: U64_MAX } satisfies MintFee,
		);
	});

	it('passes a mint without the extension through as undefined', () => {
		assert.equal(
			mintFeeAtEpoch(
				accountBytes(AAPLX_ACCOUNT),
				TOKEN_2022_PROGRAM_ADDRESS,
				922n,
			),
			undefined,
		);
	});
});
