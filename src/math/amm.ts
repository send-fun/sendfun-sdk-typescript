import { assertBps, ceilDiv, floorDiv } from './internal.js';

const BPS_DIVISOR = 10_000n;

const U64_MAX = 18_446_744_073_709_551_615n;

function assertU64(label: string, value: bigint): bigint {
	if (value > U64_MAX) {
		throw new RangeError(`${label}: overflows u64`);
	}
	return value;
}

/** A Token-2022 transfer fee for one epoch. Use the fee for the epoch the trade lands in. */
export interface MintFee {
	/** 0 to 10_000. */
	bps: number;
	/** Maximum fee per transfer, in the mint's raw units. */
	maximumFee: bigint;
}

/** Thrown when no transfer delivers exactly `amount` after the transfer fee. */
export class TransferFeeNotSettleableError extends RangeError {
	readonly amount: bigint;
	readonly mintFee: MintFee;

	constructor(amount: bigint, mintFee: MintFee) {
		super(
			`transfer fee not settleable: no transfer lands exactly ${amount} at ${mintFee.bps} bps with a ${mintFee.maximumFee} cap`,
		);
		this.name = 'TransferFeeNotSettleableError';
		this.amount = amount;
		this.mintFee = mintFee;
	}
}

function assertMintFee(fee: MintFee): void {
	assertBps('MintFee', 'bps', fee.bps);
	if (fee.maximumFee < 0n || fee.maximumFee > U64_MAX) {
		throw new RangeError('MintFee: maximumFee must fit a u64');
	}
}

/** Returns the transfer fee on `amount`. Rounds up, then caps at `maximumFee`, in SPL's order.
 *  Returns 0 without `fee`. Throws `RangeError` if `fee` is out of range. */
export function feeOn(amount: bigint, fee?: MintFee): bigint {
	if (fee === undefined) return 0n;
	assertMintFee(fee);
	if (amount === 0n || fee.bps === 0) return 0n;

	const raw = ceilDiv(amount * BigInt(fee.bps), BPS_DIVISOR);
	return raw < fee.maximumFee ? raw : fee.maximumFee;
}

/** Returns what the recipient receives when `amount` is sent. `grossUp` is the inverse. */
export function amountAfterFee(amount: bigint, fee?: MintFee): bigint {
	return amount - feeOn(amount, fee);
}

/** Matches SPL `TransferFee::calculate_pre_fee_amount`. `undefined` if the result does not fit a u64. */
function preFeeAmount(amount: bigint, fee: MintFee): bigint | undefined {
	const bps = BigInt(fee.bps);
	if (bps === 0n) return amount;
	// Unreachable from `grossUp`. Kept to match SPL.
	if (amount === 0n) return 0n;
	// At 100%, the fee is always `maximumFee`.
	if (bps === BPS_DIVISOR) {
		const capped = amount + fee.maximumFee;
		return capped > U64_MAX ? undefined : capped;
	}

	const rawPreFee = ceilDiv(amount * BPS_DIVISOR, BPS_DIVISOR - bps);
	if (rawPreFee - amount >= fee.maximumFee) {
		const capped = amount + fee.maximumFee;
		return capped > U64_MAX ? undefined : capped;
	}
	return rawPreFee > U64_MAX ? undefined : rawPreFee;
}

/** Returns the amount to send so that exactly `amount` arrives. Returns `amount` without `fee`.
 *  Throws {@link TransferFeeNotSettleableError} if no such amount exists. */
export function grossUp(amount: bigint, fee?: MintFee): bigint {
	if (fee === undefined) return amount;
	assertMintFee(fee);
	if (amount === 0n) return 0n;

	const preFee = preFeeAmount(amount, fee);
	if (preFee === undefined)
		throw new TransferFeeNotSettleableError(amount, fee);

	// SPL's inverse is inexact (`feeOn(x) >= inverse(x - feeOn(x))`). Check it forward and reject a mismatch.
	const impliedFee = feeOn(preFee, fee);
	const gross = amount + impliedFee;
	if (gross > U64_MAX || feeOn(gross, fee) !== impliedFee) {
		throw new TransferFeeNotSettleableError(amount, fee);
	}
	return gross;
}

/** `baseAmount` and `quoteAmount` are the user's transfers.
 *  Read the net amounts from the fields of {@link BuyQuote} and {@link SellQuote}. Do not calculate them again. */
export interface TradeQuote {
	/** Base sent: vault to user on a buy, user to vault on a sell. */
	baseAmount: bigint;
	/** Quote sent: user to vault on a buy, vault to user on a sell. */
	quoteAmount: bigint;
	/** Platform fee, in quote units. */
	fee: bigint;
	baseTransferFee: bigint;
	quoteTransferFee: bigint;
}

