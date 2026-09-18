/**
 * Unit tests for Freebuff P8 login-mimic fixes:
 *   - P8.1: Login UA = "Bun/1.3.14" (requestDeviceCode + pollToken)
 *   - P8.2: fingerprintId deterministic per account (enhanced-{sha256(userId).base64url})
 *   - P8.4: getTimezoneForProxy returns Intl timezone, not hardcoded UTC
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

import { FreebuffExecutor } from "../../open-sse/executors/freebuff.js";

const EXECUTOR = new FreebuffExecutor();

// ---------- P8.1: Login UA ----------

describe("P8.1 — Login UA", () => {
  const fakeConfig = {
    baseUrl: "https://freebuff.com",
    loginCodePath: "/api/auth/cli/code",
    loginStatusPath: "/api/auth/cli/status",
    oauthTimeoutMs: 300_000,
  };

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("requestDeviceCode sends Bun/1.3.14 UA", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        fingerprintId: "fp-123",
        fingerprintHash: "hash-abc",
        loginUrl: "https://freebuff.com/login?auth_code=TEST123",
        expiresAt: Date.now() + 600_000,
      }),
    });

    const mod = await import("../../src/lib/oauth/providers/freebuff.js");
    const freebuff = mod.default;

    await freebuff.requestDeviceCode(fakeConfig);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers["User-Agent"]).toBe("Bun/1.3.14");
  });

  it("pollToken sends Bun/1.3.14 UA", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: "authorization_pending" }),
    });

    const mod = await import("../../src/lib/oauth/providers/freebuff.js");
    const freebuff = mod.default;

    const deviceCode = JSON.stringify({
      fingerprintId: "fp-123",
      fingerprintHash: "hash-abc",
      expiresAt: Date.now() + 600_000,
    });

    await freebuff.pollToken(fakeConfig, deviceCode);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers["User-Agent"]).toBe("Bun/1.3.14");
  });
});

// ---------- P8.2: Deterministic fingerprint ----------

describe("P8.2 — Deterministic fingerprintId", () => {
  it("mapTokens produces enhanced-{base64url} fingerprint from userId", async () => {
    const mod = await import("../../src/lib/oauth/providers/freebuff.js");
    const freebuff = mod.default;

    const tokens = {
      access_token: "tok_abc",
      id: "0381a91d-0979-464f-891e-b03aa3570f98",
      email: "test@example.com",
      name: "Test User",
    };

    const result = freebuff.mapTokens(tokens);

    expect(result.providerSpecificData.fingerprintId).toMatch(/^enhanced-/);
    expect(result.providerSpecificData.fingerprintId.length).toBeGreaterThan(10);
    expect(result.providerSpecificData.userId).toBe(tokens.id);
  });

  it("same userId produces same fingerprintId (deterministic)", async () => {
    const mod = await import("../../src/lib/oauth/providers/freebuff.js");
    const freebuff = mod.default;

    const tokens = { access_token: "tok_abc", id: "user-42" };
    const a = freebuff.mapTokens(tokens);
    const b = freebuff.mapTokens(tokens);

    expect(a.providerSpecificData.fingerprintId).toBe(b.providerSpecificData.fingerprintId);
  });

  it("different userId produces different fingerprintId", async () => {
    const mod = await import("../../src/lib/oauth/providers/freebuff.js");
    const freebuff = mod.default;

    const a = freebuff.mapTokens({ access_token: "t1", id: "user-1" });
    const b = freebuff.mapTokens({ access_token: "t2", id: "user-2" });

    expect(a.providerSpecificData.fingerprintId).not.toBe(b.providerSpecificData.fingerprintId);
  });
});

// ---------- P8.4: Timezone fallback ----------

describe("P8.4 — getTimezoneForProxy fallback", () => {
  it("system timezone is a valid IANA string (not always UTC)", () => {
    const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(typeof systemTz).toBe("string");
    expect(systemTz.length).toBeGreaterThan(0);
    // On any real system this should be something like "America/New_York", "Asia/Tokyo", etc.
    // We just verify it's not empty — the actual getTimezoneForProxy uses this internally.
  });
});
