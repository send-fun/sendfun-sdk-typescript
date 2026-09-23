import {
	containsBytes,
	fetchEncodedAccounts,
	getAddressDecoder,
	getBase64Encoder,
	type Address,
	type Instruction,
	type Rpc,
	type GetAccountInfoApi,
	type GetMultipleAccountsApi,
	type GetProgramAccountsApi,
	type TransactionSigner,
} from '@solana/kit';
import {
	SEND_NEXUS_PROGRAM_ADDRESS,
	SYSTEM_PROGRAM_ADDRESS,
} from '../constants.js';
import { fetchInChunks } from '../utils/chunk.js';
import { findAssociatedTokenPda } from '../utils/pda.js';
import { accountIsCreated } from './generated/shared/index.js';
import { fetchStakingConfig } from './generated/accounts/stakingConfig.js';
import {
	fetchMaybeUserStakePosition,
	type UserStakePosition,
} from './generated/accounts/userStakePosition.js';
import { getUserRewardDebtDecoder } from './generated/accounts/userRewardDebt.js';
import {
	getRewardStateDecoder,
	getRewardStateSize,
	REWARD_STATE_DISCRIMINATOR,
} from './generated/accounts/rewardState.js';
import type { StakingConfig } from './generated/accounts/stakingConfig.js';
import { getStakeInstructionAsync } from './generated/instructions/stake.js';
import { getUnstakeInstructionAsync } from './generated/instructions/unstake.js';
import { getClaimInstructionAsync } from './generated/instructions/claim.js';
import { getSettleInstructionAsync } from './generated/instructions/settle.js';
import { getCreateUserRewardDebtInstructionAsync } from './generated/instructions/createUserRewardDebt.js';
import { findRewardStatePda } from './generated/pdas/rewardState.js';
import { findStakingConfigPda } from './generated/pdas/stakingConfig.js';
import { findUserRewardDebtPda } from './generated/pdas/userRewardDebt.js';
import { findUserStakePositionPda } from './generated/pdas/userStakePosition.js';
import { findRewardAccrualPda as findLaunchpadRewardAccrualPda } from '../launchpad/generated/pdas/rewardAccrual.js';
import { getRewardAccrualDecoder } from '../launchpad/generated/accounts/rewardAccrual.js';
import { findRewardAccrualPda as findDexRewardAccrualPda } from '../dex/generated/pdas/rewardAccrual.js';

// Fixed-point scale of `RewardAccrual.accPerToken` in both programs.
const PRECISION = 1_000_000_000_000n;

/** An RPC with `getAccountInfo` and, optionally, `getProgramAccounts`. Without `getProgramAccounts`, pass `rewardMints`. */
export type RewardMintRpc = Rpc<GetAccountInfoApi> &
	Partial<Rpc<GetProgramAccountsApi>>;

function hasProgramAccounts(
	rpc: RewardMintRpc,
): rpc is Rpc<GetAccountInfoApi> & Rpc<GetProgramAccountsApi> {
	return typeof rpc.getProgramAccounts === 'function';
}

// Field offsets, including the 8-byte discriminator. tests/staking.test.ts pins them.
const REWARD_STATE_STAKING_CONFIG_OFFSET = 10n;
const REWARD_STATE_REWARD_MINT_OFFSET = 42;

function compareAddresses(a: Address, b: Address): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

/** Returns every registered reward mint, disabled mints included, sorted by address.
 *  Throws if the count differs from `StakingConfig.rewardCount`. */