export interface BuyQuote extends TradeQuote {
	/** Priced on the quote that reaches the vault. */
	fee: bigint;
	/** Base the buyer receives, after the base mint's transfer fee. */
	baseToUser: bigint;
	/** Equals `quoteAmount`. */
	quoteFromUser: bigint;
}

export interface SellQuote extends TradeQuote {
	/** Priced on the AMM's quote output, before this fee. */
	fee: bigint;
	/** Equals `baseAmount`. */
	baseFromUser: bigint;
	/** Quote the seller receives, after the quote mint's transfer fee. */
	quoteToUser: bigint;
}

function sqrtBigInt(value: bigint): bigint {
	if (value < 0n) throw new RangeError('sqrtBigInt: negative input');
	if (value === 0n) return 0n;
	let x = value;
	let y = (x + 1n) / 2n;
	while (y < x) {
		x = y;
		y = (x + value / x) / 2n;
	}
	return x;
}

/** Returns the constant-product output for `amountIn`, rounded down. Throws `RangeError` on a zero
 *  reserve, a zero `amountIn`, a zero output, or an output past u64. */
export function calculateOutput(
	reserveIn: bigint,
	reserveOut: bigint,
	amountIn: bigint,
): bigint {
	if (reserveIn === 0n || reserveOut === 0n) {
		throw new RangeError('calculateOutput: insufficient liquidity');
	}
	if (amountIn === 0n) {
		throw new RangeError('calculateOutput: invalid amount');
	}

	const k = reserveIn * reserveOut;
	const newReserveIn = reserveIn + amountIn;

	const newReserveOut = ceilDiv(k, newReserveIn);

	if (newReserveOut >= reserveOut) {
		throw new RangeError('calculateOutput: insufficient liquidity');
	}

	const amountOut = reserveOut - newReserveOut;
	if (amountOut === 0n) {
		throw new RangeError('calculateOutput: insufficient liquidity');
	}

	return assertU64('calculateOutput', amountOut);
}

/** Returns the input needed for `amountOut`, rounded up. Throws `RangeError` on a zero reserve, a zero
 *  `amountOut`, an `amountOut` not below `reserveOut`, or an input past u64. */
export function calculateInputForOutput(
	reserveIn: bigint,
	reserveOut: bigint,
	amountOut: bigint,
): bigint {
	if (reserveIn === 0n || reserveOut === 0n) {
		throw new RangeError('calculateInputForOutput: insufficient liquidity');
	}
	if (amountOut === 0n || amountOut >= reserveOut) {
		throw new RangeError('calculateInputForOutput: invalid amount');
	}

	const k = reserveIn * reserveOut;
	const newReserveOut = reserveOut - amountOut;

	const newReserveIn = ceilDiv(k, newReserveOut);

	if (newReserveIn <= reserveIn) {
		throw new RangeError('calculateInputForOutput: insufficient liquidity');
	}

	const amountIn = newReserveIn - reserveIn;
	if (amountIn === 0n) {
		throw new RangeError('calculateInputForOutput: insufficient liquidity');
	}

	return assertU64('calculateInputForOutput', amountIn);
}

interface BaseQuoteParams {
	reserveQuote: bigint;
	reserveBase: bigint;
	feeBps: number;
	quoteFee?: MintFee;
	baseFee?: MintFee;
}

/** `baseReserveCap` is `bondingCurve.realBaseReserves`. A DEX pool has no cap. */
interface BaseReserveCap {
	baseReserveCap?: bigint;
}

/** Vault-side legs, before either mint's transfer fee. */
interface AmmLegs {
	baseAmount: bigint;
	quoteAmount: bigint;
	fee: bigint;
}

function ammBuyExactOut(
	params: { reserveQuote: bigint; reserveBase: bigint; feeBps: number },
	baseAmountOut: bigint,
): AmmLegs {
	const quoteBeforeFee = calculateInputForOutput(
		params.reserveQuote,
		params.reserveBase,
		baseAmountOut,
	);

	const divisor = BPS_DIVISOR - BigInt(params.feeBps);
	if (divisor <= 0n) {
		throw new RangeError('buyExactOut: invalid feeBps');
	}

	// A `feeBps` near 10_000 multiplies the leg by up to 10_000, so this can pass u64.
	const totalQuote = assertU64(
		'buyExactOut',
		ceilDiv(quoteBeforeFee * BPS_DIVISOR, divisor),
	);

	return {
		baseAmount: baseAmountOut,
		quoteAmount: totalQuote,
		fee: totalQuote - quoteBeforeFee,
	};
}

