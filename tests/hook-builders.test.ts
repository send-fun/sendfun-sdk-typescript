// What each builder that moves a token appends for its transfer hooks. On a
// hook-free market, or from infos with no hook, it appends nothing, and the
// build matches its golden byte for byte. Otherwise it appends the hook
// accounts of each hooked leg after every fixed account. It resolves them from
// the mint infos the caller reads, and reads nothing itself. The tests also
// pin what the caller's read reads.
import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
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
	TOKEN_2022_PROGRAM_ADDRESS,
	USDC_MINT,
	WSOL_MINT,
} from '../src/constants.js';
import * as launchpad from '../src/launchpad/index.js';
import { appendHookAccounts } from '../src/transfer-hook/fetch.js';
import { type AccountView } from '../src/transfer-hook/index.js';
import {
	decodeMintState,
	findValidationAddress,
} from '../src/transfer-hook/resolver.js';
import { launchMintInfo } from '../src/utils/launch-mint-info.js';
import {
	accountData,
	accountKey,
	fixed,
	literal,
	pda,
} from './support/extra-metas.js';
import { CLOCK, type RpcCall } from './support/fake-rpc.js';
import {
	BASE_MINT,
	CREATE,
	HOOK_FREE_CASES,
	snapshot,
	TKALSHI_MINT,
	type HookFreeCase,
	type InstructionSnapshot,
} from './support/hook-free-cases.js';
import {
	armedState,
	buildFrom,
	buildWithReads,
	caseInfos,
	caseRun,
	fetchedInfos,
	filledFrom,
	hookOf,
	mintsOf,
	pausedHookedMintData,
	pausedProbeAccountsOf,
	readonlyMeta,
	rpcOver,
	trailing,
	trailingOf,
	withHook,
	withoutHooks,
} from './support/hook-runs.js';
import {
	hookFreeState,
	HOOK_FREE_TOKEN_2022_MINT,
	probeAccounts,
	probeAccountsOf,
	probeState,
	PROBE_PROGRAM,
} from './support/probe-hook.js';

interface Golden {
	readonly programAddress: string;
	readonly accounts: readonly (readonly [string, AccountRole])[];
	readonly data: readonly number[];
}

