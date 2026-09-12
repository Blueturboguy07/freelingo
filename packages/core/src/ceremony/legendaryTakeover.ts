/**
 * The full-screen `Prove you're a legend` takeover (S021), and when to stop showing it.
 *
 * INV-CER-10 / EC-CER-17: after **two consecutive declines** on a course the takeover is
 * suppressed and the offer stays on the completed-node popup, which remains permanently
 * reachable; it re-arms on a section boundary or an accepted run. Recorded as a deliberate
 * divergence - Duolingo's funnel was a paywall, and Freelingo's Legendary is free.
 *
 * The popup LEGENDARY button is never disabled by any of this.
 */

export interface TakeoverState {
  readonly consecutiveDeclines: number;
}

export const FRESH_TAKEOVER_STATE: TakeoverState = { consecutiveDeclines: 0 };

/** Declines it takes to suppress the takeover. */
export const DECLINES_BEFORE_SUPPRESSION = 2;

export function takeoverEligible(state: TakeoverState): boolean {
  return state.consecutiveDeclines < DECLINES_BEFORE_SUPPRESSION;
}

/** The popup button is always enabled - suppression touches the takeover only. */
export function popupLegendaryEnabled(): boolean {
  return true;
}

export function recordDecline(state: TakeoverState): TakeoverState {
  return { consecutiveDeclines: state.consecutiveDeclines + 1 };
}

export function recordAccepted(): TakeoverState {
  return FRESH_TAKEOVER_STATE;
}

export function onSectionBoundary(): TakeoverState {
  return FRESH_TAKEOVER_STATE;
}
