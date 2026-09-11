import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	amountAfterFee,
	buyExactIn,
	buyExactOut,
	feeOn,
	grossUp,
	sellExactIn,
	sellExactOut,
	TransferFeeNotSettleableError,
	type MintFee,
} from '../src/math/amm.js';

const U64_MAX = 18_446_744_073_709_551_615n;

// Launchpad opening reserves and 1% fee.
const RQ = 30_000_000_000n;
const RB = 1_000_000_000_000_000n;
const FEE_BPS = 100;

const QUOTE_20_BPS = { bps: 20, maximumFee: U64_MAX } satisfies MintFee;

const BASE_100_BPS = { bps: 100, maximumFee: U64_MAX } satisfies MintFee;

// RangeErrors pin the message: `TransferFeeNotSettleableError` extends
// `RangeError`, so a class check cannot separate the failure modes.
const BPS_OUT_OF_RANGE = {
	name: 'RangeError',
	message: 'MintFee: bps must be an integer between 0 and 10_000',
};

describe('feeOn', () => {
	it('a zero rate never moves an amount', () => {
		assert.equal(feeOn(1_000_000n, { bps: 0, maximumFee: 0n }), 0n);
	});

	it('rounds up', () => {
		const fee = { bps: 20, maximumFee: U64_MAX } satisfies MintFee;
		assert.equal(feeOn(1n, fee), 1n);
		assert.equal(feeOn(10_000n, fee), 20n);
		assert.equal(feeOn(10_001n, fee), 21n);
	});

	it('is zero on a zero amount', () => {
		assert.equal(feeOn(0n, { bps: 10_000, maximumFee: U64_MAX }), 0n);
	});

	it('caps after rounding, not before', () => {
		assert.equal(feeOn(1_000_000n, { bps: 100, maximumFee: 500n }), 500n);
	});

	it('stays superadditive across a split at the cap', () => {
		// On-chain split bookings rely on fee(a) + fee(b) >= fee(a + b).
		const fee = { bps: 100, maximumFee: 500n } satisfies MintFee;
		assert.equal(feeOn(30_000n, fee), 300n);
		assert.equal(feeOn(40_000n, fee), 400n);
		assert.equal(feeOn(70_000n, fee), 500n);
	});

	it('is the identity when the mint carries no config', () => {
		assert.equal(feeOn(1_000_000n, undefined), 0n);
		assert.equal(amountAfterFee(1_000_000n, undefined), 1_000_000n);
		assert.equal(grossUp(1_000_000n, undefined), 1_000_000n);
	});

	it('rejects an out-of-range rate', () => {
		assert.throws(
			() => feeOn(1_000n, { bps: 10_001, maximumFee: 0n }),
			BPS_OUT_OF_RANGE,
		);
	});
});

describe('amountAfterFee', () => {
	it('deducts what feeOn charges', () => {
		assert.equal(
			amountAfterFee(1_000_000_000n, QUOTE_20_BPS),
			998_000_000n,
		);
		assert.equal(
			amountAfterFee(10_000_000_000_000n, BASE_100_BPS),
			9_900_000_000_000n,
		);
	});

	it('rejects an out-of-range rate', () => {
		assert.throws(
			() => amountAfterFee(1_000n, { bps: 10_001, maximumFee: 0n }),
			BPS_OUT_OF_RANGE,
		);
	});
});

