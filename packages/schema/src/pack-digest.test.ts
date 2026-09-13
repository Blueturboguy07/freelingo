import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { digestPackStream } from './pack-digest.js';

it('[INV-PACK-18] hashes split binary chunks exactly as the signed payload without retaining the file', async () => {
  const bytes = Uint8Array.from({ length: 8193 }, (_, i) => i % 251);
  async function* chunks() {
    for (const [start, end] of [
      [0, 1],
      [1, 4096],
      [4096, 8193],
    ])
      yield bytes.subarray(start, end);
  }
  expect(await digestPackStream(chunks())).toEqual({
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
});
it('[INV-PACK-18] an interrupted stream cannot return a digest for its successful prefix', async () => {
  let finalized = false;
  async function* chunks() {
    try {
      yield new Uint8Array([1, 2]);
      throw new Error('disk read failed');
    } finally {
      finalized = true;
    }
  }
  await expect(digestPackStream(chunks())).rejects.toThrow('disk read failed');
  expect(finalized).toBe(true);
});
