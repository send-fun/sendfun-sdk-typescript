import { getProgramDerivedAddress } from '@solana/kit';
import type { ProgramDerivedAddress } from '@solana/kit';
import { SEND_NEXUS_PROGRAM_ADDRESS } from './nexus/generated/programs/index.js';

/** Seed of the platform PDA. A platform has no on-chain account. */
export const PLATFORM_SEED = 'platform';

/** Derives the platform key for `name` under the nexus program. Each name gives a different platform. */
export async function findPlatformAddress(
	name: string,
): Promise<ProgramDerivedAddress> {
	return await getProgramDerivedAddress({
		programAddress: SEND_NEXUS_PROGRAM_ADDRESS,
		seeds: [
			new TextEncoder().encode(PLATFORM_SEED),
			new TextEncoder().encode(name),
		],
	});
}
