// The keys, legs, lists and mints that transfer-hook.test.ts and its
// token-2022 oracle, transfer-hook-oracle.test.ts, share.

import {
	AccountRole,
	getAddressDecoder,
	getAddressEncoder,
	getProgramDerivedAddress,
	type AccountMeta,
	type Address,
	type ReadonlyUint8Array,
} from '@solana/kit';

import {
	findValidationAddress,
	type HookLeg,
} from '../../src/transfer-hook/resolver.js';
import {
	accountData,
	accountKey,
	fixed,
	list,
	literal,
	pda,
} from './extra-metas.js';

const addressDecoder = getAddressDecoder();
const addressEncoder = getAddressEncoder();

/** The address of 32 copies of `byte`, as Rust `Address::new_from_array([byte; 32])`. */
export function key(byte: number): Address {
	return addressDecoder.decode(new Uint8Array(32).fill(byte));
}

export const MINT: Address = key(21);
export const PROGRAM: Address = key(22);
export const SOURCE: Address = key(23);
export const DESTINATION: Address = key(24);
export const USER: Address = key(5);
export const MARKET: Address = key(6);
export const RENT: Address = key(7);

/** The decimals of `token2022Mint`. */
export const TOKEN_2022_DECIMALS = 6;

export const VALIDATION: Address = await findValidationAddress(MINT, PROGRAM);

export function concat(...parts: readonly ArrayLike<number>[]): Uint8Array {
	const data = new Uint8Array(
		parts.reduce((total, part) => total + part.length, 0),
	);
	let offset = 0;
	for (const part of parts) {
		data.set(part, offset);
		offset += part.length;
	}
	return data;
}

export function readonlyMeta(address: Address): AccountMeta {
	return { address, role: AccountRole.READONLY };
}

export function writableMeta(address: Address): AccountMeta {
	return { address, role: AccountRole.WRITABLE };
}

export const HOOK_ACCOUNTS: readonly AccountMeta[] = [
	readonlyMeta(PROGRAM),
	readonlyMeta(VALIDATION),
];

export async function hookPda(
	...seeds: readonly (ReadonlyUint8Array | string)[]
): Promise<Address> {
	const [address] = await getProgramDerivedAddress({
		programAddress: PROGRAM,
		seeds: [...seeds],
	});
	return address;
}

export const USER_LEG: HookLeg = {
	source: SOURCE,
	mint: MINT,
	destination: DESTINATION,
	authority: USER,
	destinationOwner: MARKET,
};

/** The leg back. */
export const VAULT_LEG: HookLeg = {
	source: DESTINATION,
	mint: MINT,
	destination: SOURCE,
	authority: MARKET,
	destinationOwner: USER,
};

/** A fixed account, a writable PDA from the source, and a PDA from the source's owner, read from
 *  the source's data. Rust `programs_test_list`. */
export function programsTestList(): Uint8Array {
	return list([
		fixed(RENT),
		pda([literal('ledger'), accountKey(0)], true),
		pda([literal('owner'), accountData(0, 32, 32)]),
	]);
}

export async function programsTestAccounts(
	leg: HookLeg,
): Promise<AccountMeta[]> {
	return [
		readonlyMeta(RENT),
		writableMeta(
			await hookPda('ledger', addressEncoder.encode(leg.source)),
		),
		readonlyMeta(
			await hookPda('owner', addressEncoder.encode(leg.authority)),
		),
		...HOOK_ACCOUNTS,
	];
}

/** A Token-2022 mint with `extensions` as `[type, payload]`. */
export function token2022Mint(
	extensions: readonly (readonly [number, ArrayLike<number>])[],
): Uint8Array {
	const data = new Uint8Array(166);
	// `decimals`, `is_initialized`, then `AccountType::Mint`.
	data[44] = TOKEN_2022_DECIMALS;
	data[45] = 1;
	data[165] = 1;
	return concat(
		data,
		...extensions.map(([type, payload]) =>
			concat(
				[
					type & 0xff,
					type >> 8,
					payload.length & 0xff,
					payload.length >> 8,
				],
				payload,
			),
		),
	);
}

export function hookExtension(
	program: Address | null,
): readonly [number, Uint8Array] {
	return [
		14,
		concat(
			new Uint8Array(32).fill(7),
			program === null
				? new Uint8Array(32)
				: addressEncoder.encode(program),
		),
	];
}

// `MetadataPointer`, then `TokenMetadata`. `create_token` writes both.
export const POINTER: readonly [number, Uint8Array] = [18, new Uint8Array(64)];
export const METADATA: readonly [number, Uint8Array] = [19, new Uint8Array(90)];

export const HOOK_PROGRAM: Address = key(9);
