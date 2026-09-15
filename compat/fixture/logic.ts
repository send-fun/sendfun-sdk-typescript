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
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from 'node:http';
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
		creatorFeeConfig: address(21),
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
		reserved: new Uint8Array(64).fill(9),
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
		creatorFeeConfig: address(31),
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
		reserved: new Uint8Array(64).fill(3),
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
