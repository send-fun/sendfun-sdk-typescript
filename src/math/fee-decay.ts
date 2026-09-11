import { ceilDiv } from './internal.js';

/** Premium in bps, rounded up. */
export function calculateFeeDecayPremium(params: {
	currentTimestamp: bigint;
	createdAtTimestamp: bigint;
	decaySeconds: number;
	decayStartBps: number;
	standardFeeBps: number;
}): bigint {
	const {
		currentTimestamp,
		createdAtTimestamp,
		decaySeconds,
		decayStartBps,
		standardFeeBps,
	} = params;
	if (decaySeconds === 0) {
		return 0n;
	}

	const startBps = BigInt(decayStartBps);
	const standardBps = BigInt(standardFeeBps);
	const decaySecondsBig = BigInt(decaySeconds);

	// Future creation timestamps pay the full premium, not a discount.
	if (createdAtTimestamp > currentTimestamp) {
		if (startBps <= standardBps) return 0n;
		return startBps - standardBps;
	}

	const elapsed = currentTimestamp - createdAtTimestamp;

	if (elapsed >= decaySecondsBig) {
		return 0n;
	}

	if (startBps <= standardBps) {
		return 0n;
	}

	const range = startBps - standardBps;
	const remaining = decaySecondsBig - elapsed;

	const numerator = remaining * remaining * range;
	const denominator = decaySecondsBig * decaySecondsBig;

	return ceilDiv(numerator, denominator);
}
