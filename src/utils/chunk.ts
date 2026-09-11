import type { Address } from '@solana/kit';

/** RPCs reject a `getMultipleAccounts` call past this many addresses. */
const MAX_ACCOUNTS_PER_REQUEST = 100;

/** Splits a multi-account read into 100-address calls; results follow `addresses` order. */
export async function fetchInChunks<T>(
	addresses: readonly Address[],
	read: (chunk: Address[]) => Promise<readonly T[]>,
): Promise<T[]> {
	const chunks: Address[][] = [];
	for (
		let start = 0;
		start < addresses.length;
		start += MAX_ACCOUNTS_PER_REQUEST
	) {
		chunks.push(addresses.slice(start, start + MAX_ACCOUNTS_PER_REQUEST));
	}
	const results = await Promise.all(chunks.map((chunk) => read(chunk)));
	return results.flat();
}
