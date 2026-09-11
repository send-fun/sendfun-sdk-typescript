import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	calculateInitialLp,
	calculateSlippageDown,
	calculateSlippageUp,
	calculateInputForOutput,
	calculateOutput,
	buyExactIn,
	buyExactOut,
	sellExactIn,
	sellExactOut,
	type TradeQuote,
} from '../src/math/amm.js';

const INITIAL_VIRTUAL_QUOTE = 30_000_000_000n; // 30 SOL
const INITIAL_VIRTUAL_BASE = 1_000_000_000_000_000n; // 1B tokens (6 decimals)

describe('calculateOutput', () => {
	it('basic: 1 SOL in from initial reserves', () => {
		const output = calculateOutput(
			INITIAL_VIRTUAL_QUOTE,
			INITIAL_VIRTUAL_BASE,
			1_000_000_000n,
		);
		assert.equal(output, 32_258_064_516_129n);
	});

	it('ceiling division protects reserves', () => {
		const output = calculateOutput(1000n, 1000n, 10n);
		assert.equal(output, 9n);
	});

	it('roundtrip favors protocol', () => {
		const initialQuote = 100_000_000_000n;
		const initialBase = 1_000_000_000n;

		const tokensOut = calculateOutput(
			initialQuote,
			initialBase,
			10_000_000_000n,
		);

		const newQuote = initialQuote + 10_000_000_000n;
		const newBase = initialBase - tokensOut;

		const solOut = calculateOutput(newBase, newQuote, tokensOut);
		assert.equal(solOut, 9_999_999_900n);
	});

	it('throws on zero amount', () => {
		assert.throws(() => calculateOutput(100n, 100n, 0n));
	});
});

describe('calculateInputForOutput', () => {
	it('inverse of calculateOutput', () => {
		const quoteNeeded = calculateInputForOutput(
			100_000_000_000n,
			1_000_000_000n,
			100_000_000n,
		);
		const actualOut = calculateOutput(
			100_000_000_000n,
			1_000_000_000n,
			quoteNeeded,
		);
		assert.equal(actualOut, 100_000_000n);
	});

	it('throws when output >= reserves', () => {
		assert.throws(() =>
			calculateInputForOutput(
				100_000_000_000n,
				1_000_000_000n,
				2_000_000_000n,
			),
		);
	});
});

describe('buyExactOut', () => {
	it('with 1% fee: hardcoded values', () => {
		const quote = buyExactOut({
			reserveQuote: INITIAL_VIRTUAL_QUOTE,
			reserveBase: INITIAL_VIRTUAL_BASE,
			baseAmountOut: 10_000_000_000_000n, // 10M tokens
			feeBps: 100,
		});
		assert.equal(quote.baseAmount, 10_000_000_000_000n);
		assert.equal(quote.quoteAmount, 306_091_217n);
		assert.equal(quote.fee, 3_060_913n);
	});

	it('small amounts: ceiling rounding', () => {
		const quote = buyExactOut({
			reserveQuote: 10_000n,
			reserveBase: 10_000n,
			baseAmountOut: 99n,
			feeBps: 100,
		});
		assert.equal(quote.quoteAmount, 102n);
		assert.equal(quote.fee, 2n);
	});

	it('zero fee: fee is 0', () => {
		const quote = buyExactOut({
			reserveQuote: INITIAL_VIRTUAL_QUOTE,
			reserveBase: INITIAL_VIRTUAL_BASE,
			baseAmountOut: 10_000_000_000_000n,
			feeBps: 0,
		});
		assert.equal(quote.fee, 0n);
		const rawCost = calculateInputForOutput(
			INITIAL_VIRTUAL_QUOTE,
			INITIAL_VIRTUAL_BASE,
			10_000_000_000_000n,
		);
		assert.equal(quote.quoteAmount, rawCost);
	});

	it('throws on zero amount', () => {
		assert.throws(() =>
			buyExactOut({
				reserveQuote: INITIAL_VIRTUAL_QUOTE,
				reserveBase: INITIAL_VIRTUAL_BASE,
				baseAmountOut: 0n,
				feeBps: 100,
			}),
		);
	});
});

