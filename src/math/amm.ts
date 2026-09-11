import { assertBps, ceilDiv, floorDiv } from './internal.js';

const BPS_DIVISOR = 10_000n;

const U64_MAX = 18_446_744_073_709_551_615n;

/** Each call mirrors a `u64::try_from` in the Rust twin; drop one and an oversized leg fails in the encoder. */
function assertU64(label: string, value: bigint): bigint {
	if (value > U64_MAX) {
		throw new RangeError(`${label}: overflows u64`);
	}
	return value;
}

/** Token-2022 `TransferFeeConfig` for the epoch the trade lands in; a stale one misprices the trade. */
export interface MintFee {
	/** 0 to 10_000. */
	bps: number;
	/** Cap on the withheld amount, in the mint's raw units. */
	maximumFee: bigint;
}

/** No transfer lands exactly the requested amount; approximating one hands the program a bound it rejects. */
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

/** Rounds up, then caps (SPL's order); swapping them lets a split booking over-credit. */
export function feeOn(amount: bigint, fee?: MintFee): bigint {
	if (fee === undefined) return 0n;
	assertMintFee(fee);
	if (amount === 0n || fee.bps === 0) return 0n;

	const raw = ceilDiv(amount * BigInt(fee.bps), BPS_DIVISOR);
	return raw < fee.maximumFee ? raw : fee.maximumFee;
}

/** What lands when `amount` is sent; use `grossUp` to land an exact amount. */
export function amountAfterFee(amount: bigint, fee?: MintFee): bigint {
	return amount - feeOn(amount, fee);
}

/** Line-for-line mirror of SPL's `TransferFee::calculate_pre_fee_amount`; `undefined` when no u64 answer exists. */
function preFeeAmount(amount: bigint, fee: MintFee): bigint | undefined {
	const bps = BigInt(fee.bps);
	if (bps === 0n) return amount;
	// Unreachable via `grossUp`; SPL has it, so the mirror keeps it.
	if (amount === 0n) return 0n;
	// 100%: only the cap can be settled.
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

/** What must be sent for exactly `amount` to land; throws {@link TransferFeeNotSettleableError} if none does. */
export function grossUp(amount: bigint, fee?: MintFee): bigint {
	if (fee === undefined) return amount;
	assertMintFee(fee);
	if (amount === 0n) return 0n;

	const preFee = preFeeAmount(amount, fee);
	if (preFee === undefined)
		throw new TransferFeeNotSettleableError(amount, fee);

	// SPL's inverse is inexact (`feeOn(x) >= inverse(x - feeOn(x))`): re-derive forward and reject a mismatch.
	const impliedFee = feeOn(preFee, fee);
	const gross = amount + impliedFee;
	if (gross > U64_MAX || feeOn(gross, fee) !== impliedFee) {
		throw new TransferFeeNotSettleableError(amount, fee);
	}
	return gross;
}

/** `baseAmount`/`quoteAmount` are the user's transfers, as in on-chain `TradeResult`. Read the net
 *  fields on {@link BuyQuote}/{@link SellQuote}; re-deriving them drifts from the program by a rounding step. */
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
	/** Priced on the quote reaching the vault. */
	fee: bigint;
	/** Base credited to the buyer, after the base mint's cut. */
	baseToUser: bigint;
	/** Equals `quoteAmount`. */
	quoteFromUser: bigint;
}

export interface SellQuote extends TradeQuote {
	/** Priced on the quote leaving the vault. */
	fee: bigint;
	/** Equals `baseAmount`. */
	baseFromUser: bigint;
	/** Quote credited to the seller, after the quote mint's cut. */
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

/** Output rounds down (the new reserve rounds up), so `k` never shrinks. */
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

/** Required input rounds up so the user pays enough. */
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

/** Launchpad only: `bondingCurve.realBaseReserves`. A DEX pool has no cap. */
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

	// A `feeBps` near 10_000 amplifies the leg up to 10_000x, so this can overflow u64.
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
	// Fee comes off before the swap; the net rounds down, so the fee keeps the remainder.
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

/** Guard with `calculateSlippageUp(quoteAmount, bps)`; it already carries the quote mint's cut. */
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
	// The priced total must land, so the user is debited more than it.
	const quoteFromUser = grossUp(legs.quoteAmount, params.quoteFee);

	return buyQuote(
		{ ...legs, quoteAmount: quoteFromUser },
		quoteFromUser - legs.quoteAmount,
		params.baseFee,
	);
}

/** Guard with `calculateSlippageDown(baseToUser, bps)`, not `baseAmount`: the program bounds what the buyer nets. */
export function buyExactIn(
	params: BaseQuoteParams & BaseReserveCap & { quoteAmountIn: bigint },
): BuyQuote {
	assertBps('buyExactIn', 'feeBps', params.feeBps);
	if (params.quoteAmountIn === 0n) {
		throw new RangeError('buyExactIn: invalid amount');
	}

	// The AMM only ever prices what reaches the vault.
	const quoteIntoVault = amountAfterFee(
		params.quoteAmountIn,
		params.quoteFee,
	);
	if (quoteIntoVault === 0n) {
		throw new RangeError('buyExactIn: invalid amount');
	}

	const uncapped = ammBuyExactIn(params, quoteIntoVault);

	// Capped: re-price exact-out at the cap and gross up; clamping the base output overstates the quote leg.
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

/** Guard with `calculateSlippageDown(quoteToUser, bps)`, not `quoteAmount`. */
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
	// `feeOn`, never `grossUp`: the AMM's output leaves the vault as priced.
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

/** Guard with `calculateSlippageUp(baseFromUser, bps)`, which already carries the base mint's cut. */
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

/** Floors, as the program's `isqrt` does. */
export function calculateInitialLp(
	quoteAmount: bigint,
	baseAmount: bigint,
): bigint {
	return sqrtBigInt(quoteAmount * baseAmount);
}

/** Floating-point quote per base, for display only. */
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

/** Market cap in raw quote-token units. */
export function calculateMarketCap(params: {
	quoteReserves: bigint;
	baseReserves: bigint;
	baseSupply: bigint;
}): bigint {
	const { quoteReserves, baseReserves, baseSupply } = params;
	if (baseReserves === 0n) return 0n;
	return floorDiv(quoteReserves * baseSupply, baseReserves);
}
