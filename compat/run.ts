/**
 * Consumer compatibility harness for the published SDK.
 *
 * Packs the built SDK exactly as it is published, installs the tarball into
 * fresh temp projects for every supported @solana/kit version with npm and
 * pnpm, and in each project: audits the installed copies of kit and
 * program-client-core, typechecks consumer code plus a must-fail canary with
 * several TypeScript versions and resolution modes, and runs ESM and CommonJS
 * consumers against a stub RPC, comparing their output with a reference
 * snapshot computed from the SDK source.
 *
 * Needs network (registry installs), so it stays out of `check` and `test`.
 *
 *   pnpm run build && pnpm exec tsx compat/run.ts
 *   pnpm exec tsx compat/run.ts --kit 8.3.0 --pm pnpm --ts 7.0.2
 *
 * Flags (repeatable or comma-separated): --kit, --pm, --ts. --tarball <path>
 * tests an existing tarball instead of packing; --keep leaves the temp
 * projects on disk. Exits non-zero on any failure.
 */
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as kit from '@solana/kit';
import * as sdkSource from '../src/index.js';
import { runCompat } from './fixture/logic.js';
import { inspectTarball, packSdk } from './harness/tarball.js';
import { mapConcurrent, outputTail, runCommand } from './harness/process.js';
import {
	auditInstall,
	createProject,
	installProject,
	PACKAGE_MANAGERS,
	packageRootOf,
	versionOfPackageAt,
	type PackageManager,
	type Project,
} from './harness/project.js';
import {
	installToolchain,
	RESOLUTION_MODES,
	typecheckProject,
	writeTsconfigs,
} from './harness/typecheck.js';
import {
	kitFreshnessProblems,
	kitMatrix,
	TYPESCRIPT_VERSIONS,
} from './harness/versions.js';

type Json = Awaited<ReturnType<typeof runCompat>>[string];

const INSTALL_CONCURRENCY = 4;
const compatDirectory = dirname(fileURLToPath(import.meta.url));
const sdkRoot = resolve(compatDirectory, '..');

interface Options {
	readonly kits: readonly string[] | null;
	readonly packageManagers: readonly PackageManager[];
	readonly typescripts: readonly string[];
	readonly tarball: string | null;
	readonly keep: boolean;
}

const splitList = (values: readonly string[] | undefined): string[] =>
	(values ?? []).flatMap((value) =>
		value
			.split(',')
			.map((item) => item.trim())
			.filter((item) => item.length > 0),
	);

function parseOptions(): Options | null {
	const { values } = parseArgs({
		options: {
			kit: { type: 'string', multiple: true },
			pm: { type: 'string', multiple: true },
			ts: { type: 'string', multiple: true },
			tarball: { type: 'string' },
			keep: { type: 'boolean', default: false },
			help: { type: 'boolean', default: false },
		},
		strict: true,
	});
	if (values.help) {
		process.stdout.write(
			'usage: tsx compat/run.ts [--kit <version>] [--pm npm|pnpm] [--ts <version>] [--tarball <path>] [--keep]\n',
		);
		return null;
	}
	const kits = splitList(values.kit);
	const managers = splitList(values.pm);
	for (const manager of managers) {
		if (!PACKAGE_MANAGERS.some((known) => known === manager)) {
			throw new Error(`--pm must be npm or pnpm, got ${manager}`);
		}
	}
	const typescripts = splitList(values.ts);
	return {
		kits: kits.length > 0 ? kits : null,
		packageManagers:
			managers.length > 0
				? PACKAGE_MANAGERS.filter((known) => managers.includes(known))
				: PACKAGE_MANAGERS,
		typescripts: typescripts.length > 0 ? typescripts : TYPESCRIPT_VERSIONS,
		tarball: values.tarball === undefined ? null : resolve(values.tarball),
		keep: values.keep,
	};
}

const elapsed = (start: number): string =>
	`${((performance.now() - start) / 1_000).toFixed(1)}s`;

