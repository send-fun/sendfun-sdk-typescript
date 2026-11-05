// Hook-free inputs for every builder that appends hook accounts.
// `tests/hook-builders.test.ts` pins each hook-free build byte for byte.

import {
	address,
	createNoopSigner,
	type AccountMeta,
	type AccountRole,
	type Address,
	type Instruction,
	type InstructionWithAccounts,
	type InstructionWithData,
	type ReadonlyUint8Array,
} from '@solana/kit';

import { DEFAULT_PARTNER, WSOL_MINT } from '../../src/constants.js';
import * as dex from '../../src/dex/index.js';
import * as launchpad from '../../src/launchpad/index.js';
import type { HookLeg, HookLegs } from '../../src/transfer-hook/resolver.js';
import type { MintInfo } from '../../src/utils/mint-info.js';

export const USER: Address = address(
	'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
);
export const PAYER: Address = address(
	'9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
);
export const PARTNER: Address = address(
	'Hs3bBEkKQaR9dGkFpQyBtnQvHXWyKMYyYnFVLZ4WM5Ac',
);
/** Not WSOL or USDC: `fetchMintInfo` reads it. */
export const BASE_MINT: Address = address(
	'8JPfavtKzVzQ998RpraLSuZUi1QvVCz77T6eZ5BQ6fNq',
);
/** Mainnet Token-2022 mint. */
export const TKALSHI_MINT: Address = address(
	'TKLSidmLVt3cqGaaodG8tyRzoANfQwoh67AccjmubeZ',
);
/** Not an ATA of the user. */
export const AUX: Address = address(
	'6ksD4MwN1XHsts93q7e8VaYZsb3rxCPeBYQpdsBDiHyJ',
);
export const PLATFORM: Address = address(
	'2PJedAsa7pCnScks2XM3U4o2nPaTvvBmi2553VcCnGWB',
);

const user = createNoopSigner(USER);
const payer = createNoopSigner(PAYER);
const partner = createNoopSigner(PARTNER);

/** The mint infos a builder takes. A builder that makes its base side itself
 *  takes no `baseMintInfo`. With every info's hook `null`, it appends no hook
 *  account. */
export interface CaseInfos {
	readonly baseMintInfo?: MintInfo;
	readonly quoteMintInfo: MintInfo;
}

export interface HookFreeCase {
	readonly name: string;
	/** The mint the hooked runs arm, which the last instruction moves. */
	readonly hookMint: Address;
	/** The mints the builder takes an info of: the base, if it takes one, then the quote. */
	readonly mints:
		| readonly [quoteMint: Address]
		| readonly [baseMint: Address, quoteMint: Address];
	/** The instructions the builder returns. Only the last one carries hook
	 *  accounts. */
	build(infos: CaseInfos): Promise<readonly Instruction[]>;
	/** The legs of the last instruction, read from its slots by name. */
	legs(instruction: Instruction): HookLegs;
}

/** `instruction`, typed for a generated parser. */
export function parts(
	instruction: Instruction,
): Instruction &
	InstructionWithAccounts<readonly AccountMeta[]> &
	InstructionWithData<ReadonlyUint8Array> {
	const { accounts, data } = instruction;
	if (accounts === undefined || data === undefined) {
		throw new Error('the instruction carries no accounts or no data');
	}
	return { ...instruction, accounts, data };
}

interface TradeSlots {
	readonly user: AccountMeta;
	readonly baseMint: AccountMeta;
	readonly quoteMint: AccountMeta;
	readonly baseVault: AccountMeta;
	readonly quoteVault: AccountMeta;
	readonly userBaseAccount: AccountMeta;
	readonly userQuoteAccount: AccountMeta;
}

/** A buy moves quote from the user into `market`, then base out to the user. A sell moves base
 *  in, then quote out. */
function legsOfTrade(
	instructionType: string,
	slots: TradeSlots,
	market: Address,
	written: readonly Address[],
): HookLegs {
	const into = (
		source: AccountMeta,
		mint: AccountMeta,
		vault: AccountMeta,
	): HookLeg => ({
		source: source.address,
		mint: mint.address,
		destination: vault.address,
		authority: slots.user.address,
		destinationOwner: market,
	});
	const out = (
		vault: AccountMeta,
		mint: AccountMeta,
		destination: AccountMeta,
	): HookLeg => ({
		source: vault.address,
		mint: mint.address,
		destination: destination.address,
		authority: market,
		destinationOwner: slots.user.address,
	});
	const legs = instructionType.startsWith('buy')
		? [
				into(slots.userQuoteAccount, slots.quoteMint, slots.quoteVault),
				out(slots.baseVault, slots.baseMint, slots.userBaseAccount),
			]
		: [
				into(slots.userBaseAccount, slots.baseMint, slots.baseVault),
				out(slots.quoteVault, slots.quoteMint, slots.userQuoteAccount),
			];
	return { legs, written };
}

