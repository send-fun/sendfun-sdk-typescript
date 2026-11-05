// SPL `ExtraAccountMetaList` bytes, built by hand as the validation account
// holds them.

import { getAddressEncoder, type Address } from '@solana/kit';

import { EXECUTE_DISCRIMINATOR } from '../../src/transfer-hook/resolver.js';

const addressEncoder = getAddressEncoder();

export const LIST_HEADER = 12;
export const LIST_COUNT = 4;
export const META_LENGTH = 35;

export type SeedBytes = readonly number[];

/** An `ExtraAccountMeta`: discriminator, 32-byte address config, signer, writable. SPL's
 *  constructors refuse some of these. */
export function raw(
	discriminator: number,
	config: ArrayLike<number>,
	signer = false,
	writable = false,
): Uint8Array {
	const meta = new Uint8Array(META_LENGTH);
	meta[0] = discriminator;
	meta.set(config, 1);
	meta[33] = signer ? 1 : 0;
	meta[34] = writable ? 1 : 0;
	return meta;
}

export function fixed(account: Address, writable = false): Uint8Array {
	return raw(0, addressEncoder.encode(account), false, writable);
}

export function pda(seeds: readonly SeedBytes[], writable = false): Uint8Array {
	return raw(1, seeds.flat(), false, writable);
}

export function externalPda(
	program: number,
	seeds: readonly SeedBytes[],
): Uint8Array {
	return raw(128 + program, seeds.flat());
}

/** `PubkeyData::AccountData`: the key at `offset` of `Execute` account `account`. */
export function pubkeyData(
	account: number,
	offset: number,
	writable = false,
): Uint8Array {
	return raw(2, [2, account, offset], false, writable);
}

export function literal(text: string): SeedBytes {
	const bytes = new TextEncoder().encode(text);
	return [1, bytes.length, ...bytes];
}

export function instructionData(index: number, length: number): SeedBytes {
	return [2, index, length];
}

export function accountKey(index: number): SeedBytes {
	return [3, index];
}

export function accountData(
	account: number,
	offset: number,
	length: number,
): SeedBytes {
	return [4, account, offset, length];
}

export function u32(value: number): number[] {
	return [
		value & 0xff,
		(value >> 8) & 0xff,
		(value >> 16) & 0xff,
		value >>> 24,
	];
}

/** An `ExtraAccountMetaList` sized exactly, as SPL `ExtraAccountMetaList::init` writes it. */
export function list(extras: readonly Uint8Array[]): Uint8Array {
	const value = LIST_COUNT + extras.length * META_LENGTH;
	const data = new Uint8Array(LIST_HEADER + value);
	data.set(EXECUTE_DISCRIMINATOR);
	data.set(u32(value), 8);
	data.set(u32(extras.length), LIST_HEADER);
	for (const [index, extra] of extras.entries()) {
		data.set(extra, LIST_HEADER + LIST_COUNT + index * META_LENGTH);
	}
	return data;
}
