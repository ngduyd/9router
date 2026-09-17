/**
 * Unit tests for the Freebuff dynamic model list service (spec P4).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

import { getFreebuffModels, FALLBACK_MODELS, resetFreebuffModelsCache } from "../../open-sse/services/freebuffModels.js";

const SESSION_BODY = {
  rateLimitsByModel: {
    "z-ai/glm-5.3-flash": { limit: 20, recentCount: 0 },
    "deepseek/deepseek-v4-flash": { limit: 20, recentCount: 1 },
  },
  limitedModelOffers: [{ model: "anthropic/claude-fable-5", remaining: 3 }],
  freebucks: { prices: { "openai/gpt-5.6-luna": 10 }, balance: 25 },
};

beforeEach(() => {
  fetchMock.mockReset();
  resetFreebuffModelsCache();
});

describe("getFreebuffModels", () => {
  it("returns cached models within TTL without refetching", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => SESSION_BODY });
    const first = await getFreebuffModels("tok");
    expect(first.models.some((m) => m.isLimitedOffer)).toBe(true);
    const second = await getFreebuffModels("tok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("merges rateLimitsByModel + limitedModelOffers + freebucks.prices", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => SESSION_BODY });
    const { models, freebucks } = await getFreebuffModels("tok");
    const ids = models.map((m) => m.id);
    expect(ids).toContain("z-ai/glm-5.3-flash");
    expect(ids).toContain("anthropic/claude-fable-5");
    expect(ids).toContain("openai/gpt-5.6-luna");
    const luna = models.find((m) => m.id === "openai/gpt-5.6-luna");
    expect(luna.price).toBe(10);
    expect(freebucks).toEqual(SESSION_BODY.freebucks);
  });

  it("falls back to seed on fetch failure", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));
    const { models, freebucks } = await getFreebuffModels("tok");
    expect(models).toEqual(FALLBACK_MODELS);
    expect(freebucks).toBeNull();
  });

  it("keeps seed-only models as paused", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => SESSION_BODY });
    const { models } = await getFreebuffModels("tok");
    const spark = models.find((m) => m.id === "meta/muse-spark-1.2-contributor");
    expect(spark.paused).toBe(true);
  });
});
