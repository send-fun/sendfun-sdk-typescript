import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { effectiveFeeBps } from '../src/nexus/fee-helpers.js';
import type {
	DexFees,
	LaunchpadFees,
} from '../src/nexus/generated/types/index.js';

const LAUNCHPAD = {
	creationFeeCents: 0n,
	protocolFeeBps: 100,
	creatorFeeBps: 50,
	feeDecaySeconds: 12,
	feeDecayStartBps: 5_000,
} satisfies LaunchpadFees;

const DEX = {
	creationFeeCents: 0n,
	protocolFeeBps: 80,
	lpFeeBps: 30,
	creatorFeeBps: 40,
	feeDecaySeconds: 0,
	feeDecayStartBps: 0,
} satisfies DexFees;

describe('effectiveFeeBps', () => {
	it('charges the decay start rate at creation', () => {
		assert.equal(effectiveFeeBps(LAUNCHPAD, 100n, 100n), 5_000);
	});

	it('decays quadratically, rounding the premium up', () => {
		// 150 standard + ceil(6^2 * 4_850 / 12^2) = 150 + 1_213.
		assert.equal(effectiveFeeBps(LAUNCHPAD, 100n, 106n), 1_363);
	});

	it('falls to the standard rate when the window closes', () => {
		assert.equal(effectiveFeeBps(LAUNCHPAD, 100n, 112n), 150);
	});

	it('charges the full premium on a creation time in the future', () => {
		assert.equal(effectiveFeeBps(LAUNCHPAD, 200n, 100n), 5_000);
	});

	it('sums protocol, LP and creator on the DEX', () => {
		assert.equal(effectiveFeeBps(DEX, 100n, 100n), 150);
	});
});
