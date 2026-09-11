import type { Address, Instruction, TransactionSigner } from '@solana/kit';
import type { BuyQuote, MintFee, SellQuote } from '../math/amm.js';
import * as amm from '../math/amm.js';
import type { PartnerInput } from '../utils/partner.js';
import { getBuyExactInInstructionAsync } from './generated/instructions/buyExactIn.js';
import { getBuyExactOutInstructionAsync } from './generated/instructions/buyExactOut.js';
import { getSellExactInInstructionAsync } from './generated/instructions/sellExactIn.js';
import { getSellExactOutInstructionAsync } from './generated/instructions/sellExactOut.js';

export interface DexTradeParams {
	user: TransactionSigner;
	payer?: TransactionSigner;
	baseMint: Address;
	quoteMint: Address;
	baseReserves: bigint;
	quoteReserves: bigint;
	feeBps: number;
	slippageBps: number;
	partner: PartnerInput;
	platformConfig: Address;
	quoteTokenProgram: Address;
	/** Token-2022 schedule for the epoch the trade lands in; stale or missing skews the slippage bounds. */
	quoteFee?: MintFee;
	baseFee?: MintFee;
	/** {@inheritDoc DexInstructionParams.userQuoteAccount} */
	userQuoteAccount?: Address;
	/** {@inheritDoc DexInstructionParams.userBaseAccount} */
	userBaseAccount?: Address;
}

export interface DexInstructionParams {
	user: TransactionSigner;
	payer?: TransactionSigner;
	baseMint: Address;
	quoteMint: Address;
	partner: PartnerInput;
	platformConfig: Address;
	quoteTokenProgram: Address;
	/** Any user-owned quote-mint account. Defaults to the ATA, created mid-trade
	 *  if missing (payer funds rent), which only rescues a sell. For WSOL,
	 *  a throwaway `createAccountWithSeed` account is cheaper. */
	userQuoteAccount?: Address;
	/** Any user-owned base-mint account. Defaults to the ATA, created mid-trade
	 *  if missing (payer funds rent), which only rescues a buy. */
	userBaseAccount?: Address;
}

/** `baseAmountOut` is net to the buyer: the program reads `amount` as `base_to_user`. */
export async function buyExactOut(
	params: DexTradeParams & { baseAmountOut: bigint },
): Promise<{ instruction: Instruction; quote: BuyQuote }> {
	const quote = amm.buyExactOut({
		reserveQuote: params.quoteReserves,
		reserveBase: params.baseReserves,
		baseAmountOut: params.baseAmountOut,
		feeBps: params.feeBps,
		quoteFee: params.quoteFee,
		baseFee: params.baseFee,
	});
	// The cap is measured on the gross the buyer sends, quote transfer fee included.
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
		quoteFee: params.quoteFee,
		baseFee: params.baseFee,
	});
	// The floor is measured on the buyer's credit, not the vault's debit.
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
		quoteFee: params.quoteFee,
		baseFee: params.baseFee,
	});
	// The floor is measured on the seller's credit, not what leaves the vault.
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

/** `quoteAmountOut` is net to the seller: the program reads `amount` as `quote_to_user`. */
export async function sellExactOut(
	params: DexTradeParams & { quoteAmountOut: bigint },
): Promise<{ instruction: Instruction; quote: SellQuote }> {
	const quote = amm.sellExactOut({
		reserveQuote: params.quoteReserves,
		reserveBase: params.baseReserves,
		quoteAmountOut: params.quoteAmountOut,
		feeBps: params.feeBps,
		quoteFee: params.quoteFee,
		baseFee: params.baseFee,
	});
	// The cap is measured on the gross the seller sends, base transfer fee included.
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
	const shared = resolveSharedAccounts(params);
	return getBuyExactInInstructionAsync({
		...shared,
		amountIn: params.amountIn,
		minAmountOut: params.minAmountOut,
	});
}

export async function buildBuyExactOutInstruction(
	params: DexInstructionParams & { amountOut: bigint; maxAmountIn: bigint },
): Promise<Instruction> {
	const shared = resolveSharedAccounts(params);
	return getBuyExactOutInstructionAsync({
		...shared,
		amountOut: params.amountOut,
		maxAmountIn: params.maxAmountIn,
	});
}

export async function buildSellExactInInstruction(
	params: DexInstructionParams & { amountIn: bigint; minAmountOut: bigint },
): Promise<Instruction> {
	const shared = resolveSharedAccounts(params);
	return getSellExactInInstructionAsync({
		...shared,
		amountIn: params.amountIn,
		minAmountOut: params.minAmountOut,
	});
}

export async function buildSellExactOutInstruction(
	params: DexInstructionParams & { amountOut: bigint; maxAmountIn: bigint },
): Promise<Instruction> {
	const shared = resolveSharedAccounts(params);
	return getSellExactOutInstructionAsync({
		...shared,
		amountOut: params.amountOut,
		maxAmountIn: params.maxAmountIn,
	});
}

function resolveSharedAccounts(params: DexInstructionParams) {
	return {
		user: params.user,
		payer: params.payer ?? params.user,
		baseMint: params.baseMint,
		quoteMint: params.quoteMint,
		partner: params.partner,
		platformConfig: params.platformConfig,
		quoteTokenProgram: params.quoteTokenProgram,
		// Left undefined so the generated client derives the ATA itself.
		...(params.userQuoteAccount !== undefined && {
			userQuoteAccount: params.userQuoteAccount,
		}),
		...(params.userBaseAccount !== undefined && {
			userBaseAccount: params.userBaseAccount,
		}),
	};
}
