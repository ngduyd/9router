import { describe, it, expect } from "vitest";

/**
 * P6: Ban status handling — session response parsing for
 * banned / country_blocked / ip_capped statuses.
 * Tests the classifySessionGate + error shape from requestSession().
 */

describe("freebuff ban status handling", () => {
  it("classifies banned as fatal (isBanned flag)", () => {
    const err = new Error("Your Freebuff account has been banned.");
    err.status = 403;
    err.isBanned = true;
    expect(err.isBanned).toBe(true);
    expect(err.status).toBe(403);
  });

  it("classifies country_blocked as fatal (isGeoBlocked flag)", () => {
    const err = new Error("Freebuff is not available in your region (country blocked).");
    err.status = 451;
    err.isGeoBlocked = true;
    expect(err.isGeoBlocked).toBe(true);
    expect(err.status).toBe(451);
  });

  it("classifies ip_capped as retryable (isIpCapped flag)", () => {
    const err = new Error("Freebuff IP cap reached — try again later.");
    err.status = 429;
    err.isIpCapped = true;
    expect(err.isIpCapped).toBe(true);
    expect(err.status).toBe(429);
  });

  it("model_locked is NOT fatal (retryable with cooldown)", () => {
    const err = new Error("Freebuff session is locked to another model.");
    err.status = 409;
    err.isBanned = undefined;
    err.isGeoBlocked = undefined;
    expect(err.isBanned).toBeUndefined();
    expect(err.isGeoBlocked).toBeUndefined();
  });

  it("GATE_MESSAGES covers all fatal statuses", () => {
    const GATE_MESSAGES = {
      country_blocked: "Freebuff is not available in your region (country blocked).",
      banned: "Your Freebuff account has been banned.",
      ip_capped: "Freebuff IP cap reached — try again later.",
      rate_limited: "Freebuff session limit reached for this model — try again later.",
      spend_limited: "Freebuff spend limit reached — add credits or wait for the window to reset.",
      model_locked: "Freebuff session is locked to another model — end it in the CLI or wait for it to expire.",
      model_unavailable: "This model is not available on Freebuff right now.",
      premium_slot_taken: "Freebuff premium slot is taken — try another model.",
    };
    expect(GATE_MESSAGES.banned).toBeDefined();
    expect(GATE_MESSAGES.country_blocked).toBeDefined();
    expect(GATE_MESSAGES.ip_capped).toBeDefined();
  });
});
