import { beforeEach, describe, expect, it, vi } from "vitest";

// Route handler test for the proxyHealthCheck block in PATCH /api/settings.
// updateSettings is mocked as the real repo does it: shallow {...current, ...updates},
// which is exactly what used to wipe slowThresholdMs on partial updates.

vi.mock("next/server", () => ({
  NextResponse: {
    json: (data, init = {}) => ({ status: init.status ?? 200, body: data, headers: init.headers }),
  },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("@/lib/network/outboundProxy", () => ({
  applyOutboundProxyEnv: vi.fn(),
}));

vi.mock("open-sse/services/combo.js", () => ({
  resetComboRotation: vi.fn(),
}));

vi.mock("@/shared/services/proxyHealthCheck", () => ({
  configureProxyHealthCheck: vi.fn(),
  startProxyHealthCheck: vi.fn(),
  runProxyHealthTick: vi.fn(),
}));

const { getSettings, updateSettings } = await import("@/lib/localDb");
const { configureProxyHealthCheck } = await import("@/shared/services/proxyHealthCheck");
const { PATCH } = await import("@/app/api/settings/route");

const DEFAULT_PHC = { enabled: false, intervalMinutes: 5, slowThresholdMs: 4000 };

let dbSettings;

function patchRequest(body) {
  return { json: async () => structuredClone(body) };
}

async function runPatch(body) {
  const res = await PATCH(patchRequest(body));
  // flush the dynamic-import .then() that calls configureProxyHealthCheck
  await new Promise((resolve) => setTimeout(resolve, 0));
  return res;
}

describe("PATCH /api/settings — proxyHealthCheck normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbSettings = { proxyHealthCheck: { ...DEFAULT_PHC } };

    getSettings.mockImplementation(async () => structuredClone(dbSettings));
    // shallow merge, same semantics as settingsRepo.updateSettings
    updateSettings.mockImplementation(async (updates) => {
      dbSettings = { ...dbSettings, ...updates };
      return structuredClone(dbSettings);
    });
  });

  it("clamps intervalMinutes to 60 before persisting", async () => {
    await runPatch({ proxyHealthCheck: { enabled: true, intervalMinutes: 120 } });

    expect(dbSettings.proxyHealthCheck.intervalMinutes).toBe(60);
  });

  it("partial update {enabled} keeps the existing slowThresholdMs (shallow-merge must not wipe it)", async () => {
    dbSettings.proxyHealthCheck = { enabled: false, intervalMinutes: 10, slowThresholdMs: 8000 };

    await runPatch({ proxyHealthCheck: { enabled: true } });

    expect(dbSettings.proxyHealthCheck).toEqual({ enabled: true, intervalMinutes: 10, slowThresholdMs: 8000 });
  });

  it("drops unknown fields inside proxyHealthCheck", async () => {
    await runPatch({ proxyHealthCheck: { enabled: true, intervalMinutes: 5, evilField: "x" } });

    expect(dbSettings.proxyHealthCheck).toEqual({ enabled: true, intervalMinutes: 5, slowThresholdMs: 4000 });
  });

  it("configureProxyHealthCheck is called with normalized settings", async () => {
    dbSettings.proxyHealthCheck = { enabled: false, intervalMinutes: 10, slowThresholdMs: 8000 };

    await runPatch({ proxyHealthCheck: { enabled: true, intervalMinutes: 120 } });

    expect(configureProxyHealthCheck).toHaveBeenCalledTimes(1);
    expect(configureProxyHealthCheck).toHaveBeenCalledWith(expect.objectContaining({
      proxyHealthCheck: { enabled: true, intervalMinutes: 60, slowThresholdMs: 8000 },
    }));
  });

  it("invalid intervalMinutes falls back to default 5, invalid slowThresholdMs keeps current", async () => {
    dbSettings.proxyHealthCheck = { enabled: false, intervalMinutes: 10, slowThresholdMs: 8000 };

    await runPatch({ proxyHealthCheck: { intervalMinutes: "abc", slowThresholdMs: -1 } });

    expect(dbSettings.proxyHealthCheck).toEqual({ enabled: false, intervalMinutes: 5, slowThresholdMs: 8000 });
  });
});