// What each builder returns for the inputs in `support/hook-free-cases.ts`. A
// hook-free build must match byte for byte.
const GOLDENS: Readonly<Record<string, readonly Golden[]>> = {
	'launchpad buildBuyExactInInstruction': [
		{
			programAddress: '5R1uFyEE4oxqkm7hJDqHq6gXaLVF9dxeF3LF4yz1sfLP',
			accounts: [
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.READONLY_SIGNER,
				],
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.WRITABLE_SIGNER,
				],
				[
					'5W7vngQFdLTE9oBCo3LBN6xjfqCTPDhiBtbDihpEJBka',
					AccountRole.WRITABLE,
				],
				[
					'8JPfavtKzVzQ998RpraLSuZUi1QvVCz77T6eZ5BQ6fNq',
					AccountRole.READONLY,
				],
				[
					'So11111111111111111111111111111111111111112',
					AccountRole.READONLY,
				],
				[
					'4tMTfnQrcVKmcj6AhZzrTFG4mRb2bXsofn77iP5Evdxw',
					AccountRole.WRITABLE,
				],
				[
					'8yeQpeSGYUaHNqZJBNqokK2N8nvk6TkUuYGfAX8s7gxN',
					AccountRole.WRITABLE,
				],
				[
					'GX2VEHBsV6QvShpTsBDgtXCNi9tJ7xw5AyN51R1tiC5t',
					AccountRole.WRITABLE,
				],
				[
					'18Y9yg3mVJPWmmmYV1j214CUapfJDELtkeYcAKUNrHz',
					AccountRole.WRITABLE,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'B77P3Hvj9xLi4tcFtyjNcf6NjhkQrfJvLkz3nVZnBzec',
					AccountRole.READONLY,
				],
				[
					'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
					AccountRole.READONLY,
				],
				[
					'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
					AccountRole.READONLY,
				],
				[
					'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
					AccountRole.READONLY,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'FJVebqCthxH6JM8vvkJb7yRYA7Emsib1C1vu4ZePSP3T',
					AccountRole.READONLY,
				],
				[
					'5R1uFyEE4oxqkm7hJDqHq6gXaLVF9dxeF3LF4yz1sfLP',
					AccountRole.READONLY,
				],
			],
			data: [
				250, 234, 13, 123, 213, 156, 19, 236, 0, 202, 154, 59, 0, 0, 0,
				0, 0, 118, 190, 55, 7, 0, 0, 0,
			],
		},
	],
	'launchpad buildBuyExactInInstruction, Token-2022 quote': [
		{
			programAddress: '5R1uFyEE4oxqkm7hJDqHq6gXaLVF9dxeF3LF4yz1sfLP',
			accounts: [
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.READONLY_SIGNER,
				],
				[
					'9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
					AccountRole.WRITABLE_SIGNER,
				],
				[
					'3QLaWjJZ8VuZvMngrWkp8sMYrPXeAH8wVTweLCPF7RrZ',
					AccountRole.WRITABLE,
				],
				[
					'8JPfavtKzVzQ998RpraLSuZUi1QvVCz77T6eZ5BQ6fNq',
					AccountRole.READONLY,
				],
				[
					'TKLSidmLVt3cqGaaodG8tyRzoANfQwoh67AccjmubeZ',
					AccountRole.READONLY,
				],
				[
					'8NWLNKMMzgZHJZ3NjqmnghhMGSmnUvZJ5Ykz6hhvoVAT',
					AccountRole.WRITABLE,
				],
				[
					'CUhVgpmzhfKmFz1EpYA4JK1paf9ttVf4Sv5wqjPaZAMe',
					AccountRole.WRITABLE,
				],
				[
					'6ksD4MwN1XHsts93q7e8VaYZsb3rxCPeBYQpdsBDiHyJ',
					AccountRole.WRITABLE,
				],
				[
					'EsEezwzxG2vtBjt6K93eEGCDRjLiSASYt6bNNezzds6W',
					AccountRole.WRITABLE,
				],
				[
					'Hs3bBEkKQaR9dGkFpQyBtnQvHXWyKMYyYnFVLZ4WM5Ac',
					AccountRole.READONLY_SIGNER,
				],
				[
					'4RGizLYYsr9LNFZkzrSd6Log9faBnYmrP1poCs11Zsnp',
					AccountRole.READONLY,
				],
				[
					'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
					AccountRole.READONLY,
				],
				[
					'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
					AccountRole.READONLY,
				],
				[
					'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
					AccountRole.READONLY,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'FJVebqCthxH6JM8vvkJb7yRYA7Emsib1C1vu4ZePSP3T',
					AccountRole.READONLY,
				],
				[
					'5R1uFyEE4oxqkm7hJDqHq6gXaLVF9dxeF3LF4yz1sfLP',
					AccountRole.READONLY,
				],
			],
			data: [
				250, 234, 13, 123, 213, 156, 19, 236, 0, 202, 154, 59, 0, 0, 0,
				0, 0, 118, 190, 55, 7, 0, 0, 0,
			],
		},
	],
	'launchpad buildBuyExactOutInstruction': [
		{
			programAddress: '5R1uFyEE4oxqkm7hJDqHq6gXaLVF9dxeF3LF4yz1sfLP',
			accounts: [
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.READONLY_SIGNER,
				],
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.WRITABLE_SIGNER,
				],
				[
					'5W7vngQFdLTE9oBCo3LBN6xjfqCTPDhiBtbDihpEJBka',
					AccountRole.WRITABLE,
				],
				[
					'8JPfavtKzVzQ998RpraLSuZUi1QvVCz77T6eZ5BQ6fNq',
					AccountRole.READONLY,
				],
				[
					'So11111111111111111111111111111111111111112',
					AccountRole.READONLY,
				],
				[
					'4tMTfnQrcVKmcj6AhZzrTFG4mRb2bXsofn77iP5Evdxw',
					AccountRole.WRITABLE,
				],
				[
					'8yeQpeSGYUaHNqZJBNqokK2N8nvk6TkUuYGfAX8s7gxN',
					AccountRole.WRITABLE,
				],
				[
					'GX2VEHBsV6QvShpTsBDgtXCNi9tJ7xw5AyN51R1tiC5t',
					AccountRole.WRITABLE,
				],
				[
					'18Y9yg3mVJPWmmmYV1j214CUapfJDELtkeYcAKUNrHz',
					AccountRole.WRITABLE,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'B77P3Hvj9xLi4tcFtyjNcf6NjhkQrfJvLkz3nVZnBzec',
					AccountRole.READONLY,
				],
				[
					'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
					AccountRole.READONLY,
				],
				[
					'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
					AccountRole.READONLY,
				],
				[
					'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
					AccountRole.READONLY,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'FJVebqCthxH6JM8vvkJb7yRYA7Emsib1C1vu4ZePSP3T',
					AccountRole.READONLY,
				],
				[
					'5R1uFyEE4oxqkm7hJDqHq6gXaLVF9dxeF3LF4yz1sfLP',
					AccountRole.READONLY,
				],
			],
			data: [
				24, 211, 116, 40, 105, 3, 153, 56, 0, 228, 11, 84, 2, 0, 0, 0,
				0, 132, 215, 23, 0, 0, 0, 0,
			],
		},
	],
	'launchpad buildSellExactInInstruction': [
		{
			programAddress: '5R1uFyEE4oxqkm7hJDqHq6gXaLVF9dxeF3LF4yz1sfLP',
			accounts: [
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.READONLY_SIGNER,
				],
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.WRITABLE_SIGNER,
				],
				[
					'5W7vngQFdLTE9oBCo3LBN6xjfqCTPDhiBtbDihpEJBka',
					AccountRole.WRITABLE,
				],
				[
					'8JPfavtKzVzQ998RpraLSuZUi1QvVCz77T6eZ5BQ6fNq',
					AccountRole.READONLY,
				],
				[
					'So11111111111111111111111111111111111111112',
					AccountRole.READONLY,
				],
				[
					'4tMTfnQrcVKmcj6AhZzrTFG4mRb2bXsofn77iP5Evdxw',
					AccountRole.WRITABLE,
				],
				[
					'8yeQpeSGYUaHNqZJBNqokK2N8nvk6TkUuYGfAX8s7gxN',
					AccountRole.WRITABLE,
				],
				[
					'GX2VEHBsV6QvShpTsBDgtXCNi9tJ7xw5AyN51R1tiC5t',
					AccountRole.WRITABLE,
				],
				[
					'18Y9yg3mVJPWmmmYV1j214CUapfJDELtkeYcAKUNrHz',
					AccountRole.WRITABLE,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'B77P3Hvj9xLi4tcFtyjNcf6NjhkQrfJvLkz3nVZnBzec',
					AccountRole.READONLY,
				],
				[
					'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
					AccountRole.READONLY,
				],
				[
					'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
					AccountRole.READONLY,
				],
				[
					'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
					AccountRole.READONLY,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'FJVebqCthxH6JM8vvkJb7yRYA7Emsib1C1vu4ZePSP3T',
					AccountRole.READONLY,
				],
				[
					'5R1uFyEE4oxqkm7hJDqHq6gXaLVF9dxeF3LF4yz1sfLP',
					AccountRole.READONLY,
				],
			],
			data: [
				149, 39, 222, 155, 211, 124, 152, 26, 0, 228, 11, 84, 2, 0, 0,
				0, 128, 178, 230, 14, 0, 0, 0, 0,
			],
		},
	],
	'launchpad buildSellExactOutInstruction': [
		{
			programAddress: '5R1uFyEE4oxqkm7hJDqHq6gXaLVF9dxeF3LF4yz1sfLP',
			accounts: [
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.READONLY_SIGNER,
				],
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.WRITABLE_SIGNER,
				],
				[
					'5W7vngQFdLTE9oBCo3LBN6xjfqCTPDhiBtbDihpEJBka',
					AccountRole.WRITABLE,
				],
				[
					'8JPfavtKzVzQ998RpraLSuZUi1QvVCz77T6eZ5BQ6fNq',
					AccountRole.READONLY,
				],
				[
					'So11111111111111111111111111111111111111112',
					AccountRole.READONLY,
				],
				[
					'4tMTfnQrcVKmcj6AhZzrTFG4mRb2bXsofn77iP5Evdxw',
					AccountRole.WRITABLE,
				],
				[
					'8yeQpeSGYUaHNqZJBNqokK2N8nvk6TkUuYGfAX8s7gxN',
					AccountRole.WRITABLE,
				],
				[
					'GX2VEHBsV6QvShpTsBDgtXCNi9tJ7xw5AyN51R1tiC5t',
					AccountRole.WRITABLE,
				],
				[
					'18Y9yg3mVJPWmmmYV1j214CUapfJDELtkeYcAKUNrHz',
					AccountRole.WRITABLE,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'B77P3Hvj9xLi4tcFtyjNcf6NjhkQrfJvLkz3nVZnBzec',
					AccountRole.READONLY,
				],
				[
					'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
					AccountRole.READONLY,
				],
				[
					'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
					AccountRole.READONLY,
				],
				[
					'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
					AccountRole.READONLY,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'FJVebqCthxH6JM8vvkJb7yRYA7Emsib1C1vu4ZePSP3T',
					AccountRole.READONLY,
				],
				[
					'5R1uFyEE4oxqkm7hJDqHq6gXaLVF9dxeF3LF4yz1sfLP',
					AccountRole.READONLY,
				],
			],
			data: [
				95, 200, 71, 34, 8, 9, 11, 166, 128, 178, 230, 14, 0, 0, 0, 0,
				0, 228, 11, 84, 2, 0, 0, 0,
			],
		},
	],
	'launchpad buyExactIn': [
		{
			programAddress: '5R1uFyEE4oxqkm7hJDqHq6gXaLVF9dxeF3LF4yz1sfLP',
			accounts: [
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.READONLY_SIGNER,
				],
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.WRITABLE_SIGNER,
				],
				[
					'5W7vngQFdLTE9oBCo3LBN6xjfqCTPDhiBtbDihpEJBka',
					AccountRole.WRITABLE,
				],
				[
					'8JPfavtKzVzQ998RpraLSuZUi1QvVCz77T6eZ5BQ6fNq',
					AccountRole.READONLY,
				],
				[
					'So11111111111111111111111111111111111111112',
					AccountRole.READONLY,
				],
				[
					'4tMTfnQrcVKmcj6AhZzrTFG4mRb2bXsofn77iP5Evdxw',
					AccountRole.WRITABLE,
				],
				[
					'8yeQpeSGYUaHNqZJBNqokK2N8nvk6TkUuYGfAX8s7gxN',
					AccountRole.WRITABLE,
				],
				[
					'GX2VEHBsV6QvShpTsBDgtXCNi9tJ7xw5AyN51R1tiC5t',
					AccountRole.WRITABLE,
				],
				[
					'18Y9yg3mVJPWmmmYV1j214CUapfJDELtkeYcAKUNrHz',
					AccountRole.WRITABLE,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'B77P3Hvj9xLi4tcFtyjNcf6NjhkQrfJvLkz3nVZnBzec',
					AccountRole.READONLY,
				],
				[
					'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
					AccountRole.READONLY,
				],
				[
					'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
					AccountRole.READONLY,
				],
				[
					'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
					AccountRole.READONLY,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'FJVebqCthxH6JM8vvkJb7yRYA7Emsib1C1vu4ZePSP3T',
					AccountRole.READONLY,
				],
				[
					'5R1uFyEE4oxqkm7hJDqHq6gXaLVF9dxeF3LF4yz1sfLP',
					AccountRole.READONLY,
				],
			],
			data: [
				250, 234, 13, 123, 213, 156, 19, 236, 0, 202, 154, 59, 0, 0, 0,
				0, 194, 131, 19, 93, 7, 0, 0, 0,
			],
		},
	],
	'launchpad buyExactOut': [
		{
			programAddress: '5R1uFyEE4oxqkm7hJDqHq6gXaLVF9dxeF3LF4yz1sfLP',
			accounts: [
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.READONLY_SIGNER,
				],
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.WRITABLE_SIGNER,
				],
				[
					'5W7vngQFdLTE9oBCo3LBN6xjfqCTPDhiBtbDihpEJBka',
					AccountRole.WRITABLE,
				],
				[
					'8JPfavtKzVzQ998RpraLSuZUi1QvVCz77T6eZ5BQ6fNq',
					AccountRole.READONLY,
				],
				[
					'So11111111111111111111111111111111111111112',
					AccountRole.READONLY,
				],
				[
					'4tMTfnQrcVKmcj6AhZzrTFG4mRb2bXsofn77iP5Evdxw',
					AccountRole.WRITABLE,
				],
				[
					'8yeQpeSGYUaHNqZJBNqokK2N8nvk6TkUuYGfAX8s7gxN',
					AccountRole.WRITABLE,
				],
				[
					'GX2VEHBsV6QvShpTsBDgtXCNi9tJ7xw5AyN51R1tiC5t',
					AccountRole.WRITABLE,
				],
				[
					'18Y9yg3mVJPWmmmYV1j214CUapfJDELtkeYcAKUNrHz',
					AccountRole.WRITABLE,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'B77P3Hvj9xLi4tcFtyjNcf6NjhkQrfJvLkz3nVZnBzec',
					AccountRole.READONLY,
				],
				[
					'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
					AccountRole.READONLY,
				],
				[
					'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
					AccountRole.READONLY,
				],
				[
					'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
					AccountRole.READONLY,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'FJVebqCthxH6JM8vvkJb7yRYA7Emsib1C1vu4ZePSP3T',
					AccountRole.READONLY,
				],
				[
					'5R1uFyEE4oxqkm7hJDqHq6gXaLVF9dxeF3LF4yz1sfLP',
					AccountRole.READONLY,
				],
			],
			data: [
				24, 211, 116, 40, 105, 3, 153, 56, 0, 228, 11, 84, 2, 0, 0, 0,
				130, 73, 109, 18, 0, 0, 0, 0,
			],
		},
	],
	'launchpad sellExactIn': [
		{
			programAddress: '5R1uFyEE4oxqkm7hJDqHq6gXaLVF9dxeF3LF4yz1sfLP',
			accounts: [
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.READONLY_SIGNER,
				],
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.WRITABLE_SIGNER,
				],
				[
					'5W7vngQFdLTE9oBCo3LBN6xjfqCTPDhiBtbDihpEJBka',
					AccountRole.WRITABLE,
				],
				[
					'8JPfavtKzVzQ998RpraLSuZUi1QvVCz77T6eZ5BQ6fNq',
					AccountRole.READONLY,
				],
				[
					'So11111111111111111111111111111111111111112',
					AccountRole.READONLY,
				],
				[
					'4tMTfnQrcVKmcj6AhZzrTFG4mRb2bXsofn77iP5Evdxw',
					AccountRole.WRITABLE,
				],
				[
					'8yeQpeSGYUaHNqZJBNqokK2N8nvk6TkUuYGfAX8s7gxN',
					AccountRole.WRITABLE,
				],
				[
					'GX2VEHBsV6QvShpTsBDgtXCNi9tJ7xw5AyN51R1tiC5t',
					AccountRole.WRITABLE,
				],
				[
					'18Y9yg3mVJPWmmmYV1j214CUapfJDELtkeYcAKUNrHz',
					AccountRole.WRITABLE,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'B77P3Hvj9xLi4tcFtyjNcf6NjhkQrfJvLkz3nVZnBzec',
					AccountRole.READONLY,
				],
				[
					'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
					AccountRole.READONLY,
				],
				[
					'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
					AccountRole.READONLY,
				],
				[
					'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
					AccountRole.READONLY,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'FJVebqCthxH6JM8vvkJb7yRYA7Emsib1C1vu4ZePSP3T',
					AccountRole.READONLY,
				],
				[
					'5R1uFyEE4oxqkm7hJDqHq6gXaLVF9dxeF3LF4yz1sfLP',
					AccountRole.READONLY,
				],
			],
			data: [
				149, 39, 222, 155, 211, 124, 152, 26, 0, 228, 11, 84, 2, 0, 0,
				0, 217, 30, 90, 17, 0, 0, 0, 0,
			],
		},
	],
	'launchpad sellExactOut': [
		{
			programAddress: '5R1uFyEE4oxqkm7hJDqHq6gXaLVF9dxeF3LF4yz1sfLP',
			accounts: [
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.READONLY_SIGNER,
				],
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.WRITABLE_SIGNER,
				],
				[
					'5W7vngQFdLTE9oBCo3LBN6xjfqCTPDhiBtbDihpEJBka',
					AccountRole.WRITABLE,
				],
				[
					'8JPfavtKzVzQ998RpraLSuZUi1QvVCz77T6eZ5BQ6fNq',
					AccountRole.READONLY,
				],
				[
					'So11111111111111111111111111111111111111112',
					AccountRole.READONLY,
				],
				[
					'4tMTfnQrcVKmcj6AhZzrTFG4mRb2bXsofn77iP5Evdxw',
					AccountRole.WRITABLE,
				],
				[
					'8yeQpeSGYUaHNqZJBNqokK2N8nvk6TkUuYGfAX8s7gxN',
					AccountRole.WRITABLE,
				],
				[
					'GX2VEHBsV6QvShpTsBDgtXCNi9tJ7xw5AyN51R1tiC5t',
					AccountRole.WRITABLE,
				],
				[
					'18Y9yg3mVJPWmmmYV1j214CUapfJDELtkeYcAKUNrHz',
					AccountRole.WRITABLE,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'B77P3Hvj9xLi4tcFtyjNcf6NjhkQrfJvLkz3nVZnBzec',
					AccountRole.READONLY,
				],
				[
					'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
					AccountRole.READONLY,
				],
				[
					'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
					AccountRole.READONLY,
				],
				[
					'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
					AccountRole.READONLY,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'FJVebqCthxH6JM8vvkJb7yRYA7Emsib1C1vu4ZePSP3T',
					AccountRole.READONLY,
				],
				[
					'5R1uFyEE4oxqkm7hJDqHq6gXaLVF9dxeF3LF4yz1sfLP',
					AccountRole.READONLY,
				],
			],
			data: [
				95, 200, 71, 34, 8, 9, 11, 166, 128, 178, 230, 14, 0, 0, 0, 0,
				55, 161, 10, 255, 1, 0, 0, 0,
			],
		},
	],
	'launchpad buildCreateAndBuyInstructions': [
		{
			programAddress: '5R1uFyEE4oxqkm7hJDqHq6gXaLVF9dxeF3LF4yz1sfLP',
			accounts: [
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.WRITABLE_SIGNER,
				],
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.WRITABLE_SIGNER,
				],
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.READONLY,
				],
				[
					'H3csa1cgR7zPJdxCzNbS5chYymHMKS3XivDA5nRx4Bdq',
					AccountRole.READONLY,
				],
				[
					'8JPfavtKzVzQ998RpraLSuZUi1QvVCz77T6eZ5BQ6fNq',
					AccountRole.WRITABLE_SIGNER,
				],
				[
					'TKLSidmLVt3cqGaaodG8tyRzoANfQwoh67AccjmubeZ',
					AccountRole.READONLY,
				],
				[
					'3QLaWjJZ8VuZvMngrWkp8sMYrPXeAH8wVTweLCPF7RrZ',
					AccountRole.WRITABLE,
				],
				[
					'8NWLNKMMzgZHJZ3NjqmnghhMGSmnUvZJ5Ykz6hhvoVAT',
					AccountRole.WRITABLE,
				],
				[
					'CUhVgpmzhfKmFz1EpYA4JK1paf9ttVf4Sv5wqjPaZAMe',
					AccountRole.WRITABLE,
				],
				[
					'9Rg1Fo83qhKco1Dp8FJvR4VJN19CDRbPQxY5wSbDvwrP',
					AccountRole.WRITABLE,
				],
				[
					'7rrCurqdWFesbzwtYPo95fM8waTtVXgXwCom45x1sfNX',
					AccountRole.READONLY,
				],
				[
					'3bycfBeRULfXYqcg3DmiYFBjv6mMVidMuqKdFZJTGdNr',
					AccountRole.READONLY,
				],
				[
					'Hs3bBEkKQaR9dGkFpQyBtnQvHXWyKMYyYnFVLZ4WM5Ac',
					AccountRole.READONLY_SIGNER,
				],
				[
					'4RGizLYYsr9LNFZkzrSd6Log9faBnYmrP1poCs11Zsnp',
					AccountRole.READONLY,
				],
				[
					'9WUowYRb6KAWjWVB5KMmTngBidZXEXgQcQRTXbhxeGbF',
					AccountRole.READONLY,
				],
				[
					'BypBuAod7hb68iaUKAcAFNDfocoRrznb4CEcV9TEwaYv',
					AccountRole.WRITABLE,
				],
				[
					'EpeSe3y2EzYKPtEV6XDFLYEL9uENL6azrdNDm7fFVSp5',
					AccountRole.WRITABLE,
				],
				[
					'9AzRHyQipvK9ogESNqGckVbTJnYu2PMcUCK9QMvV873j',
					AccountRole.WRITABLE,
				],
				[
					'AyisZJxXz9ywXhMwR3sb3oePxBB6UBvixXycAQCdSgrz',
					AccountRole.WRITABLE,
				],
				[
					'91AVurtPdUC2yG3joLoujzC216KAfH5HEKnZEELFMmVH',
					AccountRole.WRITABLE,
				],
				[
					'7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE',
					AccountRole.READONLY,
				],
				[
					'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
					AccountRole.READONLY,
				],
				[
					'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
					AccountRole.READONLY,
				],
				[
					'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
					AccountRole.READONLY,
				],
				[
					'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
					AccountRole.READONLY,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'FJVebqCthxH6JM8vvkJb7yRYA7Emsib1C1vu4ZePSP3T',
					AccountRole.READONLY,
				],
				[
					'5R1uFyEE4oxqkm7hJDqHq6gXaLVF9dxeF3LF4yz1sfLP',
					AccountRole.READONLY,
				],
			],
			data: [
				84, 52, 204, 228, 24, 140, 234, 75, 20, 146, 107, 143, 82, 194,
				216, 153, 89, 206, 66, 186, 99, 124, 181, 109, 139, 11, 254,
				136, 150, 31, 161, 186, 90, 231, 197, 195, 57, 48, 69, 80, 4, 0,
				0, 0, 84, 101, 115, 116, 4, 0, 0, 0, 84, 69, 83, 84, 26, 0, 0,
				0, 104, 116, 116, 112, 115, 58, 47, 47, 101, 120, 97, 109, 112,
				108, 101, 46, 99, 111, 109, 47, 116, 46, 106, 115, 111, 110, 0,
				30, 0, 10, 0,
			],
		},
		{
			programAddress: '5R1uFyEE4oxqkm7hJDqHq6gXaLVF9dxeF3LF4yz1sfLP',
			accounts: [
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.READONLY_SIGNER,
				],
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.WRITABLE_SIGNER,
				],
				[
					'3QLaWjJZ8VuZvMngrWkp8sMYrPXeAH8wVTweLCPF7RrZ',
					AccountRole.WRITABLE,
				],
				[
					'8JPfavtKzVzQ998RpraLSuZUi1QvVCz77T6eZ5BQ6fNq',
					AccountRole.READONLY,
				],
				[
					'TKLSidmLVt3cqGaaodG8tyRzoANfQwoh67AccjmubeZ',
					AccountRole.READONLY,
				],
				[
					'8NWLNKMMzgZHJZ3NjqmnghhMGSmnUvZJ5Ykz6hhvoVAT',
					AccountRole.WRITABLE,
				],
				[
					'CUhVgpmzhfKmFz1EpYA4JK1paf9ttVf4Sv5wqjPaZAMe',
					AccountRole.WRITABLE,
				],
				[
					'GX2VEHBsV6QvShpTsBDgtXCNi9tJ7xw5AyN51R1tiC5t',
					AccountRole.WRITABLE,
				],
				[
					'EsEezwzxG2vtBjt6K93eEGCDRjLiSASYt6bNNezzds6W',
					AccountRole.WRITABLE,
				],
				[
					'Hs3bBEkKQaR9dGkFpQyBtnQvHXWyKMYyYnFVLZ4WM5Ac',
					AccountRole.READONLY_SIGNER,
				],
				[
					'4RGizLYYsr9LNFZkzrSd6Log9faBnYmrP1poCs11Zsnp',
					AccountRole.READONLY,
				],
				[
					'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
					AccountRole.READONLY,
				],
				[
					'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
					AccountRole.READONLY,
				],
				[
					'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
					AccountRole.READONLY,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'FJVebqCthxH6JM8vvkJb7yRYA7Emsib1C1vu4ZePSP3T',
					AccountRole.READONLY,
				],
				[
					'5R1uFyEE4oxqkm7hJDqHq6gXaLVF9dxeF3LF4yz1sfLP',
					AccountRole.READONLY,
				],
			],
			data: [
				250, 234, 13, 123, 213, 156, 19, 236, 0, 202, 154, 59, 0, 0, 0,
				0, 194, 131, 19, 93, 7, 0, 0, 0,
			],
		},
	],
	'launchpad buildMigrateInstruction': [
		{
			programAddress: '5R1uFyEE4oxqkm7hJDqHq6gXaLVF9dxeF3LF4yz1sfLP',
			accounts: [
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.WRITABLE_SIGNER,
				],
				[
					'3QLaWjJZ8VuZvMngrWkp8sMYrPXeAH8wVTweLCPF7RrZ',
					AccountRole.WRITABLE,
				],
				[
					'8JPfavtKzVzQ998RpraLSuZUi1QvVCz77T6eZ5BQ6fNq',
					AccountRole.WRITABLE,
				],
				[
					'TKLSidmLVt3cqGaaodG8tyRzoANfQwoh67AccjmubeZ',
					AccountRole.READONLY,
				],
				[
					'8NWLNKMMzgZHJZ3NjqmnghhMGSmnUvZJ5Ykz6hhvoVAT',
					AccountRole.WRITABLE,
				],
				[
					'CUhVgpmzhfKmFz1EpYA4JK1paf9ttVf4Sv5wqjPaZAMe',
					AccountRole.WRITABLE,
				],
				[
					'84qj5FPZZdXkQy8mfowyg6RBZ3XKuTds6XS4ZYT1sfDX',
					AccountRole.READONLY,
				],
				[
					'932vp5VTARoqoAKNgLSawfCsAx43jUJ5YURggmXBX6V',
					AccountRole.READONLY,
				],
				[
					'7Mz36vvxNxvYwEy47V76ansrXi9qNQsq6HqsXToapodv',
					AccountRole.WRITABLE,
				],
				[
					'EqgjQE1DUir3BJMMjZEPx6v9bozh5VxT2CwQUBKx1L5u',
					AccountRole.WRITABLE,
				],
				[
					'6YX9eGTcVytFqYTBE52VU6QC6xkiBkzwzcz2qiLziogy',
					AccountRole.WRITABLE,
				],
				[
					'8oF9Cke49z2jhFJa8LfoksDx7ZmMnFPnanYuM9TaX7Fw',
					AccountRole.WRITABLE,
				],
				[
					'2Wai1YPcttQ2qoKSNuMoFuXfyKzGEWCCHZucBMdQm1fM',
					AccountRole.WRITABLE,
				],
				[
					'4pTDYKRFdmxTQYFceGZkzPGd3kb8ShMA9n6XKRaPZn8t',
					AccountRole.READONLY,
				],
				[
					'7rrCurqdWFesbzwtYPo95fM8waTtVXgXwCom45x1sfNX',
					AccountRole.READONLY,
				],
				[
					'9Rg1Fo83qhKco1Dp8FJvR4VJN19CDRbPQxY5wSbDvwrP',
					AccountRole.WRITABLE,
				],
				[
					'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
					AccountRole.READONLY,
				],
				[
					'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
					AccountRole.READONLY,
				],
				[
					'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
					AccountRole.READONLY,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'FJVebqCthxH6JM8vvkJb7yRYA7Emsib1C1vu4ZePSP3T',
					AccountRole.READONLY,
				],
				[
					'5R1uFyEE4oxqkm7hJDqHq6gXaLVF9dxeF3LF4yz1sfLP',
					AccountRole.READONLY,
				],
				[
					'BqvUv1r5SLm4BZsUnZeh7JUATMKpkeaRM1UGscYMdHkk',
					AccountRole.WRITABLE,
				],
			],
			data: [155, 234, 231, 146, 236, 158, 162, 30],
		},
	],
	'dex buildBuyExactInInstruction': [
		{
			programAddress: '84qj5FPZZdXkQy8mfowyg6RBZ3XKuTds6XS4ZYT1sfDX',
			accounts: [
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.READONLY_SIGNER,
				],
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.WRITABLE_SIGNER,
				],
				[
					'A68ZM1PZt1o22yTfHBa7diFHS59YFXWSz7tB77SjmDva',
					AccountRole.WRITABLE,
				],
				[
					'8JPfavtKzVzQ998RpraLSuZUi1QvVCz77T6eZ5BQ6fNq',
					AccountRole.READONLY,
				],
				[
					'So11111111111111111111111111111111111111112',
					AccountRole.READONLY,
				],
				[
					'GQW15xteLPZszm1Dwzp4SsCoiPehJweejNSivFTMBpp9',
					AccountRole.WRITABLE,
				],
				[
					'CWYjaKHWjkatr9Rma6qRn3kj8heG8Tr1xqkGMa9ZUZg9',
					AccountRole.WRITABLE,
				],
				[
					'GX2VEHBsV6QvShpTsBDgtXCNi9tJ7xw5AyN51R1tiC5t',
					AccountRole.WRITABLE,
				],
				[
					'18Y9yg3mVJPWmmmYV1j214CUapfJDELtkeYcAKUNrHz',
					AccountRole.WRITABLE,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'B77P3Hvj9xLi4tcFtyjNcf6NjhkQrfJvLkz3nVZnBzec',
					AccountRole.READONLY,
				],
				[
					'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
					AccountRole.READONLY,
				],
				[
					'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
					AccountRole.READONLY,
				],
				[
					'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
					AccountRole.READONLY,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'4pTDYKRFdmxTQYFceGZkzPGd3kb8ShMA9n6XKRaPZn8t',
					AccountRole.READONLY,
				],
				[
					'84qj5FPZZdXkQy8mfowyg6RBZ3XKuTds6XS4ZYT1sfDX',
					AccountRole.READONLY,
				],
			],
			data: [
				250, 234, 13, 123, 213, 156, 19, 236, 0, 202, 154, 59, 0, 0, 0,
				0, 0, 118, 190, 55, 7, 0, 0, 0,
			],
		},
	],
	'dex buildBuyExactInInstruction, Token-2022 quote': [
		{
			programAddress: '84qj5FPZZdXkQy8mfowyg6RBZ3XKuTds6XS4ZYT1sfDX',
			accounts: [
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.READONLY_SIGNER,
				],
				[
					'9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
					AccountRole.WRITABLE_SIGNER,
				],
				[
					'7Mz36vvxNxvYwEy47V76ansrXi9qNQsq6HqsXToapodv',
					AccountRole.WRITABLE,
				],
				[
					'8JPfavtKzVzQ998RpraLSuZUi1QvVCz77T6eZ5BQ6fNq',
					AccountRole.READONLY,
				],
				[
					'TKLSidmLVt3cqGaaodG8tyRzoANfQwoh67AccjmubeZ',
					AccountRole.READONLY,
				],
				[
					'6YX9eGTcVytFqYTBE52VU6QC6xkiBkzwzcz2qiLziogy',
					AccountRole.WRITABLE,
				],
				[
					'8oF9Cke49z2jhFJa8LfoksDx7ZmMnFPnanYuM9TaX7Fw',
					AccountRole.WRITABLE,
				],
				[
					'6ksD4MwN1XHsts93q7e8VaYZsb3rxCPeBYQpdsBDiHyJ',
					AccountRole.WRITABLE,
				],
				[
					'EsEezwzxG2vtBjt6K93eEGCDRjLiSASYt6bNNezzds6W',
					AccountRole.WRITABLE,
				],
				[
					'Hs3bBEkKQaR9dGkFpQyBtnQvHXWyKMYyYnFVLZ4WM5Ac',
					AccountRole.READONLY_SIGNER,
				],
				[
					'4RGizLYYsr9LNFZkzrSd6Log9faBnYmrP1poCs11Zsnp',
					AccountRole.READONLY,
				],
				[
					'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
					AccountRole.READONLY,
				],
				[
					'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
					AccountRole.READONLY,
				],
				[
					'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
					AccountRole.READONLY,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'4pTDYKRFdmxTQYFceGZkzPGd3kb8ShMA9n6XKRaPZn8t',
					AccountRole.READONLY,
				],
				[
					'84qj5FPZZdXkQy8mfowyg6RBZ3XKuTds6XS4ZYT1sfDX',
					AccountRole.READONLY,
				],
			],
			data: [
				250, 234, 13, 123, 213, 156, 19, 236, 0, 202, 154, 59, 0, 0, 0,
				0, 0, 118, 190, 55, 7, 0, 0, 0,
			],
		},
	],
	'dex buildBuyExactOutInstruction': [
		{
			programAddress: '84qj5FPZZdXkQy8mfowyg6RBZ3XKuTds6XS4ZYT1sfDX',
			accounts: [
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.READONLY_SIGNER,
				],
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.WRITABLE_SIGNER,
				],
				[
					'A68ZM1PZt1o22yTfHBa7diFHS59YFXWSz7tB77SjmDva',
					AccountRole.WRITABLE,
				],
				[
					'8JPfavtKzVzQ998RpraLSuZUi1QvVCz77T6eZ5BQ6fNq',
					AccountRole.READONLY,
				],
				[
					'So11111111111111111111111111111111111111112',
					AccountRole.READONLY,
				],
				[
					'GQW15xteLPZszm1Dwzp4SsCoiPehJweejNSivFTMBpp9',
					AccountRole.WRITABLE,
				],
				[
					'CWYjaKHWjkatr9Rma6qRn3kj8heG8Tr1xqkGMa9ZUZg9',
					AccountRole.WRITABLE,
				],
				[
					'GX2VEHBsV6QvShpTsBDgtXCNi9tJ7xw5AyN51R1tiC5t',
					AccountRole.WRITABLE,
				],
				[
					'18Y9yg3mVJPWmmmYV1j214CUapfJDELtkeYcAKUNrHz',
					AccountRole.WRITABLE,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'B77P3Hvj9xLi4tcFtyjNcf6NjhkQrfJvLkz3nVZnBzec',
					AccountRole.READONLY,
				],
				[
					'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
					AccountRole.READONLY,
				],
				[
					'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
					AccountRole.READONLY,
				],
				[
					'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
					AccountRole.READONLY,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'4pTDYKRFdmxTQYFceGZkzPGd3kb8ShMA9n6XKRaPZn8t',
					AccountRole.READONLY,
				],
				[
					'84qj5FPZZdXkQy8mfowyg6RBZ3XKuTds6XS4ZYT1sfDX',
					AccountRole.READONLY,
				],
			],
			data: [
				24, 211, 116, 40, 105, 3, 153, 56, 0, 228, 11, 84, 2, 0, 0, 0,
				0, 132, 215, 23, 0, 0, 0, 0,
			],
		},
	],
	'dex buildSellExactInInstruction': [
		{
			programAddress: '84qj5FPZZdXkQy8mfowyg6RBZ3XKuTds6XS4ZYT1sfDX',
			accounts: [
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.READONLY_SIGNER,
				],
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.WRITABLE_SIGNER,
				],
				[
					'A68ZM1PZt1o22yTfHBa7diFHS59YFXWSz7tB77SjmDva',
					AccountRole.WRITABLE,
				],
				[
					'8JPfavtKzVzQ998RpraLSuZUi1QvVCz77T6eZ5BQ6fNq',
					AccountRole.READONLY,
				],
				[
					'So11111111111111111111111111111111111111112',
					AccountRole.READONLY,
				],
				[
					'GQW15xteLPZszm1Dwzp4SsCoiPehJweejNSivFTMBpp9',
					AccountRole.WRITABLE,
				],
				[
					'CWYjaKHWjkatr9Rma6qRn3kj8heG8Tr1xqkGMa9ZUZg9',
					AccountRole.WRITABLE,
				],
				[
					'GX2VEHBsV6QvShpTsBDgtXCNi9tJ7xw5AyN51R1tiC5t',
					AccountRole.WRITABLE,
				],
				[
					'18Y9yg3mVJPWmmmYV1j214CUapfJDELtkeYcAKUNrHz',
					AccountRole.WRITABLE,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'B77P3Hvj9xLi4tcFtyjNcf6NjhkQrfJvLkz3nVZnBzec',
					AccountRole.READONLY,
				],
				[
					'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
					AccountRole.READONLY,
				],
				[
					'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
					AccountRole.READONLY,
				],
				[
					'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
					AccountRole.READONLY,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'4pTDYKRFdmxTQYFceGZkzPGd3kb8ShMA9n6XKRaPZn8t',
					AccountRole.READONLY,
				],
				[
					'84qj5FPZZdXkQy8mfowyg6RBZ3XKuTds6XS4ZYT1sfDX',
					AccountRole.READONLY,
				],
			],
			data: [
				149, 39, 222, 155, 211, 124, 152, 26, 0, 228, 11, 84, 2, 0, 0,
				0, 128, 178, 230, 14, 0, 0, 0, 0,
			],
		},
	],
	'dex buildSellExactOutInstruction': [
		{
			programAddress: '84qj5FPZZdXkQy8mfowyg6RBZ3XKuTds6XS4ZYT1sfDX',
			accounts: [
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.READONLY_SIGNER,
				],
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.WRITABLE_SIGNER,
				],
				[
					'A68ZM1PZt1o22yTfHBa7diFHS59YFXWSz7tB77SjmDva',
					AccountRole.WRITABLE,
				],
				[
					'8JPfavtKzVzQ998RpraLSuZUi1QvVCz77T6eZ5BQ6fNq',
					AccountRole.READONLY,
				],
				[
					'So11111111111111111111111111111111111111112',
					AccountRole.READONLY,
				],
				[
					'GQW15xteLPZszm1Dwzp4SsCoiPehJweejNSivFTMBpp9',
					AccountRole.WRITABLE,
				],
				[
					'CWYjaKHWjkatr9Rma6qRn3kj8heG8Tr1xqkGMa9ZUZg9',
					AccountRole.WRITABLE,
				],
				[
					'GX2VEHBsV6QvShpTsBDgtXCNi9tJ7xw5AyN51R1tiC5t',
					AccountRole.WRITABLE,
				],
				[
					'18Y9yg3mVJPWmmmYV1j214CUapfJDELtkeYcAKUNrHz',
					AccountRole.WRITABLE,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'B77P3Hvj9xLi4tcFtyjNcf6NjhkQrfJvLkz3nVZnBzec',
					AccountRole.READONLY,
				],
				[
					'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
					AccountRole.READONLY,
				],
				[
					'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
					AccountRole.READONLY,
				],
				[
					'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
					AccountRole.READONLY,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'4pTDYKRFdmxTQYFceGZkzPGd3kb8ShMA9n6XKRaPZn8t',
					AccountRole.READONLY,
				],
				[
					'84qj5FPZZdXkQy8mfowyg6RBZ3XKuTds6XS4ZYT1sfDX',
					AccountRole.READONLY,
				],
			],
			data: [
				95, 200, 71, 34, 8, 9, 11, 166, 128, 178, 230, 14, 0, 0, 0, 0,
				0, 228, 11, 84, 2, 0, 0, 0,
			],
		},
	],
	'dex buyExactIn': [
		{
			programAddress: '84qj5FPZZdXkQy8mfowyg6RBZ3XKuTds6XS4ZYT1sfDX',
			accounts: [
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.READONLY_SIGNER,
				],
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.WRITABLE_SIGNER,
				],
				[
					'A68ZM1PZt1o22yTfHBa7diFHS59YFXWSz7tB77SjmDva',
					AccountRole.WRITABLE,
				],
				[
					'8JPfavtKzVzQ998RpraLSuZUi1QvVCz77T6eZ5BQ6fNq',
					AccountRole.READONLY,
				],
				[
					'So11111111111111111111111111111111111111112',
					AccountRole.READONLY,
				],
				[
					'GQW15xteLPZszm1Dwzp4SsCoiPehJweejNSivFTMBpp9',
					AccountRole.WRITABLE,
				],
				[
					'CWYjaKHWjkatr9Rma6qRn3kj8heG8Tr1xqkGMa9ZUZg9',
					AccountRole.WRITABLE,
				],
				[
					'GX2VEHBsV6QvShpTsBDgtXCNi9tJ7xw5AyN51R1tiC5t',
					AccountRole.WRITABLE,
				],
				[
					'18Y9yg3mVJPWmmmYV1j214CUapfJDELtkeYcAKUNrHz',
					AccountRole.WRITABLE,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'B77P3Hvj9xLi4tcFtyjNcf6NjhkQrfJvLkz3nVZnBzec',
					AccountRole.READONLY,
				],
				[
					'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
					AccountRole.READONLY,
				],
				[
					'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
					AccountRole.READONLY,
				],
				[
					'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
					AccountRole.READONLY,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'4pTDYKRFdmxTQYFceGZkzPGd3kb8ShMA9n6XKRaPZn8t',
					AccountRole.READONLY,
				],
				[
					'84qj5FPZZdXkQy8mfowyg6RBZ3XKuTds6XS4ZYT1sfDX',
					AccountRole.READONLY,
				],
			],
			data: [
				250, 234, 13, 123, 213, 156, 19, 236, 0, 202, 154, 59, 0, 0, 0,
				0, 194, 131, 19, 93, 7, 0, 0, 0,
			],
		},
	],
	'dex buyExactOut': [
		{
			programAddress: '84qj5FPZZdXkQy8mfowyg6RBZ3XKuTds6XS4ZYT1sfDX',
			accounts: [
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.READONLY_SIGNER,
				],
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.WRITABLE_SIGNER,
				],
				[
					'A68ZM1PZt1o22yTfHBa7diFHS59YFXWSz7tB77SjmDva',
					AccountRole.WRITABLE,
				],
				[
					'8JPfavtKzVzQ998RpraLSuZUi1QvVCz77T6eZ5BQ6fNq',
					AccountRole.READONLY,
				],
				[
					'So11111111111111111111111111111111111111112',
					AccountRole.READONLY,
				],
				[
					'GQW15xteLPZszm1Dwzp4SsCoiPehJweejNSivFTMBpp9',
					AccountRole.WRITABLE,
				],
				[
					'CWYjaKHWjkatr9Rma6qRn3kj8heG8Tr1xqkGMa9ZUZg9',
					AccountRole.WRITABLE,
				],
				[
					'GX2VEHBsV6QvShpTsBDgtXCNi9tJ7xw5AyN51R1tiC5t',
					AccountRole.WRITABLE,
				],
				[
					'18Y9yg3mVJPWmmmYV1j214CUapfJDELtkeYcAKUNrHz',
					AccountRole.WRITABLE,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'B77P3Hvj9xLi4tcFtyjNcf6NjhkQrfJvLkz3nVZnBzec',
					AccountRole.READONLY,
				],
				[
					'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
					AccountRole.READONLY,
				],
				[
					'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
					AccountRole.READONLY,
				],
				[
					'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
					AccountRole.READONLY,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'4pTDYKRFdmxTQYFceGZkzPGd3kb8ShMA9n6XKRaPZn8t',
					AccountRole.READONLY,
				],
				[
					'84qj5FPZZdXkQy8mfowyg6RBZ3XKuTds6XS4ZYT1sfDX',
					AccountRole.READONLY,
				],
			],
			data: [
				24, 211, 116, 40, 105, 3, 153, 56, 0, 228, 11, 84, 2, 0, 0, 0,
				130, 73, 109, 18, 0, 0, 0, 0,
			],
		},
	],
	'dex sellExactIn': [
		{
			programAddress: '84qj5FPZZdXkQy8mfowyg6RBZ3XKuTds6XS4ZYT1sfDX',
			accounts: [
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.READONLY_SIGNER,
				],
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.WRITABLE_SIGNER,
				],
				[
					'A68ZM1PZt1o22yTfHBa7diFHS59YFXWSz7tB77SjmDva',
					AccountRole.WRITABLE,
				],
				[
					'8JPfavtKzVzQ998RpraLSuZUi1QvVCz77T6eZ5BQ6fNq',
					AccountRole.READONLY,
				],
				[
					'So11111111111111111111111111111111111111112',
					AccountRole.READONLY,
				],
				[
					'GQW15xteLPZszm1Dwzp4SsCoiPehJweejNSivFTMBpp9',
					AccountRole.WRITABLE,
				],
				[
					'CWYjaKHWjkatr9Rma6qRn3kj8heG8Tr1xqkGMa9ZUZg9',
					AccountRole.WRITABLE,
				],
				[
					'GX2VEHBsV6QvShpTsBDgtXCNi9tJ7xw5AyN51R1tiC5t',
					AccountRole.WRITABLE,
				],
				[
					'18Y9yg3mVJPWmmmYV1j214CUapfJDELtkeYcAKUNrHz',
					AccountRole.WRITABLE,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'B77P3Hvj9xLi4tcFtyjNcf6NjhkQrfJvLkz3nVZnBzec',
					AccountRole.READONLY,
				],
				[
					'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
					AccountRole.READONLY,
				],
				[
					'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
					AccountRole.READONLY,
				],
				[
					'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
					AccountRole.READONLY,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'4pTDYKRFdmxTQYFceGZkzPGd3kb8ShMA9n6XKRaPZn8t',
					AccountRole.READONLY,
				],
				[
					'84qj5FPZZdXkQy8mfowyg6RBZ3XKuTds6XS4ZYT1sfDX',
					AccountRole.READONLY,
				],
			],
			data: [
				149, 39, 222, 155, 211, 124, 152, 26, 0, 228, 11, 84, 2, 0, 0,
				0, 217, 30, 90, 17, 0, 0, 0, 0,
			],
		},
	],
	'dex sellExactOut': [
		{
			programAddress: '84qj5FPZZdXkQy8mfowyg6RBZ3XKuTds6XS4ZYT1sfDX',
			accounts: [
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.READONLY_SIGNER,
				],
				[
					'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
					AccountRole.WRITABLE_SIGNER,
				],
				[
					'A68ZM1PZt1o22yTfHBa7diFHS59YFXWSz7tB77SjmDva',
					AccountRole.WRITABLE,
				],
				[
					'8JPfavtKzVzQ998RpraLSuZUi1QvVCz77T6eZ5BQ6fNq',
					AccountRole.READONLY,
				],
				[
					'So11111111111111111111111111111111111111112',
					AccountRole.READONLY,
				],
				[
					'GQW15xteLPZszm1Dwzp4SsCoiPehJweejNSivFTMBpp9',
					AccountRole.WRITABLE,
				],
				[
					'CWYjaKHWjkatr9Rma6qRn3kj8heG8Tr1xqkGMa9ZUZg9',
					AccountRole.WRITABLE,
				],
				[
					'GX2VEHBsV6QvShpTsBDgtXCNi9tJ7xw5AyN51R1tiC5t',
					AccountRole.WRITABLE,
				],
				[
					'18Y9yg3mVJPWmmmYV1j214CUapfJDELtkeYcAKUNrHz',
					AccountRole.WRITABLE,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'B77P3Hvj9xLi4tcFtyjNcf6NjhkQrfJvLkz3nVZnBzec',
					AccountRole.READONLY,
				],
				[
					'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
					AccountRole.READONLY,
				],
				[
					'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
					AccountRole.READONLY,
				],
				[
					'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
					AccountRole.READONLY,
				],
				['11111111111111111111111111111111', AccountRole.READONLY],
				[
					'4pTDYKRFdmxTQYFceGZkzPGd3kb8ShMA9n6XKRaPZn8t',
					AccountRole.READONLY,
				],
				[
					'84qj5FPZZdXkQy8mfowyg6RBZ3XKuTds6XS4ZYT1sfDX',
					AccountRole.READONLY,
				],
			],
			data: [
				95, 200, 71, 34, 8, 9, 11, 166, 128, 178, 230, 14, 0, 0, 0, 0,
				55, 161, 10, 255, 1, 0, 0, 0,
			],
		},
	],
};

