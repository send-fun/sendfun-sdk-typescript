import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { address, getAddressDecoder, type Address } from '@solana/kit';
import { buildSettleInstructions } from '../src/nexus/staking.js';
import {
	getRewardStateEncoder,
	getRewardStateSize,
	REWARD_STATE_DISCRIMINATOR,
} from '../src/nexus/generated/accounts/rewardState.js';
import { findRewardAccrualPda as findLaunchpadRewardAccrualPda } from '../src/launchpad/generated/pdas/rewardAccrual.js';
import { findRewardAccrualPda as findDexRewardAccrualPda } from '../src/dex/generated/pdas/rewardAccrual.js';
import { SEND_NEXUS_PROGRAM_ADDRESS } from '../src/constants.js';

// Must equal the private 1e12 scale in `nexus/staking.ts`.
const PRECISION = 1_000_000_000_000n;

// Mirrors the program's `settle_debt` and the quote in `fetchPendingRewards`.
function settlePending(
	amount: bigint,
	amountSnapshot: bigint,
	launchpadAcc: bigint,
	dexAcc: bigint,
	accSnapshot: bigint,
	owed: bigint,
): bigint {
	const basis = amountSnapshot < amount ? amountSnapshot : amount;
	const combined = launchpadAcc + dexAcc;
	const delta = combined > accSnapshot ? combined - accSnapshot : 0n;
	return owed + (basis * delta) / PRECISION;
}

const MOCK_USER = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const MOCK_STAKING_MINT = address(
	'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
);
const WSOL: Address = address('So11111111111111111111111111111111111111112');

const MOCK_PAYER = {
	address: address('5Zzguz4NsSRFxGkHfM4FmsFpGZiCDtY72zH2jzMcqkJx'),
	signTransactions: () => Promise.reject(new Error('not used')),
};

const USDC: Address = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const MOCK_STAKING_CONFIG: Address = address(
	'9WUowYRb6KAWjWVB5KMmTngBidZXEXgQcQRTXbhxeGbF',
);
const MOCK_VAULT: Address = address(
	'GKbbW7tyJardxPnbrc2NbTcJgQPzxCHLkEP4WzDA7aUt',
);

// If these drift nothing fails on chain; the sweep silently returns the wrong mints.
// Pinned against a real encode, not the constants in the module under test.
describe('RewardState wire layout the reward sweep filters on', () => {
	const image = new Uint8Array(
		getRewardStateEncoder().encode({
			version: 1,
			bump: 255,
			stakingConfig: MOCK_STAKING_CONFIG,
			rewardMint: USDC,
			vault: MOCK_VAULT,
			totalClaimed: 0n,
			usdcPrice: 1_000_000_000_000n,
			usdcPriceUpdatedAt: 0n,
			isStablecoin: 1,
			disabled: 0,
			reserved: new Uint8Array(64),
		}),
	);
	const addressDecoder = getAddressDecoder();

	it('is 196 bytes, the dataSize filter', () => {
		assert.equal(getRewardStateSize(), 196);
		assert.equal(image.length, 196);
	});

	it('opens with the discriminator', () => {
		assert.deepEqual(
			image.slice(0, 8),
			new Uint8Array(REWARD_STATE_DISCRIMINATOR),
		);
	});

	it('puts staking_config at byte 10, the memcmp offset', () => {
		assert.equal(addressDecoder.decode(image, 10), MOCK_STAKING_CONFIG);
	});

	it('puts reward_mint at byte 42', () => {
		assert.equal(addressDecoder.decode(image, 42), USDC);
	});

	// No filter may touch `disabled`: `reward_count` still counts disabled mints, so the sweep must return them.
	it('carries the disabled flag at byte 131, outside every filter', () => {
		assert.equal(image[131], 0);
	});
});

// WSOL first: the accrual-order test reads the first instruction as WSOL's.
const REGISTERED_MINTS: readonly Address[] = [WSOL, USDC];