describe('grossUp', () => {
	it('a zero rate never moves an amount', () => {
		assert.equal(
			grossUp(1_000_000n, { bps: 0, maximumFee: 0n }),
			1_000_000n,
		);
	});

	it('is a no-op at zero', () => {
		assert.equal(grossUp(0n, { bps: 100, maximumFee: U64_MAX }), 0n);
	});

	it('lands the exact amount', () => {
		for (const bps of [1, 20, 100, 500, 3_333, 9_999]) {
			const fee = { bps, maximumFee: U64_MAX } satisfies MintFee;
			for (const amount of [
				1n,
				7n,
				1_000n,
				999_983n,
				1_000_000_000n,
			] as const) {
				const gross = grossUp(amount, fee);
				assert.equal(
					gross - feeOn(gross, fee),
					amount,
					`bps ${bps} amount ${amount} grossed to ${gross}`,
				);
			}
		}
	});

	it('the maximum fee clamps the gross up', () => {
		const fee = { bps: 100, maximumFee: 500n } satisfies MintFee;
		assert.equal(feeOn(1_000_000n, fee), 500n);
		const gross = grossUp(1_000_000n, fee);
		assert.equal(gross, 1_000_500n);
		assert.equal(gross - feeOn(gross, fee), 1_000_000n);
	});

	it('a full rate with a finite cap still settles', () => {
		const fee = { bps: 10_000, maximumFee: 1_000n } satisfies MintFee;
		const gross = grossUp(4_200n, fee);
		assert.equal(gross, 5_200n);
		assert.equal(gross - feeOn(gross, fee), 4_200n);
	});

	it('a full rate without a cap is rejected', () => {
		assert.throws(
			() => grossUp(1_000n, { bps: 10_000, maximumFee: U64_MAX }),
			TransferFeeNotSettleableError,
		);
	});

	it('a gross up past u64 is rejected', () => {
		assert.throws(
			() => grossUp(U64_MAX, { bps: 5_000, maximumFee: U64_MAX }),
			TransferFeeNotSettleableError,
		);
	});

	it('rejects an out-of-range rate', () => {
		assert.throws(
			() => grossUp(1_000n, { bps: 10_001, maximumFee: 0n }),
			BPS_OUT_OF_RANGE,
		);
	});
});

describe('buyExactIn with transfer fees', () => {
	it('pins the user leg at what they sent when the mint is plain', () => {
		const quote = buyExactIn({
			reserveQuote: RQ,
			reserveBase: RB,
			quoteAmountIn: 1_000_000_000n,
			feeBps: FEE_BPS,
		});
		assert.equal(quote.baseAmount, 31_945_788_964_181n);
		assert.equal(quote.quoteAmount, 1_000_000_000n);
		assert.equal(quote.fee, 10_000_000n);
		assert.equal(quote.quoteTransferFee, 0n);
		assert.equal(quote.baseTransferFee, 0n);
		assert.equal(quote.baseToUser, 31_945_788_964_181n);
		assert.equal(quote.quoteFromUser, 1_000_000_000n);
	});

	it('prices only what reached the vault', () => {
		const quote = buyExactIn({
			reserveQuote: RQ,
			reserveBase: RB,
			quoteAmountIn: 1_000_000_000n,
			feeBps: FEE_BPS,
			quoteFee: QUOTE_20_BPS,
		});
		assert.equal(quote.baseAmount, 31_883_934_501_139n);
		assert.equal(quote.quoteAmount, 1_000_000_000n);
		assert.equal(quote.fee, 9_980_000n);
		assert.equal(quote.quoteTransferFee, 2_000_000n);
		assert.equal(quote.quoteFromUser, 1_000_000_000n);
	});

	it('nets the base leg down for the buyer', () => {
		const quote = buyExactIn({
			reserveQuote: RQ,
			reserveBase: RB,
			quoteAmountIn: 1_000_000_000n,
			feeBps: FEE_BPS,
			baseFee: BASE_100_BPS,
		});
		assert.equal(quote.baseAmount, 31_945_788_964_181n);
		assert.equal(quote.baseTransferFee, 319_457_889_642n);
		assert.equal(quote.baseToUser, 31_626_331_074_539n);
	});

	it('ignores a cap it stays under', () => {
		const capped = buyExactIn({
			reserveQuote: RQ,
			reserveBase: RB,
			quoteAmountIn: 1_000_000_000n,
			feeBps: FEE_BPS,
			baseReserveCap: U64_MAX,
		});
		assert.equal(capped.baseAmount, 31_945_788_964_181n);
		assert.equal(capped.quoteAmount, 1_000_000_000n);
		assert.equal(capped.fee, 10_000_000n);
	});

	it('grosses the user leg up from the curve leg when capped', () => {
		const plain = buyExactIn({
			reserveQuote: RQ,
			reserveBase: RB,
			quoteAmountIn: 1_000_000_000n,
			feeBps: FEE_BPS,
			baseReserveCap: 1_000_000_000_000n,
		});
		assert.equal(plain.baseAmount, 1_000_000_000_000n);
		assert.equal(plain.quoteAmount, 30_333_365n);
		assert.equal(plain.fee, 303_334n);
		assert.equal(plain.quoteTransferFee, 0n);

		const fee = buyExactIn({
			reserveQuote: RQ,
			reserveBase: RB,
			quoteAmountIn: 1_000_000_000n,
			feeBps: FEE_BPS,
			quoteFee: QUOTE_20_BPS,
			baseReserveCap: 1_000_000_000_000n,
		});
		assert.equal(fee.baseAmount, 1_000_000_000_000n);
		assert.equal(fee.quoteAmount, 30_394_154n);
		assert.equal(fee.fee, 303_334n);
		assert.equal(fee.quoteTransferFee, 60_789n);
		assert.equal(fee.quoteFromUser, 30_394_154n);
	});

	it('rejects a leg the mint eats whole', () => {
		assert.throws(
			() =>
				buyExactIn({
					reserveQuote: RQ,
					reserveBase: RB,
					quoteAmountIn: 100n,
					feeBps: FEE_BPS,
					quoteFee: { bps: 10_000, maximumFee: U64_MAX },
				}),
			// Zeroed leg, not unsettleable: the message is the only thing that tells them apart.
			{ name: 'RangeError', message: 'buyExactIn: invalid amount' },
		);
	});
});

