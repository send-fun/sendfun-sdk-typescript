import type {
	AccountMeta,
	Address,
	Instruction,
	InstructionWithAccounts,
	InstructionWithData,
	ReadonlyUint8Array,
	TransactionSigner,
} from '@solana/kit';
import type { BuyQuote, SellQuote } from '../math/amm.js';
import * as amm from '../math/amm.js';
import { appendHookAccounts } from '../transfer-hook/fetch.js';
import { tradeLegsOf } from '../transfer-hook/legs.js';
import type { HookLegs } from '../transfer-hook/resolver.js';
import {
	checkBaseMint,
	hookStateOf,
	tradeFees,
	type MintInfo,
} from '../utils/mint-info.js';
import type { PartnerInput } from '../utils/partner.js';
import { getBuyExactInInstructionAsync } from './generated/instructions/buyExactIn.js';
import { getBuyExactOutInstructionAsync } from './generated/instructions/buyExactOut.js';
import { getSellExactInInstructionAsync } from './generated/instructions/sellExactIn.js';
import { getSellExactOutInstructionAsync } from './generated/instructions/sellExactOut.js';
import { parseSendDexInstruction } from './generated/instructions/sendDex.instructions.js';

export interface DexTradeParams extends DexInstructionParams {
	baseReserves: bigint;
	quoteReserves: bigint;
	feeBps: number;
	slippageBps: number;
}

export interface DexInstructionParams {
	user: TransactionSigner;
	payer?: TransactionSigner;
	/** From `utils.fetchMintInfo`. */
	baseMintInfo: MintInfo;
	/** From `utils.fetchMintInfo`. */
	quoteMintInfo: MintInfo;
	partner: PartnerInput;
	platformConfig: Address;
	/** Any quote-mint token account that `user` owns. Defaults to the user's ATA.
	 *  The program creates a missing ATA, and `payer` pays the rent. */
	userQuoteAccount?: Address;
	/** Any base-mint token account that `user` owns. Defaults to the user's ATA.
	 *  The program creates a missing ATA, and `payer` pays the rent. */
	userBaseAccount?: Address;
}

/** `baseAmountOut` is the base the buyer receives, after the base mint's transfer fee. */
export async function buyExactOut(
	params: DexTradeParams & { baseAmountOut: bigint },
): Promise<{ instruction: Instruction; quote: BuyQuote }> {
	const quote = amm.buyExactOut({
		reserveQuote: params.quoteReserves,
		reserveBase: params.baseReserves,
		baseAmountOut: params.baseAmountOut,
		feeBps: params.feeBps,
		...tradeFees(params),
	});
	// The program checks `maxAmountIn` against the gross the buyer sends, quote transfer fee included.
	const maxQuoteIn = amm.calculateSlippageUp(
		quote.quoteFromUser,
		params.slippageBps,
	);
	return {
		instruction: await buildBuyExactOutInstruction({
			...params,
			amountOut: params.baseAmountOut,
			maxAmountIn: maxQuoteIn,
		}),
		quote,
	};
}

export async function buyExactIn(
	params: DexTradeParams & { quoteAmountIn: bigint },
): Promise<{ instruction: Instruction; quote: BuyQuote }> {
	const quote = amm.buyExactIn({
		reserveQuote: params.quoteReserves,
		reserveBase: params.baseReserves,
		quoteAmountIn: params.quoteAmountIn,
		feeBps: params.feeBps,
		...tradeFees(params),
	});
	// The program checks `minAmountOut` against what the buyer receives, not the vault's debit.
	const minBaseOut = amm.calculateSlippageDown(
		quote.baseToUser,
		params.slippageBps,
	);
	return {
		instruction: await buildBuyExactInInstruction({
			...params,
			amountIn: params.quoteAmountIn,
			minAmountOut: minBaseOut,
		}),
		quote,
	};
}

export async function sellExactIn(
	params: DexTradeParams & { baseAmountIn: bigint },
): Promise<{ instruction: Instruction; quote: SellQuote }> {
	const quote = amm.sellExactIn({
		reserveQuote: params.quoteReserves,
		reserveBase: params.baseReserves,
		baseAmountIn: params.baseAmountIn,
		feeBps: params.feeBps,
		...tradeFees(params),
	});
	// The program checks `minAmountOut` against what the seller receives, not the vault's debit.
	const minQuoteOut = amm.calculateSlippageDown(
		quote.quoteToUser,
		params.slippageBps,
	);
	return {
		instruction: await buildSellExactInInstruction({
			...params,
			amountIn: params.baseAmountIn,
			minAmountOut: minQuoteOut,
		}),
		quote,
	};
}

