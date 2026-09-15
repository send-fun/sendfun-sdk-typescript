import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { outputTail, runCommand } from './process.js';
import { TYPES_NODE_VERSION } from './versions.js';

export type PackageManager = 'npm' | 'pnpm';

export const PACKAGE_MANAGERS: readonly PackageManager[] = ['npm', 'pnpm'];

export interface Project {
	readonly directory: string;
	readonly kit: string;
	readonly packageManager: PackageManager;
	readonly label: string;
}

/** Fixture files copied verbatim into every project. */
const FIXTURE_FILES = [
	'canary.ts',
	'consumer.ts',
	'entry-cjs.cts',
	'entry-esm.ts',
	'logic.ts',
] as const;

/** Copies compiled a second time as CommonJS, against the `.d.cts` types. */
const COMMONJS_COPIES: readonly (readonly [string, string])[] = [
	['canary.ts', 'canary.cts'],
	['consumer.ts', 'consumer.cts'],
];

export async function createProject(options: {
	readonly root: string;
	readonly fixtureDirectory: string;
	readonly kit: string;
	readonly packageManager: PackageManager;
	readonly tarball: string;
}): Promise<Project> {
	const label = `${options.packageManager} kit ${options.kit}`;
	const directory = join(
		options.root,
		`${options.packageManager}-kit-${options.kit}`,
	);
	await mkdir(directory, { recursive: true });
	const manifest = {
		name: `compat-${options.packageManager}-kit-${options.kit.replaceAll('.', '-')}`,
		private: true,
		type: 'module',
		dependencies: {
			'@send-fun/sdk': `file:${options.tarball}`,
			'@solana/kit': options.kit,
		},
		devDependencies: { '@types/node': TYPES_NODE_VERSION },
	};
	await writeFile(
		join(directory, 'package.json'),
		`${JSON.stringify(manifest, null, '\t')}\n`,
	);
	await Promise.all([
		...FIXTURE_FILES.map((file) =>
			copyFile(
				join(options.fixtureDirectory, file),
				join(directory, file),
			),
		),
		...COMMONJS_COPIES.map(([from, to]) =>
			copyFile(join(options.fixtureDirectory, from), join(directory, to)),
		),
	]);
	return {
		directory,
		kit: options.kit,
		packageManager: options.packageManager,
		label,
	};
}

/** Installs a project from its manifest, as a consumer would. Returns problems. */
export async function installProject(project: Project): Promise<string[]> {
	const args =
		project.packageManager === 'npm'
			? ['install', '--no-audit', '--no-fund', '--ignore-scripts']
			: ['install', '--no-frozen-lockfile', '--ignore-scripts'];
	const result = await runCommand(project.packageManager, args, {
		cwd: project.directory,
		timeoutMs: 600_000,
	});
	if (result.code !== 0 || result.timedOut) {
		return [
			`${project.packageManager} install failed${result.timedOut ? ' (timed out)' : ''}:\n${outputTail(result)}`,
		];
	}
	return [];
}

interface Manifest {
	readonly name?: string;
	readonly version?: string;
	readonly dependencies?: Readonly<Record<string, string>>;
	readonly devDependencies?: Readonly<Record<string, string>>;
	readonly optionalDependencies?: Readonly<Record<string, string>>;
	readonly peerDependencies?: Readonly<Record<string, string>>;
}

function readManifest(packageDirectory: string): Manifest {
	const manifest: Manifest = JSON.parse(
		readFileSync(join(packageDirectory, 'package.json'), 'utf8'),
	);
	return manifest;
}

