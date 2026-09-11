import type { Address, GetAccountInfoApi, Rpc } from '@solana/kit';
import { calculateFeeDecayPremium } from '../math/fee-decay.js';
import {
	fetchMaybePartnerConfig,
	type PartnerConfig,
} from './generated/accounts/partnerConfig.js';
import { findPartnerConfigPda } from './generated/pdas/partnerConfig.js';
import type { DexFees } from './generated/types/dexFees.js';
import type { LaunchpadFees } from './generated/types/launchpadFees.js';

/** Throws if the pair is unregistered. Take `platformConfig` from the market being priced: a partner's fees differ per platform. */
export async function fetchPartnerFees(
	rpc: Rpc<GetAccountInfoApi>,
	partner: Address,
	platformConfig: Address,
): Promise<PartnerConfig> {
	const [partnerPda] = await findPartnerConfigPda({
		partner,
		platformConfig,
	});
	const maybeAccount = await fetchMaybePartnerConfig(rpc, partnerPda);
	if (!maybeAccount.exists) {
		throw new Error(
			`No fee config for partner ${partner} on platform ${platformConfig}`,
		);
	}
	return maybeAccount.data;
}

/** The `feeBps` a trade pays: the standard rate plus the decay premium from the market's
 *  `createdAt`. Pass `fees.launchpad` for a curve, `fees.dex` for a pool; times in unix seconds. */
export function effectiveFeeBps(
	schedule: LaunchpadFees | DexFees,
	createdAt: bigint,
	now: bigint,
): number {
	const standardFeeBps =
		schedule.protocolFeeBps +
		schedule.creatorFeeBps +
		('lpFeeBps' in schedule ? schedule.lpFeeBps : 0);
	const premium = calculateFeeDecayPremium({
		currentTimestamp: now,
		createdAtTimestamp: createdAt,
		decaySeconds: schedule.feeDecaySeconds,
		decayStartBps: schedule.feeDecayStartBps,
		standardFeeBps,
	});
	return standardFeeBps + Number(premium);
}
