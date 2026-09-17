/**
 * Freebuff dynamic model list (spec P4).
 *
 * The Codebuff backend has no public /v1/models endpoint — the free tier's
 * model availability is exposed on GET /api/v1/freebuff/session via
 * rateLimitsByModel (standing models with quota), limitedModelOffers
 * (capacity-limited wave offers) and freebucks.prices (metered models).
 * We merge those three sources and fall back to the static registry seed
 * when the endpoint is unreachable or returns nothing usable.
 */
import { proxyAwareFetch } from "../utils/proxyFetch.js";

const SESSION_URL = "https://www.codebuff.com/api/v1/freebuff/session";
const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;

export const FALLBACK_MODELS = [
  { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash" },
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
  { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna" },
  { id: "mimo/mimo-v2.5", name: "MiMo 2.5" },
  { id: "upstage/solar-pro4", name: "Solar Pro 4" },
  { id: "meta/muse-spark-1.2-contributor", name: "Muse Spark 1.2" },
  { id: "anthropic/claude-fable-5", name: "Claude Fable 5 (limited offer)" },
];

// ponytail: single global cache (one codebuff origin, token only gates auth
// not the model list) — switch to per-token when per-account catalogs exist.
let cache = { models: FALLBACK_MODELS, freebucks: null, expiresAt: 0 };

export function resetFreebuffModelsCache() {
  cache = { models: FALLBACK_MODELS, freebucks: null, expiresAt: 0 };
}

// Free (unmetered) iff the backend does not price the model in freebucks.
export function isFreeModel(modelId, freebucks) {
  return freebucks?.prices?.[modelId] === undefined;
}

// Pure pre-check (spec P5): true when the model is free or the balance
// covers the price. Unknown freebucks → pass (server gate is the backstop).
export function preCheckCredits(modelId, freebucks) {
  const price = freebucks?.prices?.[modelId];
  if (price === undefined) return true;
  return (Number(freebucks?.balance) || 0) >= Number(price);
}

export async function getFreebuffModels(token, options = {}) {
  const now = Date.now();
  if (cache.expiresAt > now) return cache;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("freebuff models fetch timeout")), FETCH_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;

  try {
    const response = await proxyAwareFetch(SESSION_URL, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal,
    }, options.proxyOptions || null);
    if (!response.ok) return cache;
    const data = await response.json();

    const offerModels = (Array.isArray(data?.limitedModelOffers) ? data.limitedModelOffers : [])
      .filter((o) => o && typeof o.model === "string")
      .map((o) => o.model);
    const serverModels = [
      ...Object.keys(data?.rateLimitsByModel || {}),
      ...offerModels,
      ...Object.keys(data?.freebucks?.prices || {}),
    ];
    const unique = [...new Set(serverModels)].filter((id) => typeof id === "string" && id.trim() !== "");
    if (unique.length === 0) return cache;

    const models = unique.map((id) => ({
      id,
      name: FALLBACK_MODELS.find((m) => m.id === id)?.name || id,
      ...(offerModels.includes(id) ? { isLimitedOffer: true } : {}),
      ...(data?.freebucks?.prices?.[id] !== undefined ? { price: data.freebucks.prices[id] } : {}),
    }));
    // Seed-only models (withdrawn/paused upstream) stay listed so older
    // accounts can still coerce a claim against them.
    for (const seed of FALLBACK_MODELS) {
      if (!models.some((m) => m.id === seed.id)) models.push({ ...seed, paused: true });
    }

    cache = { models, freebucks: data?.freebucks ?? null, expiresAt: now + CACHE_TTL_MS };
    return cache;
  } catch {
    return cache;
  } finally {
    clearTimeout(timeout);
  }
}
