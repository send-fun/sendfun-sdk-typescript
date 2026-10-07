import type { Address, GetAccountInfoApi, Rpc } from '@solana/kit';
import { calculateFeeDecayPremium } from '../math/fee-decay.js';
import {
	fetchMaybePartnerConfig,
	type PartnerConfig,
} from './generated/accounts/partnerConfig.js';
import { findPartnerConfigPda } from './generated/pdas/partnerConfig.js';
import type { DexFees } from './generated/types/dexFees.js';
import type { LaunchpadFees } from './generated/types/launchpadFees.js';

/** Fetches the `PartnerConfig` of `partner` on `platformConfig`. Throws if it does not exist.
 *  Use the `platformConfig` of the market you price. A partner's fees differ per platform. */
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

/** Returns the `feeBps` a trade pays: the standard rate plus the decay premium. The standard rate
 *  is the protocol and LP rates of `schedule` plus `creatorFeeBps`. `schedule` is the
 *  `PartnerConfig`'s `launchpad` for a curve or `dex` for a pool. `creatorFeeBps` and `createdAt`
 *  are the curve's or pool's. `schedule.maxCreatorFeeBps` has no effect. `createdAt` and `now`
 *  are in unix seconds. */
export function effectiveFeeBps(
	schedule: LaunchpadFees | DexFees,
	createdAt: bigint,
	now: bigint,
	creatorFeeBps: number,
): number {
	const standardFeeBps =
		schedule.protocolFeeBps +
		('lpFeeBps' in schedule ? schedule.lpFeeBps : 0) +
		creatorFeeBps;
	const premium = calculateFeeDecayPremium({
		currentTimestamp: now,
		createdAtTimestamp: createdAt,
		decaySeconds: schedule.feeDecaySeconds,
		decayStartBps: schedule.feeDecayStartBps,
		standardFeeBps,
	});
	return standardFeeBps + Number(premium);
}
