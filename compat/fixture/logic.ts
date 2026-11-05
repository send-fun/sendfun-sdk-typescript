/**
 * Runtime checks shared by the ESM and CommonJS entries. The SDK and kit
 * modules come in as arguments so each entry exercises its own module format,
 * and the harness runs this same function against the SDK source to compute
 * the reference snapshot every packed install must reproduce exactly.
 *
 * Inputs are fixed (keypairs from constant seed bytes, a constant blockhash),
 * so the snapshot is identical on every kit version and every run.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from 'node:http';
import { dirname, join } from 'node:path';
import type * as SendFunSdk from '@send-fun/sdk';
import type * as SolanaKit from '@solana/kit';

export type Sdk = typeof SendFunSdk;
export type Kit = typeof SolanaKit;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

type StoredAccount = { readonly owner: string; readonly data: Uint8Array };

const U64_MAX = 18_446_744_073_709_551_615n;
const BUY_AMOUNT_IN = 1_000_000n;
const BUY_MIN_AMOUNT_OUT = 5n;
const STAKE_AMOUNT = 7_000_000n;

const seedBytes = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

/** The `Execute` discriminator, the TLV type of a hook list's account entry. */
const EXECUTE_DISCRIMINATOR = [105, 37, 101, 197, 75, 251, 102, 26];

/** The first seed of a mint's validation account, under its hook program. */
const VALIDATION_SEED = 'extra-account-metas';

// A meta: a u8 discriminator, a 32-byte address config, then the signer and
// writable bools.
const META_FIXED = 0;
const META_HOOK_PDA = 1;
const META_PUBKEY_DATA = 2;
const SEED_ACCOUNT_KEY = 3;
const PUBKEY_ACCOUNT_DATA = 2;
const CONFIG_LENGTH = 32;
// `Execute` account 0 is the source; its owner sits at byte 32.
const SOURCE_INDEX = 0;
const OWNER_OFFSET = 32;

// Where the canary's `SharedArrayBuffer` view starts.
const SHARED_VIEW_OFFSET = 3;

// A Token-2022 mint: `is_initialized`, then `AccountType::Mint` after the
// 82-byte base and its padding, then each extension's type and length. The
// `TransferHook` extension is type 14, 64 bytes: its authority, then its
// program.
const MINT_BASE_LENGTH = 82;
const MINT_IS_INITIALIZED = 45;
const MINT_ACCOUNT_TYPE = 165;
const ACCOUNT_TYPE_MINT = 1;
const TRANSFER_HOOK_HEADER = [14, 0, 64, 0];
const MINT_HOOK_PROGRAM_OFFSET = 166 + 4 + 32;

/**
 * The version in the nearest `package.json` named `name` above `entry`. Under
 * Yarn PnP `entry` sits in a zip archive, which `yarn node` lets `node:fs`
 * read.
 */
export function packageVersion(entry: string, name: string): string {
	for (let directory = dirname(entry); ; directory = dirname(directory)) {
		const manifestPath = join(directory, 'package.json');
		if (existsSync(manifestPath)) {
			const manifest: { name?: string; version?: string } = JSON.parse(
				readFileSync(manifestPath, 'utf8'),
			);
			if (manifest.name === name) return manifest.version ?? 'unknown';
		}
		if (dirname(directory) === directory) {
			throw new Error(`no ${name} package above ${entry}`);
		}
	}
}

function u32LittleEndian(value: number): number[] {
	return [
		value & 0xff,
		(value >> 8) & 0xff,
		(value >> 16) & 0xff,
		value >>> 24,
	];
}

function hookMeta(
	discriminator: number,
	config: readonly number[],
	writable: boolean,
): number[] {
	const padded = [
		...config,
		...Array.from({ length: CONFIG_LENGTH - config.length }, () => 0),
	];
	return [discriminator, ...padded, 0, writable ? 1 : 0];
}

