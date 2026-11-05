// The legs each builder resolves its hook accounts for, as the probe's
// accounts name them. Also the caller's reads for a migrate whose list reads
// the curve, which no read of the quote mint holds.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	address,
	createNoopSigner,
	getProgramDerivedAddress,
	type AccountMeta,
	type Address,
	type Instruction,
	type ReadonlyUint8Array,
} from '@solana/kit';

import { SEND_LAUNCHPAD_PROGRAM_ADDRESS } from '../src/constants.js';
import * as dex from '../src/dex/index.js';
import * as launchpad from '../src/launchpad/index.js';
import {
	type AccountView,
	type HookState,
} from '../src/transfer-hook/index.js';
import { fetchMintInfo, type MintInfo } from '../src/utils/index.js';
import {
	findValidationAddress,
	type HookLeg,
} from '../src/transfer-hook/resolver.js';
import { accountData, pda } from './support/extra-metas.js';
import {
	AUX,
	BASE_MINT,
	PARTNER,
	PAYER,
	PLATFORM,
	TKALSHI_MINT,
	USER,
} from './support/hook-free-cases.js';
import { CLOCK, type RpcCall } from './support/fake-rpc.js';
import {
	armedState,
	buildWithReads,
	hookOf,
	readonlyMeta,
	rpcOver,
} from './support/hook-runs.js';
import { mintInfoOf, plainMintInfo } from './support/mint-infos.js';
import {
	hookFreeState,
	probeAccounts,
	probeState,
	PROBE_PROGRAM,
} from './support/probe-hook.js';

// The PDAs and ATAs the builders derive for the inputs below.
const CURVE = address('3QLaWjJZ8VuZvMngrWkp8sMYrPXeAH8wVTweLCPF7RrZ');
const CURVE_BASE_VAULT = address(
	'8NWLNKMMzgZHJZ3NjqmnghhMGSmnUvZJ5Ykz6hhvoVAT',
);
const CURVE_QUOTE_VAULT = address(
	'CUhVgpmzhfKmFz1EpYA4JK1paf9ttVf4Sv5wqjPaZAMe',
);
const POOL = address('7Mz36vvxNxvYwEy47V76ansrXi9qNQsq6HqsXToapodv');
const POOL_BASE_VAULT = address('6YX9eGTcVytFqYTBE52VU6QC6xkiBkzwzcz2qiLziogy');
const POOL_QUOTE_VAULT = address(
	'8oF9Cke49z2jhFJa8LfoksDx7ZmMnFPnanYuM9TaX7Fw',
);
/** The user's TKALSHI ATA. */
const USER_QUOTE_ATA = address('EsEezwzxG2vtBjt6K93eEGCDRjLiSASYt6bNNezzds6W');

const U64_MAX = 18_446_744_073_709_551_615n;

const user = createNoopSigner(USER);

const MARKET = [BASE_MINT, TKALSHI_MINT] as const;

const HOOK_FREE_MARKET = hookFreeState(MARKET);

// A Token-2022 quote and a base account that is not the user's ATA.
const TRADE = {
	user,
	payer: createNoopSigner(PAYER),
	partner: createNoopSigner(PARTNER),
	platformConfig: PLATFORM,
	userBaseAccount: AUX,
} as const;

const EXACT_IN = { amountIn: 1_000_000_000n, minAmountOut: 1n } as const;
const EXACT_OUT = { amountOut: 1_000_000n, maxAmountIn: U64_MAX } as const;

/** The infos of the market's mints, as `state` holds them. */
function marketInfos(state: HookState) {
	return {
		baseMintInfo: mintInfoOf(state, BASE_MINT),
		quoteMintInfo: mintInfoOf(state, TKALSHI_MINT),
	};
}

type Build = (state: HookState) => Promise<Instruction>;

const curveBuyIn: Build = (state) =>
	launchpad.trade.buildBuyExactInInstruction({
		...TRADE,
		...EXACT_IN,
		...marketInfos(state),
	});
const curveBuyOut: Build = (state) =>
	launchpad.trade.buildBuyExactOutInstruction({
		...TRADE,
		...EXACT_OUT,
		...marketInfos(state),
	});
