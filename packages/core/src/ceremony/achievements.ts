/**
 * The achievement slot (S079).
 *
 * INV-CER-07 / EC-CER-11, EC-CER-26: at most **one** achievement screen per session,
 * showing the highest tier crossed **per achievement** with a `+N tiers` sub-line, and all
 * crossed tiers' gems summed into the **single** chest. A 20-lesson day would otherwise
 * open a six-screen ceremony. Personal Records update silently, with no screen.
 *
 * Gems for every tier crossed credit atomically at the reward commit whether or not a
 * screen renders, and are paid **once** - folded into the chest bundle, never also on the
 * card.
 */

export interface TierCrossing {
  readonly achievementId: string;
  readonly achievementName: string;
  readonly tier: number;
  readonly gems: number;
}

export interface AchievementRow {
  readonly achievementId: string;
  readonly achievementName: string;
  /** The highest tier crossed this session. */
  readonly tier: number;
  /** Additional tiers crossed below it, for the `+N tiers` sub-line. */
  readonly extraTiers: number;
}

export interface AchievementSlot {
  /** Zero or one screen. Never more (INV-CER-07). */
  readonly screens: readonly { readonly rows: readonly AchievementRow[] }[];
  /** Summed into the chest bundle, never paid on the card as well. */
  readonly gems: number;
}

export function achievementSlot(crossings: readonly TierCrossing[]): AchievementSlot {
  const gems = crossings.reduce((sum, c) => sum + c.gems, 0);
  if (crossings.length === 0) return { screens: [], gems: 0 };
  const byId = new Map<string, TierCrossing[]>();
  for (const c of crossings) {
    const list = byId.get(c.achievementId) ?? [];
    list.push(c);
    byId.set(c.achievementId, list);
  }
  const rows: AchievementRow[] = [];
  for (const [id, list] of byId) {
    const highest = list.reduce((a, b) => (b.tier > a.tier ? b : a));
    rows.push({
      achievementId: id,
      achievementName: highest.achievementName,
      tier: highest.tier,
      extraTiers: list.length - 1,
    });
  }
  rows.sort((a, b) => a.achievementId.localeCompare(b.achievementId));
  return { screens: [{ rows }], gems };
}

/** Personal Records update with no screen. This exists so the gate can assert it. */
export const PERSONAL_RECORDS_RENDER_A_SCREEN = false;
