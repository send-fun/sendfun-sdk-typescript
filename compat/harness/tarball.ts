import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { outputTail, runCommand } from './process.js';

/** The only bare specifiers the built SDK may import; anything else is an undeclared dependency. */
const ALLOWED_EXTERNALS: ReadonlySet<string> = new Set([
	'@solana/kit',
	'@solana/kit/program-client-core',
]);

export interface PackedManifest {
	readonly name: string;
	readonly version: string;
	readonly peerDependencies?: Readonly<Record<string, string>>;
	readonly dependencies?: Readonly<Record<string, string>>;
	readonly exports?: unknown;
}

export interface TarballInspection {
	readonly manifest: PackedManifest;
	readonly problems: readonly string[];
}

/**
 * Packs the SDK the way it is published. `pnpm pack` applies `publishConfig`
 * (dist exports and types); `npm pack` would ship the source-pointing exports.
 */
export async function packSdk(
	sdkRoot: string,
	destination: string,
): Promise<string> {
	await mkdir(destination, { recursive: true });
	const result = await runCommand(
		'pnpm',
		['pack', '--pack-destination', destination],
		{ cwd: sdkRoot, timeoutMs: 120_000 },
	);
	const tarballs = (await readdir(destination)).filter((file) =>
		file.endsWith('.tgz'),
	);
	if (result.code !== 0 || tarballs.length !== 1) {
		throw new Error(`pnpm pack failed:\n${outputTail(result)}`);
	}
	return join(destination, tarballs[0] ?? '');
}

/** Bare module specifiers imported or required by a built file. */
function bareSpecifiers(source: string): Set<string> {
	const patterns = [
		/^(?:import|export)\s[^;]*?\bfrom\s*"([^"]+)"/gm,
		/^import\s*"([^"]+)"/gm,
		/\brequire\("([^"]+)"\)/g,
		/\bimport\("([^"]+)"\)/g,
	];
	const specifiers = new Set<string>();
	for (const pattern of patterns) {
		for (const match of source.matchAll(pattern)) {
			const specifier = match[1];
			if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
				specifiers.add(specifier);
			}
		}
	}
	return specifiers;
}

/**
 * Checks the packed artifact itself: a single `@solana/kit` peer, dist-only
 * exports, and built files that import nothing but kit and its
 * program-client-core subpath. Rolldown marks every bundled module with a
 * `//#region <path>` comment, so a region under node_modules means kit (or
 * anything else) was inlined into the SDK.
 */
export async function inspectTarball(
	tarball: string,
	destination: string,
): Promise<TarballInspection> {
	await mkdir(destination, { recursive: true });
	const extracted = await runCommand(
		'tar',
		['-xzf', tarball, '-C', destination],
		{
			cwd: destination,
			timeoutMs: 60_000,
		},
	);
	if (extracted.code !== 0) {
		throw new Error(`tar failed:\n${outputTail(extracted)}`);
	}
	const packageRoot = join(destination, 'package');
	const manifest: PackedManifest = JSON.parse(
		await readFile(join(packageRoot, 'package.json'), 'utf8'),
	);
	const problems: string[] = [];

	const peers = Object.keys(manifest.peerDependencies ?? {});
	if (peers.length !== 1 || peers[0] !== '@solana/kit') {
		problems.push(
			`peerDependencies must be exactly @solana/kit, got [${peers.join(', ')}]`,
		);
	}
	const dependencies = Object.keys(manifest.dependencies ?? {});
	if (dependencies.length > 0) {
		problems.push(
			`dependencies must be empty, got [${dependencies.join(', ')}]`,
		);
	}
	const exportsText = JSON.stringify(manifest.exports ?? null);
	for (const target of [
		'./dist/index.mjs',
		'./dist/index.cjs',
		'./dist/index.d.mts',
		'./dist/index.d.cts',
	]) {
		if (!exportsText.includes(`"${target}"`)) {
			problems.push(`exports do not reference ${target}: ${exportsText}`);
		} else if (!existsSync(join(packageRoot, target))) {
			problems.push(`exports reference ${target}, which is not packed`);
		}
	}
	if (exportsText.includes('./src/')) {
		problems.push(
			`exports point into src/ (packed without publishConfig?): ${exportsText}`,
		);
	}

	const builtFiles = (await readdir(join(packageRoot, 'dist'))).filter(
		(file) => /\.(?:mjs|cjs|d\.mts|d\.cts)$/.test(file),
	);
	for (const file of builtFiles) {
		const source = await readFile(join(packageRoot, 'dist', file), 'utf8');
		for (const specifier of bareSpecifiers(source)) {
			if (!ALLOWED_EXTERNALS.has(specifier)) {
				problems.push(
					`dist/${file} imports "${specifier}"; only ${[...ALLOWED_EXTERNALS].join(', ')} may stay external`,
				);
			}
		}
		for (const match of source.matchAll(
			/^\/\/#region (.*node_modules.*)$/gm,
		)) {
			problems.push(`dist/${file} inlines ${match[1]}`);
		}
	}
	return { manifest, problems };
}
