/**
 * Unit tests for the Freebuff fixes:
 *   - P0: stream_options.include_usage injection in transformRequest
 *   - P1a: session model mismatch guard in requestSession
 * (P1b registry/root-agent map covered by the provider-model tests below.)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

import { FreebuffExecutor, __test__, resetSessionCache } from "../../open-sse/executors/freebuff.js";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";

const { requestSession } = __test__;

const EXECUTOR = new FreebuffExecutor();

beforeEach(() => {
  fetchMock.mockReset();
  resetSessionCache();
});

// ---- P0: transformRequest stream_options ----

describe("freebuff transformRequest stream_options", () => {
  it("injects stream_options when stream=true", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    EXECUTOR.transformRequest("deepseek/deepseek-v4-flash", body, true, {});
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("does not inject stream_options when stream=false", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    EXECUTOR.transformRequest("deepseek/deepseek-v4-flash", body, false, {});
    expect(body.stream_options).toBeUndefined();
  });

  it("does not overwrite client-provided stream_options", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      stream_options: { include_usage: false },
    };
    EXECUTOR.transformRequest("deepseek/deepseek-v4-flash", body, true, {});
    expect(body.stream_options.include_usage).toBe(false);
  });
});

// ---- P1a: requestSession model mismatch guard ----

function sessionResponse(payload) {
  return {
    status: 200,
    ok: true,
    json: async () => payload,
  };
}

describe("freebuff requestSession model mismatch guard", () => {
  it("throws 409 with resetsAtMs when server returns a session for a different model", async () => {
    fetchMock.mockResolvedValue(
      sessionResponse({ status: "active", instanceId: "inst-1", model: "deepseek/deepseek-v4-flash" })
    );
    const err = await requestSession("tok", "mimo/mimo-v2.5", undefined).catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/model mismatch/);
    expect(err.resetsAtMs).toBeGreaterThan(Date.now());
  });

  it("has a resetsAtMs in the future on mismatch", async () => {
    fetchMock.mockResolvedValueOnce(
      sessionResponse({ status: "active", instanceId: "inst-1b", model: "deepseek/deepseek-v4-flash" })
    );
    const err = await requestSession("tok2", "mimo/mimo-v2.5", undefined).catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.resetsAtMs).toBeGreaterThan(Date.now());
  });

  it("passes when server model matches requested model", async () => {
    fetchMock.mockResolvedValueOnce(
      sessionResponse({ status: "active", instanceId: "inst-2", model: "mimo/mimo-v2.5", expiresAt: "" })
    );
    const res = await requestSession("tok4", "mimo/mimo-v2.5", undefined);
    expect(res).toEqual({ instanceId: "inst-2", status: "active" });
  });

  it("passes when server omits model field (backward compat)", async () => {
    fetchMock.mockResolvedValueOnce(
      sessionResponse({ status: "active", instanceId: "inst-3" })
    );
    const res = await requestSession("tok5", "deepseek/deepseek-v4-flash", undefined);
    expect(res).toEqual({ instanceId: "inst-3", status: "active" });
  });
});

// ---- P1b: registry model list ----

describe("freebuff registry model list", () => {
  it("has muse-spark 1.2 and not the withdrawn 1.3", () => {
    const ids = PROVIDER_MODELS.fb.map((m) => m.id);
    expect(ids).toContain("meta/muse-spark-1.2-contributor");
    expect(ids).not.toContain("meta/muse-spark-1.3-contributor");
  });
});
