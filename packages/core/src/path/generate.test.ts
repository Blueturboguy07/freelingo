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
import {
  canComplete,
  nodeTypesFor,
  placeableTypesWithNoCompletionPath,
  specFor,
  specHasCompletionPath,
  type DeviceCapabilities,
} from './registry.js';
import { allUnits, NODE_TYPES } from './types.js';
import type { LaunchFlavour, NodeType, PathModel, PathNode } from './types.js';
import { nodeUnlocked, unitUnlocked } from './unlock.js';
import { isComplete } from './nodes.js';
import { openChest } from './chest.js';
import {
  buildModel,
  CAPTURED_UNIT_SHAPE,
  FULL_MANIFEST,
  NO_STORIES_MANIFEST,
} from './__falsifiers__/fixtures.js';

function falsifier(id: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./__falsifiers__/${id}.json`, import.meta.url)), 'utf8'),
  ) as Record<string, unknown>;
}

const ALL_CAPS: DeviceCapabilities = { llm: true, microphone: true, audioOutput: true };

function templateOf(types: readonly NodeType[]): NodeTemplate[] {
  return types.map((type, i) => ({ id: `t${i}`, type, subLessonsTotal: 3 }));
}

/** The first node the learner can actually play right now, in path order. */
function firstPlayableNode(
  model: PathModel,
): { readonly node: PathNode; readonly unitIndex: number } | null {
  const units = allUnits(model);
  for (let u = 0; u < units.length; u += 1) {
    const unit = units[u];
    if (unit === undefined) continue;
    for (let n = 0; n < unit.nodes.length; n += 1) {
      const node = unit.nodes[n];
      if (node === undefined || isComplete(node)) continue;
      if (nodeUnlocked(model, u, n)) return { node, unitIndex: u };
    }
  }
  return null;
}

function replaceNode(model: PathModel, replacement: PathNode): PathModel {
  return {
    ...model,
    sections: model.sections.map((s) => ({
      ...s,
      units: s.units.map((u) => ({
        ...u,
        nodes: u.nodes.map((n) => (n.id === replacement.id ? replacement : n)),
      })),
    })),
  };
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

  it('[INV-PATH-19] the captured unit shape walks to the end and opens the next unit', () => {
    // The refutation this test exists for: `chest` declared `launchable: []`, so nothing in
    // the repo could ever complete one. `nodeUnlocked` requires `isComplete(previous)` and
    // `unitAdvanced` requires the LAST node complete, so the captured Unit 1 shape
    // (lesson, lesson, lesson, CHEST, lesson, unitReview) was a permanent deadlock: every
    // node after the chest stayed locked forever and Unit 2 never opened. The old property
    // passed over that dead chain because `canComplete` asked only about device
    // capabilities. This one walks the chain.
    expect(CAPTURED_UNIT_SHAPE).toEqual([
      'lesson',
      'lesson',
      'lesson',
      'chest',
      'lesson',
      'unitReview',
    ]);
    const model = buildModel([[CAPTURED_UNIT_SHAPE, ['lesson', 'unitReview']]], 0);
    let walking = model;
    let steps = 0;
    const budget = CAPTURED_UNIT_SHAPE.length + 4;
    const completedIds: string[] = [];
    for (;;) {
      const next = firstPlayableNode(walking);
      if (next === null) break;
      steps += 1;
      expect(steps).toBeLessThanOrEqual(budget);
      completedIds.push(next.node.id);
      walking =
        next.node.type === 'chest'
          ? replaceNode(walking, openChest(next.node).node)
          : replaceNode(walking, { ...next.node, subLessonsDone: next.node.subLessonsTotal });
      if (unitUnlocked(walking, 1)) break;
    }
    // Every node of Unit 1 was reachable and finishable, the chest included...
    expect(completedIds).toEqual(['u0n0', 'u0n1', 'u0n2', 'u0n3', 'u0n4', 'u0n5']);
    // ...and the next unit opened, which it could not do while the chest was a dead end.
    expect(unitUnlocked(model, 1)).toBe(false);
    expect(unitUnlocked(walking, 1)).toBe(true);
    expect(
      uncompletableNodes(
        allUnits(walking).flatMap((u) => u.nodes),
        ALL_CAPS,
      ),
    ).toEqual([]);
  });

  it('[INV-PATH-19] no placeable node type declares an empty completion path', () => {
    // The registry gate. A placeable type with no launchable flavour is a deadlock
    // generator; this is the check that catches one at review time.
    expect(placeableTypesWithNoCompletionPath()).toEqual([]);
    // The predicate over a SYNTHETIC spec, because once the chest declares `Open chest` no
    // shipped type has an empty list any more - a check that can only be reached through
    // the registry would be dead code dressed as a guard.
    const deadEnd = { ...specFor('lesson'), launchable: [] as readonly LaunchFlavour[] };
    expect(specHasCompletionPath(deadEnd, ALL_CAPS)).toBe(false);
    expect(specHasCompletionPath(specFor('lesson'), ALL_CAPS)).toBe(true);
    // ...and a capability the device lacks is still the other way to fail.
    expect(
      specHasCompletionPath(specFor('roleplay'), {
        llm: false,
        microphone: true,
        audioOutput: true,
      }),
    ).toBe(false);
    expect(canComplete('lesson', ALL_CAPS)).toBe(
      specHasCompletionPath(specFor('lesson'), ALL_CAPS),
    );
    // The chest specifically: S016's `Open chest` IS its completion path.
    expect(specFor('chest').launchable).toEqual(['chest']);
    expect(canComplete('chest', { llm: false, microphone: false, audioOutput: false })).toBe(true);
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
