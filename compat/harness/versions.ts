import { runCommand } from './process.js';

/**
 * Compilers consumers realistically run: the last 5.x, the 6.x the SDK is
 * built with, and the native 7.x that is npm's `latest`.
 */
export const TYPESCRIPT_VERSIONS: readonly string[] = [
	'5.9.3',
	'6.0.3',
	'7.0.2',
];

/** The Yarn Berry release of the Plug'n'Play projects. */
export const YARN_VERSION = '4.18.1';

/** Node 24 LTS types; consumer entries run on Node's type stripping (22.18+). */
export const TYPES_NODE_VERSION = '24.13.4';

/**
 * Errors from third-party packages (neither the SDK nor the consumer files)
 * that are known, understood, and allowed. Anything not listed fails the run.
 * Empty on purpose: the matrix installs no kit plugins, whose declarations
 * are what historically fails under `skipLibCheck: false`.
 */
export const KNOWN_THIRD_PARTY_ERRORS: readonly {
	readonly packageName: string;
	readonly code: string;
	readonly reason: string;
}[] = [];

const STABLE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const CARET_RANGE = /^\^(\d+\.\d+\.\d+)$/;

const versionParts = (version: string): number[] =>
	version.split('.').map((part) => Number.parseInt(part, 10));

/** Orders `X.Y.Z` versions; callers only pass stable three-part versions. */
export function compareVersions(left: string, right: string): number {
	const [a, b] = [versionParts(left), versionParts(right)];
	for (let index = 0; index < 3; index += 1) {
		const difference = a[index] - b[index];
		if (difference !== 0) return difference;
	}
	return 0;
}

const majorOf = (version: string): string =>
	version.slice(0, version.indexOf('.'));

/** Floors of a `^X.Y.Z || ^A.B.C` peer range, one per supported major. */
export function kitFloors(peerRange: string): string[] {
	return peerRange.split('||').map((part) => {
		const match = CARET_RANGE.exec(part.trim());
		if (match?.[1] === undefined) {
			throw new Error(
				`unsupported @solana/kit peer range "${peerRange}": the harness derives its floors from "^X.Y.Z || ^A.B.C" ranges only`,
			);
		}
		return match[1];
	});
}

/**
 * Every floor, plus the newest of `releases` in each floor's caret range: the
 * kit a consumer on that major installs today.
 */
export function kitMatrix(
	peerRange: string,
	releases: readonly string[],
): string[] {
	const versions = new Set<string>();
	for (const floor of kitFloors(peerRange)) {
		versions.add(floor);
		const newest = releases
			.filter(
				(version) =>
					majorOf(version) === majorOf(floor) &&
					compareVersions(version, floor) >= 0,
			)
			.toSorted(compareVersions)
			.at(-1);
		if (newest !== undefined) versions.add(newest);
	}
	return [...versions].toSorted(compareVersions);
}

// The consumer projects are outside the workspace, so its `minimumReleaseAge`
// does not reach their installs. This window is their release cooldown.
const KIT_RELEASE_AGE_MS = 2 * 24 * 60 * 60 * 1_000;

/**
 * The stable @solana/kit releases older than `KIT_RELEASE_AGE_MS`. The npm CLI
 * reads the same registry as the installs.
 */
export async function kitReleases(cwd: string): Promise<string[]> {
	const result = await runCommand(
		'npm',
		['view', '@solana/kit', 'time', '--json'],
		{ cwd, timeoutMs: 60_000 },
	);
	if (result.code !== 0) {
		throw new Error(
			`npm view @solana/kit failed:\n${result.stderr.trim()}`,
		);
	}
	// Also holds `created` and `modified`, which are not versions.
	const publishedAt: Record<string, string> = JSON.parse(result.stdout);
	const cutoff = Date.now() - KIT_RELEASE_AGE_MS;
	return Object.entries(publishedAt)
		.filter(
			([version, time]) =>
				STABLE_VERSION.test(version) && Date.parse(time) <= cutoff,
		)
		.map(([version]) => version);
}