const log = (message: string): void => {
	process.stdout.write(`${message}\n`);
};

function flattenJson(
	value: Json,
	path: string,
	into: Map<string, string>,
): void {
	if (value !== null && typeof value === 'object') {
		for (const [key, inner] of Object.entries(value)) {
			flattenJson(inner, `${path}.${key}`, into);
		}
	} else {
		into.set(path, JSON.stringify(value));
	}
}

const clip = (text: string | undefined): string => {
	if (text === undefined) return '(missing)';
	return text.length > 90 ? `${text.slice(0, 90)}...` : text;
};

/** Leaf paths where two snapshots differ, for a readable mismatch report. */
function snapshotDifferences(
	expected: Json,
	actual: Json,
	limit = 8,
): string[] {
	const left = new Map<string, string>();
	const right = new Map<string, string>();
	flattenJson(expected, 'snapshot', left);
	flattenJson(actual, 'snapshot', right);
	const differences: string[] = [];
	for (const path of new Set([...left.keys(), ...right.keys()])) {
		if (left.get(path) !== right.get(path)) {
			differences.push(
				`${path}: expected ${clip(left.get(path))}, got ${clip(right.get(path))}`,
			);
		}
	}
	return differences.length > limit
		? [
				...differences.slice(0, limit),
				`...and ${differences.length - limit} more`,
			]
		: differences;
}

interface ProjectReport {
	readonly project: Project;
	readonly stages: Map<string, string[]>;
}

async function runConsumer(
	project: Project,
	format: 'esm' | 'cjs',
	reference: string,
): Promise<string[]> {
	const entry = format === 'esm' ? 'entry-esm.ts' : 'entry-cjs.cts';
	const result = await runCommand(
		process.execPath,
		['--disable-warning=ExperimentalWarning', entry],
		{ cwd: project.directory, timeoutMs: 120_000 },
	);
	const lastLine = result.stdout.trim().split('\n').at(-1) ?? '';
	if (result.code !== 0 || !lastLine.startsWith('{')) {
		return [
			`${format} consumer exited ${result.code}:\n${outputTail(result, 25)}`,
		];
	}
	const report: { sdkEntry: string; kitEntry: string; snapshot: Json } =
		JSON.parse(lastLine);
	const problems: string[] = [];
	const expectedEntry = join(
		'dist',
		format === 'esm' ? 'index.mjs' : 'index.cjs',
	);
	const installedSdk = realpathSync(
		join(project.directory, 'node_modules', '@send-fun', 'sdk'),
	);
	if (realpathSync(report.sdkEntry) !== join(installedSdk, expectedEntry)) {
		problems.push(
			`${format} loaded the SDK from ${report.sdkEntry}, expected the installed ${expectedEntry}`,
		);
	}
	const loadedKit = versionOfPackageAt(
		packageRootOf(report.kitEntry, '@solana/kit'),
	);
	if (loadedKit !== project.kit) {
		problems.push(
			`${format} loaded @solana/kit ${loadedKit}, expected ${project.kit}`,
		);
	}
	if (JSON.stringify(report.snapshot) !== reference) {
		const expected: Json = JSON.parse(reference);
		problems.push(
			`${format} snapshot differs from the reference:\n  ${snapshotDifferences(expected, report.snapshot).join('\n  ')}`,
		);
	}
	return problems;
}

