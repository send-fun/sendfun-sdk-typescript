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
	maxCreatorFeeBps: 50,
	feeDecaySeconds: 12,
	feeDecayStartBps: 5_000,
} satisfies LaunchpadFees;

const DEX = {
	creationFeeCents: 0n,
	protocolFeeBps: 80,
	lpFeeBps: 30,
	maxCreatorFeeBps: 40,
	feeDecaySeconds: 0,
	feeDecayStartBps: 0,
} satisfies DexFees;

const DEX_DECAY = {
	...DEX,
	feeDecaySeconds: 100,
	feeDecayStartBps: 1_000,
} satisfies DexFees;

describe('effectiveFeeBps', () => {
	it('charges the decay start rate at creation', () => {
		assert.equal(effectiveFeeBps(LAUNCHPAD, 100n, 100n, 50), 5_000);
	});

	it('decays quadratically, rounding the premium up', () => {
		// 150 standard + ceil(6^2 * 4_850 / 12^2) = 150 + 1_213.
		assert.equal(effectiveFeeBps(LAUNCHPAD, 100n, 106n, 50), 1_363);
	});

	it('falls to the standard rate when the window closes', () => {
		assert.equal(effectiveFeeBps(LAUNCHPAD, 100n, 112n, 50), 150);
	});

	it('charges the full premium on a creation time in the future', () => {
		assert.equal(effectiveFeeBps(LAUNCHPAD, 200n, 100n, 50), 5_000);
	});

	it('sums protocol, LP and creator on the DEX', () => {
		assert.equal(effectiveFeeBps(DEX, 100n, 100n, 40), 150);
	});

	describe('a market rate below the partner max', () => {
		it('measures the premium from the total with the market rate', () => {
			// 120 standard + 6^2 * 4_880 / 12^2 = 120 + 1_220, exact.
			assert.equal(effectiveFeeBps(LAUNCHPAD, 100n, 106n, 20), 1_340);
			// 120 standard + 50^2 * 880 / 100^2 = 120 + 220, exact.
			assert.equal(effectiveFeeBps(DEX_DECAY, 100n, 150n, 10), 340);
		});

		it('charges the market rate without a premium', () => {
			assert.equal(effectiveFeeBps(LAUNCHPAD, 100n, 112n, 20), 120);
			assert.equal(effectiveFeeBps(DEX, 100n, 100n, 10), 120);
		});
	});

	// A partner can lower its max after a market was created.
	describe('a market rate above the partner max', () => {
		it('measures the premium from the total with the market rate', () => {
			// 180 standard + 6^2 * 4_820 / 12^2 = 180 + 1_205, exact.
			assert.equal(effectiveFeeBps(LAUNCHPAD, 100n, 106n, 80), 1_385);
			// 175 standard + ceil(50^2 * 825 / 100^2) = 175 + 207.
			assert.equal(effectiveFeeBps(DEX_DECAY, 100n, 150n, 65), 382);
		});

		it('charges the market rate without a premium', () => {
			assert.equal(effectiveFeeBps(LAUNCHPAD, 100n, 112n, 80), 180);
			assert.equal(effectiveFeeBps(DEX, 100n, 100n, 65), 175);
		});
	});

	describe('a market rate of 0', () => {
		it('measures the premium from the protocol and LP rates', () => {
			// 100 standard + 6^2 * 4_900 / 12^2 = 100 + 1_225, exact.
			assert.equal(effectiveFeeBps(LAUNCHPAD, 100n, 106n, 0), 1_325);
			// 110 standard + ceil(50^2 * 890 / 100^2) = 110 + 223.
			assert.equal(effectiveFeeBps(DEX_DECAY, 100n, 150n, 0), 333);
		});

		it('charges the protocol and LP rates without a premium', () => {
			assert.equal(effectiveFeeBps(LAUNCHPAD, 100n, 112n, 0), 100);
			assert.equal(effectiveFeeBps(DEX, 100n, 100n, 0), 110);
		});
	});

	it('charges no premium when the standard rate is above the decay start', () => {
		assert.equal(effectiveFeeBps(LAUNCHPAD, 100n, 100n, 4_950), 5_050);
	});

	it('ignores the partner max', () => {
		for (const maxCreatorFeeBps of [0, 65_535]) {
			assert.equal(
				effectiveFeeBps(
					{ ...LAUNCHPAD, maxCreatorFeeBps },
					100n,
					106n,
					20,
				),
				1_340,
			);
			assert.equal(
				effectiveFeeBps(
					{ ...DEX_DECAY, maxCreatorFeeBps },
					100n,
					150n,
					10,
				),
				340,
			);
			assert.equal(
				effectiveFeeBps({ ...DEX, maxCreatorFeeBps }, 100n, 100n, 10),
				120,
			);
		}
	});
});
