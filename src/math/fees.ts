export interface FeeSplitArgs {
	feeAmount: bigint;
	protocolBps: number;
	lpBps: number;
	baseTotalBps: number;
	decayPremiumBps: number;
}

export interface FeeSplit {
	protocol: bigint;
	lp: bigint;
	creator: bigint;
	/** Decay share already included in `protocol`, not a separate payout. */
	sniper: bigint;
}

/** LP/creator round down; protocol absorbs the decay premium and all remainders. */
export function splitFeeAmount(args: FeeSplitArgs): FeeSplit {
	const { feeAmount } = args;
	const protocolBps = toBps(args.protocolBps, 'protocolBps');
	const lpBps = toBps(args.lpBps, 'lpBps');
	const baseTotalBps = toBps(args.baseTotalBps, 'baseTotalBps');
	const decayPremiumBps = toBps(args.decayPremiumBps, 'decayPremiumBps');

	if (feeAmount < 0n) {
		throw new RangeError('splitFeeAmount: feeAmount must be non-negative');
	}
	if (feeAmount === 0n) {
		return { protocol: 0n, lp: 0n, creator: 0n, sniper: 0n };
	}

	const effectiveTotalBps = baseTotalBps + decayPremiumBps;
	if (effectiveTotalBps === 0n) {
		throw new RangeError('splitFeeAmount: effective total bps is zero');
	}

	if (baseTotalBps === 0n) {
		return {
			protocol: feeAmount,
			lp: 0n,
			creator: 0n,
			sniper: feeAmount,
		};
	}

	const lpFee = (feeAmount * lpBps) / effectiveTotalBps;

	const creatorBps = baseTotalBps - protocolBps - lpBps;
	if (creatorBps < 0n) {
		throw new RangeError(
			'splitFeeAmount: protocolBps + lpBps exceeds baseTotalBps',
		);
	}
	const creatorFee = (feeAmount * creatorBps) / effectiveTotalBps;

	const sniperFee = (feeAmount * decayPremiumBps) / effectiveTotalBps;

	const protocolFee = feeAmount - lpFee - creatorFee;

	return {
		protocol: protocolFee,
		lp: lpFee,
		creator: creatorFee,
		sniper: sniperFee,
	};
}

function toBps(value: number, name: string): bigint {
	if (!Number.isInteger(value) || value < 0) {
		throw new RangeError(
			`splitFeeAmount: ${name} must be a non-negative integer`,
		);
	}
	return BigInt(value);
}
