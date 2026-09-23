import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	address,
	createSolanaRpcFromTransport,
	getAddressDecoder,
	lamports,
	type Address,
	type EncodedAccount,
	type MaybeEncodedAccount,
} from '@solana/kit';
import {
	buildSettleInstructions,
	fetchMissingUserRewardDebts,
	fetchPendingRewards,
} from '../src/nexus/staking.js';
import { accountIsCreated } from '../src/nexus/generated/shared/index.js';
import {
	getRewardStateEncoder,
	getRewardStateSize,
	REWARD_STATE_DISCRIMINATOR,
} from '../src/nexus/generated/accounts/rewardState.js';
import { findRewardAccrualPda as findLaunchpadRewardAccrualPda } from '../src/launchpad/generated/pdas/rewardAccrual.js';
import { findRewardAccrualPda as findDexRewardAccrualPda } from '../src/dex/generated/pdas/rewardAccrual.js';
import {
	decodeUserStakePosition,
	fetchMaybeUserStakePosition,
	getUserStakePositionEncoder,
} from '../src/nexus/generated/accounts/userStakePosition.js';
import { SEND_NEXUS_PROGRAM_ADDRESS } from '../src/constants.js';

// Must equal the private 1e12 scale in `nexus/staking.ts`.
const PRECISION = 1_000_000_000_000n;

// Matches the `settle` instruction and the quote in `fetchPendingRewards`.
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

