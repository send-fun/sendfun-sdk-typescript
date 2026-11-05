// A hook whose extras name every key of the leg it runs on, so the trailing
// accounts show which leg a builder resolved, and the hook state a builder
// reads it from.

import {
	AccountRole,
	getAddressDecoder,
	getAddressEncoder,
	getProgramDerivedAddress,
	type AccountMeta,
	type Address,
} from '@solana/kit';

import {
	TOKEN_2022_PROGRAM_ADDRESS,
	TOKEN_PROGRAM_ADDRESS,
	WSOL_MINT,
} from '../../src/constants.js';
import {
	EXECUTE_DISCRIMINATOR,
	findValidationAddress,
	type AccountView,
	type Hook,
	type HookLeg,
	type HookState,
} from '../../src/transfer-hook/resolver.js';

/** No program lives here: the 32-byte array of 7. */
export const PROBE_PROGRAM: Address = getAddressDecoder().decode(
	new Uint8Array(32).fill(7),
);

const META_HOOK_PDA = 1;
const META_PUBKEY_DATA = 2;
const SEED_ACCOUNT_KEY = 3;
const PUBKEY_DATA_ACCOUNT_DATA = 2;

// `Execute` account indices, and the owner's offset in a token account.
const SOURCE = 0;
const DESTINATION = 2;
const MINT_OFFSET = 0;
const OWNER_OFFSET = 32;

const CONFIG_LENGTH = 32;

function u32(value: number): number[] {
	return [
		value & 0xff,
		(value >> 8) & 0xff,
		(value >> 16) & 0xff,
		value >>> 24,
	];
}

function extra(
	discriminator: number,
	config: readonly number[],
	writable: boolean,
): number[] {
	const padded = [
		...config,
		...Array.from({ length: CONFIG_LENGTH - config.length }, () => 0),
	];
	return [discriminator, ...padded, 0, writable ? 1 : 0];
}

/** The `ExtraAccountMetaList` of the probe. Its extras resolve, in order, to a hook PDA of the
 *  source (writable), the mint, a hook PDA of the destination, the source's owner and the
 *  destination's owner. Every extra reads only the mint and owner of a token account the
 *  instruction moves, so the probe resolves from the mint and its list alone. */
export function probeList(): Uint8Array {
	const extras = [
		extra(META_HOOK_PDA, [SEED_ACCOUNT_KEY, SOURCE], true),
		extra(
			META_PUBKEY_DATA,
			[PUBKEY_DATA_ACCOUNT_DATA, SOURCE, MINT_OFFSET],
			false,
		),
		extra(META_HOOK_PDA, [SEED_ACCOUNT_KEY, DESTINATION], false),
		extra(
			META_PUBKEY_DATA,
			[PUBKEY_DATA_ACCOUNT_DATA, SOURCE, OWNER_OFFSET],
			false,
		),
		extra(
			META_PUBKEY_DATA,
			[PUBKEY_DATA_ACCOUNT_DATA, DESTINATION, OWNER_OFFSET],
			false,
		),
	];
	const body = [...u32(extras.length), ...extras.flat()];
	return new Uint8Array([
		...EXECUTE_DISCRIMINATOR,
		...u32(body.length),
		...body,
	]);
}

const addressEncoder = getAddressEncoder();

/** A Token-2022 mint whose `TransferHook` names `program`, or an unset one for `null`. */
export function hookedMintData(program: Address | null): Uint8Array {
	const data = new Uint8Array(166 + 4 + 64);
	// `is_initialized`, then `AccountType::Mint`.
	data[45] = 1;
	data[165] = 1;
	// `TransferHook`: type 14, 64 bytes, the authority, then the program.
	data.set([14, 0, 64, 0], 166);
	data.fill(9, 170, 202);
	if (program !== null) data.set(addressEncoder.encode(program), 202);
	return data;
}