/** The legs of a launchpad trade. The curve is written before the transfers. */
function legsOfLaunchpadTrade(instruction: Instruction): HookLegs {
	const parsed = launchpad.instructions.parseSendLaunchpadInstruction(
		parts(instruction),
	);
	switch (parsed?.instructionType) {
		case 'buyExactIn':
		case 'buyExactOut':
		case 'sellExactIn':
		case 'sellExactOut': {
			const { accounts } = parsed;
			const curve = accounts.bondingCurve.address;
			return legsOfTrade(parsed.instructionType, accounts, curve, [
				curve,
			]);
		}
		default:
			throw new Error(
				`no launchpad trade: ${parsed?.instructionType ?? 'none'}`,
			);
	}
}

/** The legs of a dex trade. The pool is written after the transfers. */
function legsOfDexTrade(instruction: Instruction): HookLegs {
	const parsed = dex.instructions.parseSendDexInstruction(parts(instruction));
	switch (parsed?.instructionType) {
		case 'buyExactIn':
		case 'buyExactOut':
		case 'sellExactIn':
		case 'sellExactOut': {
			const { accounts } = parsed;
			return legsOfTrade(
				parsed.instructionType,
				accounts,
				accounts.pool.address,
				[],
			);
		}
		default:
			throw new Error(
				`no dex trade: ${parsed?.instructionType ?? 'none'}`,
			);
	}
}

/** The legs of a `migrate`, quote first: each curve vault into the pool vault, signed by the
 *  curve. */
function legsOfMigrate(instruction: Instruction): HookLegs {
	const { accounts } = launchpad.instructions.parseMigrateInstruction(
		parts(instruction),
	);
	const leg = (
		vault: AccountMeta,
		mint: AccountMeta,
		poolVault: AccountMeta,
	): HookLeg => ({
		source: vault.address,
		mint: mint.address,
		destination: poolVault.address,
		authority: accounts.bondingCurve.address,
		destinationOwner: accounts.pool.address,
	});
	return {
		legs: [
			leg(
				accounts.quoteVault,
				accounts.quoteMint,
				accounts.poolQuoteVault,
			),
			leg(accounts.baseVault, accounts.baseMint, accounts.poolBaseVault),
		],
		written: [],
	};
}

// WSOL is an SPL Token mint, which runs no hook: a WSOL market arms its base.
function hookMintOf(quoteMint: Address): Address {
	return quoteMint === WSOL_MINT ? BASE_MINT : quoteMint;
}

type MarketFields = Pick<HookFreeCase, 'hookMint' | 'mints' | 'legs'>;

function launchpadQuote(quoteMint: Address): MarketFields {
	return {
		hookMint: hookMintOf(quoteMint),
		mints: [BASE_MINT, quoteMint],
		legs: legsOfLaunchpadTrade,
	};
}

function dexQuote(quoteMint: Address): MarketFields {
	return {
		hookMint: hookMintOf(quoteMint),
		mints: [BASE_MINT, quoteMint],
		legs: legsOfDexTrade,
	};
}

/** The infos of a trade, which takes both. */
function tradeInfos(infos: CaseInfos): {
	readonly baseMintInfo: MintInfo;
	readonly quoteMintInfo: MintInfo;
} {
	const { baseMintInfo, quoteMintInfo } = infos;
	if (baseMintInfo === undefined) {
		throw new Error('the builder takes a base mint info');
	}
	return { baseMintInfo, quoteMintInfo };
}

const WSOL_TRADE = {
	user,
	partner: DEFAULT_PARTNER,
	platformConfig: PLATFORM,
} as const;

// Token-2022 quote, a separate payer, a signing partner and a non-ATA base account.
const TOKEN_2022_TRADE = {
	user,
	payer,
	partner,
	platformConfig: PLATFORM,
	userBaseAccount: AUX,
} as const;

const QUOTING = { feeBps: 100, slippageBps: 100 } as const;

const CURVE = {
	virtualBaseReserves: 1_000_000_000_000n,
	virtualQuoteReserves: 30_000_000_000n,
	realBaseReserves: 793_100_000_000n,
} as const;

const POOL = {
	baseReserves: 1_000_000_000_000n,
	quoteReserves: 30_000_000_000n,
} as const;