/** A Token-2022 mint whose one extension is a `TransferHook` for `program`. */
function hookedMintData(program: Uint8Array): Uint8Array {
	const data = new Uint8Array(MINT_HOOK_PROGRAM_OFFSET + program.length);
	data[MINT_IS_INITIALIZED] = 1;
	data[MINT_ACCOUNT_TYPE] = ACCOUNT_TYPE_MINT;
	data.set(TRANSFER_HOOK_HEADER, MINT_ACCOUNT_TYPE + 1);
	data.set(program, MINT_HOOK_PROGRAM_OFFSET);
	return data;
}

/**
 * An initialized mint with no extensions, as SPL Token and Token-2022 both
 * store one.
 */
function plainMintData(): Uint8Array {
	const data = new Uint8Array(MINT_BASE_LENGTH);
	data[MINT_IS_INITIALIZED] = 1;
	return data;
}

/**
 * Builds a hooked buy from a hook list in a `SharedArrayBuffer` view, as a
 * consumer can hand it over. A plain array and a read through the consumer's
 * own kit RPC must give the same buy.
 */
async function transferHookCanary(sdk: Sdk, kit: Kit): Promise<Json> {
	const { constants, launchpad, utils } = sdk;
	const address = (fill: number): SolanaKit.Address =>
		kit.getAddressDecoder().decode(seedBytes(fill));
	const hookProgram = address(20);
	const userQuoteAccount = address(21);
	const quoteMint = address(22);
	const baseMint = address(23);
	const user = kit.createNoopSigner(address(24));
	const platformConfig = address(25);
	const fixed = address(26);
	const metas = [
		hookMeta(META_FIXED, [...kit.getAddressEncoder().encode(fixed)], false),
		hookMeta(META_HOOK_PDA, [SEED_ACCOUNT_KEY, SOURCE_INDEX], true),
		hookMeta(
			META_PUBKEY_DATA,
			[PUBKEY_ACCOUNT_DATA, SOURCE_INDEX, OWNER_OFFSET],
			false,
		),
	];
	const body = [...u32LittleEndian(metas.length), ...metas.flat()];
	const list = [
		...EXECUTE_DISCRIMINATOR,
		...u32LittleEndian(body.length),
		...body,
	];
	const shared = new Uint8Array(
		new SharedArrayBuffer(SHARED_VIEW_OFFSET + list.length),
		SHARED_VIEW_OFFSET,
	);
	shared.set(list);

	const [validation] = await kit.getProgramDerivedAddress({
		programAddress: hookProgram,
		seeds: [VALIDATION_SEED, kit.getAddressEncoder().encode(quoteMint)],
	});
	const baseAccount = {
		owner: constants.TOKEN_2022_PROGRAM_ADDRESS,
		data: plainMintData(),
	};
	const quoteAccount = {
		owner: constants.TOKEN_2022_PROGRAM_ADDRESS,
		data: hookedMintData(seedBytes(20)),
	};
	const [sourcePda] = await kit.getProgramDerivedAddress({
		programAddress: hookProgram,
		seeds: [kit.getAddressEncoder().encode(userQuoteAccount)],
	});
	// The quote leg's source is the user's quote account. The user signs it.
	const expected: SolanaKit.AccountMeta[] = [
		{ address: fixed, role: kit.AccountRole.READONLY },
		{ address: sourcePda, role: kit.AccountRole.WRITABLE },
		{ address: user.address, role: kit.AccountRole.READONLY },
		{ address: hookProgram, role: kit.AccountRole.READONLY },
		{ address: validation, role: kit.AccountRole.READONLY },
	];
	const plain = {
		tokenProgram: constants.TOKEN_2022_PROGRAM_ADDRESS,
		decimals: 0,
		transferFee: null,
	};
	const baseMintInfo: SendFunSdk.utils.MintInfo = {
		address: baseMint,
		...plain,
		hookProgram: null,
		hook: null,
	};
	const quoteInfoOver = (
		data: Uint8Array | null,
	): SendFunSdk.utils.MintInfo => ({
		address: quoteMint,
		...plain,
		hookProgram: data === null ? null : hookProgram,
		hook:
			data === null
				? null
				: {
						accounts: new Map<
							SolanaKit.Address,
							SendFunSdk.transferHook.AccountView | null
						>([
							[quoteMint, quoteAccount],
							[validation, { owner: hookProgram, data }],
						]),
					},
	});
	const buy = (quoteMintInfo: SendFunSdk.utils.MintInfo) =>
		launchpad.trade.buildBuyExactInInstruction({
			user,
			baseMintInfo,
			quoteMintInfo,
			partner: constants.DEFAULT_PARTNER,
			platformConfig,
			userQuoteAccount,
			amountIn: BUY_AMOUNT_IN,
			minAmountOut: BUY_MIN_AMOUNT_OUT,
		});
	const hookFree = await buy(quoteInfoOver(null));
	const built = await buy(quoteInfoOver(shared));
	assert.deepStrictEqual(built.accounts, [
		...(hookFree.accounts ?? []),
		...expected,
	]);
	assert.deepStrictEqual(
		await buy(quoteInfoOver(new Uint8Array(list))),
		built,
	);

	const stub = await startStubRpc(
		new Map<string, StoredAccount>([
			[baseMint, baseAccount],
			[quoteMint, quoteAccount],
			[validation, { owner: hookProgram, data: shared }],
			[
				'SysvarC1ock11111111111111111111111111111111',
				{
					owner: 'Sysvar1111111111111111111111111111111111111',
					data: new Uint8Array(40),
				},
			],
		]),
	);
	let read: SendFunSdk.utils.MintInfoResult<'baseMint' | 'quoteMint'>;
	try {
		read = await utils.fetchMintInfo(kit.createSolanaRpc(stub.url), {
			baseMint,
			quoteMint,
		});
	} finally {
		stub.close();
	}
	assert.deepStrictEqual(read.baseMintInfo, baseMintInfo);
	assert.equal(read.quoteMintInfo.hookProgram, hookProgram);
	assert.deepStrictEqual(
		{ ...read.quoteMintInfo, hookProgram: null, hook: null },
		quoteInfoOver(null),
	);
	const hook = [...(read.quoteMintInfo.hook?.accounts.keys() ?? [])];
	assert.deepStrictEqual(hook, [quoteMint, validation]);
	assert.deepStrictEqual(await buy(read.quoteMintInfo), built);

	return {
		validation,
		accounts: expected.map((meta) => [meta.address, meta.role]),
		hook,
	};
}

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** JSON with bigints as `123n` strings and byte arrays as `0x` hex. */
function toJson(value: unknown): Json {
	const json: Json = JSON.parse(
		JSON.stringify(value, (_key, inner: unknown) => {
			if (typeof inner === 'bigint') return `${inner}n`;
			if (inner instanceof Uint8Array) return `0x${toHex(inner)}`;
			return inner;
		}),
	);
	return json;
}

