import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { address, createNoopSigner, type Instruction } from '@solana/kit';

import {
	DEFAULT_PARTNER,
	TOKEN_2022_PROGRAM_ADDRESS,
	TOKEN_PROGRAM_ADDRESS,
	WSOL_MINT,
} from '../src/constants.js';
import { AccountRole } from '@solana/kit';
import * as dex from '../src/dex/index.js';
import * as launchpad from '../src/launchpad/index.js';
import {
	buyExactIn,
	calculateSlippageDown,
	type MintFee,
} from '../src/math/amm.js';

const USER = address('BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND');
const BASE_MINT = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
/** Live mainnet Token-2022 mint; its 20 bps schedule prices the figures below. */
const TKALSHI_MINT = address('TKLSidmLVt3cqGaaodG8tyRzoANfQwoh67AccjmubeZ');
/** Neither user's ATA: the builder must place it verbatim, not re-derive it. */
const AUX = address('6ksD4MwN1XHsts93q7e8VaYZsb3rxCPeBYQpdsBDiHyJ');
const SENDFUN_PLATFORM_ADDRESS = address(
	'2PJedAsa7pCnScks2XM3U4o2nPaTvvBmi2553VcCnGWB',
);

const TWENTY_BPS: MintFee = {
	bps: 20,
	maximumFee: 18_446_744_073_709_551_615n,
};

const FEE_BPS = 100;
const SLIPPAGE_BPS = 100;
const FIRST_BUY = 1_000_000_000n;

const CHARGING_BASE_TO_USER = 31_883_934_501n;
const CHARGING_MIN_AMOUNT_OUT = 31_565_095_155n;
const FEELESS_MIN_AMOUNT_OUT = 31_626_331_074n;

const user = createNoopSigner(USER);

const SHARED = {
	user,
	baseMint: BASE_MINT,
	quoteMint: WSOL_MINT,
	quoteTokenProgram: TOKEN_PROGRAM_ADDRESS,
	feeBps: 100,
	slippageBps: 100,
	partner: DEFAULT_PARTNER,
	platformConfig: SENDFUN_PLATFORM_ADDRESS,
} as const;

const CURVE_RESERVES = {
	virtualBaseReserves: 1_000_000_000_000n,
	virtualQuoteReserves: 30_000_000_000n,
	realBaseReserves: 793_100_000_000n,
} as const;

describe('trade builders pass user token accounts through', () => {
	it('launchpad buyExactIn places an explicit userBaseAccount in the instruction', async () => {
		const { instruction } = await launchpad.trade.buyExactIn({
			...SHARED,
			...CURVE_RESERVES,
			quoteAmountIn: 1_000_000_000n,
			userBaseAccount: AUX,
		});

		const addresses = (instruction.accounts ?? []).map((a) => a.address);
		assert.equal(
			addresses.includes(AUX),
			true,
			'the explicit base account reached the instruction',
		);
	});

	it('launchpad sellExactIn places an explicit userBaseAccount in the instruction', async () => {
		const { instruction } = await launchpad.trade.sellExactIn({
			...SHARED,
			...CURVE_RESERVES,
			baseAmountIn: 1_000_000_000n,
			userBaseAccount: AUX,
		});

		const addresses = (instruction.accounts ?? []).map((a) => a.address);
		assert.equal(addresses.includes(AUX), true);
	});

	it('dex buyExactIn places an explicit userBaseAccount in the instruction', async () => {
		const { instruction } = await dex.trade.buyExactIn({
			...SHARED,
			baseReserves: 1_000_000_000_000n,
			quoteReserves: 30_000_000_000n,
			quoteAmountIn: 1_000_000_000n,
			userBaseAccount: AUX,
		});

		const addresses = (instruction.accounts ?? []).map((a) => a.address);
		assert.equal(addresses.includes(AUX), true);
	});

	it('dex sellExactIn places an explicit userBaseAccount in the instruction', async () => {
		const { instruction } = await dex.trade.sellExactIn({
			...SHARED,
			baseReserves: 1_000_000_000_000n,
			quoteReserves: 30_000_000_000n,
			baseAmountIn: 1_000_000_000n,
			userBaseAccount: AUX,
		});

		const addresses = (instruction.accounts ?? []).map((a) => a.address);
		assert.equal(addresses.includes(AUX), true);
	});

	// Omitted, the slot falls to the ATA the generated client derives from the IDL `pda`.
	it('launchpad buyExactIn defaults the base slot to the user’s ATA', async () => {
		const { instruction } = await launchpad.trade.buyExactIn({
			...SHARED,
			...CURVE_RESERVES,
			quoteAmountIn: 1_000_000_000n,
		});

		const addresses = (instruction.accounts ?? []).map((a) => a.address);
		assert.equal(
			addresses.includes(AUX),
			false,
			'nothing but the derived ATA occupies the slot',
		);
	});
});

