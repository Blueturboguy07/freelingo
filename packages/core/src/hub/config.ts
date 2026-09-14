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