export async function getRewardMints(
	rpc: Rpc<GetAccountInfoApi> & Rpc<GetProgramAccountsApi>,
): Promise<readonly Address[]> {
	const [stakingConfig] = findStakingConfigPda();

	const [accounts, config] = await Promise.all([
		rpc
			.getProgramAccounts(SEND_NEXUS_PROGRAM_ADDRESS, {
				encoding: 'base64',
				filters: [
					{ dataSize: BigInt(getRewardStateSize()) },
					{
						memcmp: {
							bytes: stakingConfig,
							encoding: 'base58',
							offset: REWARD_STATE_STAKING_CONFIG_OFFSET,
						},
					},
				],
			})
			.send(),
		fetchStakingConfigData(rpc),
	]);

	const base64 = getBase64Encoder();
	const addressDecoder = getAddressDecoder();

	const mints: Address[] = [];
	for (const { account } of accounts) {
		const data = base64.encode(account.data[0]);
		// Another nexus account of the same size can pass both filters.
		if (!containsBytes(data, REWARD_STATE_DISCRIMINATOR, 0)) continue;
		mints.push(
			addressDecoder.decode(data, REWARD_STATE_REWARD_MINT_OFFSET),
		);
	}

	if (mints.length !== config.rewardCount) {
		throw new Error(
			`getProgramAccounts returned ${mints.length} RewardState accounts but StakingConfig.rewardCount is ${config.rewardCount}. Settling a short list forfeits rewards, so this refuses to guess -- retry, or pass rewardMints explicitly if the RPC restricts getProgramAccounts.`,
		);
	}

	return mints.toSorted(compareAddresses);
}

export type RewardMintSource = readonly Address[] | RewardMintRpc;

function isRewardMintList(
	source: RewardMintSource,
): source is readonly Address[] {
	return Array.isArray(source);
}

async function resolveRewardMints(
	rpc: RewardMintRpc,
	rewardMints: readonly Address[] | undefined,
): Promise<readonly Address[]> {
	if (rewardMints !== undefined) return rewardMints;
	if (!hasProgramAccounts(rpc)) {
		throw new Error(
			'This RPC has no getProgramAccounts, so the reward registry cannot be read from chain. Pass rewardMints explicitly.',
		);
	}
	return await getRewardMints(rpc);
}

export interface SettleParams {
	/** Does not sign. `settle` is permissionless. */
	user: Address;
	payer: TransactionSigner;
	stakingMint: Address;
}

/** Builds one `settle` per reward mint. `source` is the mint list, or an RPC to read it from.
 *  `settle` is idempotent. With a partial list, `stake` and `unstake` fail with `RewardsNotSettled`. */
export async function buildSettleInstructions(
	source: RewardMintSource,
	params: SettleParams,
): Promise<Instruction[]> {
	const rewardMints = isRewardMintList(source)
		? source
		: await resolveRewardMints(source, undefined);
	return Promise.all(
		rewardMints.map((rewardMint) =>
			getSettleInstructionAsync({
				user: params.user,
				payer: params.payer,
				stakingMint: params.stakingMint,
				rewardMint,
			}),
		),
	);
}

export async function fetchMissingUserRewardDebts(
	rpc: RewardMintRpc & Rpc<GetMultipleAccountsApi>,
	user: Address,
	stakingMint: Address,
	knownRewardMints?: readonly Address[],
): Promise<Address[]> {
	const rewardMints = await resolveRewardMints(rpc, knownRewardMints);

	const debtPdas = await Promise.all(
		rewardMints.map(async (mint) => {
			const [addr] = await findUserRewardDebtPda({
				user,
				stakingMint,
				rewardMint: mint,
			});
			return addr;
		}),
	);

	const encodedAccounts = await fetchInChunks(debtPdas, (chunk) =>
		fetchEncodedAccounts(rpc, chunk),
	);

	const missingMints: Address[] = [];
	for (const [index, rewardMint] of rewardMints.entries()) {
		if (!accountIsCreated(encodedAccounts[index])) {
			missingMints.push(rewardMint);
		}
	}

	return missingMints;
}

export interface PrepareStakingParams {
	user: Address;
	payer: TransactionSigner;
	stakingMint: Address;
	/** If given, must hold every registered mint. With a subset, `stake` and `unstake` fail. */
	rewardMints?: readonly Address[];
}

/** Builds a `create_user_reward_debt` for each missing `UserRewardDebt`, then a `settle` for every
 *  reward mint. The user does not sign these instructions. */
