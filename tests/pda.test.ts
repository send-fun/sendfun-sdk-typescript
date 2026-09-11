import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { address } from '@solana/kit';
import { WSOL_MINT } from '../src/constants.js';
import { findAssociatedTokenPda } from '../src/utils/pda.js';
import {
	findBondingCurvePda,
	findEventAuthorityPda as findLaunchpadEventAuthorityPda,
	findGlobalConfigPda as findLaunchpadGlobalConfigPda,
	findMigrationAuthorityPda,
	findRewardAccrualPda as findLaunchpadRewardAccrualPda,
} from '../src/launchpad/generated/pdas/index.js';
import {
	findEventAuthorityPda as findDexEventAuthorityPda,
	findGlobalConfigPda as findDexGlobalConfigPda,
	findLpMintPda,
	findPoolPda,
	findRewardAccrualPda as findDexRewardAccrualPda,
} from '../src/dex/generated/pdas/index.js';
import {
	findAltRegistryPda,
	findCreatorFeeConfigPda,
	findFeePresetPda,
	findEventAuthorityPda as findNexusEventAuthorityPda,
	findGlobalConfigPda as findNexusGlobalConfigPda,
	findPartnerMetadataPda,
	findPartnerConfigPda,
	findRewardStatePda,
	findStakingConfigPda,
	findUserRewardDebtPda,
	findUserStakePositionPda,
} from '../src/nexus/generated/pdas/index.js';

const MINT_A = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const MINT_B = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const SEND_MINT = address('BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND');
const USER_A = SEND_MINT;
const USER_B = address('So11111111111111111111111111111111111111112');
const PLATFORM = address('2PJedAsa7pCnScks2XM3U4o2nPaTvvBmi2553VcCnGWB');
const PLATFORM_B = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

const KNOWN_LAUNCHPAD_GLOBAL_CONFIG = address(
	'H3csa1cgR7zPJdxCzNbS5chYymHMKS3XivDA5nRx4Bdq',
);
const KNOWN_LAUNCHPAD_EVENT_AUTH = address(
	'FJVebqCthxH6JM8vvkJb7yRYA7Emsib1C1vu4ZePSP3T',
);
const KNOWN_MIGRATION_AUTHORITY = address(
	'932vp5VTARoqoAKNgLSawfCsAx43jUJ5YURggmXBX6V',
);
const KNOWN_DEX_GLOBAL_CONFIG = address(
	'EzwCCwXhnp9DERXBmMw6gfZxHYBtBQYaC5FjCnuKbivA',
);
const KNOWN_DEX_EVENT_AUTH = address(
	'4pTDYKRFdmxTQYFceGZkzPGd3kb8ShMA9n6XKRaPZn8t',
);
const KNOWN_NEXUS_GLOBAL_CONFIG = address(
	'3bycfBeRULfXYqcg3DmiYFBjv6mMVidMuqKdFZJTGdNr',
);
const KNOWN_STAKING_CONFIG = address(
	'9WUowYRb6KAWjWVB5KMmTngBidZXEXgQcQRTXbhxeGbF',
);
const KNOWN_NEXUS_EVENT_AUTH = address(
	'BxA56yuUugqREwSEFVr117VKJ6JmVdPA7jm7MCXzDNJr',
);
const KNOWN_WSOL_REWARD_STATE = address(
	'B9Z3t5c3AFtbuUfdeK41zGGL3dQ2AkgtGCjTcakZYwFr',
);
// Matches Rust `find_creator_fee_config_pda`; the only guard against a codama seed regression.
const KNOWN_CREATOR_FEE_CONFIG = address(
	'9naWqjy2pqFvQ2Wd2EbiUnRuEEnKzAteAcjpqjtyUZx6',
);
const KNOWN_STAKING_WSOL_VAULT = address(
	'AyisZJxXz9ywXhMwR3sb3oePxBB6UBvixXycAQCdSgrz',
);

describe('Launchpad PDAs', () => {
	it('findLaunchpadGlobalConfigPda matches known address', () => {
		const [result] = findLaunchpadGlobalConfigPda();
		assert.equal(result, KNOWN_LAUNCHPAD_GLOBAL_CONFIG);
	});

	it('findLaunchpadEventAuthorityPda matches known address', () => {
		const [result] = findLaunchpadEventAuthorityPda();
		assert.equal(result, KNOWN_LAUNCHPAD_EVENT_AUTH);
	});

	it('findMigrationAuthorityPda matches known address', () => {
		const [result] = findMigrationAuthorityPda();
		assert.equal(result, KNOWN_MIGRATION_AUTHORITY);
	});
});

describe('DEX PDAs', () => {
	it('findDexGlobalConfigPda matches known address', () => {
		const [result] = findDexGlobalConfigPda();
		assert.equal(result, KNOWN_DEX_GLOBAL_CONFIG);
	});

	it('findDexEventAuthorityPda matches known address', () => {
		const [result] = findDexEventAuthorityPda();
		assert.equal(result, KNOWN_DEX_EVENT_AUTH);
	});
});

