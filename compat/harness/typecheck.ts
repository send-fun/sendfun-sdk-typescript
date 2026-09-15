import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Project } from './project.js';
import { outputTail, runCommand } from './process.js';
import { KNOWN_THIRD_PARTY_ERRORS } from './versions.js';

export type ResolutionMode = 'nodenext' | 'bundler';

export const RESOLUTION_MODES: readonly ResolutionMode[] = [
	'nodenext',
	'bundler',
];

const CANARY_FILES: Readonly<Record<ResolutionMode, readonly string[]>> = {
	nodenext: ['canary.ts', 'canary.cts'],
	bundler: ['canary.ts'],
};

const CONSUMER_FILES: Readonly<Record<ResolutionMode, readonly string[]>> = {
	nodenext: [
		'consumer.ts',
		'consumer.cts',
		'logic.ts',
		'entry-esm.ts',
		'entry-cjs.cts',
	],
	bundler: ['consumer.ts', 'logic.ts', 'entry-esm.ts'],
};

/** SDK declaration files each mode must load, proving it resolved the packed dist. */
const EXPECTED_SDK_TYPES: Readonly<Record<ResolutionMode, readonly string[]>> =
	{
		nodenext: ['dist/index.d.mts', 'dist/index.d.cts'],
		bundler: ['dist/index.d.mts'],
	};

const SDK_PACKAGE_PATH = '/node_modules/@send-fun/sdk/';

/** Installs each compiler once, under an alias, into a shared toolchain project. */
export async function installToolchain(
	root: string,
	versions: readonly string[],
): Promise<{ problems: string[]; directory: string }> {
	const directory = join(root, 'toolchain');
	await mkdir(directory, { recursive: true });
	const dependencies = Object.fromEntries(
		versions.map((version) => [
			`typescript-${version}`,
			`npm:typescript@${version}`,
		]),
	);
	await writeFile(
		join(directory, 'package.json'),
		`${JSON.stringify({ name: 'compat-toolchain', private: true, dependencies }, null, '\t')}\n`,
	);
	const result = await runCommand(
		'npm',
		['install', '--no-audit', '--no-fund', '--ignore-scripts'],
		{ cwd: directory, timeoutMs: 600_000 },
	);
	return {
		directory,
		problems:
			result.code === 0
				? []
				: [
						`TypeScript toolchain install failed:\n${outputTail(result)}`,
					],
	};
}

/**
 * Strict consumer configs with library checking on. `DOM` is in both: kit's
 * declarations name WebCrypto and EventTarget types (`CryptoKeyPair`,
 * `AddEventListenerOptions`) that only the DOM lib declares, so kit itself
 * does not compile under `skipLibCheck: false` without it.
 */
export async function writeTsconfigs(project: Project): Promise<void> {
	const common = {
		strict: true,
		noEmit: true,
		skipLibCheck: false,
		allowImportingTsExtensions: true,
		target: 'ES2022',
		lib: ['ES2023', 'DOM', 'DOM.Iterable'],
		types: ['node'],
	};
	const configs: Record<ResolutionMode, unknown> = {
		nodenext: {
			compilerOptions: {
				...common,
				module: 'nodenext',
				moduleResolution: 'nodenext',
			},
			files: [...CONSUMER_FILES.nodenext, ...CANARY_FILES.nodenext],
		},
		bundler: {
			compilerOptions: {
				...common,
				module: 'esnext',
				moduleResolution: 'bundler',
			},
			files: [...CONSUMER_FILES.bundler, ...CANARY_FILES.bundler],
		},
	};
	await Promise.all(
		RESOLUTION_MODES.map((mode) =>
			writeFile(
				join(project.directory, `tsconfig.${mode}.json`),
				`${JSON.stringify(configs[mode], null, '\t')}\n`,
			),
		),
	);
}

interface Diagnostic {
	readonly file: string | null;
	readonly line: number;
	readonly code: string;
	readonly text: string;
}

const LOCATED_DIAGNOSTIC = /^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/;
const GLOBAL_DIAGNOSTIC = /^error (TS\d+): (.*)$/;

function parseOutput(output: string): {
	diagnostics: Diagnostic[];
	listedFiles: string[];
} {
	const diagnostics: Diagnostic[] = [];
	const listedFiles: string[] = [];
	for (const line of output.split('\n')) {
		const located = LOCATED_DIAGNOSTIC.exec(line);
		const global = GLOBAL_DIAGNOSTIC.exec(line);
		if (located !== null) {
			diagnostics.push({
				file: located[1],
				line: Number(located[2]),
				code: located[3],
				text: located[4],
			});
		} else if (global !== null) {
			diagnostics.push({
				file: null,
				line: 0,
				code: global[1],
				text: global[2],
			});
		} else if (line.startsWith('/')) {
			listedFiles.push(line.trim());
		}
	}
	return { diagnostics, listedFiles };
}

/** The package that owns a path inside node_modules, or null for local files. */
function owningPackage(file: string): string | null {
	const index = file.lastIndexOf('node_modules/');
	if (index === -1) return null;
	const parts = file.slice(index + 'node_modules/'.length).split('/');
	const [scope = '', name = ''] = parts;
	return scope.startsWith('@') ? `${scope}/${name}` : scope;
}

/**
 * Expected canary errors: each block's 1-based line range and error code. A
 * block runs from the line after its marker to the line before the next.
 */
