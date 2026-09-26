// Global frozen clock: every test sees the same "now". Only Date is faked, so
// real timers (spawnSync timeouts, polling helpers) keep working.
import { afterEach, beforeEach, vi } from "vitest";

// Mid-month weekday, no nearby DST boundary.
export const FROZEN_NOW = new Date("2026-09-16T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FROZEN_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});
