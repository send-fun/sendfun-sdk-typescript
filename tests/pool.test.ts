import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateMarketCap, calculatePrice } from '../src/math/amm.js';

const QUOTE_RESERVES = 50_000_000_000n; // 50 SOL
const BASE_RESERVES = 500_000_000_000_000n; // 500M tokens (6 decimals)

describe('calculatePrice (dex pool)', () => {
	it('returns correct price with known reserves', () => {
		const p = calculatePrice({
			quoteReserves: QUOTE_RESERVES,
			baseReserves: BASE_RESERVES,
			quoteDecimals: 9,
			baseDecimals: 6,
		});
		assert.ok(Math.abs(p - 1e-7) < 1e-19);
	});

	it('returns 0 when baseReserves is 0', () => {
		const p = calculatePrice({
			quoteReserves: QUOTE_RESERVES,
			baseReserves: 0n,
			quoteDecimals: 9,
			baseDecimals: 6,
		});
		assert.equal(p, 0);
	});
});

describe('calculateMarketCap (dex pool)', () => {
	it('returns correct market cap with known reserves', () => {
		const supply = 1_000_000_000_000_000n; // 1B tokens
		const mc = calculateMarketCap({
			quoteReserves: QUOTE_RESERVES,
			baseReserves: BASE_RESERVES,
			baseSupply: supply,
		});
		assert.equal(mc, 100_000_000_000n);
	});

	it('returns 0 when baseReserves is 0', () => {
		const mc = calculateMarketCap({
			quoteReserves: QUOTE_RESERVES,
			baseReserves: 0n,
			baseSupply: 1_000_000_000_000_000n,
		});
		assert.equal(mc, 0n);
	});
});
