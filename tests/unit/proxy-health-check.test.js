import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  updateProxyPool: vi.fn(),
}));

vi.mock("@/lib/network/proxyTest", () => ({
  testProxyPool: vi.fn(),
}));

// Real testProxyPool runs against a mocked undici boundary so dispatch is
// observed where it actually happens: relay pools → fetch(relayUrl, GET,
// x-relay-target), normal pools → ProxyAgent({uri}) + fetch(HEAD).
const um = vi.hoisted(() => {
  const ProxyAgent = vi.fn(function ProxyAgent(opts) {
    if (!/^https?:\/\//.test(opts?.uri)) throw new Error("invalid uri");
    return { close: vi.fn() };
  });
  const fetch = vi.fn(async () => ({ ok: true, status: 200, statusText: "OK" }));
  return { ProxyAgent, fetch };
});
vi.mock("undici", () => ({ ProxyAgent: um.ProxyAgent, fetch: um.fetch }));

const HC_SETTINGS = { proxyHealthCheck: { enabled: true, intervalMinutes: 5, slowThresholdMs: 4000 } };

describe("proxy health check", () => {
  let runProxyHealthTick;
  let configureProxyHealthCheck;
  let startProxyHealthCheck;
  let deps;
  let state;
  let getSettings;
  let getProxyPools;
  let updateProxyPool;
  let testProxyPool;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
    delete globalThis.__9routerProxyHealthCheck__;

    ({ getSettings, getProxyPools, updateProxyPool } = await import("@/lib/localDb"));
    ({ testProxyPool } = await import("@/lib/network/proxyTest"));
    ({ runProxyHealthTick, configureProxyHealthCheck, startProxyHealthCheck } = await import("../../src/shared/services/proxyHealthCheck.js"));

    getSettings.mockResolvedValue(HC_SETTINGS);
    getProxyPools.mockResolvedValue([]);
    updateProxyPool.mockResolvedValue({});
    testProxyPool.mockResolvedValue({ ok: true, status: 200, elapsedMs: 100 });

    deps = {
      getSettings,
      getProxyPools,
      testProxyPool,
      updateProxyPool,
      log: { log: vi.fn(), warn: vi.fn() },
    };
    state = { running: false };
  });

  it("passing pool stays active with no error", async () => {
    getProxyPools.mockResolvedValue([{ id: "p1", proxyUrl: "http://127.0.0.1:7897", isActive: true }]);

    await runProxyHealthTick(deps, state);

    expect(updateProxyPool).toHaveBeenCalledWith("p1", expect.objectContaining({
      isActive: true,
      testStatus: "active",
      lastError: null,
      lastTestedAt: expect.any(String),
    }));
  });

  it("failing pool is disabled and keeps the error message", async () => {
    testProxyPool.mockResolvedValue({ ok: false, status: 500, error: "connection refused" });
    getProxyPools.mockResolvedValue([{ id: "p1", proxyUrl: "http://127.0.0.1:7897", isActive: true }]);

    await runProxyHealthTick(deps, state);

    expect(updateProxyPool).toHaveBeenCalledWith("p1", expect.objectContaining({
      isActive: false,
      testStatus: "error",
      lastError: "connection refused",
    }));
  });

  it("slow pool (elapsedMs > threshold) is disabled with a slow-response error", async () => {
    testProxyPool.mockResolvedValue({ ok: true, status: 200, elapsedMs: 5000 });
    getProxyPools.mockResolvedValue([{ id: "p1", proxyUrl: "http://127.0.0.1:7897", isActive: true }]);

    await runProxyHealthTick(deps, state);

    expect(updateProxyPool).toHaveBeenCalledWith("p1", expect.objectContaining({
      isActive: false,
      testStatus: "error",
      lastError: expect.stringContaining("Slow response 5000ms > 4000ms"),
    }));
  });

  it("reactivates a pool that recovers on a later tick", async () => {
    const pool = { id: "p1", proxyUrl: "http://127.0.0.1:7897", isActive: true };

    testProxyPool.mockResolvedValueOnce({ ok: false, status: 500, error: "timeout" });
    getProxyPools.mockResolvedValue([pool]);
    await runProxyHealthTick(deps, state);
    expect(updateProxyPool).toHaveBeenLastCalledWith("p1", expect.objectContaining({ isActive: false, testStatus: "error" }));

    pool.isActive = false;
    testProxyPool.mockResolvedValueOnce({ ok: true, status: 200, elapsedMs: 120 });
    await runProxyHealthTick(deps, state);
    expect(updateProxyPool).toHaveBeenLastCalledWith("p1", expect.objectContaining({ isActive: true, testStatus: "active", lastError: null }));
  });

  it("dispatches relay-type pools through testProxyPool", async () => {
    const relayPool = { id: "r1", type: "vercel", proxyUrl: "https://relay.example.com", isActive: true };
    getProxyPools.mockResolvedValue([relayPool]);

    await runProxyHealthTick(deps, state);

    expect(testProxyPool).toHaveBeenCalledWith(relayPool);
    expect(updateProxyPool).toHaveBeenCalledWith("r1", expect.objectContaining({ isActive: true }));
  });

  it("starts the scheduler only when enabled and stops when disabled", async () => {
    vi.useFakeTimers();

    configureProxyHealthCheck({ proxyHealthCheck: { enabled: false } });
    expect(vi.getTimerCount()).toBe(0);

    configureProxyHealthCheck({ proxyHealthCheck: { enabled: true, intervalMinutes: 5 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    configureProxyHealthCheck({ proxyHealthCheck: { enabled: false } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("running guard: a second tick returns immediately while one is in flight", async () => {
    state.running = true;

    await runProxyHealthTick(deps, state);

    expect(deps.getProxyPools).not.toHaveBeenCalled();
    expect(deps.testProxyPool).not.toHaveBeenCalled();
    expect(deps.updateProxyPool).not.toHaveBeenCalled();
  });

  it("tests inactive pools too (self-recovery path)", async () => {
    const inactive = { id: "p9", proxyUrl: "http://127.0.0.1:7897", isActive: false };
    getProxyPools.mockResolvedValue([inactive]);

    await runProxyHealthTick(deps, state);

    expect(deps.testProxyPool).toHaveBeenCalledWith(inactive);
    expect(updateProxyPool).toHaveBeenCalledWith("p9", expect.objectContaining({ isActive: true }));
  });

  it("elapsedMs exactly at threshold passes (strict >)", async () => {
    testProxyPool.mockResolvedValue({ ok: true, status: 200, elapsedMs: 4000 });
    getProxyPools.mockResolvedValue([{ id: "p1", proxyUrl: "http://127.0.0.1:7897", isActive: true }]);

    await runProxyHealthTick(deps, state);

    expect(updateProxyPool).toHaveBeenCalledWith("p1", expect.objectContaining({
      isActive: true,
      testStatus: "active",
      lastError: null,
    }));
  });

  it("updateProxyPool rejection fails open: tick resolves, other pools still tested", async () => {
    const p1 = { id: "p1", proxyUrl: "http://127.0.0.1:1", isActive: true };
    const p2 = { id: "p2", proxyUrl: "http://127.0.0.1:2", isActive: true };
    getProxyPools.mockResolvedValue([p1, p2]);
    updateProxyPool.mockImplementation((id) =>
      id === "p1" ? Promise.reject(new Error("db down")) : Promise.resolve({}));

    await runProxyHealthTick(deps, state);

    expect(testProxyPool).toHaveBeenCalledWith(p1);
    expect(testProxyPool).toHaveBeenCalledWith(p2);
    expect(updateProxyPool).toHaveBeenCalledWith("p2", expect.objectContaining({ isActive: true }));
    expect(deps.log.warn).toHaveBeenCalledWith(expect.stringContaining("update pool p1 failed"));
    expect(state.running).toBe(false);
  });

  it("testProxyPool throw is caught per pool; remaining pools continue", async () => {
    const p1 = { id: "p1", proxyUrl: "http://127.0.0.1:1", isActive: true };
    const p2 = { id: "p2", proxyUrl: "http://127.0.0.1:2", isActive: true };
    getProxyPools.mockResolvedValue([p1, p2]);
    testProxyPool.mockImplementation((pool) =>
      pool.id === "p1"
        ? Promise.reject(new Error("boom"))
        : Promise.resolve({ ok: true, status: 200, elapsedMs: 100 }));

    await runProxyHealthTick(deps, state);

    expect(updateProxyPool).toHaveBeenCalledTimes(1);
    expect(updateProxyPool).toHaveBeenCalledWith("p2", expect.objectContaining({ isActive: true }));
    expect(deps.log.warn).toHaveBeenCalledWith(expect.stringContaining("test pool p1 failed"));
    expect(state.running).toBe(false);
  });

  it("getSettings rejection is swallowed; state.running resets", async () => {
    getSettings.mockRejectedValue(new Error("settings down"));

    await runProxyHealthTick(deps, state);

    expect(getProxyPools).not.toHaveBeenCalled();
    expect(deps.log.warn).toHaveBeenCalledWith(expect.stringContaining("tick error"), "settings down");
    expect(state.running).toBe(false);
  });

  it("getProxyPools rejection is swallowed; state.running resets", async () => {
    getProxyPools.mockRejectedValue(new Error("pools down"));

    await runProxyHealthTick(deps, state);

    expect(deps.log.warn).toHaveBeenCalledWith(expect.stringContaining("tick error"), "pools down");
    expect(state.running).toBe(false);
  });

  describe("real testProxyPool dispatch (undici boundary)", () => {
    const realTestProxyPool = async () => (await vi.importActual("@/lib/network/proxyTest")).testProxyPool;

    it.each(["vercel", "cloudflare", "deno", "netlify"])(
      "pool type %s dispatches to the relay test",
      async (type) => {
        const testProxyPoolReal = await realTestProxyPool();
        const pool = { id: `r-${type}`, type, proxyUrl: "https://relay.example.com", isActive: true };

        const result = await testProxyPoolReal(pool);

        expect(result.ok).toBe(true);
        expect(um.ProxyAgent).not.toHaveBeenCalled();
        expect(um.fetch).toHaveBeenCalledWith("https://relay.example.com", expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({ "x-relay-target": "https://httpbin.org" }),
        }));
      }
    );

    it("normal pool type dispatches to testProxyUrl (proxy + HEAD)", async () => {
      const testProxyPoolReal = await realTestProxyPool();
      const pool = { id: "p1", type: "http", proxyUrl: "http://127.0.0.1:7897", isActive: true };

      const result = await testProxyPoolReal(pool);

      expect(result.ok).toBe(true);
      expect(um.ProxyAgent).toHaveBeenCalledWith({ uri: pool.proxyUrl });
      expect(um.fetch).toHaveBeenCalledWith("https://google.com/", expect.objectContaining({ method: "HEAD" }));
    });

    it("dispatch failure: invalid proxy URL returns status 400 without throwing", async () => {
      const testProxyPoolReal = await realTestProxyPool();

      const result = await testProxyPoolReal({ id: "p2", type: "http", proxyUrl: "not-a-url" });

      expect(result).toMatchObject({ ok: false, status: 400 });
      expect(result.error).toContain("Invalid proxy URL");
      expect(um.fetch).not.toHaveBeenCalled();
    });
  });

  describe("scheduler interval handling", () => {
    it("start is idempotent: never creates a second interval", async () => {
      vi.useFakeTimers();

      configureProxyHealthCheck({ proxyHealthCheck: { enabled: true, intervalMinutes: 5 } });
      startProxyHealthCheck();
      startProxyHealthCheck();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);

      configureProxyHealthCheck({ proxyHealthCheck: { enabled: false } });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("restarts only when intervalMinutes changes; threshold-only edit keeps the timer", async () => {
      vi.useFakeTimers();

      configureProxyHealthCheck({ proxyHealthCheck: { enabled: true, intervalMinutes: 5 } });
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      const afterStart = getSettings.mock.calls.length;

      // threshold-only change → no restart (no immediate re-tick, still one timer)
      configureProxyHealthCheck({ proxyHealthCheck: { enabled: true, intervalMinutes: 5, slowThresholdMs: 8000 } });
      await vi.advanceTimersByTimeAsync(0);
      expect(getSettings.mock.calls.length).toBe(afterStart);
      expect(vi.getTimerCount()).toBe(1);

      // interval change → restart with the new period, old timer cleared
      configureProxyHealthCheck({ proxyHealthCheck: { enabled: true, intervalMinutes: 10 } });
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      const afterRestart = getSettings.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5 * 60000);
      expect(getSettings.mock.calls.length).toBe(afterRestart); // stale 5min timer must be gone
      await vi.advanceTimersByTimeAsync(5 * 60000);
      expect(getSettings.mock.calls.length).toBeGreaterThan(afterRestart); // 10min tick fires

      configureProxyHealthCheck({ proxyHealthCheck: { enabled: false } });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("clamps intervalMinutes: NaN→5, 0→1, 120→60", async () => {
      vi.useFakeTimers();
      const cases = [
        { input: NaN, minutes: 5 },
        { input: 0, minutes: 1 },
        { input: 120, minutes: 60 },
      ];

      for (const { input, minutes } of cases) {
        configureProxyHealthCheck({ proxyHealthCheck: { enabled: true, intervalMinutes: input } });
        await vi.advanceTimersByTimeAsync(0);
        const base = getSettings.mock.calls.length;
        await vi.advanceTimersByTimeAsync(minutes * 60000 - 1);
        expect(getSettings.mock.calls.length, `interval ${input} → ${minutes}min: no early tick`).toBe(base);
        await vi.advanceTimersByTimeAsync(1);
        expect(getSettings.mock.calls.length, `interval ${input} → ${minutes}min: tick at boundary`).toBeGreaterThan(base);
        configureProxyHealthCheck({ proxyHealthCheck: { enabled: false } });
        expect(vi.getTimerCount()).toBe(0);
      }
    });
  });
});