describe('buyExactOut with transfer fees', () => {
	it('moves exactly what the user asked for when the mints are plain', () => {
		const quote = buyExactOut({
			reserveQuote: RQ,
			reserveBase: RB,
			baseAmountOut: 10_000_000_000_000n,
			feeBps: FEE_BPS,
		});
		assert.equal(quote.baseAmount, 10_000_000_000_000n);
		assert.equal(quote.quoteAmount, 306_091_217n);
		assert.equal(quote.fee, 3_060_913n);
		assert.equal(quote.baseTransferFee, 0n);
		assert.equal(quote.quoteTransferFee, 0n);
		assert.equal(quote.baseToUser, 10_000_000_000_000n);
		assert.equal(quote.quoteFromUser, 306_091_217n);
	});

	it('grosses both legs up', () => {
		const quote = buyExactOut({
			reserveQuote: RQ,
			reserveBase: RB,
			baseAmountOut: 10_000_000_000_000n,
			feeBps: FEE_BPS,
			quoteFee: QUOTE_20_BPS,
			baseFee: BASE_100_BPS,
		});
		assert.equal(quote.baseAmount, 10_101_010_101_011n);
		assert.equal(quote.quoteAmount, 309_834_264n);
		assert.equal(quote.fee, 3_092_146n);
		assert.equal(quote.baseTransferFee, 101_010_101_011n);
		assert.equal(quote.quoteTransferFee, 619_669n);
		assert.equal(quote.baseToUser, 10_000_000_000_000n);
		assert.equal(quote.quoteFromUser, 309_834_264n);
	});

	it('fills only up to the cap', () => {
		const quote = buyExactOut({
			reserveQuote: RQ,
			reserveBase: RB,
			baseAmountOut: 10_000_000_000_000n,
			feeBps: FEE_BPS,
			baseReserveCap: 1_000_000_000_000n,
		});
		assert.equal(quote.baseAmount, 1_000_000_000_000n);
		assert.equal(quote.quoteAmount, 30_333_365n);
		assert.equal(quote.fee, 303_334n);
		assert.equal(quote.baseToUser, 1_000_000_000_000n);
	});

	it('nets the capped fill down through the base mint', () => {
		const quote = buyExactOut({
			reserveQuote: RQ,
			reserveBase: RB,
			baseAmountOut: 10_000_000_000_000n,
			feeBps: FEE_BPS,
			baseFee: BASE_100_BPS,
			baseReserveCap: 1_000_000_000_000n,
		});
		assert.equal(quote.baseAmount, 1_000_000_000_000n);
		assert.equal(quote.baseTransferFee, 10_000_000_000n);
		assert.equal(quote.baseToUser, 990_000_000_000n);
	});
});

