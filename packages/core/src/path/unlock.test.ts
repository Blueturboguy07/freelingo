/**
 * Unlock rules, the jump-here overlay, placement integrity and script prerequisites.
 *
 * Covers INV-PATH-01, INV-PATH-13, INV-PATH-23 and INV-PATH-26. Falsifier inputs are
 * committed beside this file in `__falsifiers__/`, and the tests that consume them carry
 * the word `falsifier` so `pnpm test:falsify` selects them.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  applyJump,
  frontierUnitIndex,
  jumpHereOverlays,
  lettersNodesReachable,
  nodeUnlocked,
  placementViolations,
  serpentineOffsets,
  servedNodes,
  unintroducedScriptUnitsInServedItems,
  unitAdvanced,
  unitCompleted,
  unitUnlocked,
} from './unlock.js';
import { isComplete } from './nodes.js';
import { allUnits } from './types.js';
import type { NodeType, PathModel } from './types.js';
import {
  buildModel,
  courseShapeArb,
  linearModelArb,
  model as makeModel,
  node,
  section,
  unit,
} from './__falsifiers__/fixtures.js';
import { EMPTY_UNIT_REWIND_LEDGER, planUnitRewind, type UnitRewindEntry } from './unitRewind.js';

function falsifier(id: string): Record<string, unknown> {
  const path = fileURLToPath(new URL(`./__falsifiers__/${id}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

/** Every (unitIndex, nodeIndex) pair of a model, in path order. */
function everyNode(model: PathModel): { u: number; n: number }[] {
  const out: { u: number; n: number }[] = [];
  const units = allUnits(model);
  for (let u = 0; u < units.length; u += 1) {
    for (let n = 0; n < (units[u]?.nodes.length ?? 0); n += 1) out.push({ u, n });
  }
  return out;
}

