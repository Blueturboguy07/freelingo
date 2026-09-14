import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import { toLocalDay } from '../day/civil.js';
import {
  buildHub,
  nextHubChoice,
  prepareHubLaunch,
  wordRows,
  type HubInput,
  type HubItem,
} from './index.js';

const day = toLocalDay('2026-09-13');
const nowUtc = '2026-09-13T15:00:00Z';
const item = (id: string, unitIndex = 1): HubItem => ({
  itemId: id,
  unitIndex,
  introducedAtUtc: '2026-09-01T12:00:00Z',
  lastSeenAtUtc: '2026-09-12T12:00:00Z',
  lastSeenLocalDay: toLocalDay('2026-09-12'),
  dueAtUtc: '2026-09-12T12:00:00Z',
  text: id,
  gloss: 'a word',
  readingForm: id,
  kind: 'lexeme',
  example: 'A complete example.',
  audioRef: 'clip-' + id,
  retrievability: 0.5,
  modalities: ['text', 'listen', 'speak'],
});
export const hubInput = (): HubInput => ({
  courseId: 'en-es',
  courseLabel: 'Spanish',
  localDay: day,
  nowUtc,
  seed: 'learner',
  items: [item('casa'), item('gato')],
  mistakes: [{ itemId: 'casa', lastMissedAtUtc: nowUtc, lastMissedLocalDay: day, misses: 1 }],
  sharedReview: { localDay: day, itemIds: ['casa', 'gato'], spentIds: [] },
  completedUnitIndices: [1],
  currentUnitIndex: 2,
  unitLastOfferedDays: {},
  pathOffer: null,
  lastPathCompletedDay: day,
  preferences: { listening: true, speaking: true, listeningUntilUtc: null, speakingUntilUtc: null },
  audioAvailable: true,
  microphoneAvailable: true,
  packReady: true,
  daily: null,
  activeBoost: null,
  ladders: {},
  otherCourseMistakes: [],
});

