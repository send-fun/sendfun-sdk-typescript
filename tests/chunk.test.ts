import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getAddressDecoder, type Address } from '@solana/kit';
import { fetchInChunks } from '../src/utils/chunk.js';

const addressDecoder = getAddressDecoder();

function addresses(count: number): Address[] {
	return Array.from({ length: count }, (_, index) =>
		addressDecoder.decode(new Uint8Array(32).fill(index + 1)),
	);
}

describe('fetchInChunks', () => {
	it('reads past 100 addresses in 100-address calls, in order', async () => {
		const wanted = addresses(250);
		const calls: number[] = [];

		const read = await fetchInChunks(wanted, (chunk) => {
			calls.push(chunk.length);
			return Promise.resolve(chunk);
		});

		assert.deepEqual(calls, [100, 100, 50]);
		assert.deepEqual(read, wanted);
	});

	it('makes no call for an empty list', async () => {
		const calls: number[] = [];

		const read = await fetchInChunks([], (chunk) => {
			calls.push(chunk.length);
			return Promise.resolve(chunk);
		});

		assert.deepEqual(calls, []);
		assert.deepEqual(read, []);
	});
});
