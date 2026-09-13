import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import { decodeTraceDefinition, evaluateStroke, traceRuntime } from './trace.js';
import type { TraceDefinition } from './trace.js';
const horizontal = [
  { x: 10, y: 20 },
  { x: 90, y: 20 },
];
const vertical = [
  { x: 50, y: 10 },
  { x: 50, y: 90 },
];
const definition: TraceDefinition = {
  source: 'test:explicit-stroke-source',
  version: 1,
  viewBox: { width: 100, height: 100 },
  strokes: [{ points: horizontal }, { points: vertical }],
};
describe('sourced stroke grading', () => {
  it('[INV-PACK-16] absent source, unknown encoding and malformed geometry never manufacture a trace', () => {
    expect(decodeTraceDefinition('test:source', JSON.stringify(definition))).toEqual({
      ...definition,
      source: 'test:source',
    });
    for (const raw of [
      '[]',
      '{}',
      'null',
      'invalid',
      JSON.stringify({ ...definition, version: 2 }),
      JSON.stringify({ ...definition, strokes: [{ points: [{ x: 0, y: 0 }] }] }),
    ])
      expect(decodeTraceDefinition('test:source', raw)).toBeNull();
    expect(decodeTraceDefinition('', JSON.stringify(definition))).toBeNull();
  });
  it('[INV-A11Y-16] count/order/direction/endpoints and the full path decide each stroke', () => {
    expect(evaluateStroke(definition, 0, horizontal)).toBe(true);
    expect(evaluateStroke(definition, 0, vertical)).toBe(false);
    // A brief initial backtrack stays inside aggregate path tolerance but starts too far away.
    expect(evaluateStroke(definition, 0, [{ x: 30, y: 20 }, ...horizontal])).toBe(false);
    expect(evaluateStroke(definition, 0, [...horizontal].reverse())).toBe(false);
    expect(evaluateStroke(definition, 0, [horizontal[0]!, { x: 50, y: 20 }])).toBe(false);
    expect(evaluateStroke(definition, 0, [horizontal[0]!, { x: 50, y: 90 }, horizontal[1]!])).toBe(
      false,
    );
    expect(evaluateStroke(definition, 2, horizontal)).toBe(false);
    expect(evaluateStroke(definition, 0, [{ x: NaN, y: 20 }, horizontal[1]!])).toBe(false);
  });
  it('[INV-SESS-15] replay preserves accepted strokes and rejections without trusting a completion flag', () => {
    const attempts = [
      { id: 'wrong-order', points: vertical },
      { id: 'first', points: horizontal },
    ];
    const state = traceRuntime(definition, {
      traceRuntime: { attempts, complete: true, accepted: 999 },
    });
    expect(state).toMatchObject({ accepted: 1, rejections: 1, complete: false });
    expect(
      traceRuntime(definition, {
        traceRuntime: { attempts: [...attempts, { id: 'second', points: vertical }] },
      }),
    ).toMatchObject({ accepted: 2, rejections: 1, complete: true });
    expect(
      traceRuntime(definition, { traceRuntime: { attempts: [...attempts, attempts[1]] } }),
    ).toBeNull();
  });
  it('[INV-A11Y-16] a small translated input stays acceptable across 10000 sourced geometries', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 1000 }),
        fc.integer({ min: -2, max: 2 }),
        (size, shift) => {
          const points = [
            { x: size * 0.1, y: size * 0.2 },
            { x: size * 0.9, y: size * 0.2 },
          ];
          const pack = {
            ...definition,
            viewBox: { width: size, height: size },
            strokes: [{ points }],
          };
          expect(
            evaluateStroke(
              pack,
              0,
              points.map((p) => ({ x: p.x + shift, y: p.y + shift })),
            ),
          ).toBe(true);
          expect(evaluateStroke(pack, 0, [...points].reverse())).toBe(false);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
});
