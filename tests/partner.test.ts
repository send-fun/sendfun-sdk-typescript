import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	AccountRole,
	address,
	createNoopSigner,
	type Instruction,
} from '@solana/kit';
import {
	DEFAULT_PARTNER,
	TOKEN_PROGRAM_ADDRESS,
	WSOL_MINT,
} from '../src/constants.js';
import * as dex from '../src/dex/trade.js';
import { buildCreateTokenInstruction } from '../src/launchpad/create.js';
import * as launchpad from '../src/launchpad/trade.js';
import type { PartnerInput } from '../src/utils/partner.js';

const USER = createNoopSigner(
	address('BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND'),
);
const BASE_MINT = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const PLATFORM_CONFIG = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const TRADE_PARTNER_INDEX = 9;
const CREATE_PARTNER_INDEX = 12;

const TRADE = {
	user: USER,
	baseMint: BASE_MINT,
	quoteMint: WSOL_MINT,
	platformConfig: PLATFORM_CONFIG,
	quoteTokenProgram: TOKEN_PROGRAM_ADDRESS,
} as const;
const EXACT_IN = { amountIn: 1_000n, minAmountOut: 900n } as const;
const EXACT_OUT = { amountOut: 1_000n, maxAmountIn: 1_100n } as const;

const BUILDERS: readonly {
	name: string;
	index: number;
	build: (partner: PartnerInput) => Promise<Instruction>;
}[] = [
	{
		name: 'launchpad buyExactIn',
		index: TRADE_PARTNER_INDEX,
		build: (partner) =>
			launchpad.buildBuyExactInInstruction({
				...TRADE,
				...EXACT_IN,
				partner,
			}),
	},
	{
		name: 'launchpad buyExactOut',
		index: TRADE_PARTNER_INDEX,
		build: (partner) =>
			launchpad.buildBuyExactOutInstruction({
				...TRADE,
				...EXACT_OUT,
				partner,
			}),
	},
	{
		name: 'launchpad sellExactIn',
		index: TRADE_PARTNER_INDEX,
		build: (partner) =>
			launchpad.buildSellExactInInstruction({
				...TRADE,
				...EXACT_IN,
				partner,
			}),
	},
	{
		name: 'launchpad sellExactOut',
		index: TRADE_PARTNER_INDEX,
		build: (partner) =>
			launchpad.buildSellExactOutInstruction({
				...TRADE,
				...EXACT_OUT,
				partner,
			}),
	},
	{
		name: 'dex buyExactIn',
		index: TRADE_PARTNER_INDEX,
		build: (partner) =>
			dex.buildBuyExactInInstruction({ ...TRADE, ...EXACT_IN, partner }),
	},
	{
		name: 'dex buyExactOut',
		index: TRADE_PARTNER_INDEX,
		build: (partner) =>
			dex.buildBuyExactOutInstruction({
				...TRADE,
				...EXACT_OUT,
				partner,
			}),
	},
	{
		name: 'dex sellExactIn',
		index: TRADE_PARTNER_INDEX,
		build: (partner) =>
			dex.buildSellExactInInstruction({ ...TRADE, ...EXACT_IN, partner }),
	},
	{
		name: 'dex sellExactOut',
		index: TRADE_PARTNER_INDEX,
		build: (partner) =>
			dex.buildSellExactOutInstruction({
				...TRADE,
				...EXACT_OUT,
				partner,
			}),
	},
	{
		name: 'launchpad createToken',
		index: CREATE_PARTNER_INDEX,
		build: (partner) =>
			buildCreateTokenInstruction({
				user: USER,
				coinCreator: USER.address,
				baseMint: createNoopSigner(BASE_MINT),
				quoteMint: WSOL_MINT,
				name: 'Partner',
				symbol: 'PTNR',
				uri: 'https://send.fun/partner.json',
				creatorPlatform: 'wallet',
				creatorId: USER.address,
				partner,
				platformConfig: PLATFORM_CONFIG,
				quoteTokenProgram: TOKEN_PROGRAM_ADDRESS,
			}),
	},
];

describe('partner account', () => {
	for (const { name, index, build } of BUILDERS) {
		it(`${name}: a TransactionSigner partner is a readonly signer`, async () => {
			const partner = createNoopSigner(
				address('7NsngNMtXJNdHgeK4znQDZ5PJ19ykVvQvEF7BT5KFjMv'),
			);
			const meta = (await build(partner)).accounts?.[index];
			assert.ok(meta);
			assert.equal(meta.address, partner.address);
			assert.equal(meta.role, AccountRole.READONLY_SIGNER);
		});

		it(`${name}: DEFAULT_PARTNER stays a bare readonly account`, async () => {
			const meta = (await build(DEFAULT_PARTNER)).accounts?.[index];
			assert.ok(meta);
			assert.equal(meta.address, DEFAULT_PARTNER);
			assert.equal(meta.role, AccountRole.READONLY);
		});
	}
});
