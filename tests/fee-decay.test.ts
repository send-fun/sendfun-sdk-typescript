import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateFeeDecayPremium } from '../src/math/fee-decay.js';

describe('calculateFeeDecayPremium', () => {
	it('disabled: decaySeconds=0 returns 0', () => {
		assert.equal(
			calculateFeeDecayPremium({
				currentTimestamp: 100n,
				createdAtTimestamp: 50n,
				decaySeconds: 0,
				decayStartBps: 5000,
				standardFeeBps: 100,
			}),
			0n,
		);
	});

	it('at start: full premium', () => {
		const premium = calculateFeeDecayPremium({
			currentTimestamp: 100n,
			createdAtTimestamp: 100n,
			decaySeconds: 12,
			decayStartBps: 5000,
			standardFeeBps: 100,
		});
		assert.equal(premium, 4900n);
	});

	it('past window: no premium', () => {
		assert.equal(
			calculateFeeDecayPremium({
				currentTimestamp: 200n,
				createdAtTimestamp: 100n,
				decaySeconds: 12,
				decayStartBps: 5000,
				standardFeeBps: 100,
			}),
			0n,
		);
	});

	it('exactly at window end: no premium', () => {
		assert.equal(
			calculateFeeDecayPremium({
				currentTimestamp: 112n,
				createdAtTimestamp: 100n,
				decaySeconds: 12,
				decayStartBps: 5000,
				standardFeeBps: 100,
			}),
			0n,
		);
	});

	it('midpoint: 25% of range (quadratic)', () => {
		const premium = calculateFeeDecayPremium({
			currentTimestamp: 106n,
			createdAtTimestamp: 100n,
			decaySeconds: 12,
			decayStartBps: 5000,
			standardFeeBps: 100,
		});
		assert.equal(premium, 1225n);
	});

	it('one second remaining: ceiling of small value', () => {
		const premium = calculateFeeDecayPremium({
			currentTimestamp: 111n,
			createdAtTimestamp: 100n,
			decaySeconds: 12,
			decayStartBps: 5000,
			standardFeeBps: 100,
		});
		assert.equal(premium, 35n);
	});

	it('start_bps <= standard_fee_bps: returns 0', () => {
		assert.equal(
			calculateFeeDecayPremium({
				currentTimestamp: 100n,
				createdAtTimestamp: 100n,
				decaySeconds: 12,
				decayStartBps: 100,
				standardFeeBps: 100,
			}),
			0n,
		);
	});

	it('clock skew (created_at > current): full premium', () => {
		const premium = calculateFeeDecayPremium({
			currentTimestamp: 100n,
			createdAtTimestamp: 200n,
			decaySeconds: 12,
			decayStartBps: 5000,
			standardFeeBps: 100,
		});
		assert.equal(premium, 4900n);
	});
});