const GOLDEN_BY_NAME = new Map(Object.entries(GOLDENS));

function golden(name: string): readonly Golden[] {
	const value = GOLDEN_BY_NAME.get(name);
	if (value === undefined) throw new Error(`no golden for ${name}`);
	return value;
}

function snapshots(
	instructions: readonly Parameters<typeof snapshot>[0][],
): InstructionSnapshot[] {
	return instructions.map((instruction) => snapshot(instruction));
}

function testCaseNamed(name: string): HookFreeCase {
	const testCase = HOOK_FREE_CASES.find(
		(candidate) => candidate.name === name,
	);
	if (testCase === undefined) throw new Error(`no case ${name}`);
	return testCase;
}

// The slot the fake RPC answers at. Each read of a fill after its first asks
// for it.
const SLOT = 42;

// The config of every read: base64, at kit's default commitment.
const READ = { encoding: 'base64', commitment: 'confirmed' } as const;

function read(addresses: readonly Address[], minContextSlot?: number): RpcCall {
	return {
		method: 'getMultipleAccounts',
		params: [
			addresses,
			minContextSlot === undefined
				? READ
				: { ...READ, minContextSlot: BigInt(minContextSlot) },
		],
	};
}

/** The first read of `fetchMintInfo`: the mints but WSOL and USDC, and the clock. */
function infoRead(mints: readonly Address[]): RpcCall {
	const unread = [...new Set(mints)].filter(
		(mint) => mint !== WSOL_MINT && mint !== USDC_MINT,
	);
	return read([...unread, CLOCK]);
}