describe('P4 Practice Hub source selection', () => {
  it('[INV-HUB-03] a two-item mistake set stays two and pays its capped physical-item award', () => {
    const input = hubInput();
    const model = buildHub({
      ...input,
      mistakes: input.items.map((i) => ({
        itemId: i.itemId,
        lastMissedAtUtc: nowUtc,
        lastMissedLocalDay: day,
        misses: 1,
      })),
    });
    const offer = model.modes.find((m) => m.kind === 'mistakes')!.offer!;
    expect(offer.itemIds).toEqual(['casa', 'gato']);
    expect(offer.advertisedXp).toBe(1);
  });
  it('[INV-HUB-01] other-course mistakes are explicit switch links, never active-course items', () => {
    const model = buildHub({
      ...hubInput(),
      otherCourseMistakes: [{ courseId: 'en-fr', courseLabel: 'French', count: 9 }],
    });
    expect(model.otherCourseMistakes).toEqual([
      { courseId: 'en-fr', courseLabel: 'French', count: 9 },
    ]);
    expect(model.modes.every((m) => m.offer === null || m.offer.courseId === 'en-es')).toBe(true);
  });
  it('[INV-HUB-04] no introduced items means a cold hero and no launchable mode', () => {
    const model = buildHub({ ...hubInput(), items: [], mistakes: [] });
    expect(model.hero).toBeNull();
    expect(model.modes.every((m) => m.offer === null)).toBe(true);
  });
  it('[INV-HUB-05] frozen daily choices survive replay and completing one removes it without rerolling', () => {
    const input = hubInput();
    const first = buildHub(input);
    const frozen = { ...first.daily, completedIds: [first.hero!.id] };
    const again = buildHub({ ...input, daily: frozen });
    expect(again.daily.choiceIds).toEqual(first.daily.choiceIds);
    expect(again.hero?.id).not.toBe(first.hero!.id);
    expect(first.daily.choiceIds.length).toBeLessThanOrEqual(4);
    expect(nextHubChoice(first).hero?.id).not.toBe(first.hero!.id);
  });
  it('[INV-SCH-05] already spent Daily Refresh items cannot reach Today’s Review', () => {
    const input = hubInput();
    const model = buildHub({
      ...input,
      sharedReview: { ...input.sharedReview, spentIds: ['casa'] },
    });
    expect(model.modes.find((m) => m.kind === 'today')!.offer!.itemIds).toEqual(['gato']);
    const launch = prepareHubLaunch(
      input,
      buildHub(input).modes.find((m) => m.kind === 'today')!.offer!,
    );
    expect(launch.sharedReview.spentIds).toEqual(['casa', 'gato']);
    expect(() =>
      prepareHubLaunch({ ...input, sharedReview: launch.sharedReview }, launch.offer),
    ).toThrow('no longer available');
  });
  it('[INV-HUB-06] a neglected path node is promoted and uses its actual supplied offer', () => {
    const pathOffer = {
      id: 'node-2',
      nodeId: 'node-2',
      title: 'Order at a café',
      advertisedXp: 10,
    };
    const model = buildHub({
      ...hubInput(),
      lastPathCompletedDay: toLocalDay('2026-09-09'),
      pathOffer,
    });
    expect(model.hero?.kind).toBe('path');
    expect(model.hero?.nodeId).toBe('node-2');
  });
  it('[INV-HUB-08] Unit Rewind ranks overdue completed units and excludes recent offers/current unit', () => {
    const input = {
      ...hubInput(),
      items: [
        item('one', 1),
        { ...item('old', 3), dueAtUtc: '2026-09-01T00:00:00Z' },
        item('current', 2),
      ],
      completedUnitIndices: [1, 2, 3],
    };
    expect(buildHub(input).modes.find((m) => m.kind === 'rewind')!.offer?.unitIndex).toBe(3);
    expect(
      buildHub({ ...input, unitLastOfferedDays: { 3: day } }).modes.find(
        (m) => m.kind === 'rewind',
      )!.offer?.unitIndex,
    ).toBe(1);
  });
  it('[INV-HUB-09] every modality eligibility vector has a real hero or the cold state', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (listening, speaking, audioAvailable, packReady) => {
          const input = hubInput();
          const model = buildHub({
            ...input,
            audioAvailable,
            packReady,
            preferences: { ...input.preferences, listening, speaking },
          });
          expect(
            model.hero === null || model.hero.kind === 'path' || model.hero.itemIds.length > 0,
          ).toBe(true);
          if (!packReady) expect(model.hero).toBeNull();
          if (!listening || !audioAvailable)
            expect(model.modes.find((m) => m.kind === 'listen')!.offer).toBeNull();
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
  it('[INV-HUB-11] Words includes all introduced item kinds, with immutable learned ordering', () => {
    const a = {
      ...item('は'),
      kind: 'particle' as const,
      gloss: 'topic marker',
      readingForm: 'は',
    };
    const b = {
      ...item('か'),
      kind: 'character' as const,
      gloss: 'ka',
      readingForm: 'か',
      introducedAtUtc: '2026-09-02T00:00:00Z',
    };
    expect(
      wordRows([a, b], { id: 'recent', label: 'Recently learned', comparator: 'introduced' }).map(
        (x) => x.itemId,
      ),
    ).toEqual(['か', 'は']);
  });
  it('[INV-HUB-12] pack gojuon ordering uses readings and never kanji codepoints', () => {
    const rows = [
      { ...item('学校'), readingForm: 'がっこう' },
      { ...item('愛'), readingForm: 'あい' },
    ];
    expect(
      wordRows(rows, { id: 'reading', label: '五十音順', comparator: 'gojuon' }).map(
        (x) => x.itemId,
      ),
    ).toEqual(['愛', '学校']);
  });
  it('[INV-HUB-02] expired and overflow mistake rows are logged, badge clamps at 60+', () => {
    const items = Array.from({ length: 65 }, (_, i) => item('i' + i));
    const model = buildHub({
      ...hubInput(),
      items,
      mistakes: items.map((i) => ({
        itemId: i.itemId,
        lastMissedAtUtc: nowUtc,
        lastMissedLocalDay: day,
        misses: 1,
      })),
    });
    expect(model.mistakeBadge).toBe('60+');
    expect(model.mistakeEvictions).toHaveLength(5);
    expect(model.modes.find((m) => m.kind === 'mistakes')!.count).toBe(60);
  });
});

it('[INV-SCH-08] a paused listen-only item is absent from every mixed Hub offer', () => {
  const input = hubInput();
  const model = buildHub({
    ...input,
    items: [{ ...input.items[0]!, modalities: ['listen'] }],
    preferences: { ...input.preferences, listeningUntilUtc: '2026-09-13T16:00:00Z' },
  });
  expect(model.modes.every((m) => m.offer === null)).toBe(true);
  expect(model.mistakeBadge).toBe('1');
});

it('[INV-HUB-07] recency uses recorded local dates across the fall-back hour, not 24-hour blocks', () => {
  const localDay = toLocalDay('2026-11-09');
  const input = {
    ...hubInput(),
    localDay,
    nowUtc: '2026-11-09T13:00:00Z',
    lastPathCompletedDay: localDay,
    items: [
      {
        ...hubInput().items[0]!,
        lastSeenLocalDay: toLocalDay('2026-10-26'),
        lastSeenAtUtc: '2026-10-26T12:00:00Z',
      },
    ],
    mistakes: [],
  };
  expect(buildHub(input).modes.find((m) => m.kind === 'target')!.offer?.itemIds).toEqual(['casa']);
});
it('[INV-HUB-02] thirty recorded local days do not age a mistake out at a DST boundary', () => {
  const localDay = toLocalDay('2026-11-09');
  const input = {
    ...hubInput(),
    localDay,
    nowUtc: '2026-11-09T13:00:00Z',
    lastPathCompletedDay: localDay,
    mistakes: [
      {
        itemId: 'casa',
        misses: 1,
        lastMissedLocalDay: toLocalDay('2026-10-10'),
        lastMissedAtUtc: '2026-10-10T12:00:00Z',
      },
    ],
  };
  expect(buildHub(input).mistakeEvictions).toEqual([]);
  expect(buildHub(input).mistakeBadge).toBe('1');
});

it('[INV-ECO-15] the Hub offer uses pre-cap proration and carries the ratio used by commit', () => {
  const model = buildHub({
    ...hubInput(),
    ladders: { hubMistakes: { sessionsCompleted: 0, xpAwarded: 59 } },
  });
  const offer = model.modes.find((m) => m.kind === 'mistakes')!.offer!;
  expect(offer.advertisedXp).toBe(0);
  expect(offer.practiceItemRatio).toBe(0.1);
});
it('[INV-ECO-02] the Hub advertises the current boost and drops it at expiry before a new start', () => {
  const input = {
    ...hubInput(),
    activeBoost: {
      kind: 'xpBoost' as const,
      multiplier: 2,
      startedAtUtc: '2026-09-13T14:55:00Z',
      expiresAtUtc: '2026-09-13T15:10:00Z',
    },
  };
  expect(buildHub(input).modes.find((m) => m.kind === 'mistakes')!.offer!.advertisedXp).toBe(1);
  expect(
    buildHub({ ...input, nowUtc: '2026-09-13T15:10:00Z' }).modes.find((m) => m.kind === 'mistakes')!
      .offer!.advertisedXp,
  ).toBe(0);
});

it('[INV-HUB-04] a first cold visit does not strand the hero after the first lesson on the same local day', () => {
  const input = hubInput();
  const cold = buildHub({ ...input, items: [], mistakes: [] });
  const afterLesson = buildHub({ ...input, daily: cold.daily });
  expect(cold.hero).toBeNull();
  expect(afterLesson.hero).not.toBeNull();
  expect(afterLesson.daily.choiceIds).toEqual(cold.daily.choiceIds);
});
it('[INV-HUB-09] ineligible frozen modes fall through to Rewind then Words while completed history remains excluded', () => {
  const input = hubInput();
  const daily = {
    courseId: input.courseId,
    localDay: input.localDay,
    choiceIds: [
      `${input.localDay}/${input.courseId}/listen/`,
      `${input.localDay}/${input.courseId}/speak/`,
    ],
    completedIds: [],
    cursor: 0,
  };
  const disabled = {
    ...input,
    daily,
    preferences: { ...input.preferences, listening: false, speaking: false },
  };
  const rewind = buildHub(disabled);
  expect(rewind.hero?.kind).toBe('rewind');
  expect(rewind.daily.choiceIds).toEqual(daily.choiceIds);
  const words = buildHub({ ...disabled, daily: { ...daily, completedIds: [rewind.hero!.id] } });
  expect(words.hero?.kind).toBe('words');
  const exhausted = buildHub({
    ...disabled,
    daily: { ...daily, completedIds: [rewind.hero!.id, words.hero!.id] },
  });
  expect(exhausted.hero).toBeNull();
  expect(exhausted.daily.completedIds).toEqual([rewind.hero!.id, words.hero!.id]);
});
it('[INV-HUB-05] Switch advances from the visible candidate, skipping unavailable entries without rerolling', () => {
  const input = hubInput();
  const daily = {
    courseId: input.courseId,
    localDay: input.localDay,
    choiceIds: [
      `${input.localDay}/${input.courseId}/listen/`,
      `${input.localDay}/${input.courseId}/words/`,
      `${input.localDay}/${input.courseId}/mistakes/`,
    ],
    completedIds: [],
    cursor: 0,
  };
  const model = buildHub({
    ...input,
    daily,
    preferences: { ...input.preferences, listening: false },
  });
  expect(model.hero?.kind).toBe('words');
  expect(nextHubChoice(model).hero?.kind).toBe('mistakes');
  expect(nextHubChoice(model).daily.choiceIds).toEqual(daily.choiceIds);
});
it('[INV-HUB-05] legacy empty daily state initializes once without losing completed history', () => {
  const input = hubInput();
  const completed = `${input.localDay}/${input.courseId}/words/`;
  const model = buildHub({
    ...input,
    daily: {
      courseId: input.courseId,
      localDay: input.localDay,
      choiceIds: [],
      completedIds: [completed],
      cursor: 0,
    },
  });
  expect(model.hero).not.toBeNull();
  expect(model.hero?.id).not.toBe(completed);
  expect(model.daily.completedIds).toEqual([completed]);
  expect(model.daily.choiceIds.length).toBeLessThanOrEqual(4);
});