describe('node and unit unlocking', () => {
  it('[INV-PATH-01] falsifier: completing only the FIRST level of a unit does not unlock the next unit', () => {
    const input = falsifier('INV-PATH-01');
    const model = buildModel(
      input.shape as readonly (readonly (readonly NodeType[])[])[],
      input.completedNodeCount as number,
    );
    // The struck rule (deep/03 rules table, "complete only the first level to advance")
    // would make every one of these true.
    expect(nodeUnlocked(model, 0, 1)).toBe(true);
    expect(unitUnlocked(model, 1)).toBe(false);
    expect(nodeUnlocked(model, 1, 0)).toBe(false);
  });

  it('[INV-PATH-01] a locked node still renders a popup, for every node type', () => {
    // Duolingo showed no feedback at all on a locked tap; that is the anomaly, and the
    // copy exists (str:1429). The popup half lives in nodes.test.ts; here we assert the
    // state that makes it reachable.
    const model = buildModel(
      [
        [
          ['lesson', 'unitReview'],
          ['lesson', 'unitReview'],
        ],
      ],
      0,
    );
    expect(nodeUnlocked(model, 1, 0)).toBe(false);
  });

  it('[INV-PATH-01] unlocked(n) <=> complete(n-1) within a unit, over generated paths', () => {
    fc.assert(
      fc.property(linearModelArb, ({ model }) => {
        const units = allUnits(model);
        for (const { u, n } of everyNode(model)) {
          if (n === 0) continue;
          const previous = units[u]?.nodes[n - 1];
          const expected = unitUnlocked(model, u) && previous !== undefined && isComplete(previous);
          expect(nodeUnlocked(model, u, n)).toBe(expected);
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PATH-01] unit n+1 is locked until the LAST node of unit n is complete (ruling EC-PTH-21)', () => {
    fc.assert(
      fc.property(linearModelArb, ({ model }) => {
        const units = allUnits(model);
        for (let u = 1; u < units.length; u += 1) {
          const previous = units[u - 1];
          if (previous === undefined) continue;
          expect(unitUnlocked(model, u)).toBe(unitAdvanced(previous));
          // No early unlock: a partially complete previous unit never opens this one.
          if (!unitCompleted(previous)) expect(unitUnlocked(model, u)).toBe(false);
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PATH-01] a passed jump-here is the only way past a locked unit', () => {
    const base = buildModel(
      [
        [
          ['lesson', 'unitReview'],
          ['lesson', 'unitReview'],
        ],
      ],
      0,
    );
    expect(unitUnlocked(base, 1)).toBe(false);
    expect(unitUnlocked(applyJump(base, 1), 1)).toBe(true);
  });
});

describe('the jump-here overlay', () => {
  it('[INV-PATH-13] falsifier: the overlay exists iff its target unit is locked', () => {
    const input = falsifier('INV-PATH-13');
    const locked = buildModel(
      input.shape as readonly (readonly (readonly NodeType[])[])[],
      input.completedNodeCount as number,
    );
    expect(jumpHereOverlays(locked).map((o) => o.targetUnitIndex)).toEqual(
      (input.expect as { overlayTargets: number[] }).overlayTargets,
    );
    // EC-PTH-26: the instant the target unlocks by progression, the overlay is gone.
    const advanced = buildModel(input.shape as readonly (readonly (readonly NodeType[])[])[], 2);
    expect(unitUnlocked(advanced, 1)).toBe(true);
    expect(jumpHereOverlays(advanced)).toEqual([]);
  });

  it('[INV-PATH-13] a 9-unit course at unit 0 renders three offers, not eight', () => {
    // The previous implementation emitted one overlay per locked unit, so this canvas
    // carried eight `Jump here?` nodes. S010/S019 show the offer at the frontier and at a
    // section boundary; the doc comment always said so, the code did not.
    const shape = [
      [
        ['lesson', 'unitReview'],
        ['lesson', 'unitReview'],
        ['lesson', 'unitReview'],
      ],
      [
        ['lesson', 'unitReview'],
        ['lesson', 'unitReview'],
        ['lesson', 'unitReview'],
      ],
      [
        ['lesson', 'unitReview'],
        ['lesson', 'unitReview'],
        ['lesson', 'unitReview'],
      ],
    ] as readonly (readonly (readonly NodeType[])[])[];
    const model = buildModel(shape, 0);
    const overlays = jumpHereOverlays(model);
    // Unit 1 (next locked after the frontier) + the two section heads, units 3 and 6.
    expect(overlays.map((o) => o.targetUnitIndex)).toEqual([1, 3, 6]);
    expect(overlays.filter((o) => o.kind === 'section').map((o) => o.flavour)).toEqual([
      'sectionTest',
      'sectionTest',
    ]);
  });

  it('[INV-PATH-13] an overlay exists only for a locked unit that heads a section or follows the frontier', () => {
    fc.assert(
      fc.property(linearModelArb, ({ model }) => {
        const overlaid = new Set(jumpHereOverlays(model).map((o) => o.targetUnitIndex));
        const units = allUnits(model);
        const frontier = frontierUnitIndex(model);
        let nextLocked = -1;
        for (let u = frontier + 1; u < units.length; u += 1) {
          if (!unitUnlocked(model, u)) {
            nextLocked = u;
            break;
          }
        }
        const sectionHeads = new Set<number>();
        let absolute = 0;
        for (const s of model.sections) {
          sectionHeads.add(absolute);
          absolute += s.units.length;
        }
        for (let u = 1; u < units.length; u += 1) {
          const locked = !unitUnlocked(model, u);
          const expected = locked && (sectionHeads.has(u) || u === nextLocked);
          expect(overlaid.has(u)).toBe(expected);
        }
        // Never on an unlocked unit (EC-PTH-26), and never on the first unit of a course.
        for (const target of overlaid) expect(unitUnlocked(model, target)).toBe(false);
        expect(overlaid.has(0)).toBe(false);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PATH-13] splicing an overlay into the list leaves every placed offset byte-identical', () => {
    fc.assert(
      fc.property(linearModelArb, fc.nat({ max: 8 }), ({ model }, splicePoint) => {
        for (const unitOf of allUnits(model)) {
          const placed = unitOf.nodes;
          const before = serpentineOffsets(placed);
          // Build the SAME unit with a `Jump here?` overlay spliced in, the way a naive
          // renderer that stores the overlay as a real node would hand it over.
          const at = splicePoint % (placed.length + 1);
          const overlay = node(`${unitOf.index}-overlay`, 'jumpHere', unitOf.index);
          const spliced = [...placed.slice(0, at), overlay, ...placed.slice(at)];
          const after = serpentineOffsets(spliced);
          // Byte-identical, not merely equal in length: the exact {nodeId,x,y} triples.
          expect(JSON.stringify(after)).toBe(JSON.stringify(before));
          // ...and the overlay itself never gets an offset of its own.
          expect(after.map((o) => o.nodeId)).not.toContain(overlay.id);
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PATH-13] the offsets are a function of the placed index, so an overlay cannot re-flow them', () => {
    const nodes = [node('a', 'lesson', 0), node('b', 'lesson', 0), node('c', 'unitReview', 0)];
    const before = serpentineOffsets(nodes);
    expect(before.map((o) => o.x)).toEqual([0, -45, -70]);
    expect(before.map((o) => o.y)).toEqual([0, 94, 188]);
    // An overlay at the very top - the worst case, since it would shift every node below.
    const withOverlay = serpentineOffsets([node('j', 'jumpHere', 0), ...nodes]);
    expect(withOverlay).toEqual(before);
  });

  it('[INV-PATH-17] a section-head overlay launches the section test, not its own node type', () => {
    const model = makeModel([
      section(0, [unit(0, [node('u0n0', 'lesson', 0), node('u0n1', 'unitReview', 0)])]),
      section(1, [unit(1, [node('u1n0', 'lesson', 1), node('u1n1', 'unitReview', 1)])]),
    ]);
    const overlays = jumpHereOverlays(model);
    expect(overlays).toHaveLength(1);
    expect(overlays[0]?.kind).toBe('section');
    expect(overlays[0]?.flavour).toBe('sectionTest');
  });
});

describe('placement integrity', () => {
  it('[INV-PATH-23] falsifier: Unit Rewind pays once per unit per local day, from any entry point', () => {
    const input = falsifier('INV-PATH-23');
    let ledger = EMPTY_UNIT_REWIND_LEDGER;
    let paid = 0;
    for (const entry of input.entries as UnitRewindEntry[]) {
      const result = planUnitRewind(
        ledger,
        { unitId: input.unitId as string, localDay: input.localDay as number },
        entry,
      );
      ledger = result.ledger;
      if (result.award.payAward) paid += 1;
    }
    expect(paid).toBe((input.expect as { awardsPaid: number }).awardsPaid);
  });

  it('[INV-PATH-23] no placed node points backwards, over generated paths', () => {
    fc.assert(
      fc.property(linearModelArb, ({ model }) => {
        expect(placementViolations(model)).toEqual([]);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PATH-23] a node stored with a foreign unit index is reported as backwards', () => {
    const broken = makeModel([
      section(0, [unit(0, [node('bad', 'lesson', 0)]), unit(1, [node('back', 'lesson', 0)])]),
    ]);
    expect(placementViolations(broken)).toEqual([{ nodeId: 'back', reason: 'backwards' }]);
  });

  it('[INV-PATH-23] the jump-here overlay may never be stored as a node', () => {
    const broken = makeModel([section(0, [unit(0, [node('overlay', 'jumpHere', 0)])])]);
    expect(placementViolations(broken).map((v) => v.reason)).toContain('never-placed');
  });

  it('[INV-PATH-15] a chest or a trophy may not head a unit: it leaves the learner no session', () => {
    const chestFirst = makeModel([
      section(0, [unit(0, [node('c', 'chest', 0), node('l', 'lesson', 0)])]),
    ]);
    expect(placementViolations(chestFirst)).toEqual([{ nodeId: 'c', reason: 'cannot-head-unit' }]);
  });

  it('[INV-PATH-23] a rewind entry on a NEW local day pays again', () => {
    const first = planUnitRewind(
      EMPTY_UNIT_REWIND_LEDGER,
      { unitId: 'u1', localDay: 1 },
      'hub-hero',
    );
    expect(first.award.payAward).toBe(true);
    const sameDay = planUnitRewind(first.ledger, { unitId: 'u1', localDay: 1 }, 'section-list');
    expect(sameDay.award.payAward).toBe(false);
    const nextDay = planUnitRewind(first.ledger, { unitId: 'u1', localDay: 2 }, 'section-list');
    expect(nextDay.award.payAward).toBe(true);
  });
});

describe('script prerequisites', () => {
  const scriptModel = (jumped: boolean): PathModel => {
    const base = makeModel([
      section(0, [
        unit(0, [
          node('letters0', 'letters', 0, { introducesScriptUnits: ['hiragana-a'] }),
          node('lesson0', 'lesson', 0, { requiresScriptUnits: ['hiragana-a'] }),
          node('trophy0', 'unitReview', 0),
        ]),
      ]),
      section(1, [
        unit(1, [
          node('lesson1', 'lesson', 1, { requiresScriptUnits: ['hiragana-a'] }),
          node('trophy1', 'unitReview', 1),
        ]),
      ]),
    ]);
    return jumped ? applyJump(base, 1) : base;
  };

  it('[INV-PATH-26] falsifier: a Section-2 jump serves no item needing an unintroduced script unit', () => {
    const input = falsifier('INV-PATH-26');
    const jumped = scriptModel(true);
    expect(unintroducedScriptUnitsInServedItems(jumped)).toEqual(
      (input.expect as { unintroducedInServedItems: string[] }).unintroducedInServedItems,
    );
    expect(lettersNodesReachable(jumped)).toBe(
      (input.expect as { lettersReachable: boolean }).lettersReachable,
    );
    // The letters node is the unlocked required prefix at the target.
    expect(servedNodes(jumped).map((n) => n.id)).toContain('letters0');
    // ...and the jumped-to lesson stays unserved until it is done.
    expect(servedNodes(jumped).map((n) => n.id)).not.toContain('lesson1');
  });

  it('[INV-PATH-26] a jump never grants a script unit: only completing the letters node does', () => {
    const jumped = scriptModel(true);
    expect(jumped.introducedScriptUnits).toEqual([]);
  });

  it('[INV-PATH-26] no served item needs an unintroduced script unit, over generated paths', () => {
    fc.assert(
      fc.property(
        courseShapeArb,
        fc.nat({ max: 20 }),
        fc.array(fc.nat({ max: 4 }), { minLength: 0, maxLength: 4 }),
        (shape, completed, jumpTargets) => {
          let model = buildModel(shape, completed);
          // Sprinkle a script requirement onto every non-letters node that sits AFTER a
          // letters node in course order, so the property is about the shape it claims.
          // (Requiring a script unit before the node that introduces it is a pack-content
          // error `coursekit validate` catches at G3b, not a path-engine state.)
          let introduced = false;
          const units = allUnits(model).map((u) => ({
            ...u,
            nodes: u.nodes.map((n) => {
              if (n.type === 'letters') {
                introduced = true;
                return { ...n, introducesScriptUnits: ['s1'] };
              }
              return introduced ? { ...n, requiresScriptUnits: ['s1'] } : n;
            }),
          }));
          let cursor = 0;
          model = {
            ...model,
            sections: model.sections.map((s) => {
              const slice = units.slice(cursor, cursor + s.units.length);
              cursor += s.units.length;
              return { ...s, units: slice };
            }),
          };
          const total = allUnits(model).length;
          for (const target of jumpTargets) {
            if (target < total) model = applyJump(model, target);
          }
          expect(unintroducedScriptUnitsInServedItems(model)).toEqual([]);
          expect(lettersNodesReachable(model)).toBe(true);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
});