describe('buildSettleInstructions', () => {
	it('emits exactly one instruction per registered mint', async () => {
		const ixs = await buildSettleInstructions(REGISTERED_MINTS, {
			user: MOCK_USER,
			payer: MOCK_PAYER,
			stakingMint: MOCK_STAKING_MINT,
		});
		assert.equal(ixs.length, REGISTERED_MINTS.length);
		for (const ix of ixs) {
			assert.equal(ix.programAddress, SEND_NEXUS_PROGRAM_ADDRESS);
		}
	});

	it('uses a fixed 9 accounts per instruction at any mint count', async () => {
		const ixs = await buildSettleInstructions(REGISTERED_MINTS, {
			user: MOCK_USER,
			payer: MOCK_PAYER,
			stakingMint: MOCK_STAKING_MINT,
		});
		for (const ix of ixs) {
			assert.equal(ix.accounts?.length, 9);
		}
	});

	// Nexus reads slot 6 as the launchpad accrual and slot 7 as the dex one; a swap only fails on chain.
	it('puts the launchpad accrual before the dex accrual', async () => {
		const [ix] = await buildSettleInstructions(REGISTERED_MINTS, {
			user: MOCK_USER,
			payer: MOCK_PAYER,
			stakingMint: MOCK_STAKING_MINT,
		});
		const [launchpadAccrual] = await findLaunchpadRewardAccrualPda({
			quoteMint: WSOL,
		});
		const [dexAccrual] = await findDexRewardAccrualPda({ quoteMint: WSOL });
		const accounts = ix.accounts ?? [];
		assert.notEqual(launchpadAccrual, dexAccrual);
		assert.equal(accounts[6].address, launchpadAccrual);
		assert.equal(accounts[7].address, dexAccrual);
	});

	it('never asks the user to sign', async () => {
		const [ix] = await buildSettleInstructions(REGISTERED_MINTS, {
			user: MOCK_USER,
			payer: MOCK_PAYER,
			stakingMint: MOCK_STAKING_MINT,
		});
		const userAccount = (ix.accounts ?? []).find(
			(account) => account.address === MOCK_USER,
		);
		assert.ok(userAccount);
		assert.ok(!('signer' in userAccount));
	});
});

describe('settle formula', () => {
	it('sums the two accumulators before dividing', () => {
		const amount = 100_000_000_000n; // 100k tokens (6 decimals)

		// (100e9 * (500e9 + 200e9 - 0)) / 1e12 = 70e9, plus 5e9 already banked.
		assert.equal(
			settlePending(
				amount,
				amount,
				500_000_000_000n,
				200_000_000_000n,
				0n,
				5_000_000_000n,
			),
			75_000_000_000n,
		);
	});

	it('either program alone moves the payout', () => {
		const amount = 100_000_000_000n;

		assert.equal(
			settlePending(amount, amount, 500_000_000_000n, 0n, 0n, 0n),
			50_000_000_000n,
		);
		assert.equal(
			settlePending(amount, amount, 0n, 200_000_000_000n, 0n, 0n),
			20_000_000_000n,
		);
	});

	it('floors once over the sum, not once per program', () => {
		const amount = 3n;
		const accPerProgram = 500_000_000_000n;

		assert.equal(
			settlePending(amount, amount, accPerProgram, accPerProgram, 0n, 0n),
			3n,
		);

		const flooredPerProgram =
			(amount * accPerProgram) / PRECISION +
			(amount * accPerProgram) / PRECISION;
		assert.equal(flooredPerProgram, 2n);
	});

	it('zero pending when no stake', () => {
		assert.equal(settlePending(0n, 0n, 1_000_000_000_000n, 0n, 0n, 0n), 0n);
		assert.equal(settlePending(0n, 0n, 0n, 5_000_000_000_000n, 0n, 0n), 0n);
	});

	it('credits only the accumulator delta since the last settle', () => {
		const amount = 1_000_000_000_000n;
		assert.equal(
			settlePending(
				amount,
				amount,
				600_000_000_000n,
				400_000_000_000n,
				1_000_000_000_000n,
				0n,
			),
			0n,
		);
	});

	// Without the `min`, a partial unstake keeps accruing at the old amount and drains the vault.
	it('values an un-settled window at the smaller of the two amounts', () => {
		const accrual = 1_000_000_000_000n; // one unit per staked token

		// Snapshot 1_000_000, now holding 1: paid on 1.
		assert.equal(settlePending(1n, 1_000_000n, accrual, 0n, 0n, 0n), 1n);
		// Snapshot 1, now holding 1_000_000: still paid on 1, no retroactive credit.
		assert.equal(settlePending(1_000_000n, 1n, accrual, 0n, 0n, 0n), 1n);
	});

	it('keeps banked rewards after a full unstake', () => {
		assert.equal(
			settlePending(0n, 0n, 900_000_000_000n, 0n, 0n, 42_000_000_000n),
			42_000_000_000n,
		);
	});
});
