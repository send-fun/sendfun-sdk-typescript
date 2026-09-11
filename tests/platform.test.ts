import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findPlatformAddress } from '../src/platform.js';

test('the documented sendfun platform key matches its derivation', async () => {
	const [derived, bump] = await findPlatformAddress('sendfun');
	assert.equal(derived, '2PJedAsa7pCnScks2XM3U4o2nPaTvvBmi2553VcCnGWB');
	assert.equal(bump, 255);
});

// No registry allocates platforms; distinct slugs are all that keep two apart.
test('distinct slugs derive distinct platform keys', async () => {
	const [sendfun] = await findPlatformAddress('sendfun');
	const [acme] = await findPlatformAddress('acme');
	assert.notEqual(sendfun, acme);

	const [again] = await findPlatformAddress('sendfun');
	assert.equal(again, sendfun);
});
