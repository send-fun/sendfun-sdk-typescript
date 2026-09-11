import type { Address, Instruction, TransactionSigner } from '@solana/kit';
import type { MintFee, TradeQuote } from '../math/amm.js';
import type { PartnerInput } from '../utils/partner.js';
import { creatorHashFromId } from '../utils/creator-hash.js';
import { findCreatorFeeConfigPda } from '../nexus/generated/pdas/creatorFeeConfig.js';
import { getCreateTokenInstructionAsync } from './generated/instructions/createToken.js';
import { buyExactIn } from './trade.js';

export interface CreateTokenParams {
	user: TransactionSigner;
	payer?: TransactionSigner;
	coinCreator: Address;
	baseMint: TransactionSigner;
	quoteMint: Address;
	name: string;
	symbol: string;
	uri: string;
	/** An enabled nexus auth platform (e.g. "wallet"), max 32 bytes; hashed with
	 *  `creatorId` into the creator fee identity. Unrelated to `platformConfig`. */
	creatorPlatform: string;
	creatorId: string;
	partner: PartnerInput;
	platformConfig: Address;
	quoteTokenProgram: Address;
}

export interface CreateAndBuyParams extends CreateTokenParams {
	buyQuoteAmount: bigint;
	feeBps: number;
	slippageBps: number;
	initialVirtualQuoteReserves: bigint;
	initialVirtualBaseReserves: bigint;
	/** `globalConfig.initialRealBaseReserves`: caps the appended buy. */
	initialRealBaseReserves: bigint;
	/** Quote mint's Token-2022 schedule for the launch epoch; without it `minAmountOut`
	 *  ignores the mint's cut, and a cut above `slippageBps` can revert the buy. No
	 *  `baseFee`: this transaction creates the base mint without the extension. */
	quoteFee?: MintFee;
}

export async function buildCreateTokenInstruction(
	params: CreateTokenParams,
): Promise<Instruction> {
	return buildCreateTokenInstructionWithHash(
		params,
		await creatorHashFromId(params.creatorPlatform, params.creatorId),
	);
}

async function buildCreateTokenInstructionWithHash(
	params: CreateTokenParams,
	creatorHash: Address,
): Promise<Instruction> {
	const [creatorFeeConfig] = await findCreatorFeeConfigPda({
		creatorHash,
		quoteMint: params.quoteMint,
	});
	// The creation fee is native SOL from `user`; the client derives the WSOL staking vault.
	return getCreateTokenInstructionAsync({
		user: params.user,
		payer: params.payer ?? params.user,
		coinCreator: params.coinCreator,
		baseMint: params.baseMint,
		quoteMint: params.quoteMint,
		creatorFeeConfig,
		partner: params.partner,
		platformConfig: params.platformConfig,
		quoteTokenProgram: params.quoteTokenProgram,
		creatorPlatform: params.creatorPlatform,
		creatorId: params.creatorId,
		creatorHash,
		name: params.name,
		symbol: params.symbol,
		uri: params.uri,
	});
}

export async function buildCreateAndBuyInstructions(
	params: CreateAndBuyParams,
): Promise<{ instructions: Instruction[]; quote?: TradeQuote }> {
	const creatorHash = await creatorHashFromId(
		params.creatorPlatform,
		params.creatorId,
	);
	const createIx = await buildCreateTokenInstructionWithHash(
		params,
		creatorHash,
	);
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
			// The curve was just stamped with this same key.
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
