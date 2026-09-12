/**
 * The rasteriser's own tests.
 *
 * `legibility.test.ts` is only as trustworthy as the renderer underneath it: a floor
 * measured with a broken rasteriser is worse than no floor, because it is green. So every
 * shape here is one whose exact coverage is known in closed form — a disc is πr², a
 * rectangle is w·h — and the render is checked against the arithmetic rather than against
 * a committed baseline image, which would only prove the renderer still does whatever it
 * did last time.
 *
 * The stroke-winding case is here because it actually happened: see `strokeRings`.
 */

import { describe, expect, it } from 'vitest';
import { colourCensus, inkCoverage, regionCount } from './metrics.js';
import { encodePng, parseColour, renderSvg, toHex } from './raster.js';

const svg = (viewBox: string, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`;

describe('geometry', () => {
  it('fills a rectangle to its exact area', () => {
    // Half the frame wide, a quarter tall => 1/8 of the pixels.
    const r = renderSvg(svg('0 0 100 100', '<rect x="0" y="0" width="50" height="25" fill="#58CC02"/>'), 200); // prettier-ignore
    expect(inkCoverage(r)).toBeCloseTo(0.125, 3);
  });

  it('fills a circle to πr² within a pixel of edge', () => {
    const r = renderSvg(svg('0 0 100 100', '<circle cx="50" cy="50" r="25" fill="#58CC02"/>'), 400);
    // r = 25/100 of the frame => area fraction = π·0.25² ≈ 0.19635
    expect(inkCoverage(r)).toBeCloseTo(Math.PI * 0.25 ** 2, 2);
  });

  it('scales a non-square viewBox on its longest side', () => {
    const r = renderSvg(svg('0 0 180 240', '<rect x="0" y="0" width="180" height="240" fill="#58CC02"/>'), 240); // prettier-ignore
    expect([r.width, r.height]).toEqual([180, 240]);
    expect(inkCoverage(r)).toBeCloseTo(1, 3);
  });

  it('applies translate, rotate and scale', () => {
    const plain = renderSvg(svg('0 0 100 100', '<rect x="40" y="40" width="20" height="20" fill="#58CC02"/>'), 200); // prettier-ignore
    // The same square, reached by rotating about the frame centre: identical coverage.
    const rotated = renderSvg(svg('0 0 100 100', '<rect x="40" y="40" width="20" height="20" fill="#58CC02" transform="rotate(37 50 50)"/>'), 200); // prettier-ignore
    expect(inkCoverage(rotated)).toBeCloseTo(inkCoverage(plain), 2);

    // scale(2) about the origin doubles each side, so four times the area.
    const scaled = renderSvg(svg('0 0 100 100', '<rect x="20" y="20" width="20" height="20" fill="#58CC02" transform="scale(2)"/>'), 200); // prettier-ignore
    expect(inkCoverage(scaled)).toBeCloseTo(4 * inkCoverage(plain), 2);
  });

  it('inherits fill and transform through a <g>', () => {
    const grouped = renderSvg(svg('0 0 100 100', '<g fill="#58CC02" transform="translate(10 0)"><rect x="30" y="40" width="20" height="20"/></g>'), 200); // prettier-ignore
    const direct = renderSvg(svg('0 0 100 100', '<rect x="40" y="40" width="20" height="20" fill="#58CC02"/>'), 200); // prettier-ignore
    expect(inkCoverage(grouped)).toBeCloseTo(inkCoverage(direct), 3);
    expect(grouped.palette).toEqual(['#58cc02']);
  });

  it('paints later elements over earlier ones', () => {
    const r = renderSvg(
      svg(
        '0 0 100 100',
        '<rect x="0" y="0" width="100" height="100" fill="#58CC02"/>' +
          '<rect x="0" y="0" width="100" height="100" fill="#FFC700"/>',
      ),
      40,
    );
    const { counts } = colourCensus(r, r.palette);
    expect(counts.get('#ffc700')).toBe(40 * 40);
    expect(counts.get('#58cc02')).toBe(0);
  });
});

describe('strokes', () => {
  it('a stroked line covers length x width', () => {
    // A 60-long horizontal line at width 10 in a 100 frame: 600/10000 plus two round caps
    // of radius 5 (one full disc between them) => (600 + π·25)/10000.
    const r = renderSvg(svg('0 0 100 100', '<line x1="20" y1="50" x2="80" y2="50" stroke="#3C3C3C" stroke-width="10"/>'), 400); // prettier-ignore
    expect(inkCoverage(r)).toBeCloseTo((600 + Math.PI * 25) / 10_000, 3);
  });

  it('a corner in a polyline does not punch a hole through the stroke', () => {
    // The regression that produced a broken tick on the completed-node badge: the two
    // segment quads were wound in opposite directions, so non-zero winding cancelled
    // their overlap to zero and the joint vanished. One connected region, not two.
    const r = renderSvg(svg('0 0 100 100', '<polyline points="20,50 40,70 80,25" fill="none" stroke="#3C3C3C" stroke-width="12"/>'), 240); // prettier-ignore
    const { labels } = colourCensus(r, r.palette);
    expect(regionCount(labels, r.width, r.height, 8)).toBe(1);
  });

  it('an unclosed path is stroked but not filled', () => {
    const r = renderSvg(svg('0 0 100 100', '<path d="M20 20 C40 80 60 80 80 20" fill="none" stroke="#3C3C3C" stroke-width="8"/>'), 200); // prettier-ignore
    expect(r.palette).toEqual(['#3c3c3c']);
    expect(inkCoverage(r)).toBeGreaterThan(0.02);
    expect(inkCoverage(r)).toBeLessThan(0.2);
  });
});

describe('the authoring subset is enforced, not silently widened', () => {
  it('rejects an elliptical arc rather than dropping it', () => {
    expect(() =>
      renderSvg(svg('0 0 100 100', '<path d="M10 10 A 20 20 0 0 1 50 50 Z" fill="#58CC02"/>'), 64),
    ).toThrow(/arc/i);
  });

  it('rejects a gradient fill (deep/08 §10 measured zero gradients)', () => {
    expect(() =>
      renderSvg(svg('0 0 100 100', '<rect width="100" height="100" fill="url(#g)"/>'), 64),
    ).toThrow(/solid/i);
  });

  it('rejects an unknown element', () => {
    expect(() => renderSvg(svg('0 0 100 100', '<text x="0" y="0">hi</text>'), 64)).toThrow(
      /unsupported element/,
    );
  });

  it('requires a viewBox', () => {
    expect(() => renderSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', 64)).toThrow(
      /viewBox/,
    );
  });
});

describe('colour', () => {
  it('round-trips shorthand and longhand hex', () => {
    expect(parseColour('#58CC02')).toEqual([0x58, 0xcc, 0x02]);
    expect(parseColour('#0f0')).toEqual([0, 0xff, 0]);
    expect(parseColour('none')).toBeNull();
    expect(toHex([0x58, 0xcc, 0x02])).toBe('#58cc02');
  });
});

describe('png', () => {
  it('writes a decodable RGBA PNG with the right header and size', () => {
    const r = renderSvg(svg('0 0 100 100', '<rect width="100" height="100" fill="#58CC02"/>'), 32);
    const png = encodePng(r);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer, png.byteOffset);
    expect(String.fromCharCode(...png.subarray(12, 16))).toBe('IHDR');
    expect(view.getUint32(16)).toBe(32);
    expect(view.getUint32(20)).toBe(32);
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(6); // colour type: RGBA
    expect(String.fromCharCode(...png.subarray(png.length - 8, png.length - 4))).toBe('IEND');
  });
});
