/**
 * The four-zone matrix every day/streak property runs in (plan §Verification).
 * Named config: the zones, not string literals scattered through tests.
 */
export interface TestZone {
  readonly id: string;
  /** Why this zone is in the matrix. */
  readonly why: string;
}

export const ZONES: readonly TestZone[] = [
  { id: 'Asia/Tokyo', why: 'UTC+9, no DST' },
  { id: 'America/Los_Angeles', why: 'UTC-8/-7, 23h and 25h days' },
  { id: 'Pacific/Kiritimati', why: 'UTC+14, the earliest civil date on earth' },
  { id: 'Australia/Lord_Howe', why: 'UTC+10:30/+11, a 30-minute DST shift' },
] as const;
