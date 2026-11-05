import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	AccountRole,
	address,
	createNoopSigner,
	type Address,
	type Instruction,
} from '@solana/kit';

import {
	DEFAULT_PARTNER,
	TOKEN_2022_PROGRAM_ADDRESS,
	TOKEN_PROGRAM_ADDRESS,
	USDC_MINT,
	USDC_MINT_INFO,
	WSOL_MINT,
	WSOL_MINT_INFO,
} from '../src/constants.js';
import * as dex from '../src/dex/index.js';
import * as launchpad from '../src/launchpad/index.js';
import * as amm from '../src/math/amm.js';
import {
	buyExactIn,
	calculateSlippageDown,
	type MintFee,
} from '../src/math/amm.js';
import type { MintInfo } from '../src/utils/mint-info.js';
import * as utils from '../src/utils/index.js';
import { snapshot } from './support/hook-free-cases.js';
import { flatFee, plainMintInfo, steadyFee } from './support/mint-infos.js';

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

const BASE_INFO = plainMintInfo(BASE_MINT);

const SHARED = {
	user,
	baseMintInfo: BASE_INFO,
	quoteMintInfo: WSOL_MINT_INFO,
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

// Create and create-and-buy build these instructions from a `baseMint` signer.
const CREATE_GOLDEN = {
	programAddress: '5R1uFyEE4oxqkm7hJDqHq6gXaLVF9dxeF3LF4yz1sfLP',
	accounts: [
		[
			'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
			AccountRole.WRITABLE_SIGNER,
		],
		[
			'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
			AccountRole.WRITABLE_SIGNER,
		],
		['BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND', AccountRole.READONLY],
		['H3csa1cgR7zPJdxCzNbS5chYymHMKS3XivDA5nRx4Bdq', AccountRole.READONLY],
		[
			'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
			AccountRole.WRITABLE_SIGNER,
		],
		['So11111111111111111111111111111111111111112', AccountRole.READONLY],
		['3NAFktzFtM2q9P5JjBMqCnyBGRFVG8R9Z9J3akDKFxdt', AccountRole.WRITABLE],
		['7N5KNX4rq8BuVTuriwmFEFTthNWBs9AFg3F2CmNU2qkr', AccountRole.WRITABLE],
		['D731jS3YpCg4vDbEaiqBRzy8Aqm1jSkJHzBjfpA32vja', AccountRole.WRITABLE],
		['BaNFxXrNPPuDtM3PD5jBfEYmAf6JHbFJzVKWfr6FHiGX', AccountRole.WRITABLE],
		['7rrCurqdWFesbzwtYPo95fM8waTtVXgXwCom45x1sfNX', AccountRole.READONLY],
		['3bycfBeRULfXYqcg3DmiYFBjv6mMVidMuqKdFZJTGdNr', AccountRole.READONLY],
		['11111111111111111111111111111111', AccountRole.READONLY],
		['B77P3Hvj9xLi4tcFtyjNcf6NjhkQrfJvLkz3nVZnBzec', AccountRole.READONLY],
		['9WUowYRb6KAWjWVB5KMmTngBidZXEXgQcQRTXbhxeGbF', AccountRole.READONLY],
		['B9Z3t5c3AFtbuUfdeK41zGGL3dQ2AkgtGCjTcakZYwFr', AccountRole.WRITABLE],
		['91AVurtPdUC2yG3joLoujzC216KAfH5HEKnZEELFMmVH', AccountRole.WRITABLE],
		['AyisZJxXz9ywXhMwR3sb3oePxBB6UBvixXycAQCdSgrz', AccountRole.WRITABLE],
		['AyisZJxXz9ywXhMwR3sb3oePxBB6UBvixXycAQCdSgrz', AccountRole.WRITABLE],
		['91AVurtPdUC2yG3joLoujzC216KAfH5HEKnZEELFMmVH', AccountRole.WRITABLE],
		['7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE', AccountRole.READONLY],
		['TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', AccountRole.READONLY],
		['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', AccountRole.READONLY],
		['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', AccountRole.READONLY],
		['ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', AccountRole.READONLY],
		['11111111111111111111111111111111', AccountRole.READONLY],
		['FJVebqCthxH6JM8vvkJb7yRYA7Emsib1C1vu4ZePSP3T', AccountRole.READONLY],
		['5R1uFyEE4oxqkm7hJDqHq6gXaLVF9dxeF3LF4yz1sfLP', AccountRole.READONLY],
	],
	data: [
		84, 52, 204, 228, 24, 140, 234, 75, 20, 146, 107, 143, 82, 194, 216,
		153, 89, 206, 66, 186, 99, 124, 181, 109, 139, 11, 254, 136, 150, 31,
		161, 186, 90, 231, 197, 195, 57, 48, 69, 80, 4, 0, 0, 0, 84, 101, 115,
		116, 4, 0, 0, 0, 84, 69, 83, 84, 26, 0, 0, 0, 104, 116, 116, 112, 115,
		58, 47, 47, 101, 120, 97, 109, 112, 108, 101, 46, 99, 111, 109, 47, 116,
		46, 106, 115, 111, 110, 0, 30, 0, 10, 0,
	],
};

const DEV_BUY_GOLDEN = {
	programAddress: '5R1uFyEE4oxqkm7hJDqHq6gXaLVF9dxeF3LF4yz1sfLP',
	accounts: [
		[
			'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
			AccountRole.READONLY_SIGNER,
		],
		[
			'BA529ggBvon9p6dAHc53uRQiPQgWQaSoAAdJHFGrSEND',
			AccountRole.WRITABLE_SIGNER,
		],
		['3NAFktzFtM2q9P5JjBMqCnyBGRFVG8R9Z9J3akDKFxdt', AccountRole.WRITABLE],
		['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', AccountRole.READONLY],
		['So11111111111111111111111111111111111111112', AccountRole.READONLY],
		['7N5KNX4rq8BuVTuriwmFEFTthNWBs9AFg3F2CmNU2qkr', AccountRole.WRITABLE],
		['D731jS3YpCg4vDbEaiqBRzy8Aqm1jSkJHzBjfpA32vja', AccountRole.WRITABLE],
		['HGGAEyLW3segVxmXVGXiak8FdWoomEiGUjeQAU2d1sLr', AccountRole.WRITABLE],
		['18Y9yg3mVJPWmmmYV1j214CUapfJDELtkeYcAKUNrHz', AccountRole.WRITABLE],
		['11111111111111111111111111111111', AccountRole.READONLY],
		['B77P3Hvj9xLi4tcFtyjNcf6NjhkQrfJvLkz3nVZnBzec', AccountRole.READONLY],
		['TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', AccountRole.READONLY],
		['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', AccountRole.READONLY],
		['ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', AccountRole.READONLY],
		['11111111111111111111111111111111', AccountRole.READONLY],
		['FJVebqCthxH6JM8vvkJb7yRYA7Emsib1C1vu4ZePSP3T', AccountRole.READONLY],
		['5R1uFyEE4oxqkm7hJDqHq6gXaLVF9dxeF3LF4yz1sfLP', AccountRole.READONLY],
	],
	data: [
		250, 234, 13, 123, 213, 156, 19, 236, 0, 202, 154, 59, 0, 0, 0, 0, 194,
		131, 19, 93, 7, 0, 0, 0,
	],
};

describe('create-and-buy appends the buy to the create', () => {
	const PARTNER = address('Hs3bBEkKQaR9dGkFpQyBtnQvHXWyKMYyYnFVLZ4WM5Ac');
	// A signer on purpose: the `PartnerConfig` PDA seed must accept one.
	const partner = createNoopSigner(PARTNER);
	const baseMint = createNoopSigner(BASE_MINT);

	it('builds the instructions it built from a `baseMint` signer', async () => {
		const create = {
			user,
			coinCreator: USER,
			baseMint,
			quoteMintInfo: WSOL_MINT_INFO,
			partner: DEFAULT_PARTNER,
			platformConfig: SENDFUN_PLATFORM_ADDRESS,
			name: 'Test',
			symbol: 'TEST',
			uri: 'https://example.com/t.json',
			...CREATOR_FEE_TERMS,
		} as const;
		const createIx =
			await launchpad.create.buildCreateTokenInstruction(create);
		const { instructions } =
			await launchpad.create.buildCreateAndBuyInstructions({
				...create,
				initialVirtualBaseReserves: CURVE_RESERVES.virtualBaseReserves,
				initialVirtualQuoteReserves:
					CURVE_RESERVES.virtualQuoteReserves,
				initialRealBaseReserves: CURVE_RESERVES.realBaseReserves,
				feeBps: FEE_BPS,
				slippageBps: SLIPPAGE_BPS,
				buyQuoteAmount: FIRST_BUY,
			});

		assert.deepEqual(snapshot(createIx), CREATE_GOLDEN);
		assert.deepEqual(
			instructions.map((instruction) => snapshot(instruction)),
			[CREATE_GOLDEN, DEV_BUY_GOLDEN],
		);
	});

	it('signs the mint with baseMint', async () => {
		const createIx = await launchpad.create.buildCreateTokenInstruction({
			user,
			coinCreator: USER,
			baseMint,
			quoteMintInfo: WSOL_MINT_INFO,
			partner: DEFAULT_PARTNER,
			platformConfig: SENDFUN_PLATFORM_ADDRESS,
			name: 'Test',
			symbol: 'TEST',
			uri: 'https://example.com/t.json',
			...CREATOR_FEE_TERMS,
		});

		assert.deepEqual(
			createIx.accounts?.find((account) => account.address === BASE_MINT),
			{
				address: BASE_MINT,
				role: AccountRole.WRITABLE_SIGNER,
				signer: baseMint,
			},
		);
	});

	it('emits the create then a buy against the same curve', async () => {
		const { instructions } =
			await launchpad.create.buildCreateAndBuyInstructions({
				user,
				coinCreator: USER,
				baseMint,
				quoteMintInfo: WSOL_MINT_INFO,
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
			baseMint,
			quoteMintInfo: plainMintInfo(TKALSHI_MINT),
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
			baseMintInfo: plainMintInfo(BASE_MINT),
			quoteMintInfo: plainMintInfo(TKALSHI_MINT),
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

	async function buildFirstBuy(
		transferFee: MintFee | null,
	): Promise<Instruction> {
		const { instructions } =
			await launchpad.create.buildCreateAndBuyInstructions({
				user,
				coinCreator: USER,
				baseMint,
				// WSOL is classic SPL and has no transfer fee.
				quoteMintInfo: {
					...plainMintInfo(TKALSHI_MINT),
					transferFee:
						transferFee === null ? null : steadyFee(transferFee),
				},
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
			});

		const buy = instructions.at(1);
		if (buy === undefined) {
			throw new Error('the builder appended no buy instruction');
		}
		return buy;
	}

	// Without the quote mint's fee schedule, the first-buy minimum ignores the
	// mint's cut and is too high. A cut above slippage then makes the launch fail.
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
				decodeBuy(await buildFirstBuy(flatFee(20))),
				CHARGING_MIN_AMOUNT_OUT,
			);
		});

		it('encodes the fee-less bound when the schedule is withheld', async () => {
			assert.equal(
				decodeBuy(await buildFirstBuy(null)),
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
			baseMintInfo: { ...BASE_INFO, transferFee: steadyFee(flatFee(20)) },
			baseAmountOut: 5_000_000_000n,
		});

		assert.equal(quote.baseAmount, CAP);
		assert.equal(quote.baseToUser, 998_000_000n);
		assert.equal(signed(instruction).amountOut, 998_000_000n);
	});
});

interface TradeInfos {
	readonly baseMintInfo: MintInfo;
	readonly quoteMintInfo: MintInfo;
}

// A trade helper and a raw builder of each program, and the migrate builder.
const REFUSING: readonly (readonly [
	string,
	string,
	(infos: TradeInfos) => Promise<unknown>,
])[] = [
	[
		'launchpad.trade.buyExactIn',
		'launchpad.trade',
		(infos) =>
			launchpad.trade.buyExactIn({
				...SHARED,
				...CURVE_RESERVES,
				...infos,
				quoteAmountIn: FIRST_BUY,
			}),
	],
	[
		'launchpad.trade.buildSellExactInInstruction',
		'launchpad.trade',
		(infos) =>
			launchpad.trade.buildSellExactInInstruction({
				...SHARED,
				...infos,
				amountIn: 1n,
				minAmountOut: 1n,
			}),
	],
	[
		'dex.trade.sellExactOut',
		'dex.trade',
		(infos) =>
			dex.trade.sellExactOut({
				...SHARED,
				baseReserves: 1_000_000_000_000n,
				quoteReserves: 30_000_000_000n,
				...infos,
				quoteAmountOut: 1n,
			}),
	],
	[
		'dex.trade.buildBuyExactOutInstruction',
		'dex.trade',
		(infos) =>
			dex.trade.buildBuyExactOutInstruction({
				...SHARED,
				...infos,
				amountOut: 1n,
				maxAmountIn: 1n,
			}),
	],
	[
		'launchpad.migrate.buildMigrateInstruction',
		'launchpad.migrate',
		(infos) =>
			launchpad.migrate.buildMigrateInstruction({
				caller: user,
				...infos,
			}),
	],
];

describe('the trade and migrate builders refuse a base mint that is not a Token-2022 mint', () => {
	const classicBase = plainMintInfo(BASE_MINT, TOKEN_PROGRAM_ADDRESS);

	for (const [name, program, build] of REFUSING) {
		it(name, async () => {
			await assert.rejects(
				build({
					baseMintInfo: classicBase,
					quoteMintInfo: WSOL_MINT_INFO,
				}),
				{
					name: 'RangeError',
					message: `${program}: the base mint ${BASE_MINT} is not a Token-2022 mint`,
				},
			);
		});
	}
});

describe('the quoting builders apply each transfer fee', () => {
	for (const [bps, transferFee] of [
		[20, 2_000_000n],
		[100, 10_000_000n],
	] as const) {
		const fee = { bps, maximumFee: 1_000_000_000n };
		const info = (mint: Address): MintInfo => ({
			...plainMintInfo(mint),
			transferFee: steadyFee(fee),
		});

		it(`the quote fee at ${bps} bps`, async () => {
			const { quote } = await launchpad.trade.buyExactIn({
				...SHARED,
				...CURVE_RESERVES,
				quoteMintInfo: info(TKALSHI_MINT),
				quoteAmountIn: FIRST_BUY,
			});
			assert.equal(quote.quoteTransferFee, transferFee);
			assert.deepEqual(
				quote,
				amm.buyExactIn({
					reserveQuote: CURVE_RESERVES.virtualQuoteReserves,
					reserveBase: CURVE_RESERVES.virtualBaseReserves,
					quoteAmountIn: FIRST_BUY,
					feeBps: FEE_BPS,
					quoteFee: fee,
					baseReserveCap: CURVE_RESERVES.realBaseReserves,
				}),
			);
		});

		it(`the base fee at ${bps} bps`, async () => {
			const { quote } = await dex.trade.sellExactIn({
				...SHARED,
				baseMintInfo: info(BASE_MINT),
				baseReserves: 1_000_000_000_000n,
				quoteReserves: 30_000_000_000n,
				baseAmountIn: FIRST_BUY,
			});
			assert.equal(quote.baseTransferFee, transferFee);
			assert.deepEqual(
				quote,
				amm.sellExactIn({
					reserveQuote: 30_000_000_000n,
					reserveBase: 1_000_000_000_000n,
					baseAmountIn: FIRST_BUY,
					feeBps: FEE_BPS,
					baseFee: fee,
				}),
			);
		});
	}
});

describe('the quoting builders take the fee at the read epoch', () => {
	const older = { bps: 100, maximumFee: 1_000_000_000n };
	const newer = { bps: 20, maximumFee: 1_000_000_000n };
	for (const [readEpoch, fee, transferFee] of [
		[4n, older, 10_000_000n],
		[5n, newer, 2_000_000n],
	] as const) {
		it(`read at epoch ${readEpoch}`, async () => {
			const quoteMintInfo: MintInfo = {
				...plainMintInfo(TKALSHI_MINT),
				transferFee: {
					authority: null,
					older,
					newer,
					newerEpoch: 5n,
					readEpoch,
				},
			};
			const { quote } = await launchpad.trade.buyExactIn({
				...SHARED,
				...CURVE_RESERVES,
				quoteMintInfo,
				quoteAmountIn: FIRST_BUY,
			});
			assert.equal(quote.quoteTransferFee, transferFee);
			assert.deepEqual(
				utils.tradeFees({ baseMintInfo: BASE_INFO, quoteMintInfo }),
				{ baseFee: null, quoteFee: fee },
			);
			assert.deepEqual(
				quote,
				amm.buyExactIn({
					reserveQuote: CURVE_RESERVES.virtualQuoteReserves,
					reserveBase: CURVE_RESERVES.virtualBaseReserves,
					quoteAmountIn: FIRST_BUY,
					feeBps: FEE_BPS,
					quoteFee: fee,
					baseReserveCap: CURVE_RESERVES.realBaseReserves,
				}),
			);
		});
	}
});

describe('constants', () => {
	it('plainMintInfo', () => {
		assert.deepEqual(
			utils.plainMintInfo(TKALSHI_MINT, TOKEN_2022_PROGRAM_ADDRESS, 6),
			{
				address: TKALSHI_MINT,
				tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
				decimals: 6,
				transferFee: null,
				hookProgram: null,
				hook: null,
			},
		);
	});

	it('launchMintInfo', () => {
		assert.deepEqual(utils.launchMintInfo(BASE_MINT), {
			address: BASE_MINT,
			tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
			decimals: 6,
			transferFee: null,
			hookProgram: null,
			hook: null,
		});
	});

	it('WSOL_MINT_INFO', () => {
		assert.deepEqual(WSOL_MINT_INFO, {
			address: WSOL_MINT,
			tokenProgram: TOKEN_PROGRAM_ADDRESS,
			decimals: 9,
			transferFee: null,
			hookProgram: null,
			hook: null,
		});
	});

	it('USDC_MINT_INFO', () => {
		assert.deepEqual(USDC_MINT_INFO, {
			address: USDC_MINT,
			tokenProgram: TOKEN_PROGRAM_ADDRESS,
			decimals: 6,
			transferFee: null,
			hookProgram: null,
			hook: null,
		});
	});
});