function ammBuyExactIn(
	params: { reserveQuote: bigint; reserveBase: bigint; feeBps: number },
	quoteAmountIn: bigint,
): AmmLegs {
	// The fee comes off before the swap. The net rounds down, and the fee takes the remainder.
	const netFactor = BPS_DIVISOR - BigInt(params.feeBps);
	if (netFactor <= 0n) {
		throw new RangeError('buyExactIn: invalid feeBps');
	}

	const netQuote = floorDiv(quoteAmountIn * netFactor, BPS_DIVISOR);
	if (netQuote === 0n) {
		throw new RangeError('buyExactIn: invalid amount');
	}

	return {
		baseAmount: calculateOutput(
			params.reserveQuote,
			params.reserveBase,
			netQuote,
		),
		quoteAmount: quoteAmountIn,
		fee: quoteAmountIn - netQuote,
	};
}

function ammSellExactIn(
	params: { reserveQuote: bigint; reserveBase: bigint; feeBps: number },
	baseAmountIn: bigint,
): AmmLegs {
	const quoteBeforeFee = calculateOutput(
		params.reserveBase,
		params.reserveQuote,
		baseAmountIn,
	);

	const feeAmount = ceilDiv(
		quoteBeforeFee * BigInt(params.feeBps),
		BPS_DIVISOR,
	);

	return {
		baseAmount: baseAmountIn,
		quoteAmount: quoteBeforeFee - feeAmount,
		fee: feeAmount,
	};
}

function ammSellExactOut(
	params: { reserveQuote: bigint; reserveBase: bigint; feeBps: number },
	quoteAmountOut: bigint,
): AmmLegs {
	const divisor = BPS_DIVISOR - BigInt(params.feeBps);
	if (divisor <= 0n) {
		throw new RangeError('sellExactOut: invalid feeBps');
	}

	const quoteBeforeFee = assertU64(
		'sellExactOut',
		ceilDiv(quoteAmountOut * BPS_DIVISOR, divisor),
	);

	return {
		baseAmount: calculateInputForOutput(
			params.reserveBase,
			params.reserveQuote,
			quoteBeforeFee,
		),
		quoteAmount: quoteAmountOut,
		fee: quoteBeforeFee - quoteAmountOut,
	};
}

function buyQuote(
	legs: AmmLegs,
	quoteTransferFee: bigint,
	baseFee?: MintFee,
): BuyQuote {
	const baseTransferFee = feeOn(legs.baseAmount, baseFee);
	return {
		baseAmount: legs.baseAmount,
		quoteAmount: legs.quoteAmount,
		fee: legs.fee,
		baseTransferFee,
		quoteTransferFee,
		baseToUser: legs.baseAmount - baseTransferFee,
		quoteFromUser: legs.quoteAmount,
	};
}

/** Quotes a buy where the buyer receives `baseAmountOut`. With `baseReserveCap`, the vault sends at
 *  most the cap. Guard with `calculateSlippageUp(quoteAmount, bps)`. `quoteAmount` includes the quote
 *  mint's transfer fee. */
export function buyExactOut(
	params: BaseQuoteParams & BaseReserveCap & { baseAmountOut: bigint },
): BuyQuote {
	assertBps('buyExactOut', 'feeBps', params.feeBps);
	if (params.baseAmountOut === 0n) {
		throw new RangeError('buyExactOut: invalid amount');
	}

	const baseOutOfVault = grossUp(params.baseAmountOut, params.baseFee);
	const cap = params.baseReserveCap;
	const baseAmount =
		cap !== undefined && baseOutOfVault > cap ? cap : baseOutOfVault;

	const legs = ammBuyExactOut(params, baseAmount);
	// The priced total must reach the vault, so the user sends it grossed up.
	const quoteFromUser = grossUp(legs.quoteAmount, params.quoteFee);

	return buyQuote(
		{ ...legs, quoteAmount: quoteFromUser },
		quoteFromUser - legs.quoteAmount,
		params.baseFee,
	);
}

/** Quotes a buy that spends `quoteAmountIn`. Guard with `calculateSlippageDown(baseToUser, bps)`, not
 *  `baseAmount`. The program checks the minimum against what the buyer receives. */
export function buyExactIn(
	params: BaseQuoteParams & BaseReserveCap & { quoteAmountIn: bigint },
): BuyQuote {
	assertBps('buyExactIn', 'feeBps', params.feeBps);
	if (params.quoteAmountIn === 0n) {
		throw new RangeError('buyExactIn: invalid amount');
	}

	// The AMM prices only what reaches the vault.
	const quoteIntoVault = amountAfterFee(
		params.quoteAmountIn,
		params.quoteFee,
	);
	if (quoteIntoVault === 0n) {
		throw new RangeError('buyExactIn: invalid amount');
	}

	const uncapped = ammBuyExactIn(params, quoteIntoVault);

	// Over the cap: price exact-out at the cap, then gross up. Clamping the base output alone overstates the quote leg.
	const cap = params.baseReserveCap;
	if (cap === undefined || uncapped.baseAmount <= cap) {
		return buyQuote(
			{ ...uncapped, quoteAmount: params.quoteAmountIn },
			params.quoteAmountIn - quoteIntoVault,
			params.baseFee,
		);
	}

	const capped = ammBuyExactOut(params, cap);
	const quoteFromUser = grossUp(capped.quoteAmount, params.quoteFee);

	return buyQuote(
		{ ...capped, quoteAmount: quoteFromUser },
		quoteFromUser - capped.quoteAmount,
		params.baseFee,
	);
}

