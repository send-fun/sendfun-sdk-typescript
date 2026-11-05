// The trade legs, which both programs move the same way. Rust
// `utils::legs_of_trade`.

import type { Address } from '@solana/kit';

import type { HookLeg, HookLegs } from './resolver.js';

/** The accounts of a trade its legs read. */
export interface TradeLegAccounts {
	readonly user: Address;
	readonly market: Address;
	readonly baseMint: Address;
	readonly quoteMint: Address;
	readonly baseVault: Address;
	readonly quoteVault: Address;
	readonly userBaseAccount: Address;
	readonly userQuoteAccount: Address;
}

/** Rust `legs_of_trade`. A buy moves quote from the user's account to the quote vault, signed by
 *  `user`, then base from the base vault to the user's account, signed by the market. A sell moves
 *  base in, then quote out. The handler checks that `user` owns both user accounts. */
export function tradeLegsOf(
	direction: 'buy' | 'sell',
	accounts: TradeLegAccounts,
	layout: { readonly writesMarket: boolean },
): HookLegs {
	const a = accounts;
	const intoMarket = (
		source: Address,
		mint: Address,
		vault: Address,
	): HookLeg => ({
		source,
		mint,
		destination: vault,
		authority: a.user,
		destinationOwner: a.market,
	});
	const outOfMarket = (
		vault: Address,
		mint: Address,
		destination: Address,
	): HookLeg => ({
		source: vault,
		mint,
		destination,
		authority: a.market,
		destinationOwner: a.user,
	});
	const legs =
		direction === 'buy'
			? [
					intoMarket(a.userQuoteAccount, a.quoteMint, a.quoteVault),
					outOfMarket(a.baseVault, a.baseMint, a.userBaseAccount),
				]
			: [
					intoMarket(a.userBaseAccount, a.baseMint, a.baseVault),
					outOfMarket(a.quoteVault, a.quoteMint, a.userQuoteAccount),
				];
	return { legs, written: layout.writesMarket ? [a.market] : [] };
}