describe('Nexus PDAs', () => {
	it('findNexusGlobalConfigPda matches known address', () => {
		const [result] = findNexusGlobalConfigPda();
		assert.equal(result, KNOWN_NEXUS_GLOBAL_CONFIG);
	});

	it('findStakingConfigPda matches known address', () => {
		const [result] = findStakingConfigPda();
		assert.equal(result, KNOWN_STAKING_CONFIG);
	});

	it('findNexusEventAuthorityPda matches known address', () => {
		const [result] = findNexusEventAuthorityPda();
		assert.equal(result, KNOWN_NEXUS_EVENT_AUTH);
	});

	it('findRewardStatePda(stakingConfig, WSOL_MINT) matches known address', async () => {
		const [stakingConfig] = findStakingConfigPda();
		const [result] = await findRewardStatePda({
			stakingConfig,
			rewardMint: WSOL_MINT,
		});
		assert.equal(result, KNOWN_WSOL_REWARD_STATE);
	});
});

describe('ATA', () => {
	it('findAssociatedTokenPda(stakingConfig, WSOL_MINT) matches known address', async () => {
		const [stakingConfig] = findStakingConfigPda();
		const [result] = await findAssociatedTokenPda(stakingConfig, WSOL_MINT);
		assert.equal(result, KNOWN_STAKING_WSOL_VAULT);
	});
});

describe('findBondingCurvePda', () => {
	it('is deterministic', async () => {
		const [a] = await findBondingCurvePda({
			baseMint: MINT_A,
			quoteMint: WSOL_MINT,
		});
		const [b] = await findBondingCurvePda({
			baseMint: MINT_A,
			quoteMint: WSOL_MINT,
		});
		assert.equal(a, b);
	});

	it('different mints produce different addresses', async () => {
		const [a] = await findBondingCurvePda({
			baseMint: MINT_A,
			quoteMint: WSOL_MINT,
		});
		const [b] = await findBondingCurvePda({
			baseMint: MINT_B,
			quoteMint: WSOL_MINT,
		});
		assert.notEqual(a, b);
	});
});

describe('findPoolPda', () => {
	it('is deterministic', async () => {
		const [a] = await findPoolPda({
			baseMint: MINT_A,
			quoteMint: WSOL_MINT,
		});
		const [b] = await findPoolPda({
			baseMint: MINT_A,
			quoteMint: WSOL_MINT,
		});
		assert.equal(a, b);
	});

	it('different mints produce different addresses', async () => {
		const [a] = await findPoolPda({
			baseMint: MINT_A,
			quoteMint: WSOL_MINT,
		});
		const [b] = await findPoolPda({
			baseMint: MINT_B,
			quoteMint: WSOL_MINT,
		});
		assert.notEqual(a, b);
	});
});

describe('findLpMintPda', () => {
	it('is deterministic', async () => {
		const [a] = await findLpMintPda({
			baseMint: MINT_A,
			quoteMint: WSOL_MINT,
		});
		const [b] = await findLpMintPda({
			baseMint: MINT_A,
			quoteMint: WSOL_MINT,
		});
		assert.equal(a, b);
	});

	it('different from findPoolPda for same inputs', async () => {
		const [pool] = await findPoolPda({
			baseMint: MINT_A,
			quoteMint: WSOL_MINT,
		});
		const [lp] = await findLpMintPda({
			baseMint: MINT_A,
			quoteMint: WSOL_MINT,
		});
		assert.notEqual(pool, lp);
	});
});

describe('findAltRegistryPda', () => {
	it('is deterministic', () => {
		const [a] = findAltRegistryPda();
		const [b] = findAltRegistryPda();
		assert.equal(a, b);
	});
});

describe('findFeePresetPda', () => {
	it('is deterministic', async () => {
		const [a] = await findFeePresetPda({
			index: 3,
			platformConfig: PLATFORM,
		});
		const [b] = await findFeePresetPda({
			index: 3,
			platformConfig: PLATFORM,
		});
		assert.equal(a, b);
	});

	it('different indexes produce different addresses', async () => {
		const [a] = await findFeePresetPda({
			index: 0,
			platformConfig: PLATFORM,
		});
		const [b] = await findFeePresetPda({
			index: 1,
			platformConfig: PLATFORM,
		});
		assert.notEqual(a, b);
	});

	// A shared address would price one platform's launches off another's tier table.
	it('the same index on different platforms produces different addresses', async () => {
		const [a] = await findFeePresetPda({
			index: 1,
			platformConfig: PLATFORM,
		});
		const [b] = await findFeePresetPda({
			index: 1,
			platformConfig: PLATFORM_B,
		});
		assert.notEqual(a, b);
	});
});