describe('buyExactIn', () => {
	it('1 SOL with 1% fee', () => {
		const quote = buyExactIn({
			reserveQuote: INITIAL_VIRTUAL_QUOTE,
			reserveBase: INITIAL_VIRTUAL_BASE,
			quoteAmountIn: 1_000_000_000n,
			feeBps: 100,
		});
		assert.equal(quote.quoteAmount, 1_000_000_000n);
		assert.equal(quote.fee, 10_000_000n);
		assert.equal(quote.baseAmount, 31_945_788_964_181n);
	});

	it('throws on zero amount', () => {
		assert.throws(() =>
			buyExactIn({
				reserveQuote: INITIAL_VIRTUAL_QUOTE,
				reserveBase: INITIAL_VIRTUAL_BASE,
				quoteAmountIn: 0n,
				feeBps: 100,
			}),
		);
	});

	it('zero fee: fee is 0', () => {
		const quote = buyExactIn({
			reserveQuote: INITIAL_VIRTUAL_QUOTE,
			reserveBase: INITIAL_VIRTUAL_BASE,
			quoteAmountIn: 1_000_000_000n,
			feeBps: 0,
		});
		assert.equal(quote.fee, 0n);
		assert.equal(quote.quoteAmount, 1_000_000_000n);
	});
});

describe('sellExactIn', () => {
	it('10M tokens with 1% fee', () => {
		const quote = sellExactIn({
			reserveQuote: INITIAL_VIRTUAL_QUOTE,
			reserveBase: INITIAL_VIRTUAL_BASE,
			baseAmountIn: 10_000_000_000_000n,
			feeBps: 100,
		});
		assert.equal(quote.baseAmount, 10_000_000_000_000n);
		assert.equal(quote.quoteAmount, 294_059_404n);
		assert.equal(quote.fee, 2_970_298n);
	});

	it('fee ceiling rounding', () => {
		const quote = sellExactIn({
			reserveQuote: 1_000_000_000_000n,
			reserveBase: 1_000_000_000_000n,
			baseAmountIn: 9_999_999n,
			feeBps: 100,
		});
		assert.equal(quote.fee, 99_999n);
		assert.equal(quote.quoteAmount, 9_899_900n);
	});

	it('zero fee: fee is 0', () => {
		const quote = sellExactIn({
			reserveQuote: INITIAL_VIRTUAL_QUOTE,
			reserveBase: INITIAL_VIRTUAL_BASE,
			baseAmountIn: 10_000_000_000_000n,
			feeBps: 0,
		});
		assert.equal(quote.fee, 0n);
		const rawOutput = calculateOutput(
			INITIAL_VIRTUAL_BASE,
			INITIAL_VIRTUAL_QUOTE,
			10_000_000_000_000n,
		);
		assert.equal(quote.quoteAmount, rawOutput);
	});

	it('throws on zero amount', () => {
		assert.throws(() =>
			sellExactIn({
				reserveQuote: INITIAL_VIRTUAL_QUOTE,
				reserveBase: INITIAL_VIRTUAL_BASE,
				baseAmountIn: 0n,
				feeBps: 100,
			}),
		);
	});
});

describe('sellExactOut', () => {
	it('hardcoded: want 1 SOL after 1% fee', () => {
		const quote = sellExactOut({
			reserveQuote: INITIAL_VIRTUAL_QUOTE,
			reserveBase: INITIAL_VIRTUAL_BASE,
			quoteAmountOut: 1_000_000_000n,
			feeBps: 100,
		});
		assert.equal(quote.quoteAmount, 1_000_000_000n);
		assert.equal(quote.fee, 10_101_011n);
		assert.equal(quote.baseAmount, 34_843_205_607_004n);
	});

	it('throws on zero amount', () => {
		assert.throws(() =>
			sellExactOut({
				reserveQuote: INITIAL_VIRTUAL_QUOTE,
				reserveBase: INITIAL_VIRTUAL_BASE,
				quoteAmountOut: 0n,
				feeBps: 100,
			}),
		);
	});
});