describe('create-and-buy appends the buy to the create', () => {
	const PARTNER = address('Hs3bBEkKQaR9dGkFpQyBtnQvHXWyKMYyYnFVLZ4WM5Ac');
	// A signer on purpose: the `PartnerConfig` PDA seed must accept one without throwing.
	const partner = createNoopSigner(PARTNER);

	it('emits the create then a buy against the same curve', async () => {
		const baseMint = createNoopSigner(BASE_MINT);
		const { instructions } =
			await launchpad.create.buildCreateAndBuyInstructions({
				user,
				coinCreator: USER,
				baseMint,
				quoteMint: WSOL_MINT,
				quoteTokenProgram: TOKEN_PROGRAM_ADDRESS,
				partner,
				platformConfig: SENDFUN_PLATFORM_ADDRESS,
				name: 'Test',
				symbol: 'TEST',
				uri: 'https://example.com/t.json',
				creatorPlatform: 'wallet',
				creatorId: USER,
				initialVirtualBaseReserves: CURVE_RESERVES.virtualBaseReserves,
				initialVirtualQuoteReserves:
					CURVE_RESERVES.virtualQuoteReserves,
				initialRealBaseReserves: CURVE_RESERVES.realBaseReserves,
				feeBps: 100,
				slippageBps: 100,
				buyQuoteAmount: 1_000_000_000n,
			});

		assert.equal(instructions.length, 2);

		const [bondingCurve] = await launchpad.pda.findBondingCurvePda({
			baseMint: BASE_MINT,
			quoteMint: WSOL_MINT,
		});
		const curveSlot = (instructions[1]?.accounts ?? []).find(
			(a) => a.address === bondingCurve,
		);
		assert.notEqual(
			curveSlot,
			undefined,
			'the buy names the created curve',
		);
		assert.equal(curveSlot?.role, AccountRole.WRITABLE);
	});

	// Without the quote schedule the first-buy bound ignores the mint's cut and sits
	// above the correct one; a cut above slippage reverts the launch.
	describe('with a quote mint that charges in transit', () => {
		async function buildFirstBuy(quoteFee?: MintFee): Promise<Instruction> {
			const { instructions } =
				await launchpad.create.buildCreateAndBuyInstructions({
					user,
					coinCreator: USER,
					baseMint: createNoopSigner(BASE_MINT),
					// WSOL is classic SPL and cannot carry a transfer-fee schedule.
					quoteMint: TKALSHI_MINT,
					quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
					partner,
					platformConfig: SENDFUN_PLATFORM_ADDRESS,
					name: 'Test',
					symbol: 'TEST',
					uri: 'https://example.com/t.json',
					creatorPlatform: 'wallet',
					creatorId: USER,
					initialVirtualBaseReserves:
						CURVE_RESERVES.virtualBaseReserves,
					initialVirtualQuoteReserves:
						CURVE_RESERVES.virtualQuoteReserves,
					initialRealBaseReserves: CURVE_RESERVES.realBaseReserves,
					feeBps: FEE_BPS,
					slippageBps: SLIPPAGE_BPS,
					buyQuoteAmount: FIRST_BUY,
					quoteFee,
				});

			const buy = instructions.at(1);
			if (buy === undefined) {
				throw new Error('the builder appended no buy instruction');
			}
			return buy;
		}

		function decodeBuy(instruction: Instruction): bigint {
			const { data } = instruction;
			if (data === undefined) {
				throw new Error('the appended buy carries no instruction data');
			}
			return launchpad.instructions
				.getBuyExactInInstructionDataDecoder()
				.decode(data).minAmountOut;
		}

		it('bounds the appended buy on the base the creator is credited', async () => {
			const quote = buyExactIn({
				reserveQuote: CURVE_RESERVES.virtualQuoteReserves,
				reserveBase: CURVE_RESERVES.virtualBaseReserves,
				quoteAmountIn: FIRST_BUY,
				feeBps: FEE_BPS,
				quoteFee: TWENTY_BPS,
				baseReserveCap: CURVE_RESERVES.realBaseReserves,
			});

			assert.equal(quote.quoteTransferFee, 2_000_000n);
			assert.equal(quote.baseToUser, CHARGING_BASE_TO_USER);
			assert.equal(
				calculateSlippageDown(quote.baseToUser, SLIPPAGE_BPS),
				CHARGING_MIN_AMOUNT_OUT,
			);
			assert.equal(
				decodeBuy(await buildFirstBuy(TWENTY_BPS)),
				CHARGING_MIN_AMOUNT_OUT,
			);
		});

		it('encodes the fee-less bound when the schedule is withheld', async () => {
			assert.equal(
				decodeBuy(await buildFirstBuy()),
				FEELESS_MIN_AMOUNT_OUT,
			);
			assert.equal(
				FEELESS_MIN_AMOUNT_OUT - CHARGING_MIN_AMOUNT_OUT,
				61_235_919n,
				'the fee-less bound sits this far above the credited one',
			);
		});
	});
});
