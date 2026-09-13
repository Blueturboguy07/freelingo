import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderMascotSvg } from './composite.js';
import { MASCOT_POSES, MASCOT_SIZES, mascotSourcePath } from './poses.js';
import { renderSvg } from './raster.js';

const OUTFITS = [
  'cosmetic-explorer-outfit',
  'cosmetic-snowfall-suit',
  'cosmetic-carnival-suit',
  'cosmetic-brass-perch',
  'cosmetic-bamboo-perch',
] as const;
/** S123 implementation visibility floor: 16 changed pixels at 64px. This verifies
 * a real visible layer, rather than an outfit id attached to a neutral picture. */
const MIN_CHANGED_PIXELS_64 = 16;
describe('central mascot cosmetic composition', () => {
  it.each(MASCOT_POSES)(
    '[INV-ECO-31] %s neutral and missing variants preserve the exact committed source',
    (pose) => {
      const source = readFileSync(mascotSourcePath(pose), 'utf8');
      expect(renderMascotSvg({ pose, outfitId: null })).toBe(source);
      expect(renderMascotSvg({ pose, outfitId: 'unknown-future-outfit' })).toBe(source);
      expect(renderMascotSvg({ pose, outfitId: '<script>unexpected</script>' })).toBe(source);
    },
  );
  it.each(OUTFITS)(
    '[INV-ECO-31] %s changes visible parrot pixels at both required sizes without covering its expression',
    (outfitId) => {
      for (const pose of MASCOT_POSES) {
        const original = readFileSync(mascotSourcePath(pose), 'utf8');
        for (const size of MASCOT_SIZES) {
          const neutral = renderSvg(original, size),
            dressed = renderSvg(renderMascotSvg({ pose, outfitId }), size);
          let changed = 0;
          for (let y = 0; y < size; y++)
            for (let x = 0; x < size; x++) {
              const offset = (y * size + x) * 4;
              const same = neutral.pixels
                .slice(offset, offset + 4)
                .every((value, index) => value === dressed.pixels[offset + index]);
              if (!same) changed++;
              // All authored eyes and mouths lie in this protected central rectangle.
              if (
                x >= (size * 70) / 240 &&
                x < (size * 170) / 240 &&
                y >= (size * 72) / 240 &&
                y < (size * 180) / 240
              )
                expect(same).toBe(true);
            }
          expect(changed).toBeGreaterThanOrEqual(MIN_CHANGED_PIXELS_64 * (size / 64) ** 2);
        }
      }
    },
  );
});
