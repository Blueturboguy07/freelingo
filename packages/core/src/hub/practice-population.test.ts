import { expect, it } from 'vitest';
import { buildHub, wordRows, type HubInput, type HubItem } from './index.js';
import { toLocalDay } from '../day/index.js';
const day = toLocalDay('2026-09-13');
function fixture(): HubInput {
  const items: HubItem[] = Array.from({ length: 5 }, (_, i) => ({
    itemId: 'word-' + i,
    unitIndex: 0,
    introducedAtUtc: '2026-09-01T00:00:00Z',
    lastSeenAtUtc: '2026-09-12T00:00:00Z',
    lastSeenLocalDay: toLocalDay('2026-09-12'),
    dueAtUtc: '2026-09-12T00:00:00Z',
    text: 'word ' + i,
    gloss: 'meaning ' + i,
    readingForm: '',
    kind: 'lexeme',
    example: 'Sentence ' + i,
    audioRef: null,
    retrievability: 0.5,
    modalities: [],
  }));
  return {
    courseId: 'en-es',
    courseLabel: 'Spanish',
    localDay: day,
    nowUtc: day + 'T12:00:00Z',
    seed: '4',
    items,
    practiceItems: [
      {
        ...items[0]!,
        itemId: 'match-aggregate',
        targetItemIds: items.map((i) => i.itemId),
        modalities: ['text'],
        practiceModes: ['today', 'mistakes', 'words', 'target', 'rewind'],
      },
    ],
    mistakes: [],
    sharedReview: { localDay: day, itemIds: ['match-aggregate'], spentIds: [] },
    completedUnitIndices: [],
    currentUnitIndex: 0,
    unitLastOfferedDays: {},
    pathOffer: null,
    lastPathCompletedDay: day,
    preferences: {
      listening: true,
      speaking: true,
      listeningUntilUtc: null,
      speakingUntilUtc: null,
    },
    audioAvailable: true,
    microphoneAvailable: true,
    packReady: true,
    daily: null,
    activeBoost: null,
    ladders: {},
    otherCourseMistakes: [],
  };
}
it('[INV-HUB-03][INV-ECO-15] five MATCH targets are one offered exercise and one tenth of the practice award', () => {
  const input = fixture(),
    model = buildHub(input);
  for (const kind of ['today', 'words', 'target']) {
    const offer = model.modes.find((m) => m.kind === kind)!.offer;
    expect(offer?.itemIds).toEqual(['match-aggregate']);
    expect(offer?.practiceItemRatio).toBe(0.1);
  }
  expect(
    wordRows(input.items, { id: 'recent', label: 'Recently learned', comparator: 'introduced' }),
  ).toHaveLength(5);
});
it('[INV-HUB-01][INV-HUB-03] two missed children select their one aggregate exercise once', () => {
  const input = fixture();
  const model = buildHub({
    ...input,
    mistakes: [0, 1].map((i) => ({
      itemId: 'word-' + i,
      lastMissedAtUtc: '2026-09-12T00:00:00Z',
      lastMissedLocalDay: toLocalDay('2026-09-12'),
      misses: 1,
    })),
  });
  expect(model.mistakeBadge).toBe('2');
  expect(model.modes.find((m) => m.kind === 'mistakes')!.offer?.itemIds).toEqual([
    'match-aggregate',
  ]);
  expect(model.modes.find((m) => m.kind === 'mistakes')!.offer?.practiceItemRatio).toBe(0.1);
});
it('[INV-SCH-11][INV-HUB-09] a practice group cannot serve a target absent from the actual introduced list', () => {
  const input = fixture();
  const model = buildHub({ ...input, items: input.items.slice(0, 4) });
  expect(model.hero).toBeNull();
  expect(model.modes.every((m) => m.offer === null)).toBe(true);
});
it('[INV-SCH-05] a spent aggregate is absent from Today while every introduced Words row remains', () => {
  const input = fixture();
  const model = buildHub({
    ...input,
    sharedReview: { ...input.sharedReview, spentIds: ['match-aggregate'] },
  });
  expect(model.modes.find((m) => m.kind === 'today')!.offer).toBeNull();
  expect(model.modes.find((m) => m.kind === 'words')!.offer?.itemIds).toEqual(['match-aggregate']);
  expect(input.items).toHaveLength(5);
});
it('[INV-HUB-04][INV-HUB-09] an explicit typed-only source population cannot advertise a matching Words session', () => {
  const input = fixture();
  const typed = {
    ...input.practiceItems![0]!,
    practiceModes: ['today', 'target', 'rewind'] as const,
  };
  const model = buildHub({ ...input, practiceItems: [typed] });
  expect(model.modes.find((m) => m.kind === 'words')!.offer).toBeNull();
  expect(model.modes.find((m) => m.kind === 'today')!.offer?.itemIds).toEqual([typed.itemId]);
  expect(
    wordRows(input.items, { id: 'recent', label: 'Recently learned', comparator: 'introduced' }),
  ).toHaveLength(5);
});
it('[INV-HUB-04][INV-HUB-09] an explicit physical source without mode proof is unavailable', () => {
  const input = fixture();
  const raw = { ...input.practiceItems![0]! };
  delete raw.practiceModes;
  const model = buildHub({ ...input, practiceItems: [raw] });
  expect(model.modes.every((m) => m.offer === null)).toBe(true);
});

it('[INV-HUB-04][INV-HUB-09] an unavailable different-form source preserves the backlog without claiming it was reviewed', () => {
  const input = fixture();
  const model = buildHub({
    ...input,
    practiceItems: [{ ...input.practiceItems![0]!, practiceModes: ['today', 'words'] }],
    mistakes: [
      {
        itemId: 'word-0',
        lastMissedAtUtc: '2026-09-12T12:00:00Z',
        lastMissedLocalDay: toLocalDay('2026-09-12'),
        misses: 1,
      },
    ],
  });
  expect(model.mistakeBadge).toBe('1');
  expect(model.modes.find((m) => m.kind === 'mistakes')).toMatchObject({
    offer: null,
    reason: 'No eligible exercises are available for these mistakes yet.',
  });
});
