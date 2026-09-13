/** Practice Hub S091–S100. Pure selection over persisted, active-course facts. */
import { civilDaysBetween, type LocalDay } from '../day/civil.js';
import { seededPrng } from '../economy/prng.js';
import { awardForSession, EMPTY_LADDER_STATE, type LadderStateToday } from '../economy/xp.js';
import { expireBoosts } from '../economy/boost.js';
import { FLAVOUR_XP } from '../economy/config.js';
import { serveItemsFromPool, type ReviewPoolDay } from '../scheduler/pool.js';
import type { ItemId } from '../scheduler/types.js';
import type { ActiveBoost, SessionFlavour, XpLadderMode } from '../types/index.js';

/** Freelingo choices, 2026-09-13; deep07, EC-HUB02/03/08 and EC-MIS05/06. */
export const HUB_CONFIG = {
  target: 10,
  maxChoices: 4,
  mistakeCap: 60,
  mistakeAgeDays: 30,
  recentDays: 14,
  rewindCooldownDays: 7,
  pathPromotionDays: 3,
  fallbackOrder: ['rewind', 'words'],
} as const;
export type HubKind =
  'today' | 'mistakes' | 'words' | 'listen' | 'speak' | 'target' | 'rewind' | 'path';
export interface HubItem {
  readonly itemId: string;
  readonly unitIndex: number;
  readonly introducedAtUtc: string;
  readonly lastSeenAtUtc: string;
  readonly lastSeenLocalDay: LocalDay;
  readonly dueAtUtc: string;
  readonly text: string;
  readonly gloss: string;
  readonly readingForm: string;
  readonly kind: 'lexeme' | 'grammar' | 'particle' | 'morpheme' | 'character';
  readonly example: string;
  readonly audioRef: string | null;
  readonly retrievability: number;
  /** Only forms that the installed pack and current generation policy can actually serve. */
  readonly modalities: readonly ('text' | 'listen' | 'speak')[];
}
export interface HubMistake {
  readonly itemId: string;
  readonly lastMissedAtUtc: string;
  readonly lastMissedLocalDay: LocalDay;
  readonly misses: number;
}
export interface OtherCourseMistakes {
  readonly courseId: string;
  readonly courseLabel: string;
  readonly count: number;
}
export interface HubDailyState {
  readonly courseId: string;
  readonly localDay: LocalDay;
  readonly choiceIds: readonly string[];
  readonly completedIds: readonly string[];
  readonly cursor: number;
}
export interface SharedReviewSnapshot {
  readonly localDay: LocalDay;
  readonly itemIds: readonly string[];
  readonly spentIds: readonly string[];
}
export interface HubPreferences {
  readonly listening: boolean;
  readonly speaking: boolean;
  readonly listeningUntilUtc: string | null;
  readonly speakingUntilUtc: string | null;
}
export interface HubInput {
  readonly courseId: string;
  readonly courseLabel: string;
  readonly localDay: LocalDay;
  readonly nowUtc: string;
  readonly seed: string;
  readonly items: readonly HubItem[];
  readonly mistakes: readonly HubMistake[];
  readonly sharedReview: SharedReviewSnapshot;
  readonly completedUnitIndices: readonly number[];
  readonly currentUnitIndex: number;
  readonly unitLastOfferedDays: Readonly<Record<number, LocalDay>>;
  readonly pathOffer: {
    readonly id: string;
    readonly nodeId: string;
    readonly title: string;
    readonly advertisedXp: number;
  } | null;
  readonly lastPathCompletedDay: LocalDay;
  readonly preferences: HubPreferences;
  readonly audioAvailable: boolean;
  readonly microphoneAvailable: boolean;
  readonly packReady: boolean;
  readonly daily: HubDailyState | null;
  readonly activeBoost: ActiveBoost | null;
  readonly ladders: Partial<Readonly<Record<XpLadderMode, LadderStateToday>>>;
  readonly otherCourseMistakes: readonly OtherCourseMistakes[];
}
export interface HubOffer {
  readonly id: string;
  readonly courseId: string;
  readonly localDay: LocalDay;
  readonly kind: HubKind;
  readonly title: string;
  readonly flavour: SessionFlavour;
  readonly itemIds: readonly string[];
  readonly advertisedXp: number;
  readonly nodeId: string | null;
  readonly unitIndex: number | null;
  readonly reserveSharedReview: boolean;
  readonly practiceItemRatio: number;
}
export interface HubMode {
  readonly kind: HubKind;
  readonly title: string;
  readonly count: number;
  readonly reason: string | null;
  readonly offer: HubOffer | null;
}
export interface HubModel {
  readonly courseId: string;
  readonly courseLabel: string;
  readonly hero: HubOffer | null;
  readonly canSwitch: boolean;
  readonly modes: readonly HubMode[];
  readonly daily: HubDailyState;
  readonly otherCourseMistakes: readonly OtherCourseMistakes[];
  readonly mistakeBadge: string;
  readonly mistakeEvictions: readonly {
    readonly itemId: string;
    readonly reason: 'aged' | 'overflow';
  }[];
}
export const HUB_MODES: readonly {
  readonly kind: Exclude<HubKind, 'path'>;
  readonly title: string;
  readonly flavour: SessionFlavour;
}[] = [
  { kind: 'today', title: "Today's Review", flavour: 'hubTargetPractice' },
  { kind: 'mistakes', title: 'Mistakes', flavour: 'hubMistakes' },
  { kind: 'words', title: 'Words', flavour: 'hubWords' },
  { kind: 'listen', title: 'Listen-Up', flavour: 'hubListenUp' },
  { kind: 'speak', title: 'Perfect Pronunciation', flavour: 'hubPronunciation' },
  { kind: 'target', title: 'Target Practice', flavour: 'hubTargetPractice' },
  { kind: 'rewind', title: 'Unit Rewind', flavour: 'hubUnitRewind' },
];
function millis(value: string): number {
  const n = Date.parse(value);
  if (!Number.isFinite(n)) throw new RangeError('Invalid Hub timestamp: ' + value);
  return n;
}
function uniqueItems(items: readonly HubItem[]): HubItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    if (seen.has(i.itemId)) return false;
    seen.add(i.itemId);
    return true;
  });
}
function selectedHero(modes: readonly HubMode[], daily: HubDailyState): HubOffer | null {
  const ids = daily.choiceIds;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[(Math.max(0, daily.cursor) + i) % ids.length];
    if (id === undefined || daily.completedIds.includes(id)) continue;
    const offer = modes.find((m) => m.offer?.id === id)?.offer;
    if (offer) return offer;
  }
  for (const kind of HUB_CONFIG.fallbackOrder) {
    const offer = modes.find((mode) => mode.kind === kind)?.offer;
    if (offer && !daily.completedIds.includes(offer.id)) return offer;
  }
  return null;
}
/** Render selection does not mutate the durable mistake queue or reserve review items. */
export function buildHub(input: HubInput): HubModel {
  const now = millis(input.nowUtc);
  const introduced = uniqueItems(input.items).filter((i) => millis(i.introducedAtUtc) <= now);
  const listeningPaused =
    input.preferences.listeningUntilUtc !== null &&
    millis(input.preferences.listeningUntilUtc) > now;
  const speakingPaused =
    input.preferences.speakingUntilUtc !== null && millis(input.preferences.speakingUntilUtc) > now;
  const eligible = introduced.filter(
    (i) =>
      i.modalities.includes('text') ||
      (input.preferences.listening &&
        !listeningPaused &&
        input.audioAvailable &&
        i.modalities.includes('listen')) ||
      (input.preferences.speaking &&
        !speakingPaused &&
        input.microphoneAvailable &&
        i.modalities.includes('speak')),
  );
  const introducedIds = new Set(introduced.map((i) => i.itemId));
  const byId = new Map(eligible.map((i) => [i.itemId, i]));
  const due = eligible
    .filter((i) => millis(i.dueAtUtc) <= now)
    .sort((a, b) => millis(a.dueAtUtc) - millis(b.dueAtUtc) || a.itemId.localeCompare(b.itemId));
  const evictions: { itemId: string; reason: 'aged' | 'overflow' }[] = [];
  const seen = new Set<string>();
  const mistakes = [...input.mistakes]
    .sort(
      (a, b) =>
        millis(b.lastMissedAtUtc) - millis(a.lastMissedAtUtc) ||
        b.misses - a.misses ||
        a.itemId.localeCompare(b.itemId),
    )
    .filter((m) => {
      if (!introducedIds.has(m.itemId) || seen.has(m.itemId)) return false;
      seen.add(m.itemId);
      if (civilDaysBetween(m.lastMissedLocalDay, input.localDay) > HUB_CONFIG.mistakeAgeDays) {
        evictions.push({ itemId: m.itemId, reason: 'aged' });
        return false;
      }
      return true;
    });
  for (const m of mistakes.slice(HUB_CONFIG.mistakeCap))
    evictions.push({ itemId: m.itemId, reason: 'overflow' });
  const kept = mistakes.slice(0, HUB_CONFIG.mistakeCap);
  const missed = new Set(kept.map((m) => m.itemId));
  const rewindUnits = input.completedUnitIndices.filter(
    (u) =>
      u !== input.currentUnitIndex &&
      (input.unitLastOfferedDays[u] === undefined ||
        civilDaysBetween(input.unitLastOfferedDays[u], input.localDay) >=
          HUB_CONFIG.rewindCooldownDays),
  );
  const overdue = (unit: number): number =>
    due.filter((i) => i.unitIndex === unit).reduce((n, i) => n + now - millis(i.dueAtUtc), 0);
  const rewind =
    rewindUnits.filter((u) => overdue(u) > 0).sort((a, b) => overdue(b) - overdue(a) || a - b)[0] ??
    null;
  const pools: Record<Exclude<HubKind, 'path'>, readonly HubItem[]> = {
    today:
      input.sharedReview.localDay === input.localDay
        ? input.sharedReview.itemIds
            .filter((id) => !input.sharedReview.spentIds.includes(id))
            .flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
        : [],
    mistakes: kept.flatMap((m) => (byId.has(m.itemId) ? [byId.get(m.itemId)!] : [])),
    words: eligible,
    listen: eligible.filter((i) => i.modalities.includes('listen')),
    speak: eligible.filter((i) => i.modalities.includes('speak')),
    target: eligible.filter(
      (i) =>
        civilDaysBetween(i.lastSeenLocalDay, input.localDay) >= 0 &&
        civilDaysBetween(i.lastSeenLocalDay, input.localDay) <= HUB_CONFIG.recentDays &&
        (missed.has(i.itemId) || millis(i.dueAtUtc) <= now),
    ),
    rewind: due.filter((i) => i.unitIndex === rewind),
  };
  const modes: HubMode[] = HUB_MODES.map((mode) => {
    const pool = pools[mode.kind];
    const reason = !input.packReady
      ? 'Practice Hub is currently unavailable'
      : mode.kind === 'listen' && !input.preferences.listening
        ? 'Turn on listening exercises to practice this session!'
        : mode.kind === 'speak' && !input.preferences.speaking
          ? 'Turn on speaking exercises to practice this session!'
          : mode.kind === 'listen' && listeningPaused
            ? 'Listening exercises are paused'
            : mode.kind === 'speak' && speakingPaused
              ? 'Speaking exercises are paused'
              : mode.kind === 'listen' && !input.audioAvailable
                ? 'No listening exercises.'
                : mode.kind === 'speak' && !input.microphoneAvailable
                  ? 'Turn on your microphone!'
                  : pool.length === 0
                    ? mode.kind === 'mistakes'
                      ? "Good job! You've reviewed all your mistakes"
                      : 'Come back later to practice as you make more progress'
                    : null;
    const ids = pool.slice(0, HUB_CONFIG.target).map((i) => i.itemId);
    const award = awardForSession({
      flavour: mode.flavour,
      outcome: 'completed',
      boostAtSessionStart: expireBoosts(
        { activeBoost: input.activeBoost, inventory: [] },
        input.nowUtc,
      ).activeBoost,
      practiceItemRatio: ids.length / HUB_CONFIG.target,
      committedAtUtc: input.nowUtc,
      ladderStateToday: input.ladders[FLAVOUR_XP[mode.flavour].ladderMode] ?? EMPTY_LADDER_STATE,
    });
    const offer: HubOffer | null =
      reason !== null
        ? null
        : {
            id: `${input.localDay}/${input.courseId}/${mode.kind}/${mode.kind === 'rewind' ? rewind : ''}`,
            courseId: input.courseId,
            localDay: input.localDay,
            kind: mode.kind,
            title: mode.title,
            flavour: mode.flavour,
            itemIds: ids,
            advertisedXp: award.awardedXp,
            practiceItemRatio: ids.length / HUB_CONFIG.target,
            nodeId: null,
            unitIndex: mode.kind === 'rewind' ? rewind : null,
            reserveSharedReview: mode.kind === 'today',
          };
    return { kind: mode.kind, title: mode.title, count: pool.length, reason, offer };
  });
  const path = input.pathOffer;
  const promote =
    input.packReady &&
    path !== null &&
    civilDaysBetween(input.lastPathCompletedDay, input.localDay) >= HUB_CONFIG.pathPromotionDays;
  if (promote)
    modes.unshift({
      kind: 'path',
      title: path.title,
      count: 1,
      reason: null,
      offer: {
        id: `${input.localDay}/${input.courseId}/path/${path.id}`,
        courseId: input.courseId,
        localDay: input.localDay,
        kind: 'path',
        title: path.title,
        flavour: 'lesson',
        itemIds: [],
        advertisedXp: path.advertisedXp,
        practiceItemRatio: 1,
        nodeId: path.nodeId,
        unitIndex: null,
        reserveSharedReview: false,
      },
    });
  // Freeze candidate identities independently of temporary eligibility. A cold visit
  // must not freeze an empty menu for the remainder of this local day.
  const allIds = modes.map(
    (m) =>
      m.offer?.id ??
      `${input.localDay}/${input.courseId}/${m.kind}/${m.kind === 'rewind' ? rewind : ''}`,
  );
  const shuffled = seededPrng(`${input.seed}/${input.localDay}/${input.courseId}`).shuffle(
    allIds.filter((id) => !id.includes('/path/')),
  );
  const prior =
    input.daily?.localDay === input.localDay && input.daily.courseId === input.courseId
      ? input.daily
      : null;
  const daily =
    prior && prior.choiceIds.length > 0
      ? prior
      : {
          courseId: input.courseId,
          localDay: input.localDay,
          choiceIds: [...(promote ? [allIds[0]!] : []), ...shuffled].slice(
            0,
            HUB_CONFIG.maxChoices,
          ),
          completedIds: prior?.completedIds ?? [],
          cursor: 0,
        };
  return {
    courseId: input.courseId,
    courseLabel: input.courseLabel,
    modes,
    daily,
    hero: selectedHero(modes, daily),
    canSwitch:
      daily.choiceIds.filter(
        (id) => !daily.completedIds.includes(id) && modes.some((m) => m.offer?.id === id),
      ).length > 1,
    otherCourseMistakes: input.otherCourseMistakes.filter(
      (c) => c.courseId !== input.courseId && c.count > 0,
    ),
    mistakeBadge: mistakes.length >= HUB_CONFIG.mistakeCap ? '60+' : String(kept.length),
    mistakeEvictions: evictions,
  };
}
export function nextHubChoice(model: HubModel): HubModel {
  if (!model.canSwitch) return model;
  const visible = model.daily.choiceIds.indexOf(model.hero?.id ?? '');
  for (let offset = 1; offset <= model.daily.choiceIds.length; offset++) {
    const cursor = (Math.max(visible, 0) + offset) % model.daily.choiceIds.length;
    const id = model.daily.choiceIds[cursor];
    const offer = model.modes.find((mode) => mode.offer?.id === id)?.offer;
    if (offer && !model.daily.completedIds.includes(offer.id)) {
      const daily = { ...model.daily, cursor };
      return { ...model, daily, hero: offer };
    }
  }
  return model;
}
/** Must run against a fresh snapshot inside the session-creation transaction. */
export function prepareHubLaunch(
  input: HubInput,
  offered: HubOffer,
): { offer: HubOffer; sharedReview: SharedReviewSnapshot } {
  const current = buildHub(input).modes.find((m) => m.offer?.id === offered.id)?.offer;
  if (!current || JSON.stringify(current) !== JSON.stringify(offered))
    throw new Error('This practice session is no longer available');
  if (!current.reserveSharedReview) return { offer: current, sharedReview: input.sharedReview };
  const pool: ReviewPoolDay = {
    localDay: input.sharedReview.localDay,
    itemIds: input.sharedReview.itemIds as readonly ItemId[],
    spentBy: new Map(
      input.sharedReview.spentIds.map((id) => [id as ItemId, 'dailyRefresh' as const]),
    ),
  };
  const reserved = serveItemsFromPool(pool, 'todaysReview', current.itemIds as readonly ItemId[]);
  if (reserved.served.length !== current.itemIds.length)
    throw new Error('This practice session is no longer available');
  return {
    offer: current,
    sharedReview: { ...input.sharedReview, spentIds: [...reserved.pool.spentBy.keys()] },
  };
}
export interface WordSort {
  readonly id: string;
  readonly label: string;
  readonly comparator: 'introduced' | 'alphabetical' | 'gojuon';
}
export function wordRows(items: readonly HubItem[], sort: WordSort): HubItem[] {
  for (const i of items)
    if (
      !i.text.trim() ||
      !i.gloss.trim() ||
      !i.example.trim() ||
      !i.lastSeenAtUtc ||
      (sort.comparator === 'gojuon' && !i.readingForm.trim())
    )
      throw new Error('Incomplete Words row: ' + i.itemId);
  const collator = new Intl.Collator(sort.comparator === 'gojuon' ? 'ja' : 'en');
  return uniqueItems(items).sort((a, b) =>
    sort.comparator === 'introduced'
      ? millis(b.introducedAtUtc) - millis(a.introducedAtUtc) || a.itemId.localeCompare(b.itemId)
      : collator.compare(
          sort.comparator === 'gojuon' ? a.readingForm : a.text,
          sort.comparator === 'gojuon' ? b.readingForm : b.text,
        ) || a.itemId.localeCompare(b.itemId),
  );
}