describe('feeBps validation', () => {
	const RESERVE = 1_000_000n;
	const AMOUNT = 1_000n;

	const directions = [
		[
			'buyExactOut',
			(feeBps: number) =>
				buyExactOut({
					reserveQuote: RESERVE,
					reserveBase: RESERVE,
					baseAmountOut: AMOUNT,
					feeBps,
				}),
		],
		[
			'buyExactIn',
			(feeBps: number) =>
				buyExactIn({
					reserveQuote: RESERVE,
					reserveBase: RESERVE,
					quoteAmountIn: AMOUNT,
					feeBps,
				}),
		],
		[
			'sellExactIn',
			(feeBps: number) =>
				sellExactIn({
					reserveQuote: RESERVE,
					reserveBase: RESERVE,
					baseAmountIn: AMOUNT,
					feeBps,
				}),
		],
		[
			'sellExactOut',
			(feeBps: number) =>
				sellExactOut({
					reserveQuote: RESERVE,
					reserveBase: RESERVE,
					quoteAmountOut: AMOUNT,
					feeBps,
				}),
		],
	] as const satisfies readonly (readonly [
		string,
		(feeBps: number) => TradeQuote,
	])[];

	for (const [name, quote] of directions) {
		for (const feeBps of [-1, -10_000, 0.5, 10_001]) {
			it(`${name} throws on feeBps ${feeBps}`, () => {
				assert.throws(() => quote(feeBps), RangeError);
			});
		}
	}

	for (const [name, quote] of directions.filter(
		([n]) => n !== 'sellExactIn',
	)) {
		it(`${name} throws on feeBps 10_000 (zero divisor)`, () => {
			assert.throws(() => quote(10_000), RangeError);
		});
	}

	it('sellExactIn accepts feeBps 10_000 and returns the whole output as fee', () => {
		const q = sellExactIn({
			reserveQuote: RESERVE,
			reserveBase: RESERVE,
			baseAmountIn: AMOUNT,
			feeBps: 10_000,
		});
		assert.equal(q.baseAmount, 1_000n);
		assert.equal(q.quoteAmount, 0n);
		assert.equal(q.fee, 999n);
	});
});

describe('slippageBps rejects non-integers', () => {
	it('calculateSlippageUp throws on 0.5', () => {
		assert.throws(
			() => calculateSlippageUp(1_000_000_000n, 0.5),
			RangeError,
		);
	});

	it('calculateSlippageDown throws on 0.5', () => {
		assert.throws(
			() => calculateSlippageDown(1_000_000_000n, 0.5),
			RangeError,
		);
	});
});

describe('slippage bounds at 100 bps', () => {
	it('buyExactOut: maxQuoteIn is slippageUp(quoteAmount)', () => {
		const q = buyExactOut({
			reserveQuote: INITIAL_VIRTUAL_QUOTE,
			reserveBase: INITIAL_VIRTUAL_BASE,
			baseAmountOut: 10_000_000_000_000n,
			feeBps: 100,
		});
		assert.equal(q.quoteAmount, 306_091_217n);
		assert.equal(calculateSlippageUp(q.quoteAmount, 100), 309_152_130n);
	});

	it('buyExactIn: minBaseOut is slippageDown(baseAmount)', () => {
		const q = buyExactIn({
			reserveQuote: INITIAL_VIRTUAL_QUOTE,
			reserveBase: INITIAL_VIRTUAL_BASE,
			quoteAmountIn: 1_000_000_000n,
			feeBps: 100,
		});
		assert.equal(q.baseAmount, 31_945_788_964_181n);
		assert.equal(
			calculateSlippageDown(q.baseAmount, 100),
			31_626_331_074_539n,
		);
	});

	it('sellExactIn: minQuoteOut is slippageDown(quoteAmount)', () => {
		const q = sellExactIn({
			reserveQuote: INITIAL_VIRTUAL_QUOTE,
			reserveBase: INITIAL_VIRTUAL_BASE,
			baseAmountIn: 10_000_000_000_000n,
			feeBps: 100,
		});
		assert.equal(q.quoteAmount, 294_059_404n);
		assert.equal(calculateSlippageDown(q.quoteAmount, 100), 291_118_809n);
	});

	it('sellExactOut: maxBaseIn is slippageUp(baseAmount)', () => {
		const q = sellExactOut({
			reserveQuote: INITIAL_VIRTUAL_QUOTE,
			reserveBase: INITIAL_VIRTUAL_BASE,
			quoteAmountOut: 1_000_000_000n,
			feeBps: 100,
		});
		assert.equal(q.baseAmount, 34_843_205_607_004n);
		assert.equal(
			calculateSlippageUp(q.baseAmount, 100),
			35_191_637_663_075n,
		);
	});

	it('a zero-bps bound is the exact amount', () => {
		const buy = buyExactOut({
			reserveQuote: INITIAL_VIRTUAL_QUOTE,
			reserveBase: INITIAL_VIRTUAL_BASE,
			baseAmountOut: 10_000_000_000_000n,
			feeBps: 100,
		});
		assert.equal(calculateSlippageUp(buy.quoteAmount, 0), buy.quoteAmount);

		const sell = sellExactIn({
			reserveQuote: INITIAL_VIRTUAL_QUOTE,
			reserveBase: INITIAL_VIRTUAL_BASE,
			baseAmountIn: 10_000_000_000_000n,
			feeBps: 100,
		});
		assert.equal(
			calculateSlippageDown(sell.quoteAmount, 0),
			sell.quoteAmount,
		);
	});
});

