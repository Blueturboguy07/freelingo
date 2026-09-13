import type { InstalledFeatures, MonthlyBadgeRow, QuestProgressRow } from '@freelingo/core/economy';
import type { DayCell, LocalDay } from '@freelingo/core/day';

/** S118/S119: rows were derived and durably updated by the economy transaction. */
export interface QuestsSnapshot {
  readonly localDay: LocalDay;
  readonly resetInSeconds: number;
  readonly quests: readonly QuestProgressRow[];
  readonly badge: MonthlyBadgeRow;
  readonly badgeHistory: readonly MonthlyBadgeRow[];
}
export interface ShopSnapshot {
  readonly gems: number;
  readonly freezes: {
    readonly held: number;
    readonly cap: number;
    readonly refillInDays: number | null;
  };
  /** Monotonic/high-water expiry is already resolved by the runtime, never by Date.now in a view. */
  readonly activeBoost: { readonly multiplier: number; readonly remainingSeconds: number } | null;
  readonly boostInventory: readonly {
    readonly id: string;
    readonly multiplier: number;
    readonly durationMinutes: number;
  }[];
  readonly ownedCosmeticIds: readonly string[];
  readonly equippedCosmeticId: string | null;
}
export interface WeeklyReportSnapshot {
  readonly periodLabel: string;
  readonly wordsStudied: number;
  readonly lessonsFinished: number;
  readonly streak: number;
  readonly studyMinutes: number;
  readonly previousStudyMinutes: number;
  readonly courseProgressLabel: string;
}
export interface ProfileSnapshot {
  readonly joinedLabel: string;
  readonly streak: number;
  /** Account lifetime total, never the removable active course counter. */
  readonly lifetimeXp: number;
  readonly societyBadge: string | null;
  readonly counters: Readonly<Record<string, number>>;
  readonly installedFeatures: InstalledFeatures;
  /** First-tier reachability under all installed packs; null means unbounded. */
  readonly counterMaximums: Readonly<Record<string, number | null>>;
  readonly records: {
    readonly longestStreak: number;
    readonly dailyMostXp: number;
    readonly perfectLessons: number;
  };
  readonly calendar: {
    readonly monthLabel: string;
    readonly today: LocalDay;
    readonly cells: readonly {
      readonly day: LocalDay;
      readonly cell: DayCell;
      readonly provenance: string | null;
    }[];
  };
  readonly weeklyReport: WeeklyReportSnapshot;
}
export interface MainTabsSnapshot {
  readonly quests: QuestsSnapshot;
  readonly shop: ShopSnapshot;
  readonly profile: ProfileSnapshot;
}
/** All mutations are account-wide and transactional. Views await and reread snapshots.
 * Purchase revalidates current SHOP_CATALOGUE entry, funds, cap and ownership inside
 * the transaction. Rejected writes cannot change either balance or inventory.
 * Activation revalidates the exact held row and cannot extend an active boost.
 */
export interface MainTabsPorts {
  purchaseShopEntry(entryId: string): Promise<void>;
  equipCosmetic(entryId: string): Promise<void>;
  activateHeldBoost(inventoryId: string): Promise<void>;
  shareWeeklyReport(): Promise<void>;
}
