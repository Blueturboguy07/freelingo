/**
 * Virtual clock. The engine never reads `Date.now()` directly; tests drive time here.
 * P1 extends this with monotonic-vs-wall separation (INV-MOD-01 reboot detection).
 */
export interface Clock {
  now(): Date;
}

export class VirtualClock implements Clock {
  #instant: Date;

  constructor(start: Date | string) {
    this.#instant = typeof start === 'string' ? new Date(start) : new Date(start.getTime());
  }

  now(): Date {
    return new Date(this.#instant.getTime());
  }

  advanceMs(ms: number): void {
    this.#instant = new Date(this.#instant.getTime() + ms);
  }

  advanceHours(hours: number): void {
    this.advanceMs(hours * 3_600_000);
  }

  set(instant: Date | string): void {
    this.#instant = typeof instant === 'string' ? new Date(instant) : new Date(instant.getTime());
  }
}
