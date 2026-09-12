/**
 * Test doubles for the ports this lane does not own.
 *
 * LANE NOTE. `GradingPort` is implemented by `packages/core/src/grading` and
 * `SchedulerPort` by `packages/core/src/scheduler` — both other P1 tasks, neither on
 * `origin/main` yet. Rather than reimplement a checker (explicitly forbidden), the
 * session tests drive these fakes through the real interfaces. When the real modules land
 * the tests keep running and only the construction lines change.
 *
 * Shipped in `src/` rather than a test folder so that the app can use them for a debug
 * build, and so the purity test covers them like everything else.
 */
import type {
  AudioAvailabilityPort,
  GradeRequest,
  GradingPort,
  ModalityPort,
  MonotonicClock,
  PackResolverPort,
  SchedulerCommit,
  SchedulerPort,
} from './ports.js';
import type { ItemFamily, MistakeRow, QueuedItem, Verdict, VerdictKind } from './types.js';

/**
 * A grader driven by a script: `verdicts[itemId]`, defaulting to `correct`.
 *
 * `setVerdict` takes a whole `Verdict`, notes included, because the tier-2 note is part
 * of what the real grader returns (six soft notes, `deep/01` §Rules) and INV-COM-09 is
 * about what the runtime does with it. A double that could only produce a bare kind made
 * that invariant untestable, which is how the note came to be silently dropped.
 */
export class ScriptedGrading implements GradingPort {
  #verdicts: Map<string, Verdict>;
  #fallback: Verdict;

  constructor(verdicts: Record<string, VerdictKind> = {}, fallback: VerdictKind = 'correct') {
    this.#verdicts = new Map(
      Object.entries(verdicts).map(([id, kind]) => [id, { kind }] as const),
    );
    this.#fallback = { kind: fallback };
  }

  set(itemId: string, verdict: VerdictKind): void {
    this.#verdicts.set(itemId, { kind: verdict });
  }

  setVerdict(itemId: string, verdict: Verdict): void {
    this.#verdicts.set(itemId, verdict);
  }

  setFallback(verdict: Verdict): void {
    this.#fallback = verdict;
  }

  grade(request: GradeRequest): Verdict {
    return this.#verdicts.get(request.item.itemId) ?? this.#fallback;
  }
}

export class RecordingScheduler implements SchedulerPort {
  readonly commits: SchedulerCommit[] = [];
  #due: readonly QueuedItem[];
  #seen: ReadonlySet<string>;
  #open: readonly MistakeRow[];

  constructor(
    options: {
      due?: readonly QueuedItem[];
      seen?: Iterable<string>;
      openMistakes?: readonly MistakeRow[];
    } = {},
  ) {
    this.#due = options.due ?? [];
    this.#seen = new Set(options.seen ?? []);
    this.#open = options.openMistakes ?? [];
  }

  commit(commit: SchedulerCommit): void {
    this.commits.push(commit);
  }

  duePool(): readonly QueuedItem[] {
    return this.#due;
  }

  /** Default TRUE: an unconfigured fixture must not silently empty every queue. */
  isSeen(_courseId: string, itemId: string): boolean {
    return this.#seen.size === 0 ? true : this.#seen.has(itemId);
  }

  openMistakes(): readonly MistakeRow[] {
    return this.#open;
  }
}

export class FixedAudio implements AudioAvailabilityPort {
  #unavailable: ReadonlySet<string>;
  constructor(unavailable: Iterable<string> = []) {
    this.#unavailable = new Set(unavailable);
  }
  canProduce(itemId: string): boolean {
    return !this.#unavailable.has(itemId);
  }
}

export class FixedPack implements PackResolverPort {
  #missingIds: ReadonlySet<string>;
  #movedTo: ReadonlyMap<string, string>;
  #missingAssets: ReadonlySet<string>;
  #nodeRef: string;

  constructor(
    options: {
      nodeRef?: string;
      unresolved?: Iterable<string>;
      movedTo?: Record<string, string>;
      missingAssets?: Iterable<string>;
    } = {},
  ) {
    this.#nodeRef = options.nodeRef ?? 'node-1';
    this.#missingIds = new Set(options.unresolved ?? []);
    this.#movedTo = new Map(Object.entries(options.movedTo ?? {}));
    this.#missingAssets = new Set(options.missingAssets ?? []);
  }

  resolves(itemId: string): boolean {
    return !this.#missingIds.has(itemId);
  }

  nodeRefOf(itemId: string): string | null {
    if (this.#missingIds.has(itemId)) return null;
    return this.#movedTo.get(itemId) ?? this.#nodeRef;
  }

  assetPresent(itemId: string): boolean {
    return !this.#missingAssets.has(itemId);
  }
}

export class FixedModality implements ModalityPort {
  #gated: readonly ItemFamily[];
  constructor(gated: readonly ItemFamily[] = []) {
    this.#gated = gated;
  }
  gatedFamilies(): readonly ItemFamily[] {
    return this.#gated;
  }
}

/**
 * A monotonic counter under test control.
 *
 * It refuses to go backwards on its own — a real monotonic clock cannot — but `set()`
 * accepts any value so a test can feed the runtime an adversarial reading and assert that
 * `monotonicAgeMs` clamps rather than returning a negative age (INV-SESS-10).
 */
export class TestMonotonicClock implements MonotonicClock {
  #ms: number;
  constructor(startMs = 0) {
    this.#ms = startMs;
  }
  nowMs(): number {
    return this.#ms;
  }
  advance(ms: number): void {
    this.#ms += ms;
  }
  set(ms: number): void {
    this.#ms = ms;
  }
}