const curveSellIn: Build = (state) =>
	launchpad.trade.buildSellExactInInstruction({
		...TRADE,
		...EXACT_IN,
		...marketInfos(state),
	});
const curveSellOut: Build = (state) =>
	launchpad.trade.buildSellExactOutInstruction({
		...TRADE,
		...EXACT_OUT,
		...marketInfos(state),
	});
const poolBuyIn: Build = (state) =>
	dex.trade.buildBuyExactInInstruction({
		...TRADE,
		...EXACT_IN,
		...marketInfos(state),
	});
const poolBuyOut: Build = (state) =>
	dex.trade.buildBuyExactOutInstruction({
		...TRADE,
		...EXACT_OUT,
		...marketInfos(state),
	});
const poolSellIn: Build = (state) =>
	dex.trade.buildSellExactInInstruction({
		...TRADE,
		...EXACT_IN,
		...marketInfos(state),
	});
const poolSellOut: Build = (state) =>
	dex.trade.buildSellExactOutInstruction({
		...TRADE,
		...EXACT_OUT,
		...marketInfos(state),
	});

/** A migrate of a hook-free base mint and `quoteMintInfo`. */
function migrateWith(quoteMintInfo: MintInfo): Promise<Instruction> {
	return launchpad.migrate.buildMigrateInstruction({
		caller: user,
		baseMintInfo: plainMintInfo(BASE_MINT),
		quoteMintInfo,
	});
}

const migrate: Build = (state) => migrateWith(mintInfoOf(state, TKALSHI_MINT));

/** The four legs a trade can move, for a market and its vaults. */
function tradeLegsAt(market: {
	readonly address: Address;
	readonly baseVault: Address;
	readonly quoteVault: Address;
}): Record<'quoteIn' | 'baseOut' | 'baseIn' | 'quoteOut', HookLeg> {
	return {
		quoteIn: {
			source: USER_QUOTE_ATA,
			mint: TKALSHI_MINT,
			destination: market.quoteVault,
			authority: USER,
			destinationOwner: market.address,
		},
		baseOut: {
			source: market.baseVault,
			mint: BASE_MINT,
			destination: AUX,
			authority: market.address,
			destinationOwner: USER,
		},
		baseIn: {
			source: AUX,
			mint: BASE_MINT,
			destination: market.baseVault,
			authority: USER,
			destinationOwner: market.address,
		},
		quoteOut: {
			source: market.quoteVault,
			mint: TKALSHI_MINT,
			destination: USER_QUOTE_ATA,
			authority: market.address,
			destinationOwner: USER,
		},
	};
}

const AT_CURVE = tradeLegsAt({
	address: CURVE,
	baseVault: CURVE_BASE_VAULT,
	quoteVault: CURVE_QUOTE_VAULT,
});

const AT_POOL = tradeLegsAt({
	address: POOL,
	baseVault: POOL_BASE_VAULT,
	quoteVault: POOL_QUOTE_VAULT,
});

// A migrate moves both vaults of the curve to the pool, quote first.
const MIGRATE: readonly HookLeg[] = [
	{
		source: CURVE_QUOTE_VAULT,
		mint: TKALSHI_MINT,
		destination: POOL_QUOTE_VAULT,
		authority: CURVE,
		destinationOwner: POOL,
	},
	{
		source: CURVE_BASE_VAULT,
		mint: BASE_MINT,
		destination: POOL_BASE_VAULT,
		authority: CURVE,
		destinationOwner: POOL,
	},
];

/** A builder and the legs it resolves its hook accounts for, in transfer order. */
interface LegCase {
	readonly name: string;
	build(state: HookState): Promise<Instruction>;
	readonly legs: readonly HookLeg[];
	/** The number of accounts in the hook-free instruction. */
	readonly fixed: number;
}

