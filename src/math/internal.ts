export function floorDiv(a: bigint, b: bigint): bigint {
	return a / b;
}

// Assumes non-negative inputs.
export function ceilDiv(a: bigint, b: bigint): bigint {
	return a / b + (a % b > 0n ? 1n : 0n);
}

export function assertBps(fn: string, name: string, bps: number): void {
	if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
		throw new RangeError(
			`${fn}: ${name} must be an integer between 0 and 10_000`,
		);
	}
}