describe('calculateSlippageUp', () => {
	it('1 SOL with 1% slippage', () => {
		assert.equal(calculateSlippageUp(1_000_000_000n, 100), 1_010_000_000n);
	});

	it('ceiling: 101 with 50bps', () => {
		assert.equal(calculateSlippageUp(101n, 50), 102n);
	});

	it('accepts the inclusive max 10_000 bps (doubles)', () => {
		assert.equal(
			calculateSlippageUp(1_000_000_000n, 10_000),
			2_000_000_000n,
		);
	});

	it('throws one bps past the max (10_001)', () => {
		assert.throws(
			() => calculateSlippageUp(1_000_000_000n, 10_001),
			RangeError,
		);
	});

	it('throws when slippageBps > 10_000', () => {
		assert.throws(
			() => calculateSlippageUp(1_000_000_000n, 15_000),
			RangeError,
		);
	});

	it('throws on negative slippageBps', () => {
		assert.throws(
			() => calculateSlippageUp(1_000_000_000n, -1),
			RangeError,
		);
	});
});

describe('calculateSlippageDown', () => {
	it('1 SOL with 1% slippage', () => {
		assert.equal(calculateSlippageDown(1_000_000_000n, 100), 990_000_000n);
	});

	it('floor: 101 with 50bps', () => {
		assert.equal(calculateSlippageDown(101n, 50), 100n);
	});

	it('100% slippage returns 0 floor (accept any output)', () => {
		assert.equal(calculateSlippageDown(1_000_000_000n, 10_000), 0n);
	});

	it('throws one bps past the max (10_001)', () => {
		assert.throws(
			() => calculateSlippageDown(1_000_000_000n, 10_001),
			RangeError,
		);
	});

	it('throws when slippageBps > 10_000', () => {
		assert.throws(
			() => calculateSlippageDown(1_000_000_000n, 15_000),
			RangeError,
		);
	});

	it('throws on negative slippageBps', () => {
		assert.throws(
			() => calculateSlippageDown(1_000_000_000n, -1),
			RangeError,
		);
	});
});

describe('calculateInitialLp', () => {
	it('perfect square: sqrt(1e9 * 1e9) = 1e9', () => {
		assert.equal(
			calculateInitialLp(1_000_000_000n, 1_000_000_000n),
			1_000_000_000n,
		);
	});

	it('floors a non-perfect square', () => {
		assert.equal(
			calculateInitialLp(1_000_000_000n, 1_000_000_001n),
			1_000_000_000n,
		);
	});
});

describe('u64 bounds', () => {
	it('buyExactOut rejects a quote leg past u64', () => {
		// ~5e15 before fee fits u64; feeBps 9_999 leaves divisor 1 and amplifies it to ~5e19.
		assert.throws(
			() =>
				buyExactOut({
					reserveQuote: 85_000_000_000n,
					reserveBase: 1_000_000_000_000_000n,
					baseAmountOut: 999_983_000_000_000n,
					feeBps: 9_999,
				}),
			{ name: 'RangeError', message: 'buyExactOut: overflows u64' },
		);
	});

	it('sellExactOut rejects a base leg past u64', () => {
		// Draining quote to one unit makes the new base reserve `k / 1`, so the input is ~8.5e25.
		assert.throws(
			() =>
				sellExactOut({
					reserveQuote: 85_000_000_000n,
					reserveBase: 1_000_000_000_000_000n,
					quoteAmountOut: 84_999_999_999n,
					feeBps: 0,
				}),
			{
				name: 'RangeError',
				message: 'calculateInputForOutput: overflows u64',
			},
		);
	});

	it('calculateSlippageUp rejects a bound past u64', () => {
		assert.throws(
			() => calculateSlippageUp(18_446_744_073_709_551_615n, 1),
			{
				name: 'RangeError',
				message: 'calculateSlippageUp: overflows u64',
			},
		);
	});
});
