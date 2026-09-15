/**
 * Compile-only consumer of the packed SDK; it must typecheck cleanly. The
 * `Expect<NotAny<...>>` checks fail when a declaration spells out `any`. They
 * cannot catch an import that stops resolving: TypeScript suppresses errors
 * cascading from the resulting error type, which is what canary.ts is for.
 * The harness compiles a `.cts` copy too, against the CommonJS declarations.
 */
import { constants, dex, launchpad, nexus } from '@send-fun/sdk';
import {
	address,
	createClient,
	createSolanaRpc,
	type Address,
	type ClientWithPayer,
	type ClientWithRpc,
	type ClientWithTransactionPlanning,
	type ClientWithTransactionSending,
	type GetAccountInfoApi,
	type GetMultipleAccountsApi,
	type Instruction,
	type MaybeAccount,
	type TransactionSigner,
} from '@solana/kit';

type IsAny<T> = 0 extends 1 & T ? true : false;
type NotAny<T> = IsAny<T> extends true ? false : true;
/** Mutual assignability; `NotAny` checks cover the `any` case this cannot. */
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;

/** A hand-written client that meets the plugin requirements with kit types only. */
declare const base: ClientWithRpc<GetAccountInfoApi & GetMultipleAccountsApi> &
	ClientWithPayer &
	ClientWithTransactionPlanning &
	ClientWithTransactionSending;
declare const user: TransactionSigner;

const client = createClient(base)
	.use(launchpad.plugins.sendLaunchpadProgram())
	.use(dex.plugins.sendDexProgram())
	.use(nexus.plugins.sendNexusProgram());

type BuyInput = Parameters<
	typeof client.sendLaunchpad.instructions.buyExactIn
>[0];
type PendingBuy = ReturnType<
	typeof client.sendLaunchpad.instructions.buyExactIn
>;
type FetchedCurve = Awaited<
	ReturnType<typeof client.sendLaunchpad.accounts.bondingCurve.fetchMaybe>
>;
type PlannedMessage = Awaited<ReturnType<PendingBuy['planTransaction']>>;
type SentResult = Awaited<ReturnType<PendingBuy['sendTransaction']>>;
type DirectFetchRpc = Parameters<
	typeof launchpad.accounts.fetchBondingCurve
>[0];

export type TypeChecks = [
	Expect<NotAny<typeof client.sendLaunchpad>>,
	Expect<NotAny<typeof client.sendDex.accounts.pool>>,
	Expect<NotAny<typeof client.sendNexus.instructions.stake>>,
	Expect<NotAny<BuyInput>>,
	Expect<NotAny<PendingBuy>>,
	Expect<NotAny<PendingBuy['planTransaction']>>,
	Expect<NotAny<PlannedMessage>>,
	Expect<NotAny<SentResult>>,
	Expect<NotAny<FetchedCurve>>,
	Expect<NotAny<DirectFetchRpc>>,
	Expect<NotAny<launchpad.plugins.SendLaunchpadPluginRequirements>>,
	Expect<Equals<FetchedCurve, MaybeAccount<launchpad.accounts.BondingCurve>>>,
	Expect<
		Equals<launchpad.accounts.BondingCurve['virtualBaseReserves'], bigint>
	>,
	Expect<Equals<dex.accounts.Pool['baseMint'], Address>>,
	Expect<Equals<nexus.accounts.StakingConfig['stakingEnabled'], boolean>>,
	Expect<Awaited<PendingBuy> extends Instruction ? true : false>,
	Expect<
		BuyInput['payer'] extends TransactionSigner | undefined ? true : false
	>,
];

export async function usage(where: Address): Promise<bigint> {
	const curve =
		await client.sendLaunchpad.accounts.bondingCurve.fetchMaybe(where);
	const pool = await client.sendDex.accounts.pool.fetch(where);
	const pending = client.sendLaunchpad.instructions.buyExactIn({
		user,
		baseMint: address('11111111111111111111111111111111'),
		quoteMint: constants.WSOL_MINT,
		partner: constants.DEFAULT_PARTNER,
		quoteTokenProgram: constants.TOKEN_PROGRAM_ADDRESS,
		amountIn: 1n,
		minAmountOut: 1n,
		platformConfig: where,
	});
	const message = await pending.planTransaction();
	const staked = await client.sendNexus.instructions
		.stake({ user, stakingMint: where, amount: 1n })
		.sendTransaction();
	const instruction =
		await launchpad.instructions.getBuyExactInInstructionAsync({
			user,
			payer: base.payer,
			baseMint: where,
			quoteMint: constants.USDC_MINT,
			partner: constants.DEFAULT_PARTNER,
			quoteTokenProgram: constants.TOKEN_PROGRAM_ADDRESS,
			amountIn: 1n,
			minAmountOut: 1n,
			platformConfig: where,
		});
	const direct = await launchpad.accounts.fetchMaybeBondingCurve(
		createSolanaRpc('http://127.0.0.1:8899'),
		where,
	);
	const planned: Instruction = instruction;
	return (
		(curve.exists ? curve.data.virtualBaseReserves : 0n) +
		pool.data.baseReserves +
		(direct.exists ? direct.data.realQuoteReserves : 0n) +
		BigInt(message.instructions.length) +
		BigInt(staked.kind.length) +
		BigInt(planned.programAddress.length)
	);
}