// A buy moves quote into the market, then base out. A sell moves base in, then
// quote out.
const CURVE_BUY = [AT_CURVE.quoteIn, AT_CURVE.baseOut];
const CURVE_SELL = [AT_CURVE.baseIn, AT_CURVE.quoteOut];
const POOL_BUY = [AT_POOL.quoteIn, AT_POOL.baseOut];
const POOL_SELL = [AT_POOL.baseIn, AT_POOL.quoteOut];

// The number of accounts in a trade and in a migrate.
const TRADE_ACCOUNTS = 17;
const MIGRATE_ACCOUNTS = 23;

// A launchpad base mint has no hook: a migrate resolves its quote leg alone.
const LEG_CASES: readonly LegCase[] = [
	{
		name: 'launchpad buy_exact_in',
		build: curveBuyIn,
		legs: CURVE_BUY,
		fixed: TRADE_ACCOUNTS,
	},
	{
		name: 'launchpad buy_exact_out',
		build: curveBuyOut,
		legs: CURVE_BUY,
		fixed: TRADE_ACCOUNTS,
	},
	{
		name: 'launchpad sell_exact_in',
		build: curveSellIn,
		legs: CURVE_SELL,
		fixed: TRADE_ACCOUNTS,
	},
	{
		name: 'launchpad sell_exact_out',
		build: curveSellOut,
		legs: CURVE_SELL,
		fixed: TRADE_ACCOUNTS,
	},
	{
		name: 'launchpad migrate',
		build: migrate,
		legs: MIGRATE.slice(0, 1),
		fixed: MIGRATE_ACCOUNTS,
	},
	{
		name: 'dex buy_exact_in',
		build: poolBuyIn,
		legs: POOL_BUY,
		fixed: TRADE_ACCOUNTS,
	},
	{
		name: 'dex buy_exact_out',
		build: poolBuyOut,
		legs: POOL_BUY,
		fixed: TRADE_ACCOUNTS,
	},
	{
		name: 'dex sell_exact_in',
		build: poolSellIn,
		legs: POOL_SELL,
		fixed: TRADE_ACCOUNTS,
	},
	{
		name: 'dex sell_exact_out',
		build: poolSellOut,
		legs: POOL_SELL,
		fixed: TRADE_ACCOUNTS,
	},
];

function withAccounts(
	instruction: Instruction,
	accounts: readonly AccountMeta[],
): Instruction {
	return {
		...instruction,
		accounts: [...(instruction.accounts ?? []), ...accounts],
	};
}

function othersThan(mint: Address): Address[] {
	return MARKET.filter((other) => other !== mint);
}

// The slot the fake RPC answers at, and the config of each read.
const SLOT = 42;
const READ = { encoding: 'base64', commitment: 'confirmed' } as const;

describe('the legs a builder resolves, named by the probe’s accounts', () => {
	for (const legCase of LEG_CASES) {
		describe(legCase.name, () => {
			it('appends none on a hook-free market', async () => {
				assert.equal(
					(await legCase.build(HOOK_FREE_MARKET)).accounts?.length,
					legCase.fixed,
				);
			});

			it('appends the probe’s accounts of the leg that moves a hooked mint, after every account', async () => {
				const hookFree = await legCase.build(HOOK_FREE_MARKET);
				for (const leg of legCase.legs) {
					assert.deepEqual(
						await legCase.build(
							await probeState([leg.mint], othersThan(leg.mint)),
						),
						withAccounts(hookFree, await probeAccounts(leg)),
					);
				}
			});
		});
	}

	describe('merges the legs of two hooked mints in transfer order, each account once', () => {
		for (const name of [
			'launchpad buy_exact_in',
			'launchpad sell_exact_out',
			'dex buy_exact_out',
			'dex sell_exact_in',
		]) {
			it(name, async () => {
				const legCase = LEG_CASES.find(
					(candidate) => candidate.name === name,
				);
				assert.ok(legCase !== undefined);
				const [first, second] = legCase.legs;
				assert.equal(legCase.legs.length, 2);
				const firstAccounts = await probeAccounts(first);
				// The second leg's authority, destination owner and the probe
				// program each repeat one of the first's.
				const [source, mint, destination, , , , validation] =
					await probeAccounts(second);
				assert.deepEqual(
					await legCase.build(await probeState(MARKET)),
					withAccounts(await legCase.build(HOOK_FREE_MARKET), [
						...firstAccounts,
						source,
						mint,
						destination,
						validation,
					]),
				);
			});
		}
	});
});

