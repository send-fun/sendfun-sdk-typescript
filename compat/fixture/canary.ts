/**
 * Must-fail canary. Each `// canary: TSxxxx` marker opens a block that has to
 * produce that error code and nothing else; the block runs to the next marker
 * or to `// canary: end`. No error may appear outside a block. If SDK or kit
 * types stop resolving they collapse to `any`, every misuse below compiles,
 * and the harness fails instead of reporting a clean typecheck.
 */
import { launchpad, nexus } from '@send-fun/sdk';
import {
	address,
	createClient,
	type ClientWithPayer,
	type ClientWithRpc,
	type ClientWithTransactionPlanning,
	type ClientWithTransactionSending,
	type GetAccountInfoApi,
	type GetMultipleAccountsApi,
	type TransactionSigner,
} from '@solana/kit';

declare const base: ClientWithRpc<GetAccountInfoApi & GetMultipleAccountsApi> &
	ClientWithPayer &
	ClientWithTransactionPlanning &
	ClientWithTransactionSending;
declare const user: TransactionSigner;

const client = createClient(base)
	.use(launchpad.plugins.sendLaunchpadProgram())
	.use(nexus.plugins.sendNexusProgram());
const lp = client.sendLaunchpad;
const where = address('11111111111111111111111111111111');
const buy = {
	user,
	baseMint: where,
	quoteMint: where,
	partner: where,
	quoteTokenProgram: where,
	amountIn: 1n,
	minAmountOut: 1n,
	platformConfig: where,
};

export async function canary(): Promise<unknown[]> {
	// canary: TS2345
	const byNumber = await lp.accounts.bondingCurve.fetchMaybe(123);
	// canary: TS2322
	const reserves: string = (await lp.accounts.bondingCurve.fetch(where)).data
		.virtualBaseReserves;
	// canary: TS2345
	const listed = await lp.accounts.globalConfig.fetchAllMaybe('not-a-list');
	// canary: TS2339
	const unknownAccount = lp.accounts.pool;
	// canary: TS2322
	const sendAll: number = lp.instructions.buyExactIn(buy).sendTransactions;
	// canary: TS2322
	const wrongAmount = lp.instructions.buyExactIn({ ...buy, amountIn: 'x' });
	// canary: TS2345
	const noAmount = client.sendNexus.instructions.stake({
		user,
		stakingMint: where,
	});
	// canary: TS2345
	const bare = createClient({}).use(launchpad.plugins.sendLaunchpadProgram());
	// canary: TS2559
	const planned = await lp.instructions.buyExactIn(buy).planTransaction(42);
	// canary: TS2554
	const extraSeed = lp.pdas.bondingCurve(
		{ baseMint: where, quoteMint: where },
		1,
	);
	// canary: end
	return [
		byNumber,
		reserves,
		listed,
		unknownAccount,
		sendAll,
		wrongAmount,
		noAmount,
		bare,
		planned,
		extraSeed,
	];
}