export async function buildStakingPreflightInstructions(
	rpc: RewardMintRpc & Rpc<GetMultipleAccountsApi>,
	params: PrepareStakingParams,
): Promise<Instruction[]> {
	// Read the mints once. Two reads can return different lists.
	const rewardMints = await resolveRewardMints(rpc, params.rewardMints);

	const missingMints = await fetchMissingUserRewardDebts(
		rpc,
		params.user,
		params.stakingMint,
		rewardMints,
	);

	const createIxs = await Promise.all(
		missingMints.map((rewardMint) =>
			getCreateUserRewardDebtInstructionAsync({
				user: params.user,
				payer: params.payer,
				stakingMint: params.stakingMint,
				rewardMint,
			}),
		),
	);

	const settleIxs = await buildSettleInstructions(rewardMints, params);

	return [...createIxs, ...settleIxs];
}

/** Returns true if `stake` and `unstake` pass the `settledCount == rewardCount` check. */
export async function isFullySettled(
	rpc: Rpc<GetAccountInfoApi>,
	user: Address,
	stakingMint: Address,
): Promise<boolean> {
	const [config, position] = await Promise.all([
		fetchStakingConfigData(rpc),
		fetchUserStakePositionData(rpc, user, stakingMint),
	]);
	if (position === null) return config.rewardCount === 0;
	return position.settledCount === config.rewardCount;
}

export interface StakeParams {
	user: TransactionSigner;
	payer?: TransactionSigner;
	stakingMint: Address;
	amount: bigint;
}

/** The instruction fails with `RewardsNotSettled` until every mint is settled at the current
 *  `stakeVersion`. Run `buildStakingPreflightInstructions` first. */
export async function buildStakeInstruction(
	params: StakeParams,
): Promise<Instruction> {
	return getStakeInstructionAsync({
		user: params.user,
		payer: params.payer ?? params.user,
		stakingMint: params.stakingMint,
		amount: params.amount,
	});
}

export interface UnstakeParams {
	user: TransactionSigner;
	payer?: TransactionSigner;
	stakingMint: Address;
	amount: bigint;
}

/** Run `buildStakingPreflightInstructions` immediately before. The check also passes on an older
 *  settle. Rewards since that settle then accrue on the smaller post-unstake amount, and the
 *  difference is lost. */
export async function buildUnstakeInstruction(
	params: UnstakeParams,
): Promise<Instruction> {
	return getUnstakeInstructionAsync({
		user: params.user,
		payer: params.payer ?? params.user,
		stakingMint: params.stakingMint,
		amount: params.amount,
	});
}

export interface ClaimRewardsParams {
	user: TransactionSigner;
	payer?: TransactionSigner;
	stakingMint: Address;
	/** Defaults to every registered mint. A subset needs no preflight: each `claim` settles its own mint. */
	rewardMints?: readonly Address[];
}

/** Builds one `claim` per reward mint. A `create_user_reward_debt` comes before each `claim` whose
 *  `UserRewardDebt` is missing: `claim` fails without it. Throws if a mint has no `RewardState`. */
export async function buildClaimRewardsInstructions(
	rpc: RewardMintRpc & Rpc<GetMultipleAccountsApi>,
	params: ClaimRewardsParams,
): Promise<Instruction[]> {
	const [stakingConfigAddr] = findStakingConfigPda();
	const rewardMints = await resolveRewardMints(rpc, params.rewardMints);
	if (rewardMints.length === 0) return [];

	const [rewardStatePdas, debtPdas] = await Promise.all([
		Promise.all(
			rewardMints.map(async (rewardMint) => {
				const [pda] = await findRewardStatePda({
					stakingConfig: stakingConfigAddr,
					rewardMint,
				});
				return pda;
			}),
		),
		Promise.all(
			rewardMints.map(async (rewardMint) => {
				const [pda] = await findUserRewardDebtPda({
					user: params.user.address,
					stakingMint: params.stakingMint,
					rewardMint,
				});
				return pda;
			}),
		),
	]);

	const fetched = await fetchInChunks(
		[...rewardStatePdas, ...rewardMints, ...debtPdas],
		(chunk) => fetchEncodedAccounts(rpc, chunk),
	);
	const rewardStateDecoder = getRewardStateDecoder();
	const payer = params.payer ?? params.user;

	const perMint = await Promise.all(
		rewardMints.map(async (rewardMint, index) => {
			const encodedRewardState = fetched[index];
			if (!accountIsCreated(encodedRewardState)) {
				throw new Error(`RewardState not found for mint ${rewardMint}`);
			}
			const { vault } = rewardStateDecoder.decode(
				encodedRewardState.data,
			);

			const encodedMint = fetched[rewardMints.length + index];
			const tokenProgram = encodedMint.exists
				? encodedMint.programAddress
				: undefined;
			const [destination] = await findAssociatedTokenPda(
				params.user.address,
				rewardMint,
				tokenProgram,
			);

			const instructions: Instruction[] = [];

			// Directly before its own `claim`, so a split of the list by mint keeps each pair together.
			if (!accountIsCreated(fetched[rewardMints.length * 2 + index])) {
				instructions.push(
					await getCreateUserRewardDebtInstructionAsync({
						user: params.user.address,
						payer,
						stakingMint: params.stakingMint,
						rewardMint,
					}),
				);
			}

			instructions.push(
				await getClaimInstructionAsync({
					user: params.user,
					payer,
					stakingMint: params.stakingMint,
					rewardMint,
					vault,
					destination,
					tokenProgram,
				}),
			);

			return instructions;
		}),
	);

	return perMint.flat();
}