/** Minimal JSON-RPC node serving fixed accounts; never imports kit. */
async function startStubRpc(
	accounts: ReadonlyMap<string, StoredAccount>,
): Promise<{ url: string; close: () => void }> {
	const encodeAccount = (address: unknown): Json => {
		const account =
			typeof address === 'string' ? accounts.get(address) : undefined;
		if (account === undefined) return null;
		return {
			data: [Buffer.from(account.data).toString('base64'), 'base64'],
			executable: false,
			lamports: 1_000_000,
			owner: account.owner,
			rentEpoch: 0,
			space: account.data.length,
		};
	};
	const handle = (method: unknown, params: unknown): Json => {
		const list = Array.isArray(params) ? (params as unknown[]) : [];
		const context = { slot: 100 };
		if (method === 'getAccountInfo') {
			return { context, value: encodeAccount(list[0]) };
		}
		if (method === 'getMultipleAccounts') {
			const addresses = Array.isArray(list[0])
				? (list[0] as unknown[])
				: [];
			return { context, value: addresses.map(encodeAccount) };
		}
		throw new Error(`stub RPC does not serve ${String(method)}`);
	};
	const server = createServer(
		(request: IncomingMessage, response: ServerResponse) => {
			let body = '';
			request.setEncoding('utf8');
			request.on('data', (chunk: string) => {
				body += chunk;
			});
			request.on('end', () => {
				const call: { id: Json; method: unknown; params: unknown } =
					JSON.parse(body);
				let reply: Json;
				try {
					reply = {
						jsonrpc: '2.0',
						id: call.id,
						result: handle(call.method, call.params),
					};
				} catch (error) {
					reply = {
						jsonrpc: '2.0',
						id: call.id,
						error: {
							code: -32_601,
							message:
								error instanceof Error
									? error.message
									: String(error),
						},
					};
				}
				response.setHeader('content-type', 'application/json');
				response.end(JSON.stringify(reply));
			});
		},
	);
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});
	const bound = server.address();
	if (bound === null || typeof bound === 'string') {
		throw new Error('stub RPC is not listening on a TCP port');
	}
	return {
		url: `http://127.0.0.1:${bound.port}`,
		close: () => {
			server.closeAllConnections();
			server.close();
		},
	};
}

