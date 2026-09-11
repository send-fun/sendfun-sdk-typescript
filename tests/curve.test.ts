import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateBondingCurveProgress } from '../src/launchpad/trade.js';
import { calculateMarketCap, calculatePrice } from '../src/math/amm.js';

const INITIAL_REAL_BASE_RESERVES = 793_100_000_000_000n;
const INITIAL_VIRTUAL_QUOTE = 30_000_000_000n;
const INITIAL_VIRTUAL_BASE = 1_000_000_000_000_000n;

describe('calculateBondingCurveProgress', () => {
	it('0% at start', () => {
		assert.equal(
			calculateBondingCurveProgress({
				realBaseReserves: INITIAL_REAL_BASE_RESERVES,
				initialRealBase: INITIAL_REAL_BASE_RESERVES,
			}),
			0,
		);
	});

	it('100% when all sold', () => {
		assert.equal(
			calculateBondingCurveProgress({
				realBaseReserves: 0n,
				initialRealBase: INITIAL_REAL_BASE_RESERVES,
			}),
			100,
		);
	});

	it('50% when half sold', () => {
		const half = INITIAL_REAL_BASE_RESERVES / 2n;
		assert.equal(
			calculateBondingCurveProgress({
				realBaseReserves: half,
				initialRealBase: INITIAL_REAL_BASE_RESERVES,
			}),
			50,
		);
	});

	it('100 when initialRealBase is 0', () => {
		assert.equal(
			calculateBondingCurveProgress({
				realBaseReserves: 0n,
				initialRealBase: 0n,
			}),
			100,
		);
	});
});

describe('calculatePrice', () => {
	it('returns correct price with known reserves', () => {
		const p = calculatePrice({
			quoteReserves: INITIAL_VIRTUAL_QUOTE,
			baseReserves: INITIAL_VIRTUAL_BASE,
			quoteDecimals: 9,
			baseDecimals: 6,
		});
		assert.ok(Math.abs(p - 3e-8) < 1e-20);
	});
});

describe('calculateMarketCap', () => {
	it('returns correct marketCap', () => {
		const supply = 1_000_000_000_000_000n;
		assert.equal(
			calculateMarketCap({
				quoteReserves: INITIAL_VIRTUAL_QUOTE,
				baseReserves: INITIAL_VIRTUAL_BASE,
				baseSupply: supply,
			}),
			30_000_000_000n,
		);
	});

	it('returns 0 when baseReserves is 0', () => {
		assert.equal(
			calculateMarketCap({
				quoteReserves: INITIAL_VIRTUAL_QUOTE,
				baseReserves: 0n,
				baseSupply: 1_000_000_000n,
			}),
			0n,
		);
	});
});