/** A mint account that runs no hook: an initialized classic SPL Token mint. */
export const HOOK_FREE_MINT: AccountView = Object.freeze({
	owner: TOKEN_PROGRAM_ADDRESS,
	// `is_initialized`.
	data: new Uint8Array(82).fill(1, 45, 46),
});

/** A Token-2022 mint account with no extension. It runs no hook. */
export const HOOK_FREE_TOKEN_2022_MINT: AccountView = Object.freeze({
	owner: TOKEN_2022_PROGRAM_ADDRESS,
	data: HOOK_FREE_MINT.data,
});

/** WSOL as `WSOL_MINT_INFO` gives it: an initialized SPL Token mint of 9 decimals. */
const WSOL_MINT_ACCOUNT: AccountView = Object.freeze({
	owner: TOKEN_PROGRAM_ADDRESS,
	// `decimals`, then `is_initialized`.
	data: new Uint8Array(82).fill(9, 44, 45).fill(1, 45, 46),
});

/** The account of `mint` where it runs no hook. WSOL is an SPL Token mint. Each other mint of
 *  these tests is a Token-2022 mint. */
export function hookFreeMintOf(mint: Address): AccountView {
	return mint === WSOL_MINT ? WSOL_MINT_ACCOUNT : HOOK_FREE_TOKEN_2022_MINT;
}

/** The hook state of a market whose `mints` run no hook. */
export function hookFreeState(mints: readonly Address[]): HookState {
	return {
		accounts: new Map<Address, AccountView | null>(
			mints.map((mint) => [mint, hookFreeMintOf(mint)]),
		),
	};
}

/** The accounts that arm the probe on `mint`: the mint, then its list. */
export async function probeAccountsOf(
	mint: Address,
	list: Uint8Array = probeList(),
): Promise<[Address, AccountView][]> {
	return [
		[
			mint,
			{
				owner: TOKEN_2022_PROGRAM_ADDRESS,
				data: hookedMintData(PROBE_PROGRAM),
			},
		],
		[
			await findValidationAddress(mint, PROBE_PROGRAM),
			{ owner: PROBE_PROGRAM, data: list },
		],
	];
}

/** The hook state of a market where `hooked` run the probe and `hookFree` run no hook. */
export async function probeState(
	hooked: readonly Address[],
	hookFree: readonly Address[] = [],
): Promise<HookState> {
	const accounts = new Map<Address, AccountView | null>(
		hookFree.map((mint) => [mint, hookFreeMintOf(mint)]),
	);
	for (const mint of hooked) {
		for (const [address, account] of await probeAccountsOf(mint)) {
			accounts.set(address, account);
		}
	}
	return { accounts };
}

/** The probe armed on `mint`, its list loaded. */
export async function probeHook(mint: Address): Promise<Hook> {
	return {
		mint,
		program: PROBE_PROGRAM,
		validation: await findValidationAddress(mint, PROBE_PROGRAM),
		list: { kind: 'Loaded', data: probeList() },
	};
}

async function probePda(key: Address): Promise<Address> {
	const [pda] = await getProgramDerivedAddress({
		programAddress: PROBE_PROGRAM,
		seeds: [addressEncoder.encode(key)],
	});
	return pda;
}

/** What the probe adds for `leg`: its extras, in SPL's roles, then the hook program and the
 *  validation account. */
export async function probeAccounts(leg: HookLeg): Promise<AccountMeta[]> {
	return [
		{ address: await probePda(leg.source), role: AccountRole.WRITABLE },
		{ address: leg.mint, role: AccountRole.READONLY },
		{
			address: await probePda(leg.destination),
			role: AccountRole.READONLY,
		},
		{ address: leg.authority, role: AccountRole.READONLY },
		{ address: leg.destinationOwner, role: AccountRole.READONLY },
		{ address: PROBE_PROGRAM, role: AccountRole.READONLY },
		{
			address: await findValidationAddress(leg.mint, PROBE_PROGRAM),
			role: AccountRole.READONLY,
		},
	];
}
