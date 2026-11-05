// A Solana RPC that answers `getMultipleAccounts` and `getAccountInfo` from a
// fixed map, through kit's own transport and response transformers.

import assert from 'node:assert/strict';
import {
	address,
	createSolanaRpcFromTransport,
	type Address,
	type GetAccountInfoApi,
	type GetMultipleAccountsApi,
	type Rpc,
	type RpcTransport,
} from '@solana/kit';

export interface FakeAccount {
	readonly owner: Address;
	readonly data: Uint8Array;
}

export interface RpcCall {
	readonly method: string;
	readonly params: readonly unknown[];
}

function isRpcCall(
	payload: unknown,
): payload is { id: unknown; method: string; params: unknown[] } {
	return (
		typeof payload === 'object' &&
		payload !== null &&
		'id' in payload &&
		'method' in payload &&
		typeof payload.method === 'string' &&
		'params' in payload &&
		Array.isArray(payload.params)
	);
}

function isAddress(value: unknown): value is Address {
	return typeof value === 'string';
}

function isAddressList(value: unknown): value is Address[] {
	return Array.isArray(value) && value.every(isAddress);
}

// An account value as the RPC sends it, in JSON numbers. Kit upcasts them.
function accountValue(account: FakeAccount | undefined) {
	if (account === undefined) return null;
	return {
		data: [Buffer.from(account.data).toString('base64'), 'base64'],
		executable: false,
		lamports: 2_039_280,
		owner: account.owner,
		rentEpoch: 0,
		space: account.data.length,
	};
}

// Kit 6 and 7 turn bigint params into numbers before the transport. Kit 8
// does not. Both send the same JSON.
function slotAsBigint(parameter: unknown): unknown {
	if (
		typeof parameter === 'object' &&
		parameter !== null &&
		'minContextSlot' in parameter &&
		typeof parameter.minContextSlot === 'number'
	) {
		return {
			...parameter,
			minContextSlot: BigInt(parameter.minContextSlot),
		};
	}
	return parameter;
}

export const CLOCK: Address = address(
	'SysvarC1ock11111111111111111111111111111111',
);

/** The `Clock` sysvar at `epoch`. */
export function clockAccount(epoch: bigint): FakeAccount {
	const data = new Uint8Array(40);
	new DataView(data.buffer).setBigUint64(16, epoch, true);
	return {
		owner: address('Sysvar1111111111111111111111111111111111111'),
		data,
	};
}

/** An RPC that answers from `accounts` at `slot`. An address that is not in `accounts` is a
 *  missing account. If `accounts` has no `CLOCK`, it answers the clock at `epoch`. `calls` records
 *  each request. */
export function fakeRpc(
	accounts: ReadonlyMap<Address, FakeAccount>,
	slot = 0,
	epoch = 0n,
): {
	readonly rpc: Rpc<GetAccountInfoApi & GetMultipleAccountsApi>;
	readonly calls: readonly RpcCall[];
} {
	const answers = new Map(accounts);
	if (!answers.has(CLOCK)) answers.set(CLOCK, clockAccount(epoch));
	const calls: RpcCall[] = [];
	// A JSON round trip, as the wire does. `JSON.parse` returns `any`, which
	// satisfies the transport's generic response type without an assertion.
	const transport: RpcTransport = ({ payload }) => {
		assert.ok(isRpcCall(payload));
		const { id, method, params } = payload;
		calls.push({ method, params: params.map(slotAsBigint) });
		const [first] = params;
		let value;
		if (method === 'getMultipleAccounts') {
			assert.ok(isAddressList(first));
			value = first.map((key) => accountValue(answers.get(key)));
		} else {
			assert.equal(method, 'getAccountInfo');
			assert.ok(isAddress(first));
			value = accountValue(answers.get(first));
		}
		const response = {
			id,
			jsonrpc: '2.0',
			result: { context: { slot }, value },
		};
		return Promise.resolve(JSON.parse(JSON.stringify(response)));
	};
	return { rpc: createSolanaRpcFromTransport(transport), calls };
}
