// Reads the token program from the mint account. Do not hard-code it.
import {
	getBase64Encoder,
	type Address,
	type Commitment,
	type GetAccountInfoApi,
	type GetMultipleAccountsApi,
	type Rpc,
} from '@solana/kit';

import {
	TOKEN_2022_PROGRAM_ADDRESS,
	TOKEN_PROGRAM_ADDRESS,
} from '../constants.js';
import { fetchInChunks } from './chunk.js';

// Both token programs use the same base mint: 36-byte `COption<Pubkey>` authority,
// u64 supply, then decimals.
const MINT_BASE_LENGTH = 82;
const MINT_DECIMALS_OFFSET = 44;

export interface QuoteMintInfo {
	mint: Address;
	/** Cannot change after the mint is created. */
	decimals: number;
	/** The account's owner: `TOKEN_PROGRAM_ADDRESS` or `TOKEN_2022_PROGRAM_ADDRESS`. */
	tokenProgram: Address;
}

function decodeMintInfo(
	mint: Address,
	data: Uint8Array,
	owner: Address,
): QuoteMintInfo {
	if (
		owner !== TOKEN_PROGRAM_ADDRESS &&
		owner !== TOKEN_2022_PROGRAM_ADDRESS
	) {
		throw new Error(
			`fetchQuoteMintInfo: ${mint} is owned by ${owner}, which is not a token program`,
		);
	}
	// A minimum: Token-2022 mints with extensions are longer.
	if (data.length < MINT_BASE_LENGTH) {
		throw new Error(
			`fetchQuoteMintInfo: ${mint} holds ${data.length} bytes, too short for a mint`,
		);
	}
	return { mint, decimals: data[MINT_DECIMALS_OFFSET], tokenProgram: owner };
}

/** Reads the decimals and token program of `mint`. Throws if the account does not exist, a token
 *  program does not own it, or it is too short for a mint. */
export async function fetchQuoteMintInfo(
	rpc: Rpc<GetAccountInfoApi>,
	mint: Address,
	commitment?: Commitment,
): Promise<QuoteMintInfo> {
	const { value } = await rpc
		.getAccountInfo(
			mint,
			commitment === undefined
				? { encoding: 'base64' }
				: { commitment, encoding: 'base64' },
		)
		.send();
	if (!value) {
		throw new Error(`fetchQuoteMintInfo: no account at ${mint}`);
	}
	const data = new Uint8Array(getBase64Encoder().encode(value.data[0]));
	return decodeMintInfo(mint, data, value.owner);
}

/** Reads the decimals and token program of each mint. Results follow `mints` order. Throws as
 *  {@link fetchQuoteMintInfo} does. */
export async function fetchQuoteMintInfos(
	rpc: Rpc<GetMultipleAccountsApi>,
	mints: readonly Address[],
	commitment?: Commitment,
): Promise<QuoteMintInfo[]> {
	if (mints.length === 0) return [];
	const value = await fetchInChunks(mints, (chunk) =>
		rpc
			.getMultipleAccounts(
				chunk,
				commitment === undefined
					? { encoding: 'base64' }
					: { commitment, encoding: 'base64' },
			)
			.send()
			.then((response) => response.value),
	);

	const base64Encoder = getBase64Encoder();
	return mints.map((mint, index) => {
		const account = value.at(index);
		if (!account) {
			throw new Error(`fetchQuoteMintInfo: no account at ${mint}`);
		}
		const data = new Uint8Array(base64Encoder.encode(account.data[0]));
		return decodeMintInfo(mint, data, account.owner);
	});
}
