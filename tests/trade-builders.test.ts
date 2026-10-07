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
/** Mainnet Token-2022 mint. The figures below use its 20 bps transfer fee. */
const TKALSHI_MINT = address('TKLSidmLVt3cqGaaodG8tyRzoANfQwoh67AccjmubeZ');
/** Not an ATA of the user. The builder must pass it unchanged. */
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

const CREATOR_FEE_TERMS = {
	creatorFeeMode: 0,
	creatorFeeBps: 30,
	dexCreatorFeeBps: 10,
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

	// When omitted, the generated client derives the ATA from the IDL `pda`.
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

function decodeBuy(instruction: Instruction): bigint {
	const { data } = instruction;
	if (data === undefined) {
		throw new Error('the appended buy carries no instruction data');
	}
	return launchpad.instructions
		.getBuyExactInInstructionDataDecoder()
		.decode(data).minAmountOut;
}

describe('create-and-buy appends the buy to the create', () => {
	const PARTNER = address('Hs3bBEkKQaR9dGkFpQyBtnQvHXWyKMYyYnFVLZ4WM5Ac');
	// A signer on purpose: the `PartnerConfig` PDA seed must accept one.
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
				...CREATOR_FEE_TERMS,
				initialVirtualBaseReserves: CURVE_RESERVES.virtualBaseReserves,
				initialVirtualQuoteReserves:
					CURVE_RESERVES.virtualQuoteReserves,
				initialRealBaseReserves: CURVE_RESERVES.realBaseReserves,
				feeBps: 100,
				slippageBps: 100,
				buyQuoteAmount: 1_000_000_000n,
			});

		assert.equal(instructions.length, 2);

		const createData = instructions[0]?.data;
		if (createData === undefined) {
			throw new Error('the create carries no instruction data');
		}
		const createArgs = launchpad.instructions
			.getCreateTokenInstructionDataDecoder()
			.decode(createData);
		assert.equal(createArgs.creatorFeeMode, 0);
		assert.equal(createArgs.creatorFeeBps, 30);
		assert.equal(createArgs.dexCreatorFeeBps, 10);

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

	it('names coinCreator as given, derives the creator fee config PDA and encodes no creator identity', async () => {
		const coinCreator = address(
			'9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
		);
		const create = await launchpad.create.buildCreateTokenInstruction({
			user,
			coinCreator,
			baseMint: createNoopSigner(BASE_MINT),
			quoteMint: TKALSHI_MINT,
			quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
			partner,
			platformConfig: SENDFUN_PLATFORM_ADDRESS,
			name: 'Test',
			symbol: 'TEST',
			uri: 'https://example.com/t.json',
			...CREATOR_FEE_TERMS,
		});

		const accounts = create.accounts ?? [];
		assert.equal(accounts.length, 28);
		assert.equal(accounts[0]?.address, USER);
		assert.equal(accounts[0]?.role, AccountRole.WRITABLE_SIGNER);
		assert.equal(accounts[2]?.address, coinCreator);
		assert.equal(accounts[2]?.role, AccountRole.READONLY);
		// `["creator_fee_config", BASE_MINT, TKALSHI_MINT]` under the launchpad.
		assert.equal(
			accounts[9]?.address,
			'3njD8ZFphZUA3B27h9rKULMnqJV7RP5iFF1u1UEP4CjK',
		);
		assert.equal(
			accounts[9]?.address,
			(
				await launchpad.pda.findCreatorFeeConfigPda({
					baseMint: BASE_MINT,
					quoteMint: TKALSHI_MINT,
				})
			)[0],
		);
		assert.notEqual(
			accounts[9]?.address,
			(
				await dex.pda.findCreatorFeeConfigPda({
					baseMint: BASE_MINT,
					quoteMint: TKALSHI_MINT,
				})
			)[0],
		);
		assert.equal(accounts[9]?.role, AccountRole.WRITABLE);

		if (create.data === undefined) {
			throw new Error('the create carries no instruction data');
		}
		const args = launchpad.instructions
			.getCreateTokenInstructionDataDecoder()
			.decode(create.data);
		const { discriminator, ...decoded } = args;
		assert.deepEqual(
			discriminator,
			launchpad.instructions.CREATE_TOKEN_DISCRIMINATOR,
		);
		assert.deepEqual(decoded, {
			platformConfig: SENDFUN_PLATFORM_ADDRESS,
			name: 'Test',
			symbol: 'TEST',
			uri: 'https://example.com/t.json',
			creatorFeeMode: 0,
			creatorFeeBps: 30,
			dexCreatorFeeBps: 10,
		});
		// 8 discriminator, 32 platformConfig, 4 + 4 name, 4 + 4 symbol, 4 + 26 uri,
		// 1 + 2 + 2 fee terms (mode, bps, pool bps).
		assert.equal(create.data.length, 91);
	});

	// `migrate` refuses any creator fee config address but the two PDAs.
	it('derives the curve and the pool creator fee config PDAs for migrate', async () => {
		const migrate = await launchpad.migrate.buildMigrateInstruction({
			caller: user,
			baseMint: BASE_MINT,
			quoteMint: TKALSHI_MINT,
			quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
		});

		const accounts = migrate.accounts ?? [];
		assert.equal(accounts.length, 23);
		// `["creator_fee_config", BASE_MINT, TKALSHI_MINT]` under the launchpad.
		assert.equal(
			accounts[15]?.address,
			'3njD8ZFphZUA3B27h9rKULMnqJV7RP5iFF1u1UEP4CjK',
		);
		assert.equal(
			accounts[15]?.address,
			(
				await launchpad.pda.findCreatorFeeConfigPda({
					baseMint: BASE_MINT,
					quoteMint: TKALSHI_MINT,
				})
			)[0],
		);
		assert.equal(accounts[15]?.role, AccountRole.WRITABLE);
		// The same seeds under the dex.
		assert.equal(
			accounts[22]?.address,
			'CZgYKqL9TydsDxinjFT84d6htBT6uaYnc8pZtKB7GBiU',
		);
		assert.equal(
			accounts[22]?.address,
			(
				await dex.pda.findCreatorFeeConfigPda({
					baseMint: BASE_MINT,
					quoteMint: TKALSHI_MINT,
				})
			)[0],
		);
		assert.equal(accounts[22]?.role, AccountRole.WRITABLE);
	});

	async function buildFirstBuy(quoteFee?: MintFee): Promise<Instruction> {
		const { instructions } =
			await launchpad.create.buildCreateAndBuyInstructions({
				user,
				coinCreator: USER,
				baseMint: createNoopSigner(BASE_MINT),
				// WSOL is classic SPL and has no transfer fee.
				quoteMint: TKALSHI_MINT,
				quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
				partner,
				platformConfig: SENDFUN_PLATFORM_ADDRESS,
				name: 'Test',
				symbol: 'TEST',
				uri: 'https://example.com/t.json',
				...CREATOR_FEE_TERMS,
				initialVirtualBaseReserves: CURVE_RESERVES.virtualBaseReserves,
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

	// Without `quoteFee`, the first-buy minimum ignores the mint's cut and is too
	// high. A cut above slippage then makes the launch fail.
	describe('with a quote mint that charges in transit', () => {
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

describe('launchpad buyExactOut signs an amount the curve can deliver', () => {
	const decoder =
		launchpad.instructions.getBuyExactOutInstructionDataDecoder();
	const CAP = 1_000_000_000n;

	function signed(instruction: Instruction) {
		return decoder.decode(instruction.data ?? new Uint8Array());
	}

	it('passes a request under the supply left through unchanged', async () => {
		const { instruction, quote } = await launchpad.trade.buyExactOut({
			...SHARED,
			...CURVE_RESERVES,
			baseAmountOut: 10_000_000_000n,
		});

		assert.equal(quote.baseToUser, 10_000_000_000n);
		assert.equal(signed(instruction).amountOut, 10_000_000_000n);
	});

	it('clamps a request over the supply left to the capped fill', async () => {
		const { instruction, quote } = await launchpad.trade.buyExactOut({
			...SHARED,
			...CURVE_RESERVES,
			realBaseReserves: CAP,
			baseAmountOut: 5_000_000_000n,
		});

		assert.equal(quote.baseToUser, CAP);
		assert.equal(signed(instruction).amountOut, CAP);
	});

	it('clamps to what the buyer nets once the base mint takes its cut', async () => {
		const { instruction, quote } = await launchpad.trade.buyExactOut({
			...SHARED,
			...CURVE_RESERVES,
			realBaseReserves: CAP,
			baseFee: TWENTY_BPS,
			baseAmountOut: 5_000_000_000n,
		});

		assert.equal(quote.baseAmount, CAP);
		assert.equal(quote.baseToUser, 998_000_000n);
		assert.equal(signed(instruction).amountOut, 998_000_000n);
	});
});
