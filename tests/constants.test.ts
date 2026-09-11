import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { creatorHashFromId } from '../src/utils/creator-hash.js';

describe('creatorHashFromId', () => {
	it('deterministic: same inputs produce same output', async () => {
		const a = await creatorHashFromId('twitter', 'alice123');
		const b = await creatorHashFromId('twitter', 'alice123');
		assert.equal(a, b);
	});

	it('different inputs produce different outputs', async () => {
		const a = await creatorHashFromId('twitter', 'alice123');
		const b = await creatorHashFromId('twitter', 'bob456');
		assert.notEqual(a, b);
	});

	it('different platforms produce different outputs', async () => {
		const a = await creatorHashFromId('twitter', 'alice123');
		const b = await creatorHashFromId('discord', 'alice123');
		assert.notEqual(a, b);
	});

	it('throws for platform exceeding 32 bytes', async () => {
		const longPlatform = 'a'.repeat(33);
		await assert.rejects(
			creatorHashFromId(longPlatform, 'id'),
			/creatorPlatform exceeds 32 bytes/,
		);
	});

	it('accepts id exceeding 32 bytes (wallet addresses are 44 chars)', async () => {
		const longId = 'b'.repeat(44);
		const result = await creatorHashFromId('wallet', longId);
		assert.ok(typeof result === 'string');
		assert.ok(result.length > 0);
	});

	it('accepts max-length inputs', async () => {
		const result = await creatorHashFromId('a'.repeat(32), 'b'.repeat(32));
		assert.ok(typeof result === 'string');
		assert.ok(result.length > 0);
	});

	it('produces a known hash', async () => {
		const hash = await creatorHashFromId('twitter', 'alice123');
		assert.equal(hash, 'oiZL4KcM2jYpYBHDtTUm9QbGUeWvEfPQN35ufpDzxTL');
	});
});