/** Little-endian u64, written without kit so it checks the SDK encoders. */
function u64LittleEndian(value: bigint): Uint8Array {
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setBigUint64(0, value, true);
	return bytes;
}

export async function runCompat(
	sdk: Sdk,
	kit: Kit,
): Promise<Record<string, Json>> {
	const { constants, dex, launchpad, nexus } = sdk;
	const address = (fill: number): SolanaKit.Address =>
		kit.getAddressDecoder().decode(seedBytes(fill));
	const user = await kit.createKeyPairSignerFromPrivateKeyBytes(seedBytes(1));
	const payer = await kit.createKeyPairSignerFromPrivateKeyBytes(
		seedBytes(2),
	);
	const baseMint = address(10);
	const platformConfig = address(11);
	const stakingMint = address(12);
	const missing = address(13);
	const lifetime = {
		blockhash: kit.blockhash(kit.getBase58Decoder().decode(seedBytes(7))),
		lastValidBlockHeight: 1_000n,
	};

	const [bondingCurveAddress, bondingCurveBump] =
		await launchpad.pda.findBondingCurvePda({
			baseMint,
			quoteMint: constants.WSOL_MINT,
		});
	const [poolAddress, poolBump] = await dex.pda.findPoolPda({
		baseMint,
		quoteMint: constants.USDC_MINT,
	});
	const [stakingConfigAddress, stakingConfigBump] =
		nexus.pda.findStakingConfigPda();
	const [userStakePositionAddress, userStakePositionBump] =
		await nexus.pda.findUserStakePositionPda({
			user: user.address,
			stakingMint,
		});

	const bondingCurveArgs = {
		version: 1,
		bump: bondingCurveBump,
		status: launchpad.types.BondingCurveStatus.Funding,
		baseMint,
		baseDecimals: 6,
		baseSupply: 1_000_000_000_000_000n,
		initialVirtualBase: 1_073_000_000_000_000n,
		initialVirtualQuote: 30_000_000_000n,
		initialRealBase: 793_100_000_000_000n,
		quoteMint: constants.WSOL_MINT,
		quoteDecimals: 9,
		coinCreator: address(20),
		padding0: [
			0x1515_1515_1515_1515n,
			0x1515_1515_1515_1515n,
			0x1515_1515_1515_1515n,
			0x1515_1515_1515_1515n,
		],
		partner: constants.DEFAULT_PARTNER,
		baseVault: address(22),
		quoteVault: address(23),
		virtualBaseReserves: U64_MAX,
		virtualQuoteReserves: 30_000_000_001n,
		realBaseReserves: 793_099_999_999_999n,
		realQuoteReserves: 1n,
		createdAt: -1_234_567_890n,
		protocolOwed: 42n,
		creatorOwed: 43n,
		platformConfig,
		creatorFeeMode: 255,
		creatorFeeBps: 100,
		dexCreatorFeeBps: 65_535,
		reserved: new Uint8Array(256).fill(9),
	};
	const poolArgs = {
		version: 1,
		bump: poolBump,
		status: dex.types.PoolStatus.Active,
		baseMint,
		baseDecimals: 6,
		quoteMint: constants.USDC_MINT,
		quoteDecimals: 6,
		coinCreator: address(30),
		padding0: [
			0x1f1f_1f1f_1f1f_1f1fn,
			0x1f1f_1f1f_1f1f_1f1fn,
			0x1f1f_1f1f_1f1f_1f1fn,
			0x1f1f_1f1f_1f1f_1f1fn,
		],
		baseVault: address(32),
		quoteVault: address(33),
		lpMint: address(34),
		lpSupply: 206_900_000_000_000n,
		baseReserves: U64_MAX - 1n,
		quoteReserves: 85_000_000_000n,
		quoteLedger: 85_000_000_001n,
		createdAt: 1_700_000_000n,
		protocolOwed: 0n,
		creatorOwed: U64_MAX,
		platformConfig,
		creatorFeeMode: 1,
		creatorFeeBps: 10,
		reserved: new Uint8Array(256).fill(3),
	};
	const stakingConfigArgs = {
		version: 1,
		bump: stakingConfigBump,
		stakingMint,
		totalStaked: U64_MAX,
		stakingEnabled: true,
		rewardCount: 3,
		reserved: new Uint8Array(64).fill(5),
	};

	const bondingCurveBytes = new Uint8Array(
		launchpad.accounts.getBondingCurveEncoder().encode(bondingCurveArgs),
	);
	const poolBytes = new Uint8Array(
		dex.accounts.getPoolEncoder().encode(poolArgs),
	);
	const stakingConfigBytes = new Uint8Array(
		nexus.accounts.getStakingConfigEncoder().encode(stakingConfigArgs),
	);
	assert.equal(
		bondingCurveBytes.length,
		launchpad.accounts.getBondingCurveSize(),
	);
	assert.equal(poolBytes.length, dex.accounts.getPoolSize());
	assert.equal(
		stakingConfigBytes.length,
		nexus.accounts.getStakingConfigSize(),
	);

	const transferHook = await transferHookCanary(sdk, kit);

	const stub = await startStubRpc(
		new Map<string, StoredAccount>([
			[
				bondingCurveAddress,
				{
					owner: constants.SEND_LAUNCHPAD_PROGRAM_ADDRESS,
					data: bondingCurveBytes,
				},
			],
			[
				poolAddress,
				{ owner: constants.SEND_DEX_PROGRAM_ADDRESS, data: poolBytes },
			],
			[
				stakingConfigAddress,
				{
					owner: constants.SEND_NEXUS_PROGRAM_ADDRESS,
					data: stakingConfigBytes,
				},
			],
		]),
	);
	try {
		const rpc = kit.createSolanaRpc(stub.url);

		const bondingCurve = await launchpad.accounts.fetchBondingCurve(
			rpc,
			bondingCurveAddress,
		);
		assert.deepStrictEqual(bondingCurve.data, {
			discriminator: new Uint8Array(
				launchpad.accounts.BONDING_CURVE_DISCRIMINATOR,
			),
			...bondingCurveArgs,
		});
		const pool = await dex.accounts.fetchPool(rpc, poolAddress);
		assert.deepStrictEqual(pool.data, {
			discriminator: new Uint8Array(dex.accounts.POOL_DISCRIMINATOR),
			...poolArgs,
		});
		const stakingConfig = await nexus.accounts.fetchStakingConfig(
			rpc,
			stakingConfigAddress,
		);
		assert.deepStrictEqual(stakingConfig.data, {
			discriminator: new Uint8Array(
				nexus.accounts.STAKING_CONFIG_DISCRIMINATOR,
			),
			...stakingConfigArgs,
		});
		assert.equal(
			bondingCurve.programAddress,
			constants.SEND_LAUNCHPAD_PROGRAM_ADDRESS,
		);

		let missingAccountError: Json = null;
		try {
			await dex.accounts.fetchPool(rpc, missing);
		} catch (error) {
			assert.ok(
				kit.isSolanaError(
					error,
					kit.SOLANA_ERROR__ACCOUNTS__ACCOUNT_NOT_FOUND,
				),
			);
			missingAccountError = {
				code: error.context.__code,
				isAppSolanaError: error instanceof kit.SolanaError,
			};
		}

		// An error raised inside program-client-core. With a second copy of
		// program-client-core it would not be an instance of the app's
		// SolanaError. Reflect.apply feeds the builder an input its types forbid.
		let programClientCoreError: Json = null;
		try {
			await Reflect.apply(
				launchpad.instructions.getBuyExactInInstructionAsync,
				undefined,
				[{}],
			);
		} catch (error) {
			assert.ok(kit.isSolanaError(error));
			programClientCoreError = {
				code: error.context.__code,
				isAppSolanaError: error instanceof kit.SolanaError,
			};
		}

		const buyExactIn =
			await launchpad.instructions.getBuyExactInInstructionAsync({
				user,
				payer,
				baseMint,
				quoteMint: constants.WSOL_MINT,
				partner: constants.DEFAULT_PARTNER,
				quoteTokenProgram: constants.TOKEN_PROGRAM_ADDRESS,
				amountIn: BUY_AMOUNT_IN,
				minAmountOut: BUY_MIN_AMOUNT_OUT,
				platformConfig,
			});
		assert.deepStrictEqual(
			new Uint8Array(buyExactIn.data),
			new Uint8Array([
				...launchpad.instructions.BUY_EXACT_IN_DISCRIMINATOR,
				...u64LittleEndian(BUY_AMOUNT_IN),
				...u64LittleEndian(BUY_MIN_AMOUNT_OUT),
			]),
		);
		const [userMeta, payerMeta, bondingCurveMeta] = buyExactIn.accounts;
		assert.deepStrictEqual(userMeta, {
			address: user.address,
			role: kit.AccountRole.READONLY_SIGNER,
			signer: user,
		});
		assert.deepStrictEqual(payerMeta, {
			address: payer.address,
			role: kit.AccountRole.WRITABLE_SIGNER,
			signer: payer,
		});
		assert.deepStrictEqual(bondingCurveMeta, {
			address: bondingCurveAddress,
			role: kit.AccountRole.WRITABLE,
		});

		const stake = await nexus.instructions.getStakeInstructionAsync({
			user,
			payer,
			stakingMint,
			amount: STAKE_AMOUNT,
		});

		const message = kit.pipe(
			kit.createTransactionMessage({ version: 0 }),
			(draft) => kit.setTransactionMessageFeePayerSigner(payer, draft),
			(draft) =>
				kit.setTransactionMessageLifetimeUsingBlockhash(
					lifetime,
					draft,
				),
			(draft) =>
				kit.appendTransactionMessageInstruction(buyExactIn, draft),
		);
		const signed = await kit.signTransactionMessageWithSigners(message);
		assert.deepStrictEqual(
			Object.keys(signed.signatures).toSorted(),
			[user.address, payer.address].toSorted(),
		);
		assert.ok(
			Object.values(signed.signatures).every(
				(signature) => signature !== null,
			),
		);

		const planner = kit.createTransactionPlanner({
			createTransactionMessage: () =>
				kit.pipe(
					kit.createTransactionMessage({ version: 0 }),
					(draft) =>
						kit.setTransactionMessageFeePayerSigner(payer, draft),
					(draft) =>
						kit.setTransactionMessageLifetimeUsingBlockhash(
							lifetime,
							draft,
						),
				),
		});
		const base: SolanaKit.ClientWithRpc<
			SolanaKit.GetAccountInfoApi & SolanaKit.GetMultipleAccountsApi
		> &
			SolanaKit.ClientWithPayer &
			SolanaKit.ClientWithTransactionPlanning &
			SolanaKit.ClientWithTransactionSending = {
			rpc,
			payer,
			planTransactions: (input, config) =>
				planner(kit.parseInstructionPlanInput(input), config),
			planTransaction: async (input, config) => {
				const plan = await planner(
					kit.parseInstructionPlanInput(input),
					config,
				);
				if (plan.kind !== 'single') {
					throw new Error(`planned ${plan.kind}, expected single`);
				}
				return plan.message;
			},
			sendTransaction: () =>
				Promise.reject(new Error('sending is not exercised')),
			sendTransactions: () =>
				Promise.reject(new Error('sending is not exercised')),
		};
		const client = kit
			.createClient(base)
			.use(launchpad.plugins.sendLaunchpadProgram())
			.use(dex.plugins.sendDexProgram())
			.use(nexus.plugins.sendNexusProgram());

		const pluginBondingCurve =
			await client.sendLaunchpad.accounts.bondingCurve.fetchMaybe(
				bondingCurveAddress,
			);
		const pluginMissing =
			await client.sendLaunchpad.accounts.bondingCurve.fetchMaybe(
				missing,
			);
		const pluginAllMaybe =
			await client.sendLaunchpad.accounts.bondingCurve.fetchAllMaybe([
				bondingCurveAddress,
				missing,
			]);
		const pluginPool =
			await client.sendDex.accounts.pool.fetchMaybe(poolAddress);
		const pluginStakingConfig =
			await client.sendNexus.accounts.stakingConfig.fetchMaybe(
				stakingConfigAddress,
			);
		assert.ok(pluginBondingCurve.exists);
		assert.deepStrictEqual(pluginBondingCurve.data, bondingCurve.data);
		assert.equal(pluginMissing.exists, false);
		assert.deepStrictEqual(
			pluginAllMaybe.map((account) => account.exists),
			[true, false],
		);
		assert.ok(pluginPool.exists);
		assert.deepStrictEqual(pluginPool.data, pool.data);
		assert.ok(pluginStakingConfig.exists);
		assert.deepStrictEqual(pluginStakingConfig.data, stakingConfig.data);

		// The plugin defaults `payer` from the client, so its planned message
		// must compile to the same bytes as the hand-built one.
		const pending = client.sendLaunchpad.instructions.buyExactIn({
			user,
			baseMint,
			quoteMint: constants.WSOL_MINT,
			partner: constants.DEFAULT_PARTNER,
			quoteTokenProgram: constants.TOKEN_PROGRAM_ADDRESS,
			amountIn: BUY_AMOUNT_IN,
			minAmountOut: BUY_MIN_AMOUNT_OUT,
			platformConfig,
		});
		const plannedMessage = await pending.planTransaction();
		const plannedBytes = new Uint8Array(
			kit.compileTransaction(plannedMessage).messageBytes,
		);
		const manualBytes = new Uint8Array(
			kit.compileTransaction(message).messageBytes,
		);
		assert.deepStrictEqual(plannedBytes, manualBytes);
		const stakePlan = await client.sendNexus.instructions
			.stake({ user, stakingMint, amount: STAKE_AMOUNT })
			.planTransactions();

		const describeInstruction = (
			instruction: SolanaKit.Instruction,
		): Json => ({
			programAddress: instruction.programAddress,
			accounts: (instruction.accounts ?? []).map((meta) => [
				meta.address,
				meta.role,
				'signer' in meta,
			]),
			data: `0x${toHex(new Uint8Array(instruction.data ?? []))}`,
		});

		return {
			signers: { user: user.address, payer: payer.address },
			pdas: {
				bondingCurve: [bondingCurveAddress, bondingCurveBump],
				pool: [poolAddress, poolBump],
				stakingConfig: [stakingConfigAddress, stakingConfigBump],
				userStakePosition: [
					userStakePositionAddress,
					userStakePositionBump,
				],
			},
			accountBytes: {
				bondingCurve: `0x${toHex(bondingCurveBytes)}`,
				pool: `0x${toHex(poolBytes)}`,
				stakingConfig: `0x${toHex(stakingConfigBytes)}`,
			},
			fetched: {
				bondingCurve: toJson(bondingCurve),
				pool: toJson(pool),
				stakingConfig: toJson(stakingConfig),
				missingAccountError,
			},
			instructions: {
				buyExactIn: describeInstruction(buyExactIn),
				stake: describeInstruction(stake),
				programClientCoreError,
			},
			signedWireTransaction: kit.getBase64EncodedWireTransaction(signed),
			transferHook,
			plugin: {
				bondingCurve: toJson(pluginBondingCurve),
				missing: toJson(pluginMissing),
				allMaybeExists: pluginAllMaybe.map((account) => account.exists),
				pool: toJson(pluginPool),
				stakingConfig: toJson(pluginStakingConfig),
				plannedMessage: `0x${toHex(plannedBytes)}`,
				stakePlanKind: stakePlan.kind,
			},
		};
	} finally {
		stub.close();
	}
}
