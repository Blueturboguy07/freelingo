/**
 * Writes the PNG a legibility check just measured, so a human can look at it.
 *
 * Off by default. `legibility.test.ts` calls this on every asset at every size, and it
 * does nothing unless `FREELINGO_ART_PREVIEW=1` is set:
 *
 *     FREELINGO_ART_PREVIEW=1 pnpm vitest run --project ui
 *
 * Two reasons it lives inside the test rather than in a script of its own. First, there is
 * then exactly one rasteriser call per asset per size, so the picture you look at is
 * provably the picture the floor measured — a separate preview script is a second code
 * path that drifts. Second, `node --experimental-strip-types` does not resolve the
 * `./foo.js` specifiers that `module: NodeNext` requires (probed 2026-09-11:
 * `ERR_MODULE_NOT_FOUND … /a.js` for an import of a sibling `a.ts`), so a standalone CLI
 * in this package would need a TypeScript runner that is not installed, and installing one
 * is the deps task's call rather than this lane's.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { env } from 'node:process';
import { RASTER_OUT_DIR, artPath } from '../assets/paths.js';
import type { Bitmap } from './raster.js';
import { encodePng } from './raster.js';

export function previewEnabled(): boolean {
  return env['FREELINGO_ART_PREVIEW'] === '1';
}

/** `art/build/mascot/parrot-idle@64.png` for `art/mascot/parrot-idle.svg` at 64. */
export function previewPath(source: string, size: number): string {
  return join(
    artPath(RASTER_OUT_DIR),
    source.replace(/^art\//, '').replace(/\.svg$/, `@${size}.png`),
  );
}

export function writePreview(source: string, size: number, bitmap: Bitmap): void {
  if (!previewEnabled()) return;
  const out = previewPath(source, size);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, encodePng(bitmap));
}