function printSummary(options: {
	readonly reports: readonly ProjectReport[];
	readonly globalProblems: ReadonlyMap<string, string[]>;
	readonly typescripts: readonly string[];
}): number {
	const columns = [
		'install',
		'copies',
		...options.typescripts.map((version) => `tsc ${version}`),
		'esm',
		'cjs',
	];
	const header = ['kit', 'pm', ...columns];
	const rows = options.reports.map((report) => [
		report.project.kit,
		report.project.packageManager,
		...columns.map((column) => {
			const problems = report.stages.get(column);
			if (problems === undefined) return 'skip';
			return problems.length === 0 ? 'ok' : 'FAIL';
		}),
	]);
	const widths = header.map((title, index) =>
		Math.max(title.length, ...rows.map((row) => (row[index] ?? '').length)),
	);
	const format = (row: readonly string[]): string =>
		row
			.map((cell, index) => cell.padEnd(widths[index] ?? 0))
			.join('  ')
			.trimEnd();

	log('');
	log(format(header));
	for (const row of rows) log(format(row));
	log('');

	const failures: string[] = [];
	for (const [check, problems] of options.globalProblems) {
		log(`${check}: ${problems.length === 0 ? 'ok' : 'FAIL'}`);
		for (const problem of problems) failures.push(`[${check}] ${problem}`);
	}
	for (const report of options.reports) {
		for (const [stage, problems] of report.stages) {
			for (const problem of problems) {
				failures.push(`[${report.project.label} ${stage}] ${problem}`);
			}
		}
	}
	if (failures.length === 0) {
		log('\nall compatibility checks passed');
		return 0;
	}
	log(`\n${failures.length} failure(s):`);
	for (const failure of failures) log(`- ${failure}`);
	return 1;
}