/** Quotes a sell of `baseAmountIn`. Guard with `calculateSlippageDown(quoteToUser, bps)`, not `quoteAmount`. */
export function sellExactIn(
	params: BaseQuoteParams & { baseAmountIn: bigint },
): SellQuote {
	assertBps('sellExactIn', 'feeBps', params.feeBps);
	if (params.baseAmountIn === 0n) {
		throw new RangeError('sellExactIn: invalid amount');
	}

	const baseIntoVault = amountAfterFee(params.baseAmountIn, params.baseFee);
	if (baseIntoVault === 0n) {
		throw new RangeError('sellExactIn: invalid amount');
	}

	const legs = ammSellExactIn(params, baseIntoVault);
	// `feeOn`, not `grossUp`: the AMM's output leaves the vault as priced.
	const quoteTransferFee = feeOn(legs.quoteAmount, params.quoteFee);

	return {
		baseAmount: params.baseAmountIn,
		quoteAmount: legs.quoteAmount,
		fee: legs.fee,
		baseTransferFee: params.baseAmountIn - baseIntoVault,
		quoteTransferFee,
		baseFromUser: params.baseAmountIn,
		quoteToUser: legs.quoteAmount - quoteTransferFee,
	};
}

/** Quotes a sell where the seller receives `quoteAmountOut`. Guard with
 *  `calculateSlippageUp(baseFromUser, bps)`. `baseFromUser` includes the base mint's transfer fee. */
export function sellExactOut(
	params: BaseQuoteParams & { quoteAmountOut: bigint },
): SellQuote {
	assertBps('sellExactOut', 'feeBps', params.feeBps);
	if (params.quoteAmountOut === 0n) {
		throw new RangeError('sellExactOut: invalid amount');
	}

	const quoteOutOfVault = grossUp(params.quoteAmountOut, params.quoteFee);
	const legs = ammSellExactOut(params, quoteOutOfVault);
	const baseFromUser = grossUp(legs.baseAmount, params.baseFee);

	return {
		baseAmount: baseFromUser,
		quoteAmount: quoteOutOfVault,
		fee: legs.fee,
		baseTransferFee: baseFromUser - legs.baseAmount,
		quoteTransferFee: quoteOutOfVault - params.quoteAmountOut,
		baseFromUser,
		quoteToUser: params.quoteAmountOut,
	};
}

export function calculateSlippageUp(
	amount: bigint,
	slippageBps: number,
): bigint {
	assertBps('calculateSlippageUp', 'slippageBps', slippageBps);
	return assertU64(
		'calculateSlippageUp',
		ceilDiv(amount * (BPS_DIVISOR + BigInt(slippageBps)), BPS_DIVISOR),
	);
}

export function calculateSlippageDown(
	amount: bigint,
	slippageBps: number,
): bigint {
	assertBps('calculateSlippageDown', 'slippageBps', slippageBps);
	const factor = BPS_DIVISOR - BigInt(slippageBps);
	return assertU64(
		'calculateSlippageDown',
		floorDiv(amount * factor, BPS_DIVISOR),
	);
}

/** Returns `sqrt(quoteAmount * baseAmount)`, rounded down. */
export function calculateInitialLp(
	quoteAmount: bigint,
	baseAmount: bigint,
): bigint {
	return sqrtBigInt(quoteAmount * baseAmount);
}

/** Returns the price of one base token in quote tokens, as a float. For display only. */
export function calculatePrice(params: {
	quoteReserves: bigint;
	baseReserves: bigint;
	quoteDecimals: number;
	baseDecimals: number;
}): number {
	const { quoteReserves, baseReserves, quoteDecimals, baseDecimals } = params;
	if (baseReserves === 0n) return 0;
	const rawRatio = Number(quoteReserves) / Number(baseReserves);
	return rawRatio * 10 ** (baseDecimals - quoteDecimals);
}

/** Returns the market cap in raw quote units. */
export function calculateMarketCap(params: {
	quoteReserves: bigint;
	baseReserves: bigint;
	baseSupply: bigint;
}): bigint {
	const { quoteReserves, baseReserves, baseSupply } = params;
	if (baseReserves === 0n) return 0n;
	return floorDiv(quoteReserves * baseSupply, baseReserves);
}
