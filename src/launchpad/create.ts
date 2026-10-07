import type { Address, Instruction, TransactionSigner } from '@solana/kit';
import type { MintFee, TradeQuote } from '../math/amm.js';
import type { PartnerInput } from '../utils/partner.js';
import { getCreateTokenInstructionAsync } from './generated/instructions/createToken.js';
import { buyExactIn } from './trade.js';

export interface CreateTokenParams {
	user: TransactionSigner;
	payer?: TransactionSigner;
	/** The wallet that claims the creator fees. */
	coinCreator: Address;
	baseMint: TransactionSigner;
	quoteMint: Address;
	name: string;
	symbol: string;
	uri: string;
	partner: PartnerInput;
	platformConfig: Address;
	quoteTokenProgram: Address;
	creatorFeeMode: number;
	creatorFeeBps: number;
	/** The creator fee of the pool after migration, in bps. */
	dexCreatorFeeBps: number;
}

export interface CreateAndBuyParams extends CreateTokenParams {
	buyQuoteAmount: bigint;
	feeBps: number;
	slippageBps: number;
	initialVirtualQuoteReserves: bigint;
	initialVirtualBaseReserves: bigint;
	/** `globalConfig.initialRealBaseReserves`. Caps the buy. */
	initialRealBaseReserves: bigint;
	/** The quote mint's transfer fee for the epoch the launch lands in. Without it, `minAmountOut`
	 *  ignores the mint's cut, and a cut above `slippageBps` can make the buy fail. The new base
	 *  mint has no transfer fee. */
	quoteFee?: MintFee;
}

export async function buildCreateTokenInstruction(
	params: CreateTokenParams,
): Promise<Instruction> {
	return getCreateTokenInstructionAsync({
		user: params.user,
		payer: params.payer ?? params.user,
		coinCreator: params.coinCreator,
		baseMint: params.baseMint,
		quoteMint: params.quoteMint,
		partner: params.partner,
		platformConfig: params.platformConfig,
		quoteTokenProgram: params.quoteTokenProgram,
		name: params.name,
		symbol: params.symbol,
		uri: params.uri,
		creatorFeeMode: params.creatorFeeMode,
		creatorFeeBps: params.creatorFeeBps,
		dexCreatorFeeBps: params.dexCreatorFeeBps,
	});
}

export async function buildCreateAndBuyInstructions(
	params: CreateAndBuyParams,
): Promise<{ instructions: Instruction[]; quote?: TradeQuote }> {
	const createIx = await buildCreateTokenInstruction(params);
	const instructions: Instruction[] = [createIx];
	let quote: TradeQuote | undefined;

	if (params.buyQuoteAmount > 0n) {
		const buyResult = await buyExactIn({
			user: params.user,
			payer: params.payer,
			baseMint: params.baseMint.address,
			quoteMint: params.quoteMint,
			virtualQuoteReserves: params.initialVirtualQuoteReserves,
			virtualBaseReserves: params.initialVirtualBaseReserves,
			realBaseReserves: params.initialRealBaseReserves,
			platformConfig: params.platformConfig,
			feeBps: params.feeBps,
			slippageBps: params.slippageBps,
			partner: params.partner,
			quoteFee: params.quoteFee,
			quoteTokenProgram: params.quoteTokenProgram,
			quoteAmountIn: params.buyQuoteAmount,
		});

		instructions.push(buyResult.instruction);
		quote = buyResult.quote;
	}

	return { instructions, quote };
}