/** `quoteAmountOut` is the quote the seller receives, after the quote mint's transfer fee. */
export async function sellExactOut(
	params: DexTradeParams & { quoteAmountOut: bigint },
): Promise<{ instruction: Instruction; quote: SellQuote }> {
	const quote = amm.sellExactOut({
		reserveQuote: params.quoteReserves,
		reserveBase: params.baseReserves,
		quoteAmountOut: params.quoteAmountOut,
		feeBps: params.feeBps,
		...tradeFees(params),
	});
	// The program checks `maxAmountIn` against the gross the seller sends, base transfer fee included.
	const maxBaseIn = amm.calculateSlippageUp(
		quote.baseFromUser,
		params.slippageBps,
	);
	return {
		instruction: await buildSellExactOutInstruction({
			...params,
			amountOut: params.quoteAmountOut,
			maxAmountIn: maxBaseIn,
		}),
		quote,
	};
}

export async function buildBuyExactInInstruction(
	params: DexInstructionParams & { amountIn: bigint; minAmountOut: bigint },
): Promise<Instruction> {
	const shared = sharedAccounts(params);
	return withHooks(
		await getBuyExactInInstructionAsync({
			...shared,
			amountIn: params.amountIn,
			minAmountOut: params.minAmountOut,
		}),
		params,
	);
}

export async function buildBuyExactOutInstruction(
	params: DexInstructionParams & { amountOut: bigint; maxAmountIn: bigint },
): Promise<Instruction> {
	const shared = sharedAccounts(params);
	return withHooks(
		await getBuyExactOutInstructionAsync({
			...shared,
			amountOut: params.amountOut,
			maxAmountIn: params.maxAmountIn,
		}),
		params,
	);
}

export async function buildSellExactInInstruction(
	params: DexInstructionParams & { amountIn: bigint; minAmountOut: bigint },
): Promise<Instruction> {
	const shared = sharedAccounts(params);
	return withHooks(
		await getSellExactInInstructionAsync({
			...shared,
			amountIn: params.amountIn,
			minAmountOut: params.minAmountOut,
		}),
		params,
	);
}

export async function buildSellExactOutInstruction(
	params: DexInstructionParams & { amountOut: bigint; maxAmountIn: bigint },
): Promise<Instruction> {
	const shared = sharedAccounts(params);
	return withHooks(
		await getSellExactOutInstructionAsync({
			...shared,
			amountOut: params.amountOut,
			maxAmountIn: params.maxAmountIn,
		}),
		params,
	);
}

type BuiltTrade = Instruction &
	InstructionWithAccounts<readonly AccountMeta[]> &
	InstructionWithData<ReadonlyUint8Array>;

async function withHooks(
	instruction: BuiltTrade,
	params: DexInstructionParams,
): Promise<Instruction> {
	return appendHookAccounts(
		instruction,
		tradeLegs(instruction),
		hookStateOf([params.baseMintInfo, params.quoteMintInfo]),
	);
}

// The two legs of a trade this module built, read by name with the generated
// parser. The pool's writes all follow the transfers.
function tradeLegs(instruction: BuiltTrade): HookLegs {
	const parsed = parseSendDexInstruction(instruction);
	switch (parsed?.instructionType) {
		case 'buyExactIn':
		case 'buyExactOut':
		case 'sellExactIn':
		case 'sellExactOut': {
			const { accounts } = parsed;
			return tradeLegsOf(
				parsed.instructionType.startsWith('buy') ? 'buy' : 'sell',
				{
					user: accounts.user.address,
					market: accounts.pool.address,
					baseMint: accounts.baseMint.address,
					quoteMint: accounts.quoteMint.address,
					baseVault: accounts.baseVault.address,
					quoteVault: accounts.quoteVault.address,
					userBaseAccount: accounts.userBaseAccount.address,
					userQuoteAccount: accounts.userQuoteAccount.address,
				},
				{ writesMarket: false },
			);
		}
		default:
			throw new RangeError(
				`expected a dex trade, got ${parsed?.instructionType ?? 'none'}`,
			);
	}
}

function sharedAccounts(params: DexInstructionParams) {
	const { baseMintInfo, quoteMintInfo } = params;
	checkBaseMint('dex.trade', baseMintInfo);
	return {
		user: params.user,
		payer: params.payer ?? params.user,
		baseMint: baseMintInfo.address,
		quoteMint: quoteMintInfo.address,
		partner: params.partner,
		platformConfig: params.platformConfig,
		quoteTokenProgram: quoteMintInfo.tokenProgram,
		// When omitted, the generated client derives the ATA.
		...(params.userQuoteAccount !== undefined && {
			userQuoteAccount: params.userQuoteAccount,
		}),
		...(params.userBaseAccount !== undefined && {
			userBaseAccount: params.userBaseAccount,
		}),
	};
}