export interface WithdrawFeesAccounts {
	rewardState: Address;
	vault: Address;
	rewardMint: Address;
	destinationTokenAccount: Address;
	tokenProgram: Address;
}

/** Returns the accounts of `withdraw_fees` for one reward mint. Without `tokenProgram`, reads it
 *  from the mint account. Throws if that account does not exist. */
export async function buildWithdrawFeesAccounts(
	rpc: Rpc<GetAccountInfoApi>,
	params: {
		rewardMint: Address;
		/** A wallet, not a token account. The SDK derives its ATA. */
		destination: Address;
		tokenProgram?: Address;
	},
): Promise<WithdrawFeesAccounts> {
	const [stakingConfigAddr] = findStakingConfigPda();

	const tokenProgram =
		params.tokenProgram ??
		(
			await rpc
				.getAccountInfo(params.rewardMint, { encoding: 'base64' })
				.send()
		).value?.owner;

	const [[rewardState], [vault], [destinationTokenAccount]] =
		await Promise.all([
			findRewardStatePda({
				stakingConfig: stakingConfigAddr,
				rewardMint: params.rewardMint,
			}),
			findAssociatedTokenPda(
				stakingConfigAddr,
				params.rewardMint,
				tokenProgram,
			),
			findAssociatedTokenPda(
				params.destination,
				params.rewardMint,
				tokenProgram,
			),
		]);

	if (tokenProgram === undefined) {
		throw new Error(`Mint ${params.rewardMint} not found`);
	}

	return {
		rewardState,
		vault,
		rewardMint: params.rewardMint,
		destinationTokenAccount,
		tokenProgram,
	};
}

export async function fetchStakingConfigData(
	rpc: Rpc<GetAccountInfoApi>,
): Promise<StakingConfig> {
	const [stakingConfigAddr] = findStakingConfigPda();
	const config = await fetchStakingConfig(rpc, stakingConfigAddr);
	return config.data;
}

export async function fetchUserStakePositionData(
	rpc: Rpc<GetAccountInfoApi>,
	user: Address,
	stakingMint: Address,
): Promise<UserStakePosition | null> {
	const [positionAddr] = await findUserStakePositionPda({
		user,
		stakingMint,
	});
	const maybePosition = await fetchMaybeUserStakePosition(rpc, positionAddr);
	return maybePosition.exists ? maybePosition.data : null;
}

/** Returns false for the system program address, the value of an unbound staking mint. */
export function isStakingMintBound(stakingMint: Address): boolean {
	return stakingMint !== SYSTEM_PROGRAM_ADDRESS;
}

/** Returns the staking mint. Throws if no staking mint is bound. A bound staking mint cannot change. */
export async function fetchSendMint(
	rpc: Rpc<GetAccountInfoApi>,
): Promise<Address> {
	const { stakingMint } = await fetchStakingConfigData(rpc);
	if (!isStakingMintBound(stakingMint)) {
		throw new Error(
			'Staking mint not yet bound -- nexus not fully initialized',
		);
	}
	return stakingMint;
}