async function main(options: Options, temporaryRoot: string): Promise<number> {
	const started = performance.now();
	const manifest: { peerDependencies: Record<string, string | undefined> } =
		JSON.parse(await readFile(join(sdkRoot, 'package.json'), 'utf8'));
	const peerRange = manifest.peerDependencies['@solana/kit'] ?? '';
	const kits = options.kits ?? kitMatrix(peerRange);
	const globalProblems = new Map<string, string[]>();

	if (
		options.tarball === null &&
		!existsSync(join(sdkRoot, 'dist', 'index.mjs'))
	) {
		throw new Error(
			`no build at ${join(sdkRoot, 'dist')}; run \`pnpm run build\` first`,
		);
	}
	if (process.features.typescript === false) {
		throw new Error(
			'the consumer entries need Node >= 22.18 with type stripping enabled',
		);
	}

	const [npmVersion, pnpmVersion] = await Promise.all(
		(['npm', 'pnpm'] as const).map(async (tool) => {
			const result = await runCommand(tool, ['--version'], {
				cwd: temporaryRoot,
				timeoutMs: 60_000,
			});
			return result.code === 0 ? result.stdout.trim() : 'unavailable';
		}),
	);
	log(`node ${process.version} | npm ${npmVersion} | pnpm ${pnpmVersion}`);
	log(`kit ${kits.join(' ')} (peer ${peerRange})`);
	log(
		`typescript ${options.typescripts.join(' ')} x ${RESOLUTION_MODES.join(', ')}`,
	);
	log(`temp root ${temporaryRoot}`);

	if (options.kits === null) {
		globalProblems.set(
			'kit freshness',
			await kitFreshnessProblems(peerRange, temporaryRoot),
		);
	} else {
		log('kit freshness: skipped (--kit given)');
	}

	const tarball =
		options.tarball ??
		(await packSdk(sdkRoot, join(temporaryRoot, 'pack')));
	const inspection = await inspectTarball(
		tarball,
		join(temporaryRoot, 'packed'),
	);
	globalProblems.set('packed tarball', [...inspection.problems]);
	log(
		`packed ${inspection.manifest.name}@${inspection.manifest.version} from ${tarball}`,
	);

	let reference = '';
	try {
		reference = JSON.stringify(await runCompat(sdkSource, kit));
		globalProblems.set('reference snapshot', []);
	} catch (error) {
		globalProblems.set('reference snapshot', [
			`computing the reference from src/ failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
		]);
	}

	const projectsStart = performance.now();
	const toolchainPromise = installToolchain(
		temporaryRoot,
		options.typescripts,
	);
	const reports = await mapConcurrent(
		kits.flatMap((version) =>
			options.packageManagers.map((packageManager) => ({
				version,
				packageManager,
			})),
		),
		INSTALL_CONCURRENCY,
		async ({ version, packageManager }): Promise<ProjectReport> => {
			const project = await createProject({
				root: temporaryRoot,
				fixtureDirectory: join(compatDirectory, 'fixture'),
				kit: version,
				packageManager,
				tarball,
			});
			const stages = new Map([
				['install', await installProject(project)],
			]);
			// A misaligned install still gets typechecked and run: the later
			// stages show what the duplicate copies break for a consumer.
			if (stages.get('install')?.length === 0) {
				stages.set(
					'copies',
					auditInstall(project, sdkRoot, inspection.manifest.version),
				);
			}
			const failed = [...stages.values()].some(
				(problems) => problems.length > 0,
			);
			log(`install ${project.label}: ${failed ? 'FAIL' : 'ok'}`);
			return { project, stages };
		},
	);
	const toolchain = await toolchainPromise;
	globalProblems.set('typescript toolchain', toolchain.problems);
	log(`installs done in ${elapsed(projectsStart)}`);

	const installed = reports.filter(
		(report) => report.stages.get('install')?.length === 0,
	);
	const parallelism = availableParallelism();

	if (toolchain.problems.length === 0) {
		const typecheckStart = performance.now();
		await Promise.all(
			installed.map((report) => writeTsconfigs(report.project)),
		);
		const jobs = installed.flatMap((report) =>
			options.typescripts.flatMap((typescript) =>
				RESOLUTION_MODES.map((mode) => ({ report, typescript, mode })),
			),
		);
		const results = await mapConcurrent(jobs, parallelism, async (job) => {
			const outcome = await typecheckProject({
				project: job.report.project,
				compiler: join(
					toolchain.directory,
					'node_modules',
					`typescript-${job.typescript}`,
					'bin',
					'tsc',
				),
				typescript: job.typescript,
				mode: job.mode,
			});
			return { job, outcome };
		});
		let knownErrors = 0;
		for (const { job, outcome } of results) {
			const stage = `tsc ${job.typescript}`;
			const stageProblems = job.report.stages.get(stage) ?? [];
			stageProblems.push(...outcome.problems);
			job.report.stages.set(stage, stageProblems);
			knownErrors += outcome.knownErrors;
		}
		log(
			`typecheck (${jobs.length} runs) done in ${elapsed(typecheckStart)}; ${knownErrors} listed third-party errors ignored`,
		);
	}

	if (reference !== '') {
		const runtimeStart = performance.now();
		const jobs = installed.flatMap((report) =>
			(['esm', 'cjs'] as const).map((format) => ({ report, format })),
		);
		const results = await mapConcurrent(jobs, parallelism, async (job) => ({
			job,
			problems: await runConsumer(
				job.report.project,
				job.format,
				reference,
			),
		}));
		for (const { job, problems } of results) {
			job.report.stages.set(job.format, problems);
		}
		log(`runtime (${jobs.length} runs) done in ${elapsed(runtimeStart)}`);
	}

	const exitCode = printSummary({
		reports,
		globalProblems,
		typescripts: options.typescripts,
	});
	log(`total ${elapsed(started)}`);
	return exitCode;
}

const options = parseOptions();
if (options !== null) {
	const temporaryRoot = await mkdtemp(join(tmpdir(), `send-fun-sdk-compat-`));
	const cleanUp = async (): Promise<void> => {
		if (options.keep) {
			log(`kept ${temporaryRoot}`);
			return;
		}
		await rm(temporaryRoot, { recursive: true, force: true });
	};
	const onInterrupt = (signal: NodeJS.Signals): void => {
		void cleanUp().finally(() => {
			process.kill(process.pid, signal);
		});
	};
	process.once('SIGINT', onInterrupt);
	process.once('SIGTERM', onInterrupt);
	try {
		process.exitCode = await main(options, temporaryRoot);
	} catch (error) {
		process.exitCode = 1;
		log(
			`compat harness failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
		);
	} finally {
		process.off('SIGINT', onInterrupt);
		process.off('SIGTERM', onInterrupt);
		await cleanUp();
	}
}