// The quote list seeds a PDA with the first 8 bytes of its transfer's
// authority, which on a migrate is the curve.
const READS_CURVE = [pda([accountData(3, 0, 8)])];

const CURVE_ACCOUNT: AccountView = {
	owner: SEND_LAUNCHPAD_PROGRAM_ADDRESS,
	data: Uint8Array.from({ length: 16 }, (_, index) => index + 1),
};

async function probePda(seed: ReadonlyUint8Array): Promise<Address> {
	const [pdaAddress] = await getProgramDerivedAddress({
		programAddress: PROBE_PROGRAM,
		seeds: [seed],
	});
	return pdaAddress;
}

/** What a migrate appends where the quote list reads `CURVE_ACCOUNT`. */
async function curveReadAccounts(): Promise<AccountMeta[]> {
	return [
		readonlyMeta(await probePda(CURVE_ACCOUNT.data.subarray(0, 8))),
		readonlyMeta(PROBE_PROGRAM),
		readonlyMeta(await findValidationAddress(TKALSHI_MINT, PROBE_PROGRAM)),
	];
}

describe('launchpad buildMigrateInstruction from the quote mint’s read', () => {
	it('rejects a list that reads the curve, which the read lacks, and names only the curve', async () => {
		await assert.rejects(
			migrate(await armedState(TKALSHI_MINT, READS_CURVE, [BASE_MINT])),
			{
				name: 'TransferHookError',
				error: 'NotLoaded',
				addresses: [CURVE],
			},
		);
	});

	it('builds once the hook holds the curve', async () => {
		assert.deepEqual(
			await migrate(
				await armedState(
					TKALSHI_MINT,
					READS_CURVE,
					[BASE_MINT],
					[[CURVE, CURVE_ACCOUNT]],
				),
			),
			withAccounts(
				await migrate(HOOK_FREE_MARKET),
				await curveReadAccounts(),
			),
		);
	});

	it('the caller reads the quote mint, reads the curve the build names into a copy, and builds again', async () => {
		const chain = await armedState(
			TKALSHI_MINT,
			READS_CURVE,
			[BASE_MINT],
			[[CURVE, CURVE_ACCOUNT]],
		);
		const { rpc, calls } = rpcOver(chain, SLOT);
		const read = await fetchMintInfo(rpc, { quoteMint: TKALSHI_MINT });
		const validation = await findValidationAddress(
			TKALSHI_MINT,
			PROBE_PROGRAM,
		);
		assert.deepEqual(
			[...hookOf(read, TKALSHI_MINT).accounts.keys()],
			[TKALSHI_MINT, validation],
		);
		const { built, infos } = await buildWithReads(rpc, read, (current) =>
			migrateWith(current.quoteMintInfo),
		);
		assert.deepEqual(
			hookOf(infos, TKALSHI_MINT),
			mintInfoOf(chain, TKALSHI_MINT, {
				accounts: new Map(
					[TKALSHI_MINT, validation, CURVE].map((account) => [
						account,
						chain.accounts.get(account) ?? null,
					]),
				),
			}).hook,
		);
		// The read goes into a copy: the first read stays as it was.
		assert.equal(hookOf(read, TKALSHI_MINT).accounts.has(CURVE), false);
		assert.deepEqual(
			built,
			withAccounts(
				await migrate(HOOK_FREE_MARKET),
				await curveReadAccounts(),
			),
		);
		const expected: RpcCall[] = [
			{
				method: 'getMultipleAccounts',
				params: [[TKALSHI_MINT, CLOCK], READ],
			},
			{
				method: 'getMultipleAccounts',
				params: [
					[validation],
					{ ...READ, minContextSlot: BigInt(SLOT) },
				],
			},
			{ method: 'getMultipleAccounts', params: [[CURVE], READ] },
		];
		assert.deepEqual(calls, expected);
	});
});