describe('findPartnerMetadataPda', () => {
	it('is deterministic', async () => {
		const [a] = await findPartnerMetadataPda({
			partner: USER_A,
			platformConfig: PLATFORM,
		});
		const [b] = await findPartnerMetadataPda({
			partner: USER_A,
			platformConfig: PLATFORM,
		});
		assert.equal(a, b);
	});

	it('different partners produce different addresses', async () => {
		const [a] = await findPartnerMetadataPda({
			partner: USER_A,
			platformConfig: PLATFORM,
		});
		const [b] = await findPartnerMetadataPda({
			partner: USER_B,
			platformConfig: PLATFORM,
		});
		assert.notEqual(a, b);
	});

	it('differs from the partner account PDA for the same partner', async () => {
		const [meta] = await findPartnerMetadataPda({
			partner: USER_A,
			platformConfig: PLATFORM,
		});
		const [account] = await findPartnerConfigPda({
			partner: USER_A,
			platformConfig: PLATFORM,
		});
		assert.notEqual(meta, account);
	});
});

describe('findPartnerConfigPda', () => {
	it('is deterministic', async () => {
		const [a] = await findPartnerConfigPda({
			partner: USER_A,
			platformConfig: PLATFORM,
		});
		const [b] = await findPartnerConfigPda({
			partner: USER_A,
			platformConfig: PLATFORM,
		});
		assert.equal(a, b);
	});

	it('different partners produce different addresses', async () => {
		const [a] = await findPartnerConfigPda({
			partner: USER_A,
			platformConfig: PLATFORM,
		});
		const [b] = await findPartnerConfigPda({
			partner: USER_B,
			platformConfig: PLATFORM,
		});
		assert.notEqual(a, b);
	});
});

describe('findRewardAccrualPda', () => {
	it('is deterministic', async () => {
		const [a] = await findLaunchpadRewardAccrualPda({
			quoteMint: WSOL_MINT,
		});
		const [b] = await findLaunchpadRewardAccrualPda({
			quoteMint: WSOL_MINT,
		});
		assert.equal(a, b);
	});

	it('different mints produce different addresses', async () => {
		const [a] = await findLaunchpadRewardAccrualPda({
			quoteMint: WSOL_MINT,
		});
		const [b] = await findLaunchpadRewardAccrualPda({
			quoteMint: SEND_MINT,
		});
		assert.notEqual(a, b);
	});

	// Same seeds, per-program addresses: a total read from one program alone is silently short.
	it('the two platforms derive different addresses from the same mint', async () => {
		const [launchpad] = await findLaunchpadRewardAccrualPda({
			quoteMint: WSOL_MINT,
		});
		const [dex] = await findDexRewardAccrualPda({ quoteMint: WSOL_MINT });
		assert.notEqual(launchpad, dex);
	});
});

describe('findUserStakePositionPda', () => {
	it('is deterministic', async () => {
		const [a] = await findUserStakePositionPda({
			user: USER_A,
			stakingMint: SEND_MINT,
		});
		const [b] = await findUserStakePositionPda({
			user: USER_A,
			stakingMint: SEND_MINT,
		});
		assert.equal(a, b);
	});

	it('different users produce different addresses', async () => {
		const [a] = await findUserStakePositionPda({
			user: USER_A,
			stakingMint: SEND_MINT,
		});
		const [b] = await findUserStakePositionPda({
			user: USER_B,
			stakingMint: SEND_MINT,
		});
		assert.notEqual(a, b);
	});
});

describe('findUserRewardDebtPda', () => {
	it('is deterministic', async () => {
		const [a] = await findUserRewardDebtPda({
			user: USER_A,
			stakingMint: SEND_MINT,
			rewardMint: WSOL_MINT,
		});
		const [b] = await findUserRewardDebtPda({
			user: USER_A,
			stakingMint: SEND_MINT,
			rewardMint: WSOL_MINT,
		});
		assert.equal(a, b);
	});

	it('different reward mints produce different addresses', async () => {
		const [a] = await findUserRewardDebtPda({
			user: USER_A,
			stakingMint: SEND_MINT,
			rewardMint: WSOL_MINT,
		});
		const [b] = await findUserRewardDebtPda({
			user: USER_A,
			stakingMint: SEND_MINT,
			rewardMint: MINT_A,
		});
		assert.notEqual(a, b);
	});
});

describe('findCreatorFeeConfigPda', () => {
	it('derives the frozen address for (creatorHash, quoteMint)', async () => {
		const [addr, bump] = await findCreatorFeeConfigPda({
			creatorHash: USER_A,
			quoteMint: WSOL_MINT,
		});
		assert.equal(addr, KNOWN_CREATOR_FEE_CONFIG);
		assert.equal(bump, 254);
	});

	it('is deterministic', async () => {
		const [a] = await findCreatorFeeConfigPda({
			creatorHash: USER_A,
			quoteMint: WSOL_MINT,
		});
		const [b] = await findCreatorFeeConfigPda({
			creatorHash: USER_A,
			quoteMint: WSOL_MINT,
		});
		assert.equal(a, b);
	});

	it('different hashes produce different addresses', async () => {
		const [a] = await findCreatorFeeConfigPda({
			creatorHash: USER_A,
			quoteMint: WSOL_MINT,
		});
		const [b] = await findCreatorFeeConfigPda({
			creatorHash: USER_B,
			quoteMint: WSOL_MINT,
		});
		assert.notEqual(a, b);
	});
});