/** The create-and-buy of the case below, but its quote mint info. */
export const CREATE: Omit<
	launchpad.create.CreateAndBuyParams,
	'quoteMintInfo'
> = {
	user,
	coinCreator: USER,
	baseMint: createNoopSigner(BASE_MINT),
	partner,
	platformConfig: PLATFORM,
	name: 'Test',
	symbol: 'TEST',
	uri: 'https://example.com/t.json',
	creatorFeeMode: 0,
	creatorFeeBps: 30,
	dexCreatorFeeBps: 10,
	initialVirtualBaseReserves: CURVE.virtualBaseReserves,
	initialVirtualQuoteReserves: CURVE.virtualQuoteReserves,
	initialRealBaseReserves: CURVE.realBaseReserves,
	...QUOTING,
	buyQuoteAmount: 1_000_000_000n,
};

async function one(instruction: Promise<Instruction>) {
	return [await instruction];
}

async function quoted(built: Promise<{ instruction: Instruction }>) {
	return [(await built).instruction];
}

export const HOOK_FREE_CASES: readonly HookFreeCase[] = [
	{
		name: 'launchpad buildBuyExactInInstruction',
		...launchpadQuote(WSOL_MINT),
		build: (infos) =>
			one(
				launchpad.trade.buildBuyExactInInstruction({
					...WSOL_TRADE,
					...tradeInfos(infos),
					amountIn: 1_000_000_000n,
					minAmountOut: 31_000_000_000n,
				}),
			),
	},
	{
		name: 'launchpad buildBuyExactInInstruction, Token-2022 quote',
		...launchpadQuote(TKALSHI_MINT),
		build: (infos) =>
			one(
				launchpad.trade.buildBuyExactInInstruction({
					...TOKEN_2022_TRADE,
					...tradeInfos(infos),
					amountIn: 1_000_000_000n,
					minAmountOut: 31_000_000_000n,
				}),
			),
	},
	{
		name: 'launchpad buildBuyExactOutInstruction',
		...launchpadQuote(WSOL_MINT),
		build: (infos) =>
			one(
				launchpad.trade.buildBuyExactOutInstruction({
					...WSOL_TRADE,
					...tradeInfos(infos),
					amountOut: 10_000_000_000n,
					maxAmountIn: 400_000_000n,
				}),
			),
	},
	{
		name: 'launchpad buildSellExactInInstruction',
		...launchpadQuote(WSOL_MINT),
		build: (infos) =>
			one(
				launchpad.trade.buildSellExactInInstruction({
					...WSOL_TRADE,
					...tradeInfos(infos),
					amountIn: 10_000_000_000n,
					minAmountOut: 250_000_000n,
				}),
			),
	},
	{
		name: 'launchpad buildSellExactOutInstruction',
		...launchpadQuote(WSOL_MINT),
		build: (infos) =>
			one(
				launchpad.trade.buildSellExactOutInstruction({
					...WSOL_TRADE,
					...tradeInfos(infos),
					amountOut: 250_000_000n,
					maxAmountIn: 10_000_000_000n,
				}),
			),
	},
	{
		name: 'launchpad buyExactIn',
		...launchpadQuote(WSOL_MINT),
		build: (infos) =>
			quoted(
				launchpad.trade.buyExactIn({
					...WSOL_TRADE,
					...QUOTING,
					...CURVE,
					...tradeInfos(infos),
					quoteAmountIn: 1_000_000_000n,
				}),
			),
	},
	{
		name: 'launchpad buyExactOut',
		...launchpadQuote(WSOL_MINT),
		build: (infos) =>
			quoted(
				launchpad.trade.buyExactOut({
					...WSOL_TRADE,
					...QUOTING,
					...CURVE,
					...tradeInfos(infos),
					baseAmountOut: 10_000_000_000n,
				}),
			),
	},
	{
		name: 'launchpad sellExactIn',
		...launchpadQuote(WSOL_MINT),
		build: (infos) =>
			quoted(
				launchpad.trade.sellExactIn({
					...WSOL_TRADE,
					...QUOTING,
					...CURVE,
					...tradeInfos(infos),
					baseAmountIn: 10_000_000_000n,
				}),
			),
	},
	{
		name: 'launchpad sellExactOut',
		...launchpadQuote(WSOL_MINT),
		build: (infos) =>
			quoted(
				launchpad.trade.sellExactOut({
					...WSOL_TRADE,
					...QUOTING,
					...CURVE,
					...tradeInfos(infos),
					quoteAmountOut: 250_000_000n,
				}),
			),
	},
	{
		name: 'launchpad buildCreateAndBuyInstructions',
		...launchpadQuote(TKALSHI_MINT),
		// The create makes the base mint.
		mints: [TKALSHI_MINT],
		build: async (infos) =>
			(
				await launchpad.create.buildCreateAndBuyInstructions({
					...CREATE,
					quoteMintInfo: infos.quoteMintInfo,
				})
			).instructions,
	},
	{
		name: 'launchpad buildMigrateInstruction',
		hookMint: TKALSHI_MINT,
		mints: [BASE_MINT, TKALSHI_MINT],
		legs: legsOfMigrate,
		build: (infos) =>
			one(
				launchpad.migrate.buildMigrateInstruction({
					caller: user,
					...tradeInfos(infos),
				}),
			),
	},
	{
		name: 'dex buildBuyExactInInstruction',
		...dexQuote(WSOL_MINT),
		build: (infos) =>
			one(
				dex.trade.buildBuyExactInInstruction({
					...WSOL_TRADE,
					...tradeInfos(infos),
					amountIn: 1_000_000_000n,
					minAmountOut: 31_000_000_000n,
				}),
			),
	},
	{
		name: 'dex buildBuyExactInInstruction, Token-2022 quote',
		...dexQuote(TKALSHI_MINT),
		build: (infos) =>
			one(
				dex.trade.buildBuyExactInInstruction({
					...TOKEN_2022_TRADE,
					...tradeInfos(infos),
					amountIn: 1_000_000_000n,
					minAmountOut: 31_000_000_000n,
				}),
			),
	},
	{
		name: 'dex buildBuyExactOutInstruction',
		...dexQuote(WSOL_MINT),
		build: (infos) =>
			one(
				dex.trade.buildBuyExactOutInstruction({
					...WSOL_TRADE,
					...tradeInfos(infos),
					amountOut: 10_000_000_000n,
					maxAmountIn: 400_000_000n,
				}),
			),
	},
	{
		name: 'dex buildSellExactInInstruction',
		...dexQuote(WSOL_MINT),
		build: (infos) =>
			one(
				dex.trade.buildSellExactInInstruction({
					...WSOL_TRADE,
					...tradeInfos(infos),
					amountIn: 10_000_000_000n,
					minAmountOut: 250_000_000n,
				}),
			),
	},
	{
		name: 'dex buildSellExactOutInstruction',
		...dexQuote(WSOL_MINT),
		build: (infos) =>
			one(
				dex.trade.buildSellExactOutInstruction({
					...WSOL_TRADE,
					...tradeInfos(infos),
					amountOut: 250_000_000n,
					maxAmountIn: 10_000_000_000n,
				}),
			),
	},
	{
		name: 'dex buyExactIn',
		...dexQuote(WSOL_MINT),
		build: (infos) =>
			quoted(
				dex.trade.buyExactIn({
					...WSOL_TRADE,
					...QUOTING,
					...POOL,
					...tradeInfos(infos),
					quoteAmountIn: 1_000_000_000n,
				}),
			),
	},
	{
		name: 'dex buyExactOut',
		...dexQuote(WSOL_MINT),
		build: (infos) =>
			quoted(
				dex.trade.buyExactOut({
					...WSOL_TRADE,
					...QUOTING,
					...POOL,
					...tradeInfos(infos),
					baseAmountOut: 10_000_000_000n,
				}),
			),
	},
	{
		name: 'dex sellExactIn',
		...dexQuote(WSOL_MINT),
		build: (infos) =>
			quoted(
				dex.trade.sellExactIn({
					...WSOL_TRADE,
					...QUOTING,
					...POOL,
					...tradeInfos(infos),
					baseAmountIn: 10_000_000_000n,
				}),
			),
	},
	{
		name: 'dex sellExactOut',
		...dexQuote(WSOL_MINT),
		build: (infos) =>
			quoted(
				dex.trade.sellExactOut({
					...WSOL_TRADE,
					...QUOTING,
					...POOL,
					...tradeInfos(infos),
					quoteAmountOut: 250_000_000n,
				}),
			),
	},
];

export interface InstructionSnapshot {
	readonly programAddress: Address;
	readonly accounts: readonly (readonly [Address, AccountRole])[];
	readonly data: readonly number[];
}

export function snapshot(instruction: Instruction): InstructionSnapshot {
	return {
		programAddress: instruction.programAddress,
		accounts: (instruction.accounts ?? []).map(
			(meta) => [meta.address, meta.role] as const,
		),
		data: Array.from(instruction.data ?? []),
	};
}