/** Node's lookup: the nearest `node_modules/<name>` above `fromDirectory`. */
function locatePackage(fromDirectory: string, name: string): string | null {
	let current = fromDirectory;
	for (;;) {
		const candidate = join(current, 'node_modules', name);
		if (existsSync(join(candidate, 'package.json'))) {
			return realpathSync(candidate);
		}
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/**
 * Walks the installed dependency graph from the project root (a real path),
 * the way Node
 * resolves it (regular, optional and peer edges), so it counts the copies a
 * consumer can actually load under any layout: npm hoisting, pnpm's virtual
 * store, or nested installs. Returns every physical copy of each package name.
 */
function installedCopies(projectDirectory: string): Map<string, Set<string>> {
	const copies = new Map<string, Set<string>>();
	const visited = new Set<string>();
	const queue: { directory: string; root: boolean }[] = [
		{ directory: projectDirectory, root: true },
	];
	for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
		if (visited.has(item.directory)) continue;
		visited.add(item.directory);
		const manifest = readManifest(item.directory);
		if (!item.root && manifest.name !== undefined) {
			const found = copies.get(manifest.name) ?? new Set<string>();
			found.add(item.directory);
			copies.set(manifest.name, found);
		}
		const edges = {
			...manifest.peerDependencies,
			...manifest.optionalDependencies,
			...manifest.dependencies,
			...(item.root ? manifest.devDependencies : {}),
		};
		for (const name of Object.keys(edges)) {
			const located = locatePackage(item.directory, name);
			if (located !== null)
				queue.push({ directory: located, root: false });
		}
	}
	return copies;
}

/** Walks up from a resolved entry file to the package directory named `name`. */
export function packageRootOf(entryFile: string, name: string): string {
	let current = dirname(entryFile);
	for (;;) {
		if (
			existsSync(join(current, 'package.json')) &&
			readManifest(current).name === name
		) {
			return realpathSync(current);
		}
		const parent = dirname(current);
		if (parent === current) {
			throw new Error(`no ${name} package above ${entryFile}`);
		}
		current = parent;
	}
}

export const versionOfPackageAt = (packageDirectory: string): string =>
	readManifest(packageDirectory).version ?? 'unknown';

/**
 * The install-level assertions: the SDK is the packed copy (never a link to
 * the source tree), exactly one `@solana/kit` at the requested version, exactly
 * one `@solana/program-client-core` at that same version, and the SDK's own
 * `@solana/kit` and `@solana/kit/program-client-core` imports land on those
 * single copies.
 */
export function auditInstall(
	project: Project,
	sdkRoot: string,
	sdkVersion: string,
): string[] {
	const problems: string[] = [];
	const sdkLink = join(project.directory, 'node_modules', '@send-fun', 'sdk');
	if (!existsSync(join(sdkLink, 'package.json'))) {
		return ['@send-fun/sdk is not installed'];
	}
	const sdkDirectory = realpathSync(sdkLink);
	const fromSource = relative(realpathSync(sdkRoot), sdkDirectory);
	if (!fromSource.startsWith(`..${sep}`) && fromSource !== '..') {
		problems.push(
			`@send-fun/sdk resolves into the SDK source tree (${sdkDirectory}), not the packed tarball`,
		);
	}
	if (versionOfPackageAt(sdkDirectory) !== sdkVersion) {
		problems.push(
			`installed @send-fun/sdk is ${versionOfPackageAt(sdkDirectory)}, packed ${sdkVersion}`,
		);
	}

	const projectDirectory = realpathSync(project.directory);
	const copies = installedCopies(projectDirectory);
	const describe = (name: string): string =>
		[...(copies.get(name) ?? [])]
			.map(
				(directory) =>
					`${versionOfPackageAt(directory)} at ${relative(projectDirectory, directory)}`,
			)
			.join('; ');
	const kitCopies = [...(copies.get('@solana/kit') ?? [])];
	const coreCopies = [...(copies.get('@solana/program-client-core') ?? [])];
	if (
		kitCopies.length !== 1 ||
		kitCopies.some(
			(directory) => versionOfPackageAt(directory) !== project.kit,
		)
	) {
		problems.push(
			`expected exactly one @solana/kit at ${project.kit}, found ${kitCopies.length}: ${describe('@solana/kit')}`,
		);
	}
	if (
		coreCopies.length !== 1 ||
		coreCopies.some(
			(directory) => versionOfPackageAt(directory) !== project.kit,
		)
	) {
		problems.push(
			`expected exactly one @solana/program-client-core at ${project.kit} (kit's version), found ${coreCopies.length}: ${describe('@solana/program-client-core')}`,
		);
	}

	const sdkRequire = createRequire(join(sdkDirectory, 'dist', 'index.cjs'));
	try {
		const sdkKit = packageRootOf(
			sdkRequire.resolve('@solana/kit'),
			'@solana/kit',
		);
		const sdkSubpath = sdkRequire.resolve(
			'@solana/kit/program-client-core',
		);
		if (kitCopies.length === 1 && sdkKit !== kitCopies[0]) {
			problems.push(
				`the SDK resolves @solana/kit to ${sdkKit}, not the app's copy`,
			);
		}
		if (!realpathSync(sdkSubpath).startsWith(`${sdkKit}${sep}`)) {
			problems.push(
				`the SDK resolves @solana/kit/program-client-core outside kit: ${sdkSubpath}`,
			);
		}
		const kitCore = packageRootOf(
			createRequire(join(sdkKit, 'package.json')).resolve(
				'@solana/program-client-core',
			),
			'@solana/program-client-core',
		);
		if (coreCopies.length === 1 && kitCore !== coreCopies[0]) {
			problems.push(
				`kit resolves @solana/program-client-core to ${kitCore}, not the single installed copy`,
			);
		}
	} catch (error) {
		problems.push(
			`resolving kit from the SDK failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return problems;
}
