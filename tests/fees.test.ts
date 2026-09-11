import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { splitFeeAmount, type FeeSplitArgs } from '../src/math/fees.js';

const STANDARD: FeeSplitArgs = {
	feeAmount: 1000n,
	protocolBps: 200,
	lpBps: 200,
	baseTotalBps: 1000,
	decayPremiumBps: 0,
};

describe('splitFeeAmount', () => {
	it('loses no dust', () => {
		const { protocol, lp, creator, sniper } = splitFeeAmount(STANDARD);

		assert.equal(protocol, 200n);
		assert.equal(lp, 200n);
		assert.equal(creator, 600n);
		assert.equal(sniper, 0n);
		assert.equal(protocol + lp + creator, 1000n);
	});

	it('gives protocol the rounding remainder', () => {
		const { protocol, lp, creator, sniper } = splitFeeAmount({
			...STANDARD,
			feeAmount: 1001n,
		});

		assert.equal(lp, 200n);
		assert.equal(creator, 600n);
		assert.equal(protocol, 201n);
		assert.equal(sniper, 0n);
		assert.equal(protocol + lp + creator, 1001n);
	});

	it('gives protocol the rounding remainder with a decay premium', () => {
		const { protocol, lp, creator, sniper } = splitFeeAmount({
			...STANDARD,
			feeAmount: 1001n,
			decayPremiumBps: 500,
		});

		assert.equal(lp, 133n);
		assert.equal(creator, 400n);
		assert.equal(protocol, 468n);
		assert.equal(sniper, 333n);
		assert.equal(protocol + lp + creator, 1001n);
	});

	it('conserves the total at a large fee amount', () => {
		const feeAmount = 1_000_000_000_000_000n;
		const { protocol, lp, creator } = splitFeeAmount({
			feeAmount,
			protocolBps: 100,
			lpBps: 100,
			baseTotalBps: 300,
			decayPremiumBps: 0,
		});

		assert.equal(protocol + lp + creator, feeAmount);
	});

	it('splits a zero fee into zeros', () => {
		assert.deepEqual(
			splitFeeAmount({
				feeAmount: 0n,
				protocolBps: 100,
				lpBps: 100,
				baseTotalBps: 300,
				decayPremiumBps: 0,
			}),
			{ protocol: 0n, lp: 0n, creator: 0n, sniper: 0n },
		);
	});

	it('throws when protocolBps + lpBps exceeds baseTotalBps', () => {
		assert.throws(
			() =>
				splitFeeAmount({
					...STANDARD,
					protocolBps: 600,
					lpBps: 500,
				}),
			RangeError,
		);
	});

	it('throws when the effective total bps is zero', () => {
		assert.throws(
			() =>
				splitFeeAmount({
					feeAmount: 1000n,
					protocolBps: 0,
					lpBps: 0,
					baseTotalBps: 0,
					decayPremiumBps: 0,
				}),
			RangeError,
		);
	});

	it('splits a zero fee into zeros even with zero total bps', () => {
		assert.deepEqual(
			splitFeeAmount({
				feeAmount: 0n,
				protocolBps: 0,
				lpBps: 0,
				baseTotalBps: 0,
				decayPremiumBps: 0,
			}),
			{ protocol: 0n, lp: 0n, creator: 0n, sniper: 0n },
		);
	});

	it('routes an all-premium fee entirely to protocol', () => {
		assert.deepEqual(
			splitFeeAmount({
				feeAmount: 1000n,
				protocolBps: 0,
				lpBps: 0,
				baseTotalBps: 0,
				decayPremiumBps: 500,
			}),
			{ protocol: 1000n, lp: 0n, creator: 0n, sniper: 1000n },
		);
	});
});
