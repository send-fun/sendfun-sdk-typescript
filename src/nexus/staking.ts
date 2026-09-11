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

// 1e12 scale of `RewardAccrual.accPerToken` on both programs; must match send_shared `PRECISION`.
const PRECISION = 1_000_000_000_000n;

/** `getProgramAccounts` is optional: many providers restrict it and LiteSVM lacks it, so pass `rewardMints` there. */
export type RewardMintRpc = Rpc<GetAccountInfoApi> &
	Partial<Rpc<GetProgramAccountsApi>>;

function hasProgramAccounts(
	rpc: RewardMintRpc,
): rpc is Rpc<GetAccountInfoApi> & Rpc<GetProgramAccountsApi> {
	return typeof rpc.getProgramAccounts === 'function';
}

// On-chain body offsets + 8 for the discriminator; pinned by tests/staking.test.ts.
const REWARD_STATE_STAKING_CONFIG_OFFSET = 10n;
const REWARD_STATE_REWARD_MINT_OFFSET = 42;

function compareAddresses(a: Address, b: Address): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

/** Registered reward mints, sorted by address. Includes disabled mints: their accrued balance is
 *  still owed and the settle gate still counts them. Throws when the sweep disagrees with
 *  `StakingConfig.rewardCount` rather than settle a short list. */
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
		// Another nexus account of the same size could pass both filters.
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
	/** `settle` is permissionless: the user does not sign. */
	user: Address;
	payer: TransactionSigner;
	stakingMint: Address;
}

/** One idempotent `settle` per mint; a partial mint list leaves `stake` and `unstake` failing `RewardsNotSettled`. */
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
		if (!encodedAccounts[index].exists) {
			missingMints.push(rewardMint);
		}
	}

	return missingMints;
}

export interface PrepareStakingParams {
	user: Address;
	payer: TransactionSigner;
	stakingMint: Address;
	/** Must be the full registry when supplied; a subset leaves `stake` and `unstake` blocked. */
	rewardMints?: readonly Address[];
}

/** Opens missing `UserRewardDebt`s, then settles every mint; the user never signs, so the stake or unstake after is one wallet prompt. */
export async function buildStakingPreflightInstructions(
	rpc: RewardMintRpc & Rpc<GetMultipleAccountsApi>,
	params: PrepareStakingParams,
): Promise<Instruction[]> {
	// One sweep for both halves: two sweeps can disagree.
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

/** True once `stake` and `unstake` will pass the `settledCount == rewardCount` gate. */
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

/** Fails `RewardsNotSettled` until every mint is settled at the current `stakeVersion`; run `buildStakingPreflightInstructions` first. */
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

/** Settle immediately before via `buildStakingPreflightInstructions`: the gate passes on a stale settle,
 *  and the window since it is then paid at the post-unstake amount, forfeiting accrual. */
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
	/** Defaults to every registered mint; each claim settles its own mint, so a subset needs no preflight. */
	rewardMints?: readonly Address[];
}

/** One `claim` per mint, preceded by `create_user_reward_debt` where the debt is missing:
 *  `Claim` requires the account to exist, so one missing debt fails the whole transaction. */
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
			if (!encodedRewardState.exists) {
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

			// Directly before its own `claim`, so slicing the list by mint keeps each pair together.
			if (!fetched[rewardMints.length * 2 + index].exists) {
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

/** Accounts for one mint's `withdraw_fees`; call once per mint. */
export async function buildWithdrawFeesAccounts(
	rpc: Rpc<GetAccountInfoApi>,
	params: {
		rewardMint: Address;
		/** Wallet, not token account: its ATA is derived. */
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

/** Unbound reads as `Pubkey::default()` (the system program address), which `bind_staking_mint`
 *  can never store: it requires a token mint. */
export function isStakingMintBound(stakingMint: Address): boolean {
	return stakingMint !== SYSTEM_PROGRAM_ADDRESS;
}

/** The staking mint is immutable once bound, so this result is safe to cache. */
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
	/** Base units of `rewardMint`. */
	pending: bigint;
}

/** One entry per reward mint, in `knownRewardMints` order, else sorted by address. Each amount is in
 *  its own mint's base units, so never sum them. */
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
	// One decoder for both: the two `RewardAccrual` types share shape and discriminator.
	const rewardAccrualDecoder = getRewardAccrualDecoder();

	return pdas.map(({ rewardMint }, index) => {
		const base = index * 3;

		const encodedDebt = encodedAccounts[base];
		// A missing debt is not zero owed: `create_user_reward_debt` opens it at
		// `accSnapshot = 0`, `amountSnapshot = position.amount`, and the claim pays that.
		const debt = encodedDebt.exists
			? userRewardDebtDecoder.decode(encodedDebt.data)
			: { owed: 0n, accSnapshot: 0n, amountSnapshot: stakeAmount };

		const encodedLaunchpadAccrual = encodedAccounts[base + 1];
		const launchpadAcc = encodedLaunchpadAccrual.exists
			? rewardAccrualDecoder.decode(encodedLaunchpadAccrual.data)
					.accPerToken
			: 0n;

		const encodedDexAccrual = encodedAccounts[base + 2];
		const dexAcc = encodedDexAccrual.exists
			? rewardAccrualDecoder.decode(encodedDexAccrual.data).accPerToken
			: 0n;

		// Mirrors `settle_debt`: basis is the smaller amount (`amountSnapshot` alone over-quotes
		// after an unstake), floored once over the summed accumulators. A negative delta quotes 0
		// where the program would fail.
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