/** Orders reads by the addresses they read. */
function byAddresses(a: RpcCall, b: RpcCall): number {
	return String(a.params[0]).localeCompare(String(b.params[0]));
}

/** Rejects every request the test sends through `fetch`: a build holds no RPC. */
function noRequests(t: TestContext) {
	return t.mock.method(globalThis, 'fetch', () =>
		Promise.reject(new Error('the build sent a request')),
	);
}

function notLoaded(addresses: readonly Address[]) {
	return { name: 'TransferHookError', error: 'NotLoaded', addresses };
}

function validationOf(mint: Address): Promise<Address> {
	return findValidationAddress(mint, PROBE_PROGRAM);
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

/** The probe program and the validation account of `mint`, after a list's extras. */
async function hookTail(mint: Address) {
	return [
		readonlyMeta(PROBE_PROGRAM),
		readonlyMeta(await validationOf(mint)),
	];
}

describe('a hook-free build matches the pre-hook goldens', () => {
	it('pins one golden per case', () => {
		assert.deepEqual(
			Object.keys(GOLDENS),
			HOOK_FREE_CASES.map(({ name }) => name),
		);
	});

	for (const testCase of HOOK_FREE_CASES) {
		describe(testCase.name, () => {
			it('from a hook-free state', async () => {
				assert.deepEqual(
					snapshots(
						await buildFrom(
							testCase,
							hookFreeState(testCase.mints),
						),
					),
					golden(testCase.name),
				);
			});

			it('from the infos of hook-free mints, read in one call, with no read of its own', async (t) => {
				const chain = hookFreeState(testCase.mints);
				const { filled, calls } = await filledFrom(
					chain,
					testCase,
					SLOT,
				);
				assert.deepEqual(filled, caseInfos(testCase, chain));
				assert.deepEqual(calls, [infoRead(testCase.mints)]);
				const fetch = noRequests(t);
				assert.deepEqual(
					snapshots(await testCase.build(filled)),
					golden(testCase.name),
				);
				assert.deepEqual(calls, [infoRead(testCase.mints)]);
				assert.equal(fetch.mock.callCount(), 0);
			});

			it('appends nothing to the instruction, and returns the instruction itself', async () => {
				const { last, legs } = await caseRun(testCase);
				assert.equal(
					await appendHookAccounts(
						last,
						legs,
						hookFreeState(mintsOf(legs)),
					),
					last,
				);
			});
		});
	}
});

describe('an info with a hook program and a null hook is refused', () => {
	for (const testCase of HOOK_FREE_CASES) {
		it(`${testCase.name}: throws a RangeError that names its hook mint, and sends no request`, async (t) => {
			const run = await caseRun(testCase);
			const state = await probeState([testCase.hookMint], run.others);
			const fetch = noRequests(t);
			await assert.rejects(
				testCase.build(withoutHooks(caseInfos(testCase, state))),
				new RangeError(
					`the mint ${testCase.hookMint} has a hook program and no hook. Read it with fetchMintInfo`,
				),
			);
			assert.equal(fetch.mock.callCount(), 0);
		});
	}
});

describe('a hooked build appends its hook accounts after every fixed account', () => {
	for (const testCase of HOOK_FREE_CASES) {
		describe(testCase.name, () => {
			it('from a hook state: the hook accounts of the leg that moves the hooked mint', async () => {
				const run = await caseRun(testCase);
				assert.deepEqual(
					await trailing(
						testCase,
						run,
						await probeState([testCase.hookMint], run.others),
					),
					await probeAccounts(run.leg),
				);
			});

			it('from the read infos: the mints, then the list at the first read’s slot or later, and no read of its own', async (t) => {
				const run = await caseRun(testCase);
				const chain = await probeState([testCase.hookMint], run.others);
				const { filled, calls } = await filledFrom(
					chain,
					testCase,
					SLOT,
				);
				const validation = await validationOf(testCase.hookMint);
				assert.deepEqual(
					filled,
					fetchedInfos(testCase, chain, [
						testCase.hookMint,
						validation,
					]),
				);
				const fill = [
					infoRead(testCase.mints),
					read([validation], SLOT),
				];
				assert.deepEqual(calls, fill);
				const fetch = noRequests(t);
				assert.deepEqual(
					await trailingOf(testCase, run, filled),
					await probeAccounts(run.leg),
				);
				assert.deepEqual(calls, fill);
				assert.equal(fetch.mock.callCount(), 0);
			});

			it('rejects a hook map that lacks the hooked mint, and names it', async () => {
				const run = await caseRun(testCase);
				const infos = caseInfos(
					testCase,
					await probeState([testCase.hookMint], run.others),
				);
				await assert.rejects(
					testCase.build(
						withHook(infos, testCase.hookMint, {
							accounts: new Map(),
						}),
					),
					notLoaded([testCase.hookMint]),
				);
			});

			it('rejects a hook map that lacks the mint’s list, and names it', async () => {
				const run = await caseRun(testCase);
				const [mint, [validation]] = await probeAccountsOf(
					testCase.hookMint,
				);
				const infos = caseInfos(
					testCase,
					await probeState([testCase.hookMint], run.others),
				);
				await assert.rejects(
					testCase.build(
						withHook(infos, testCase.hookMint, {
							accounts: new Map([mint]),
						}),
					),
					notLoaded([validation]),
				);
			});

			it('builds for a paused mint, which the chain refuses', async () => {
				const run = await caseRun(testCase);
				const state = {
					accounts: new Map([
						...hookFreeState(run.others).accounts,
						...(await pausedProbeAccountsOf(testCase.hookMint)),
					]),
				};
				assert.deepEqual(
					await trailing(testCase, run, state),
					await probeAccounts(run.leg),
				);
			});
		});
	}

	it('the paused mint above runs the probe', () => {
		assert.deepEqual(
			decodeMintState({
				owner: TOKEN_2022_PROGRAM_ADDRESS,
				data: pausedHookedMintData(PROBE_PROGRAM),
			}),
			{
				tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
				decimals: 0,
				transferFee: null,
				hookProgram: PROBE_PROGRAM,
			},
		);
	});
});

describe('launchpad buildCreateAndBuyInstructions', () => {
	const testCase = testCaseNamed('launchpad buildCreateAndBuyInstructions');

	it('buys with its base mint info, a Token-2022 mint with no fee and no hook, with a hooked quote', async () => {
		const run = await caseRun(testCase);
		const chain = await probeState([TKALSHI_MINT]);
		const { filled } = await filledFrom(chain, testCase, SLOT);
		const [create, buy] = await testCase.build(filled);
		assert.deepEqual(create, run.hookFree[0]);
		const { instruction } = await launchpad.trade.buyExactIn({
			user: CREATE.user,
			baseMintInfo: launchMintInfo(CREATE.baseMint.address),
			quoteMintInfo: filled.quoteMintInfo,
			virtualQuoteReserves: CREATE.initialVirtualQuoteReserves,
			virtualBaseReserves: CREATE.initialVirtualBaseReserves,
			realBaseReserves: CREATE.initialRealBaseReserves,
			platformConfig: CREATE.platformConfig,
			feeBps: CREATE.feeBps,
			slippageBps: CREATE.slippageBps,
			partner: CREATE.partner,
			quoteAmountIn: CREATE.buyQuoteAmount,
		});
		assert.deepEqual(buy, instruction);
		// The quote leg alone: the base leg runs no hook.
		assert.deepEqual(
			await trailingOf(testCase, run, filled),
			await probeAccounts(run.leg),
		);
	});
});

describe('launchpad buildMigrateInstruction', () => {
	const testCase = testCaseNamed('launchpad buildMigrateInstruction');

	it('reads both mints and their lists, and resolves both legs where both mints run a hook', async () => {
		const run = await caseRun(testCase);
		const [quoteLeg, baseLeg] = run.legs.legs;
		assert.equal(quoteLeg.mint, TKALSHI_MINT);
		assert.equal(baseLeg.mint, BASE_MINT);
		const chain = await probeState([TKALSHI_MINT, BASE_MINT]);
		const { filled, calls } = await filledFrom(chain, testCase, SLOT);
		const [first, ...lists] = calls;
		assert.deepEqual(first, infoRead([BASE_MINT, TKALSHI_MINT]));
		// Each mint fills its own hook, so the two list reads can come in
		// either order.
		assert.deepEqual(
			lists.toSorted(byAddresses),
			[
				read([await validationOf(BASE_MINT)], SLOT),
				read([await validationOf(TKALSHI_MINT)], SLOT),
			].toSorted(byAddresses),
		);
		const merged: AccountMeta[] = [];
		for (const meta of [
			...(await probeAccounts(quoteLeg)),
			...(await probeAccounts(baseLeg)),
		]) {
			const index = merged.findIndex(
				({ address }) => address === meta.address,
			);
			if (index === -1) merged.push(meta);
			else if (meta.role === AccountRole.WRITABLE) merged[index] = meta;
		}
		assert.deepEqual(await trailingOf(testCase, run, filled), merged);
	});
});

const addressEncoder = getAddressEncoder();

/** An account no leg moves, at a key that is no PDA. */
const CONFIG_KEY: Address = getAddressDecoder().decode(
	new Uint8Array(32).fill(61),
);

/** The data of an account a list reads. */
const CONFIG_DATA = Uint8Array.from([3, 1, 4, 1, 5, 9, 2, 6, 5, 3]);

const CONFIG_SEED = new TextEncoder().encode('config');
const FEE_SEED = new TextEncoder().encode('fee');

function probeView(data: Uint8Array): AccountView {
	return { owner: PROBE_PROGRAM, data };
}

describe('a list that reads an account at a fixed address resolves from the read infos', () => {
	for (const testCase of HOOK_FREE_CASES) {
		describe(testCase.name, () => {
			for (const kind of ['a PDA of literal seeds', 'a fixed key']) {
				it(`${kind}: the read takes the mints, the list, then the account, and the build reads nothing`, async (t) => {
					const run = await caseRun(testCase);
					const pdaOfSeeds = kind === 'a PDA of literal seeds';
					const config = pdaOfSeeds
						? await probePda(CONFIG_SEED)
						: CONFIG_KEY;
					const chain = await armedState(
						testCase.hookMint,
						[
							pdaOfSeeds
								? pda([literal('config')])
								: fixed(CONFIG_KEY),
							pda([literal('fee'), accountData(5, 0, 8)]),
						],
						run.others,
						[[config, probeView(CONFIG_DATA)]],
					);
					const { filled, calls } = await filledFrom(
						chain,
						testCase,
						SLOT,
					);
					const validation = await validationOf(testCase.hookMint);
					assert.deepEqual(
						filled,
						fetchedInfos(testCase, chain, [
							testCase.hookMint,
							validation,
							config,
						]),
					);
					const fill = [
						infoRead(testCase.mints),
						read([validation], SLOT),
						read([config], SLOT),
					];
					assert.deepEqual(calls, fill);
					const fetch = noRequests(t);
					assert.deepEqual(await trailingOf(testCase, run, filled), [
						readonlyMeta(config),
						readonlyMeta(
							await probePda(
								FEE_SEED,
								CONFIG_DATA.subarray(0, 8),
							),
						),
						...(await hookTail(testCase.hookMint)),
					]);
					assert.deepEqual(calls, fill);
					assert.equal(fetch.mock.callCount(), 0);
				});
			}
		});
	}
});

describe('a list that reads an account the trade sets refuses the read infos, which never hold it', () => {
	for (const testCase of HOOK_FREE_CASES) {
		it(`${testCase.name}: NotLoaded, naming the PDA of the authority, until the caller reads it into the hook`, async (t) => {
			const run = await caseRun(testCase);
			const authorityPda = await probePda(
				addressEncoder.encode(run.leg.authority),
			);
			const chain = await armedState(
				testCase.hookMint,
				[pda([accountKey(3)]), pda([accountData(5, 0, 4)])],
				run.others,
				[[authorityPda, probeView(CONFIG_DATA)]],
			);
			const { filled, calls } = await filledFrom(chain, testCase, SLOT);
			// The mints and the list alone.
			const fill = [
				infoRead(testCase.mints),
				read([await validationOf(testCase.hookMint)], SLOT),
			];
			assert.deepEqual(calls, fill);
			assert.equal(
				hookOf(filled, testCase.hookMint).accounts.has(authorityPda),
				false,
			);
			const fetch = noRequests(t);
			await assert.rejects(
				testCase.build(filled),
				notLoaded([authorityPda]),
			);
			assert.deepEqual(calls, fill);
			assert.equal(fetch.mock.callCount(), 0);
			// The caller reads what the build names into a copy of the hook,
			// and builds again.
			const { rpc, calls: reads } = rpcOver(chain, SLOT);
			const { built, infos } = await buildWithReads(
				rpc,
				filled,
				(current) => testCase.build(current),
			);
			assert.deepEqual(reads, [read([authorityPda])]);
			assert.deepEqual(built, await testCase.build(infos));
			assert.deepEqual(await trailingOf(testCase, run, infos), [
				readonlyMeta(authorityPda),
				readonlyMeta(await probePda(CONFIG_DATA.subarray(0, 4))),
				...(await hookTail(testCase.hookMint)),
			]);
		});
	}
});

/** A Token-2022 base mint with no extension, whose first 8 bytes read `[1, 0, 0, 0, 8, 8, 8, 8]`. */
const BASE_VIEW: AccountView = {
	owner: TOKEN_2022_PROGRAM_ADDRESS,
	data: Uint8Array.from(HOOK_FREE_TOKEN_2022_MINT.data, (byte, index) => {
		if (index === 0) return 1;
		if (index >= 4 && index < 8) return 8;
		return byte;
	}),
};

describe('a hook-free info reads as missing only where the other info’s hook lacks its mint', () => {
	const testCase = testCaseNamed(
		'dex buildBuyExactInInstruction, Token-2022 quote',
	);
	// The quote list reads the base mint at a fixed key, then seeds a PDA with
	// its first 8 bytes.
	const extras = [fixed(BASE_MINT), pda([accountData(5, 0, 8)])];

	it('a quote list that reads the base mint finds it in the quote’s hook', async () => {
		const run = await caseRun(testCase);
		const chain = await armedState(
			TKALSHI_MINT,
			extras,
			[],
			[[BASE_MINT, BASE_VIEW]],
		);
		const { filled, calls } = await filledFrom(chain, testCase, SLOT);
		const validation = await validationOf(TKALSHI_MINT);
		assert.deepEqual(calls, [
			infoRead([BASE_MINT, TKALSHI_MINT]),
			read([validation], SLOT),
			read([BASE_MINT], SLOT),
		]);
		assert.equal(filled.baseMintInfo?.hook, null);
		assert.deepEqual(
			filled,
			fetchedInfos(testCase, chain, [
				TKALSHI_MINT,
				validation,
				BASE_MINT,
			]),
		);
		assert.deepEqual(await trailingOf(testCase, run, filled), [
			readonlyMeta(BASE_MINT),
			readonlyMeta(await probePda(BASE_VIEW.data.subarray(0, 8))),
			...(await hookTail(TKALSHI_MINT)),
		]);
		// Without the base mint in the quote's hook, the hook-free base reads
		// as missing. A missing account has no data, so the read fails.
		await assert.rejects(
			testCase.build(
				withHook(filled, TKALSHI_MINT, {
					accounts: new Map(
						[...hookOf(filled, TKALSHI_MINT).accounts].filter(
							([address]) => address !== BASE_MINT,
						),
					),
				}),
			),
			{
				name: 'TransferHookError',
				error: 'Unresolvable(ExtraUnresolved)',
			},
		);
	});
});