function canaryBlocks(
	source: string,
): { start: number; end: number; code: string }[] {
	const markers: { line: number; code: string }[] = [];
	for (const [index, text] of source.split('\n').entries()) {
		const match = /\/\/ canary: (TS\d+|end)\s*$/.exec(text);
		if (match?.[1] !== undefined) {
			markers.push({ line: index + 1, code: match[1] });
		}
	}
	const blocks: { start: number; end: number; code: string }[] = [];
	for (let index = 0; index + 1 < markers.length; index += 1) {
		const marker = markers[index];
		if (marker.code !== 'end') {
			blocks.push({
				start: marker.line + 1,
				end: markers[index + 1].line - 1,
				code: marker.code,
			});
		}
	}
	return blocks;
}

function checkCanary(
	file: string,
	source: string,
	diagnostics: readonly Diagnostic[],
): string[] {
	const problems: string[] = [];
	const blocks = canaryBlocks(source);
	if (blocks.length === 0) return [`${file} has no canary blocks`];
	const own = diagnostics.filter((diagnostic) => diagnostic.file === file);
	for (const block of blocks) {
		const inside = own.filter(
			(diagnostic) =>
				diagnostic.line >= block.start && diagnostic.line <= block.end,
		);
		if (inside.length === 0) {
			problems.push(
				`${file}:${block.start} canary compiled cleanly; expected ${block.code} (SDK types may have degraded to any)`,
			);
		}
		for (const diagnostic of inside) {
			if (diagnostic.code !== block.code) {
				problems.push(
					`${file}:${diagnostic.line} canary expected ${block.code}, got ${diagnostic.code}: ${diagnostic.text}`,
				);
			}
		}
	}
	for (const diagnostic of own) {
		const covered = blocks.some(
			(block) =>
				diagnostic.line >= block.start && diagnostic.line <= block.end,
		);
		if (!covered) {
			problems.push(
				`${file}:${diagnostic.line} unexpected ${diagnostic.code} outside canary blocks: ${diagnostic.text}`,
			);
		}
	}
	return problems;
}

/**
 * Runs one compiler over one resolution mode and attributes every error:
 * canary files must fail exactly as marked, consumer files and the SDK's
 * declarations must be clean, and third-party errors pass only when listed
 * in KNOWN_THIRD_PARTY_ERRORS. `--listFiles` confirms the SDK types came from
 * the packed `dist/` and that a single kit copy supplied kit's types.
 */
export async function typecheckProject(options: {
	readonly project: Project;
	readonly compiler: string;
	readonly typescript: string;
	readonly mode: ResolutionMode;
}): Promise<{ problems: string[]; knownErrors: number }> {
	const { project, mode } = options;
	const result = await runCommand(
		process.execPath,
		[
			options.compiler,
			'-p',
			`tsconfig.${mode}.json`,
			'--pretty',
			'false',
			'--listFiles',
		],
		{ cwd: project.directory, timeoutMs: 600_000 },
	);
	const prefix = `tsc ${options.typescript} ${mode}`;
	if (result.timedOut)
		return { problems: [`${prefix}: timed out`], knownErrors: 0 };
	const { diagnostics, listedFiles } = parseOutput(
		`${result.stdout}\n${result.stderr}`,
	);
	const problems: string[] = [];
	let knownErrors = 0;

	for (const diagnostic of diagnostics) {
		const where =
			diagnostic.file === null
				? ''
				: `${diagnostic.file}:${diagnostic.line} `;
		const summary = `${where}${diagnostic.code}: ${diagnostic.text}`;
		if (diagnostic.file === null) {
			problems.push(`${prefix}: global ${summary}`);
			continue;
		}
		if (CANARY_FILES[mode].includes(diagnostic.file)) continue;
		const owner = owningPackage(diagnostic.file);
		if (owner === null) {
			problems.push(`${prefix}: consumer ${summary}`);
		} else if (owner === '@send-fun/sdk') {
			problems.push(`${prefix}: SDK declarations ${summary}`);
		} else if (
			KNOWN_THIRD_PARTY_ERRORS.some(
				(known) =>
					known.packageName === owner &&
					known.code === diagnostic.code,
			)
		) {
			knownErrors += 1;
		} else {
			problems.push(
				`${prefix}: unlisted third-party (${owner}) ${summary}`,
			);
		}
	}
	for (const file of CANARY_FILES[mode]) {
		const source = readFileSync(join(project.directory, file), 'utf8');
		for (const problem of checkCanary(file, source, diagnostics)) {
			problems.push(`${prefix}: ${problem}`);
		}
	}

	if (listedFiles.length === 0) {
		problems.push(
			`${prefix}: compiler listed no files (exit ${result.code}):\n${outputTail(result)}`,
		);
	}
	for (const expected of EXPECTED_SDK_TYPES[mode]) {
		if (
			!listedFiles.some((file) =>
				file.endsWith(`${SDK_PACKAGE_PATH}${expected}`),
			)
		) {
			problems.push(`${prefix}: SDK types did not load ${expected}`);
		}
	}
	const sourceTypes = listedFiles.filter((file) =>
		file.includes(`${SDK_PACKAGE_PATH}src/`),
	);
	if (sourceTypes.length > 0) {
		problems.push(
			`${prefix}: compiled SDK source instead of declarations: ${sourceTypes[0] ?? ''}`,
		);
	}
	const kitRoots = new Set(
		listedFiles
			.map(
				(file) => /^(.*\/node_modules\/@solana\/kit)\//.exec(file)?.[1],
			)
			.filter((root) => root !== undefined),
	);
	if (kitRoots.size !== 1) {
		problems.push(
			`${prefix}: expected kit types from one copy, loaded ${kitRoots.size}: ${[...kitRoots].join(', ')}`,
		);
	}
	return { problems, knownErrors };
}
