import { spawn } from 'node:child_process';

export interface CommandResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}

export interface CommandOptions {
	readonly cwd: string;
	readonly timeoutMs: number;
}

/** Variables a package manager injects into `pnpm exec` / `npm run` children. */
const INJECTED_VARIABLE =
	/^(?:npm_(?:command|execpath|node_execpath|config_user_agent|lifecycle_.*|package_.*)|pnpm_config_.*|PNPM_PACKAGE_NAME|PNPM_SCRIPT_SRC_DIR|NODE_OPTIONS)$/;

/**
 * The environment for every child process. What `pnpm exec tsx` injects (the
 * calling workspace's pnpm settings, loader `NODE_OPTIONS`) would otherwise
 * leak into the temp projects' installs and Node runs.
 */
export function isolatedEnvironment(): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) => !INJECTED_VARIABLE.test(key),
		),
	);
}

/** Runs a command to completion, capturing output. Never throws on exit code. */
export async function runCommand(
	command: string,
	args: readonly string[],
	options: CommandOptions,
): Promise<CommandResult> {
	const child = spawn(command, args, {
		cwd: options.cwd,
		env: isolatedEnvironment(),
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let stdout = '';
	let stderr = '';
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill('SIGKILL');
	}, options.timeoutMs);
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on('data', (chunk: string) => {
		stderr += chunk;
	});
	// Not `events.once`: it rejects on the `error` a spawn failure emits before `close`.
	child.on('error', (error) => {
		stderr += error.message;
	});
	const code = await new Promise<number | null>((resolve) => {
		child.on('close', resolve);
	});
	clearTimeout(timer);
	return {
		code: code ?? 1,
		stdout,
		stderr,
		timedOut,
	};
}

/** Maps `items` through `task` with at most `limit` tasks in flight, keeping order. */
export async function mapConcurrent<T, R>(
	items: readonly T[],
	limit: number,
	task: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = Array.from({ length: items.length });
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const index = next;
			next += 1;
			results[index] = await task(items[index]);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, worker),
	);
	return results;
}

/** The last `lines` lines of a command's combined output, for failure reports. */
export function outputTail(result: CommandResult, lines = 15): string {
	const combined = `${result.stdout}\n${result.stderr}`.trim().split('\n');
	return combined.slice(-lines).join('\n');
}
