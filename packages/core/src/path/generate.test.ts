/**
 * Path generation against device capabilities and the pack manifest: INV-PATH-19,
 * INV-PACK-03.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import { generateUnitNodes, uncompletableNodes, type NodeTemplate } from './generate.js';
import { canComplete, nodeTypesFor, type DeviceCapabilities } from './registry.js';
import { NODE_TYPES } from './types.js';
import type { NodeType } from './types.js';
import { FULL_MANIFEST, NO_STORIES_MANIFEST } from './__falsifiers__/fixtures.js';

function falsifier(id: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./__falsifiers__/${id}.json`, import.meta.url)), 'utf8'),
  ) as Record<string, unknown>;
}

const ALL_CAPS: DeviceCapabilities = { llm: true, microphone: true, audioOutput: true };

function templateOf(types: readonly NodeType[]): NodeTemplate[] {
  return types.map((type, i) => ({ id: `t${i}`, type, subLessonsTotal: 3 }));
}

describe('capability-gated generation', () => {
  it('[INV-PATH-19] falsifier: with the LLM stubbed absent, no Roleplay node is generated', () => {
    const input = falsifier('INV-PATH-19');
    const caps = input.capabilities as DeviceCapabilities;
    const template = templateOf(input.template as NodeType[]);
    const result = generateUnitNodes(template, 0, FULL_MANIFEST, caps);
    const expected = input.expect as Record<string, number>;
    expect(result.nodes.filter((n) => n.type === 'roleplay')).toHaveLength(expected.roleplayNodes!);
    // The slot is rebalanced, never dropped: the node count per unit is unchanged.
    expect(result.nodes).toHaveLength(expected.nodeCount!);
    expect(result.rebalanced.map((r) => r.from)).toEqual(['roleplay']);
    expect(uncompletableNodes(result.nodes, caps)).toHaveLength(expected.uncompletable!);
  });

  it('[INV-PATH-19] every generated node is completable on the generating device', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<NodeType>(...NODE_TYPES), { minLength: 1, maxLength: 8 }),
        fc.record({ llm: fc.boolean(), microphone: fc.boolean(), audioOutput: fc.boolean() }),
        (types, caps) => {
          const result = generateUnitNodes(templateOf(types), 0, FULL_MANIFEST, caps);
          expect(uncompletableNodes(result.nodes, caps)).toEqual([]);
          for (const node of result.nodes) expect(canComplete(node.type, caps)).toBe(true);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PATH-19] the node count per unit survives the rebalance', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<NodeType>('lesson', 'roleplay', 'speaking', 'radio', 'story'), {
          minLength: 1,
          maxLength: 8,
        }),
        fc.record({ llm: fc.boolean(), microphone: fc.boolean(), audioOutput: fc.boolean() }),
        (types, caps) => {
          const result = generateUnitNodes(templateOf(types), 0, FULL_MANIFEST, caps);
          // `lesson` is always declared and always completable, so the fallback is total.
          expect(result.nodes).toHaveLength(types.length);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

describe('the pack-driven registry', () => {
  it('[INV-PACK-03] falsifier: a pack with no stories yields a path with no book nodes', () => {
    const input = falsifier('INV-PACK-03');
    const result = generateUnitNodes(
      templateOf(input.template as NodeType[]),
      0,
      NO_STORIES_MANIFEST,
      ALL_CAPS,
    );
    const expected = input.expect as Record<string, number>;
    expect(result.nodes.filter((n) => n.type === 'story')).toHaveLength(expected.storyNodes!);
    expect(result.nodes).toHaveLength(expected.nodeCount!);
    expect(nodeTypesFor(NO_STORIES_MANIFEST)).not.toContain('story');
  });

  it('[INV-PACK-03] no generated node has a type the pack did not declare', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<NodeType>(...NODE_TYPES), { minLength: 1, maxLength: 8 }),
        fc.subarray([...NODE_TYPES.filter((t) => t !== 'jumpHere')], { minLength: 1 }),
        (types, declared) => {
          const manifest = { ...FULL_MANIFEST, declaredNodeTypes: declared };
          const result = generateUnitNodes(templateOf(types), 0, manifest, ALL_CAPS);
          for (const node of result.nodes) expect(declared).toContain(node.type);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PACK-03] the jump-here overlay is never generated as a stored node', () => {
    const result = generateUnitNodes(
      templateOf(['jumpHere', 'lesson']),
      0,
      FULL_MANIFEST,
      ALL_CAPS,
    );
    expect(result.nodes.map((n) => n.type)).not.toContain('jumpHere');
  });
});
