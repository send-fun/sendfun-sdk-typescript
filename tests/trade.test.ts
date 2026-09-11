import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	buyExactIn,
	buyExactOut,
	sellExactIn,
	sellExactOut,
} from '../src/math/amm.js';

const VIRTUAL_QUOTE = 30_000_000_000n;
const VIRTUAL_BASE = 1_000_000_000_000_000n;
const FEE_BPS = 100;

describe('trade quote consistency', () => {
	it('buyExactOut returns exact TradeQuote', () => {
		const quote = buyExactOut({
			reserveQuote: VIRTUAL_QUOTE,
			reserveBase: VIRTUAL_BASE,
			baseAmountOut: 10_000_000_000_000n,
			feeBps: FEE_BPS,
		});
		assert.equal(quote.baseAmount, 10_000_000_000_000n);
		assert.equal(quote.quoteAmount, 306_091_217n);
		assert.equal(quote.fee, 3_060_913n);
	});

	it('buyExactIn returns exact TradeQuote', () => {
		const quote = buyExactIn({
			reserveQuote: VIRTUAL_QUOTE,
			reserveBase: VIRTUAL_BASE,
			quoteAmountIn: 1_000_000_000n,
			feeBps: FEE_BPS,
		});
		assert.equal(quote.quoteAmount, 1_000_000_000n);
		assert.equal(quote.baseAmount, 31_945_788_964_181n);
		assert.equal(quote.fee, 10_000_000n);
	});

	it('sellExactIn returns exact TradeQuote', () => {
		const quote = sellExactIn({
			reserveQuote: VIRTUAL_QUOTE,
			reserveBase: VIRTUAL_BASE,
			baseAmountIn: 10_000_000_000_000n,
			feeBps: FEE_BPS,
		});
		assert.equal(quote.baseAmount, 10_000_000_000_000n);
		assert.equal(quote.quoteAmount, 294_059_404n);
		assert.equal(quote.fee, 2_970_298n);
	});

	it('sellExactOut returns exact TradeQuote', () => {
		const quote = sellExactOut({
			reserveQuote: VIRTUAL_QUOTE,
			reserveBase: VIRTUAL_BASE,
			quoteAmountOut: 1_000_000_000n,
			feeBps: FEE_BPS,
		});
		assert.equal(quote.quoteAmount, 1_000_000_000n);
		assert.equal(quote.baseAmount, 34_843_205_607_004n);
		assert.equal(quote.fee, 10_101_011n);
	});

	it('buy fee splits correctly: fee + net = gross', () => {
		const quote = buyExactOut({
			reserveQuote: VIRTUAL_QUOTE,
			reserveBase: VIRTUAL_BASE,
			baseAmountOut: 10_000_000_000_000n,
			feeBps: FEE_BPS,
		});
		assert.equal(quote.fee, 3_060_913n);
		assert.equal(quote.quoteAmount - quote.fee, 303_030_304n);
	});

	it('sell fee splits correctly: net + fee = gross', () => {
		const quote = sellExactIn({
			reserveQuote: VIRTUAL_QUOTE,
			reserveBase: VIRTUAL_BASE,
			baseAmountIn: 10_000_000_000_000n,
			feeBps: FEE_BPS,
		});
		assert.equal(quote.fee, 2_970_298n);
		assert.equal(quote.quoteAmount + quote.fee, 297_029_702n);
	});

	it('zero fee when feeBps is 0', () => {
		const buyQuote = buyExactOut({
			reserveQuote: VIRTUAL_QUOTE,
			reserveBase: VIRTUAL_BASE,
			baseAmountOut: 10_000_000_000_000n,
			feeBps: 0,
		});
		assert.equal(buyQuote.fee, 0n);

		const sellQuote = sellExactIn({
			reserveQuote: VIRTUAL_QUOTE,
			reserveBase: VIRTUAL_BASE,
			baseAmountIn: 10_000_000_000_000n,
			feeBps: 0,
		});
		assert.equal(sellQuote.fee, 0n);
	});
});