// Pins the offsets the reward sweep filters on, against a real encode, not the
// constants in the module under test.
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

	// No filter may read `disabled`. `reward_count` counts disabled mints, so the sweep must return them.
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

	// Nexus reads slot 6 as the launchpad accrual and slot 7 as the dex accrual.
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

	it('values an un-settled window at the smaller of the two amounts', () => {
		const accrual = 1_000_000_000_000n; // one reward unit per staked unit

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

function isRpcCall(
	payload: unknown,
): payload is { method: string; params: unknown[] } {
	return (
		typeof payload === 'object' &&
		payload !== null &&
		'method' in payload &&
		typeof payload.method === 'string' &&
		'params' in payload &&
		Array.isArray(payload.params)
	);
}

// A getAccountInfo / getMultipleAccounts account value, as the RPC sends it.
function accountValue(owner: Address, data: Uint8Array) {
	return {
		data: [Buffer.from(data).toString('base64'), 'base64'],
		executable: false,
		lamports: 890_880n,
		owner,
		rentEpoch: 0n,
		space: BigInt(data.length),
	};
}

// A dusted, uncreated PDA is system-owned with no data. Fetch helpers must read
// it as missing and not throw.
describe('an uncreated PDA someone sent lamports to', () => {
	const SYSTEM_PROGRAM: Address = address('11111111111111111111111111111111');
	const POSITION: Address = address(
		'3pX7QSTRnSFGAbq7rNkV7K4ydrbx9Gw1cTTqoNaaMDwT',
	);

	// `satisfies`, not a return type: kit 8's read-only `EncodedAccount.data`
	// fails `MaybeEncodedAccount`.
	function lamportsOnly(programAddress: Address) {
		return {
			address: POSITION,
			data: new Uint8Array(0),
			executable: false,
			lamports: lamports(890_880n),
			programAddress,
			space: 0n,
		} satisfies EncodedAccount;
	}

	// Answers every address with one dusted account, through kit's own transport.
	// With `position`, `getAccountInfo` returns a nexus-owned account with that data.
	function rpcReturning(
		owner: Address,
		data: Uint8Array,
		position?: Uint8Array,
	) {
		const value = accountValue(owner, data);
		const singleValue =
			position === undefined
				? value
				: accountValue(SEND_NEXUS_PROGRAM_ADDRESS, position);
		const transport = <TResponse>(
			config: Readonly<{ payload: unknown }>,
		): Promise<TResponse> => {
			assert.ok(isRpcCall(config.payload));
			const { method, params } = config.payload;
			const context = { slot: 0n };
			let result;
			if (method === 'getMultipleAccounts') {
				const [addresses] = params;
				assert.ok(Array.isArray(addresses));
				result = { context, value: addresses.map(() => value) };
			} else {
				assert.equal(method, 'getAccountInfo');
				result = { context, value: singleValue };
			}
			const response = { id: 1, jsonrpc: '2.0', result };
			// RpcTransport is generic over the caller's response type, so a stub
			// asserts once; the api validates it.
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
			return Promise.resolve(response as TResponse);
		};
		return createSolanaRpcFromTransport(transport);
	}

	it('fetches as missing rather than throwing', async () => {
		const rpc = rpcReturning(SYSTEM_PROGRAM, new Uint8Array(0));
		const maybe = await fetchMaybeUserStakePosition(rpc, POSITION);
		assert.deepEqual(maybe, { address: POSITION, exists: false });
	});

	it('leaves a real foreign owner throwing from the fetch helper', async () => {
		const rpc = rpcReturning(WSOL, new Uint8Array(0));
		await assert.rejects(fetchMaybeUserStakePosition(rpc, POSITION), {
			name: 'AccountOwnerMismatchError',
		});
	});

	// A caller narrowing to `exists: true` must not get an uncreated PDA as an
	// Account.
	it('still throws from decode when passed as an existing account', () => {
		const maybe = {
			...lamportsOnly(SYSTEM_PROGRAM),
			exists: true,
		} satisfies MaybeEncodedAccount;
		assert.throws(() => decodeUserStakePosition(maybe), {
			name: 'AccountOwnerMismatchError',
			message: `decodeUserStakePosition: account ${POSITION} is owned by ${SYSTEM_PROGRAM}, expected ${SEND_NEXUS_PROGRAM_ADDRESS}`,
		});
		assert.throws(
			() => decodeUserStakePosition(lamportsOnly(SYSTEM_PROGRAM)),
			{
				name: 'AccountOwnerMismatchError',
			},
		);
	});

	it('still rejects an empty account another program owns', () => {
		const maybe = {
			...lamportsOnly(WSOL),
			exists: true,
		} satisfies MaybeEncodedAccount;
		assert.throws(() => decodeUserStakePosition(maybe), {
			name: 'AccountOwnerMismatchError',
			message: `decodeUserStakePosition: account ${POSITION} is owned by ${WSOL}, expected ${SEND_NEXUS_PROGRAM_ADDRESS}`,
		});
	});

	// The staking helpers read raw encoded accounts. A dusted UserRewardDebt
	// still needs `create_user_reward_debt` before a claim.
	it('still counts a dusted UserRewardDebt as missing', async () => {
		const rpc = rpcReturning(SYSTEM_PROGRAM, new Uint8Array(0));
		const missing = await fetchMissingUserRewardDebts(
			rpc,
			MOCK_USER,
			MOCK_STAKING_MINT,
			REGISTERED_MINTS,
		);
		assert.deepEqual(missing, [WSOL, USDC]);
	});

	// A real position skips fetchPendingRewards' early return, so the dusted
	// debt and accruals reach its raw decode paths.
	it('quotes a dusted UserRewardDebt as zero owed instead of throwing', async () => {
		const position = new Uint8Array(
			getUserStakePositionEncoder().encode({
				version: 1,
				bump: 255,
				user: MOCK_USER,
				stakingMint: MOCK_STAKING_MINT,
				amount: 1_000n,
				stakeVersion: 0,
				settledCount: 0,
				reserved: new Uint8Array(32),
			}),
		);
		const rpc = rpcReturning(SYSTEM_PROGRAM, new Uint8Array(0), position);
		const pending = await fetchPendingRewards(
			rpc,
			MOCK_USER,
			MOCK_STAKING_MINT,
			REGISTERED_MINTS,
		);
		assert.deepEqual(pending, [
			{ rewardMint: WSOL, pending: 0n },
			{ rewardMint: USDC, pending: 0n },
		]);
	});
});

describe('accountIsCreated', () => {
	const SYSTEM_PROGRAM: Address = address('11111111111111111111111111111111');
	const POSITION: Address = address(
		'3pX7QSTRnSFGAbq7rNkV7K4ydrbx9Gw1cTTqoNaaMDwT',
	);

	function encoded(programAddress: Address, data: Uint8Array) {
		return {
			address: POSITION,
			data,
			executable: false,
			exists: true,
			lamports: lamports(890_880n),
			programAddress,
			space: BigInt(data.length),
		} satisfies MaybeEncodedAccount;
	}

	it('is false for a missing account and for a lamports-only address', () => {
		assert.equal(
			accountIsCreated({ address: POSITION, exists: false }),
			false,
		);
		assert.equal(
			accountIsCreated(encoded(SYSTEM_PROGRAM, new Uint8Array(0))),
			false,
		);
	});

	it('is true for a created account, even a system-owned one with data', () => {
		assert.equal(
			accountIsCreated(
				encoded(SEND_NEXUS_PROGRAM_ADDRESS, new Uint8Array(8)),
			),
			true,
		);
		assert.equal(
			accountIsCreated(encoded(SYSTEM_PROGRAM, new Uint8Array(8))),
			true,
		);
	});
});
