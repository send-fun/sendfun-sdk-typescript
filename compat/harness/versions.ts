import { runCommand } from './process.js';

// Bump on purpose; the full run fails once a newer release is two days old.
// Floors come from the SDK's peer range, not this list.
export const NEWEST_KIT_BY_MAJOR: Readonly<Partial<Record<string, string>>> = {
	'6': '6.10.0',
	'7': '7.1.1',
	'8': '8.3.0',
};

/**
 * Compilers consumers realistically run: the last 5.x, the 6.x the SDK is
 * built with, and the native 7.x that is npm's `latest`.
 */
export const TYPESCRIPT_VERSIONS: readonly string[] = [
	'5.9.3',
	'6.0.3',
	'7.0.2',
];

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

/** Every floor plus the pinned newest release of each floor's major. */
export function kitMatrix(peerRange: string): string[] {
	const versions = new Set<string>();
	for (const floor of kitFloors(peerRange)) {
		const newest = NEWEST_KIT_BY_MAJOR[majorOf(floor)];
		if (newest === undefined) {
			throw new Error(
				`peer range supports kit ${majorOf(floor)}.x but NEWEST_KIT_BY_MAJOR has no entry for it`,
			);
		}
		versions.add(floor).add(newest);
	}
	return [...versions].toSorted(compareVersions);
}

// Matches `minimumReleaseAge`: younger releases cannot install yet, so they must not fail CI.
const KIT_RELEASE_AGE_MS = 2 * 24 * 60 * 60 * 1_000;

// npm CLI, so the registry is the same one installs use.
export async function kitFreshnessProblems(
	peerRange: string,
	cwd: string,
): Promise<string[]> {
	const result = await runCommand(
		'npm',
		['view', '@solana/kit', 'time', '--json'],
		{ cwd, timeoutMs: 60_000 },
	);
	if (result.code !== 0) {
		return [`npm view @solana/kit failed:\n${result.stderr.trim()}`];
	}
	// Also holds `created` and `modified`, which are not versions.
	const publishedAt: Record<string, string> = JSON.parse(result.stdout);
	const cutoff = Date.now() - KIT_RELEASE_AGE_MS;
	const published = Object.entries(publishedAt)
		.filter(
			([version, time]) =>
				STABLE_VERSION.test(version) && Date.parse(time) <= cutoff,
		)
		.map(([version]) => version);
	const problems: string[] = [];
	for (const floor of kitFloors(peerRange)) {
		const major = majorOf(floor);
		const newest = published
			.filter((version) => majorOf(version) === major)
			.toSorted(compareVersions)
			.at(-1);
		const pinned = NEWEST_KIT_BY_MAJOR[major];
		// Newer, not different: a pin younger than the age window is ahead of `newest`.
		if (
			newest !== undefined &&
			(pinned === undefined || compareVersions(newest, pinned) > 0)
		) {
			problems.push(
				`@solana/kit ${newest} is the newest ${major}.x on the registry but NEWEST_KIT_BY_MAJOR pins ${pinned ?? 'nothing'}; bump it in compat/harness/versions.ts`,
			);
		}
	}
	return problems;
}