describe('sellExactIn with transfer fees', () => {
	it('pays the user the net when the mints are plain', () => {
		const quote = sellExactIn({
			reserveQuote: RQ,
			reserveBase: RB,
			baseAmountIn: 10_000_000_000_000n,
			feeBps: FEE_BPS,
		});
		assert.equal(quote.baseAmount, 10_000_000_000_000n);
		assert.equal(quote.quoteAmount, 294_059_404n);
		assert.equal(quote.fee, 2_970_298n);
		assert.equal(quote.baseTransferFee, 0n);
		assert.equal(quote.quoteTransferFee, 0n);
		assert.equal(quote.baseFromUser, 10_000_000_000_000n);
		assert.equal(quote.quoteToUser, 294_059_404n);
	});

	it('books only the base that landed', () => {
		const quote = sellExactIn({
			reserveQuote: RQ,
			reserveBase: RB,
			baseAmountIn: 10_000_000_000_000n,
			feeBps: FEE_BPS,
			baseFee: BASE_100_BPS,
		});
		assert.equal(quote.baseAmount, 10_000_000_000_000n);
		assert.equal(quote.baseTransferFee, 100_000_000_000n);
		assert.equal(quote.quoteAmount, 291_147_637n);
		assert.equal(quote.fee, 2_940_886n);
		assert.equal(quote.baseFromUser, 10_000_000_000_000n);
	});

	it('takes the quote mint cut off the outbound leg', () => {
		const quote = sellExactIn({
			reserveQuote: RQ,
			reserveBase: RB,
			baseAmountIn: 10_000_000_000_000n,
			feeBps: FEE_BPS,
			quoteFee: QUOTE_20_BPS,
		});
		assert.equal(quote.quoteAmount, 294_059_404n);
		assert.equal(quote.quoteTransferFee, 588_119n);
		assert.equal(quote.quoteToUser, 293_471_285n);
	});

	it('rejects a leg the mint eats whole', () => {
		assert.throws(
			() =>
				sellExactIn({
					reserveQuote: RQ,
					reserveBase: RB,
					baseAmountIn: 100n,
					feeBps: FEE_BPS,
					baseFee: { bps: 10_000, maximumFee: U64_MAX },
				}),
			// Zeroed leg, not unsettleable: the message is the only thing that tells them apart.
			{ name: 'RangeError', message: 'sellExactIn: invalid amount' },
		);
	});
});

describe('sellExactOut with transfer fees', () => {
	it('lands exactly what the user asked for when the mints are plain', () => {
		const quote = sellExactOut({
			reserveQuote: RQ,
			reserveBase: RB,
			quoteAmountOut: 100_000_000n,
			feeBps: FEE_BPS,
		});
		assert.equal(quote.baseAmount, 3_378_378_411_599n);
		assert.equal(quote.quoteAmount, 100_000_000n);
		assert.equal(quote.fee, 1_010_102n);
		assert.equal(quote.baseTransferFee, 0n);
		assert.equal(quote.quoteTransferFee, 0n);
		assert.equal(quote.baseFromUser, 3_378_378_411_599n);
		assert.equal(quote.quoteToUser, 100_000_000n);
	});

	it('grosses both legs up', () => {
		const quote = sellExactOut({
			reserveQuote: RQ,
			reserveBase: RB,
			quoteAmountOut: 100_000_000n,
			feeBps: FEE_BPS,
			quoteFee: QUOTE_20_BPS,
			baseFee: BASE_100_BPS,
		});
		assert.equal(quote.baseAmount, 3_419_365_278_607n);
		assert.equal(quote.quoteAmount, 100_200_401n);
		assert.equal(quote.fee, 1_012_126n);
		assert.equal(quote.baseTransferFee, 34_193_652_787n);
		assert.equal(quote.quoteTransferFee, 200_401n);
		assert.equal(quote.baseFromUser, 3_419_365_278_607n);
		assert.equal(quote.quoteToUser, 100_000_000n);
	});

	it('surfaces an unsettleable quote leg', () => {
		assert.throws(
			() =>
				sellExactOut({
					reserveQuote: RQ,
					reserveBase: RB,
					quoteAmountOut: 100_000_000n,
					feeBps: FEE_BPS,
					quoteFee: { bps: 10_000, maximumFee: U64_MAX },
				}),
			TransferFeeNotSettleableError,
		);
	});
});
