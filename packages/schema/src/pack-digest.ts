import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** Bounded-memory payload verification for immutable pack files; no entire-file copy. */
export async function digestPackStream(chunks: AsyncIterable<Uint8Array>): Promise<{
  readonly sha256: string;
  readonly bytes: number;
}> {
  const hash = sha256.create();
  let bytes = 0;
  try {
    for await (const chunk of chunks) {
      if (!(chunk instanceof Uint8Array)) throw new TypeError('Invalid pack byte stream');
      bytes += chunk.byteLength;
      if (!Number.isSafeInteger(bytes)) throw new RangeError('Pack byte count is too large');
      hash.update(chunk);
    }
    return { sha256: bytesToHex(hash.digest()), bytes };
  } finally {
    hash.destroy();
  }
}
