/**
 * P9 — Sticky IP: proxyPoolId plumbing for login/poll passthrough
 *
 * Verifies that:
 * 1. requestDeviceCode resolves proxy from proxyPoolId and passes to proxyAwareFetch
 * 2. requestDeviceCode without proxyPoolId → direct (null)
 * 3. pollToken reads cached proxyOptions from requestDeviceCode
 * 4. pollForToken passes proxyOptions to provider.pollToken
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

vi.mock("../../src/lib/network/connectionProxy.js", () => ({
  resolveConnectionProxyConfig: vi.fn().mockResolvedValue({
    source: "pool",
    connectionProxyEnabled: true,
    connectionProxyUrl: "http://proxy.test:8080",
    connectionNoProxy: "",
    vercelRelayUrl: "",
    strictProxy: false,
  }),
}));

const { resolveConnectionProxyConfig } = await import("../../src/lib/network/connectionProxy.js");

// ---------- requestDeviceCode ----------

describe("P9 — requestDeviceCode proxy passthrough", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    resolveConnectionProxyConfig.mockReset();
    resolveConnectionProxyConfig.mockResolvedValue({
      source: "pool",
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.test:8080",
      connectionNoProxy: "",
      vercelRelayUrl: "",
      strictProxy: false,
    });
  });

  it("resolves proxy from proxyPoolId and passes to proxyAwareFetch", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        fingerprintId: "fp-abc",
        fingerprintHash: "hash-abc",
        loginUrl: "https://freebuff.com/login?auth_code=TEST",
        expiresAt: Date.now() + 600_000,
      }),
    });

    const mod = await import("../../src/lib/oauth/providers/freebuff.js");
    const freebuff = mod.default;

    await freebuff.requestDeviceCode(
      { baseUrl: "https://freebuff.com", loginCodePath: "/api/auth/cli/code", oauthTimeoutMs: 300_000 },
      undefined,
      { proxyPoolId: "test-pool-1" },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, , proxyOpts] = fetchMock.mock.calls[0];
    expect(proxyOpts).toEqual({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.test:8080",
      connectionNoProxy: "",
      vercelRelayUrl: "",
      strictProxy: false,
    });
    expect(resolveConnectionProxyConfig).toHaveBeenCalledWith({ proxyPoolId: "test-pool-1" });
  });

  it("passes null proxy when no proxyPoolId", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        fingerprintId: "fp-def",
        fingerprintHash: "hash-def",
        loginUrl: "https://freebuff.com/login?auth_code=DEF",
        expiresAt: Date.now() + 600_000,
      }),
    });

    const mod = await import("../../src/lib/oauth/providers/freebuff.js");
    const freebuff = mod.default;

    await freebuff.requestDeviceCode(
      { baseUrl: "https://freebuff.com", loginCodePath: "/api/auth/cli/code", oauthTimeoutMs: 300_000 },
      undefined,
      {},
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, , proxyOpts] = fetchMock.mock.calls[0];
    expect(proxyOpts).toBeNull();
  });
});

// ---------- pollToken cached proxy ----------

describe("P9 — pollToken reads cached proxy", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    resolveConnectionProxyConfig.mockReset();
    resolveConnectionProxyConfig.mockResolvedValue({
      source: "pool",
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.test:8080",
      connectionNoProxy: "",
      vercelRelayUrl: "",
      strictProxy: false,
    });
  });

  it("uses cached proxyOptions from requestDeviceCode", async () => {
    // Step 1: requestDeviceCode to populate cache
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        fingerprintId: "fp-cache",
        fingerprintHash: "hash-cache",
        loginUrl: "https://freebuff.com/login?auth_code=CACHE",
        expiresAt: Date.now() + 600_000,
      }),
    });

    const mod = await import("../../src/lib/oauth/providers/freebuff.js");
    const freebuff = mod.default;

    await freebuff.requestDeviceCode(
      { baseUrl: "https://freebuff.com", loginCodePath: "/api/auth/cli/code", oauthTimeoutMs: 300_000 },
      undefined,
      { proxyPoolId: "cached-pool" },
    );

    // Step 2: pollToken — should use cached proxy
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: "authorization_pending" }),
    });

    const deviceCode = JSON.stringify({
      fingerprintId: "fp-cache",
      fingerprintHash: "hash-cache",
      expiresAt: Date.now() + 600_000,
    });

    await freebuff.pollToken(
      { baseUrl: "https://freebuff.com", loginStatusPath: "/api/auth/cli/status" },
      deviceCode,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, , proxyOpts] = fetchMock.mock.calls[1];
    expect(proxyOpts).toEqual({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.test:8080",
      connectionNoProxy: "",
      vercelRelayUrl: "",
      strictProxy: false,
    });
  });

  it("passes null when no cached proxy", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: "authorization_pending" }),
    });

    const mod = await import("../../src/lib/oauth/providers/freebuff.js");
    const freebuff = mod.default;

    const deviceCode = JSON.stringify({
      fingerprintId: "fp-nocache",
      fingerprintHash: "hash-nocache",
      expiresAt: Date.now() + 600_000,
    });

    await freebuff.pollToken(
      { baseUrl: "https://freebuff.com", loginStatusPath: "/api/auth/cli/status" },
      deviceCode,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, , proxyOpts] = fetchMock.mock.calls[0];
    expect(proxyOpts).toBeNull();
  });
});

// ---------- pollForToken passthrough ----------

describe("P9 — pollForToken passes proxyOptions", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("passes proxyOptions to provider.pollToken as 5th arg", async () => {
    const mod = await import("../../src/lib/oauth/providers/freebuff.js");
    const freebuff = mod.default;

    let receivedArgs;
    const originalPoll = freebuff.pollToken;
    freebuff.pollToken = async (...args) => {
      receivedArgs = args;
      return { ok: true, data: { error: "authorization_pending" } };
    };

    const { pollForToken } = await import("../../src/lib/oauth/providers/index.js");
    const mockProxy = { connectionProxyEnabled: true, connectionProxyUrl: "http://x:80" };

    await pollForToken("freebuff", '{"fingerprintId":"f","fingerprintHash":"h","expiresAt":1}', null, null, mockProxy);

    expect(receivedArgs).toBeDefined();
    expect(receivedArgs[4]).toEqual(mockProxy);

    freebuff.pollToken = originalPoll;
  });
});
