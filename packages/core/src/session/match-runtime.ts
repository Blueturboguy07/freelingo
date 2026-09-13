/** S033: validated per-pair state lives in the existing opaque persisted checkpoint. */
export interface RuntimeMatchPair {
  readonly leftId: string;
  readonly rightId: string;
}
export interface RuntimeMatchTap extends RuntimeMatchPair {
  readonly attemptId: string;
  readonly wrong: boolean;
}
export interface MatchRuntime {
  readonly taps: readonly RuntimeMatchTap[];
  readonly matchedLeftIds: readonly string[];
  readonly paid: number;
}
export const MATCH_RUNTIME_KEY = 'matchRuntime';
export function matchRuntime(
  partial: Readonly<Record<string, unknown>>,
  pairs: readonly RuntimeMatchPair[],
): MatchRuntime | null {
  const value = partial[MATCH_RUNTIME_KEY];
  if (value === undefined) return { taps: [], matchedLeftIds: [], paid: 0 };
  if (
    value === null ||
    typeof value !== 'object' ||
    !('taps' in value) ||
    !Array.isArray(value.taps)
  )
    return null;
  const taps: RuntimeMatchTap[] = [];
  const ids = new Set<string>();
  const matched = new Set<string>();
  let paid = 0;
  for (const raw of value.taps as unknown[]) {
    if (
      raw === null ||
      typeof raw !== 'object' ||
      !('attemptId' in raw) ||
      !('leftId' in raw) ||
      !('rightId' in raw) ||
      typeof raw.attemptId !== 'string' ||
      typeof raw.leftId !== 'string' ||
      typeof raw.rightId !== 'string' ||
      ids.has(raw.attemptId)
    )
      return null;
    const pair = pairs.find((p) => p.leftId === raw.leftId);
    if (
      pair === undefined ||
      !pairs.some((p) => p.rightId === raw.rightId) ||
      matched.has(raw.leftId)
    )
      return null;
    const wrong = pair.rightId !== raw.rightId;
    taps.push({ attemptId: raw.attemptId, leftId: raw.leftId, rightId: raw.rightId, wrong });
    ids.add(raw.attemptId);
    if (wrong) paid++;
    else matched.add(raw.leftId);
  }
  return { taps, matchedLeftIds: [...matched], paid };
}
/** Presentation input may carry all its own keys, but may never manufacture a payment. */
export function preserveMatchRuntime(
  current: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const result = { ...next };
  delete result[MATCH_RUNTIME_KEY];
  if (current[MATCH_RUNTIME_KEY] !== undefined)
    result[MATCH_RUNTIME_KEY] = current[MATCH_RUNTIME_KEY];
  return result;
}
