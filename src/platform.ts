import { getProgramDerivedAddress } from '@solana/kit';
import type { ProgramDerivedAddress } from '@solana/kit';
import { SEND_NEXUS_PROGRAM_ADDRESS } from './nexus/generated/programs/index.js';

/** A platform is only a key, with no on-chain account; it is a PDA so a platform account can later `init` at it. */
export const PLATFORM_SEED = 'platform';

/** The name is the platform's identity: renaming one orphans every market and partner config under the old key. */
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
