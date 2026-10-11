// Proxy health check scheduler: periodically tests every proxy pool and flips
// isActive based on the result, so traffic never flows into dead/slow pools.
import { getSettings, getProxyPools, updateProxyPool } from "@/lib/localDb";
import { testProxyPool } from "@/lib/network/proxyTest";
import { PROXY_HEALTH_CHECK_CONFIG } from "@/shared/constants/config";

const C = PROXY_HEALTH_CHECK_CONFIG;

// Survive Next.js hot reload and keep one scheduler per server process.
const g = (globalThis.__9routerProxyHealthCheck__ ??= {
  interval: null,
  intervalMinutes: C.defaultIntervalMinutes,
  running: false,
});

function clampIntervalMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return C.defaultIntervalMinutes;
  return Math.min(C.maxIntervalMinutes, Math.max(C.minIntervalMinutes, Math.round(n)));
}

function normalizeSlowThresholdMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : C.slowThresholdMs;
}

async function runWithConcurrency(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) break;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function buildUpdate(pool, result, pass, slowThresholdMs) {
  const slow = result.ok && (result.elapsedMs ?? 0) > slowThresholdMs;
  return {
    isActive: pass,
    testStatus: pass ? "active" : "error",
    lastTestedAt: new Date().toISOString(),
    lastError: pass
      ? null
      : (slow
        ? `Slow response ${result.elapsedMs}ms > ${slowThresholdMs}ms`
        : (result.error || `Proxy test failed with status ${result.status}`)),
  };
}

function createDefaultDeps() {
  return {
    getSettings,
    getProxyPools,
    testProxyPool,
    updateProxyPool,
    log: console,
  };
}

export async function runProxyHealthTick(deps = createDefaultDeps(), state = g) {
  if (state.running) return;
  state.running = true;
  try {
    const settings = await deps.getSettings();
    const cfg = settings?.proxyHealthCheck || {};
    const slowThresholdMs = normalizeSlowThresholdMs(cfg.slowThresholdMs);
    const list = (await deps.getProxyPools()) || [];

    let alive = 0;
    let dead = 0;
    let reactivated = 0;
    let newlyDisabled = 0;

    await runWithConcurrency(list, C.concurrency, async (pool) => {
      try {
        const result = await deps.testProxyPool(pool);
        const slow = result.ok && (result.elapsedMs ?? 0) > slowThresholdMs;
        const pass = result.ok && !slow;
        if (pass) alive++; else dead++;
        if (pass && pool.isActive === false) reactivated++;
        if (!pass && pool.isActive !== false) newlyDisabled++;
        try {
          await deps.updateProxyPool(pool.id, buildUpdate(pool, result, pass, slowThresholdMs));
        } catch (e) {
          deps.log.warn(`[ProxyHealthCheck] update pool ${pool.id} failed: ${e.message}`);
        }
      } catch (e) {
        deps.log.warn(`[ProxyHealthCheck] test pool ${pool.id} failed: ${e.message}`);
      }
    });

    if (list.length > 0 && alive === 0) {
      deps.log.warn("[ProxyHealthCheck] all pools inactive");
    }
    deps.log.log(`[ProxyHealthCheck] tick: ${alive} alive, ${dead} dead (${reactivated} reactivated, ${newlyDisabled} newly disabled)`);
  } catch (e) {
    deps.log.warn("[ProxyHealthCheck] tick error:", e.message);
  } finally {
    state.running = false;
  }
}

export function startProxyHealthCheck() {
  // Mark started synchronously (same pattern as quotaAutoPing) so a second
  // call while the first tick is in flight can never create a 2nd interval.
  if (g.interval) return;
  console.log("[ProxyHealthCheck] scheduler started");
  runProxyHealthTick().catch(() => {});
  g.interval = setInterval(() => { runProxyHealthTick().catch(() => {}); }, g.intervalMinutes * 60000);
  if (g.interval.unref) g.interval.unref();
}

export function stopProxyHealthCheck() {
  if (!g.interval) return;
  clearInterval(g.interval);
  g.interval = null;
  console.log("[ProxyHealthCheck] scheduler stopped");
}

export function configureProxyHealthCheck(settings) {
  const cfg = settings?.proxyHealthCheck || {};
  if (!cfg.enabled) {
    stopProxyHealthCheck();
    return;
  }
  const minutes = clampIntervalMinutes(cfg.intervalMinutes);
  // Restart only when the interval value itself changed; enabled/threshold edits keep the timer.
  if (g.interval && minutes !== g.intervalMinutes) stopProxyHealthCheck();
  g.intervalMinutes = minutes;
  startProxyHealthCheck();
}
