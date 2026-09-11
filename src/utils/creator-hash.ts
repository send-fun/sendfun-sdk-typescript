import { getAddressDecoder } from '@solana/kit';
import type { Address, ReadonlyUint8Array } from '@solana/kit';

const MAX_CREATOR_PLATFORM_LEN = 32;

/** SHA-256 of the LE-u32-length-prefixed platform and id. Frozen: it seeds live PDAs. */
export async function creatorHashFromId(
	creatorPlatform: string,
	creatorId: string,
): Promise<Address> {
	const encoder = new TextEncoder();
	const platformBuf = encoder.encode(creatorPlatform);
	const idBuf = encoder.encode(creatorId);

	if (platformBuf.length > MAX_CREATOR_PLATFORM_LEN) {
		throw new RangeError(
			`creatorPlatform exceeds ${MAX_CREATOR_PLATFORM_LEN} bytes (got ${platformBuf.length})`,
		);
	}
	const platformLength = new Uint8Array(4);
	new DataView(platformLength.buffer).setUint32(0, platformBuf.length, true);
	const idLength = new Uint8Array(4);
	new DataView(idLength.buffer).setUint32(0, idBuf.length, true);

	const buf = new Uint8Array(4 + platformBuf.length + 4 + idBuf.length);
	buf.set(platformLength, 0);
	buf.set(platformBuf, 4);
	buf.set(idLength, 4 + platformBuf.length);
	buf.set(idBuf, 4 + platformBuf.length + 4);

	const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));

	const addressDecoder = getAddressDecoder();
	return addressDecoder.decode(hash);
}

/** NUL-pads `text` to `length` bytes, the on-chain `CreatorFeeConfig.platformId` form; throws RangeError if longer. */
export function encodeCreatorId(text: string, length: number): Uint8Array {
	const bytes = new TextEncoder().encode(text);
	if (bytes.length > length) {
		throw new RangeError(
			`text exceeds ${length} bytes (got ${bytes.length})`,
		);
	}
	const out = new Uint8Array(length);
	out.set(bytes, 0);
	return out;
}

/** Strips NUL padding. Pass this, never the padded array, to {@link creatorHashFromId}: the hash is length-prefixed. */
export function decodeCreatorId(bytes: ReadonlyUint8Array): string {
	let end = bytes.length;
	while (end > 0 && bytes[end - 1] === 0) {
		end -= 1;
	}
	return new TextDecoder().decode(bytes.slice(0, end));
}
