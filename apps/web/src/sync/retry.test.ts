import { describe, expect, it } from "vitest";
import { FIRST_WAIT_MS, MAX_WAIT_MS, backOff, retryDue } from "./retry";

const NOW = 1_700_000_000_000;

describe("backOff", () => {
  it("doubles the wait with each consecutive failure", () => {
    let schedule = backOff(undefined, NOW);
    expect(schedule).toEqual({ attempts: 1, notBefore: NOW + FIRST_WAIT_MS });

    schedule = backOff(schedule, NOW);
    expect(schedule).toEqual({ attempts: 2, notBefore: NOW + FIRST_WAIT_MS * 2 });

    schedule = backOff(schedule, NOW);
    expect(schedule).toEqual({ attempts: 3, notBefore: NOW + FIRST_WAIT_MS * 4 });
  });

  it("stops growing at the ceiling, however long the outage lasts", () => {
    let schedule = { attempts: 0, notBefore: 0 };
    for (let i = 0; i < 40; i++) schedule = backOff(schedule, NOW);

    // Still counting (the count is what a UI would report), but the wait is
    // capped: an hour-long outage must not become an hour-long silence after it
    // ends.
    expect(schedule.attempts).toBe(40);
    expect(schedule.notBefore).toBe(NOW + MAX_WAIT_MS);
  });
});

describe("retryDue", () => {
  it("lets through anything that is not serving a wait", () => {
    expect(retryDue(undefined, NOW)).toBe(true);
  });

  it("holds until the moment it named, then lets go", () => {
    const schedule = backOff(undefined, NOW);

    expect(retryDue(schedule, NOW)).toBe(false);
    expect(retryDue(schedule, NOW + FIRST_WAIT_MS - 1)).toBe(false);
    expect(retryDue(schedule, NOW + FIRST_WAIT_MS)).toBe(true);
  });
});