export interface PendingReward {
	rewardMint: Address;
	/** Amount the vault sends, in raw units of `rewardMint`. Equals `ClaimEvent.amount`. A mint with a
	 *  transfer fee delivers less. Get the fee with `transferFee.fetchMintFees`. */
	pending: bigint;
}

/** Returns one entry per reward mint, in `knownRewardMints` order, else sorted by address. Each amount
 *  is in the raw units of its own mint. Do not add them together. Each amount is what the vault sends,
 *  before the mint's transfer fee. */
export async function fetchPendingRewards(
	rpc: RewardMintRpc & Rpc<GetMultipleAccountsApi>,
	user: Address,
	stakingMint: Address,
	knownRewardMints?: readonly Address[],
): Promise<PendingReward[]> {
	const rewardMints = await resolveRewardMints(rpc, knownRewardMints);
	if (rewardMints.length === 0) return [];

	const [userPositionPda] = await findUserStakePositionPda({
		user,
		stakingMint,
	});
	const maybePosition = await fetchMaybeUserStakePosition(
		rpc,
		userPositionPda,
	);

	if (!maybePosition.exists) {
		return rewardMints.map((rewardMint) => ({ rewardMint, pending: 0n }));
	}

	const stakeAmount = maybePosition.data.amount;

	const pdas = await Promise.all(
		rewardMints.map(async (rewardMint) => {
			const [[debtPda], [launchpadAccrualPda], [dexAccrualPda]] =
				await Promise.all([
					findUserRewardDebtPda({ user, stakingMint, rewardMint }),
					findLaunchpadRewardAccrualPda({ quoteMint: rewardMint }),
					findDexRewardAccrualPda({ quoteMint: rewardMint }),
				]);
			return { rewardMint, debtPda, launchpadAccrualPda, dexAccrualPda };
		}),
	);

	const encodedAccounts = await fetchInChunks(
		pdas.flatMap((p) => [
			p.debtPda,
			p.launchpadAccrualPda,
			p.dexAccrualPda,
		]),
		(chunk) => fetchEncodedAccounts(rpc, chunk),
	);

	const userRewardDebtDecoder = getUserRewardDebtDecoder();
	// One decoder for both: the two `RewardAccrual` types have the same layout and discriminator.
	const rewardAccrualDecoder = getRewardAccrualDecoder();

	return pdas.map(({ rewardMint }, index) => {
		const base = index * 3;

		const encodedDebt = encodedAccounts[base];
		// A missing debt is not zero owed. `create_user_reward_debt` opens it at
		// `accSnapshot = 0` and `amountSnapshot = position.amount`, and the claim pays from there.
		const debt = accountIsCreated(encodedDebt)
			? userRewardDebtDecoder.decode(encodedDebt.data)
			: { owed: 0n, accSnapshot: 0n, amountSnapshot: stakeAmount };

		const encodedLaunchpadAccrual = encodedAccounts[base + 1];
		const launchpadAcc = accountIsCreated(encodedLaunchpadAccrual)
			? rewardAccrualDecoder.decode(encodedLaunchpadAccrual.data)
					.accPerToken
			: 0n;

		const encodedDexAccrual = encodedAccounts[base + 2];
		const dexAcc = accountIsCreated(encodedDexAccrual)
			? rewardAccrualDecoder.decode(encodedDexAccrual.data).accPerToken
			: 0n;

		// Matches `settle`: the basis is the smaller amount, floored once over the summed
		// accumulators. A negative delta quotes 0, where the program fails.
		const basis =
			debt.amountSnapshot < stakeAmount
				? debt.amountSnapshot
				: stakeAmount;
		const combined = launchpadAcc + dexAcc;
		const delta =
			combined > debt.accSnapshot ? combined - debt.accSnapshot : 0n;
		const accrued = (basis * delta) / PRECISION;

		return { rewardMint, pending: debt.owed + accrued };
	});
}
