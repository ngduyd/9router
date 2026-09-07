/**
 * Proxy Manager — Time + Error-based proxy rotation
 *
 * Replaces per-request rotation with:
 *   1. Sticky proxy per combo (reuse TCP+TLS connections)
 *   2. Time-based rotation (default: 5 min)
 *   3. Error-based rotation (429 → cooldown 1 min → next proxy)
 */

const DEFAULT_ROTATE_INTERVAL_MS = 5 * 60 * 1000;  // 5 phút
const DEFAULT_COOLDOWN_MS = 60 * 1000;             // 1 phút khi bị 429

class ProxyManager {
    constructor(options = {}) {
        this.rotateIntervalMs = options.rotateIntervalMs || DEFAULT_ROTATE_INTERVAL_MS;
        this.cooldownMs = options.cooldownMs || DEFAULT_COOLDOWN_MS;

        // comboKey (providerId::model) → { current, index, lastRotate, cooldownUntil }
        this.entries = new Map();
    }

    /**
     * Get stable combo key
     */
    comboKey(providerId, comboId) {
        return `${providerId}::${comboId || "default"}`;
    }

    /**
     * Get proxy for a combo (sticky, rotate on time/error)
     */
    getProxy(providerId, availableProxies, comboId = null) {
        if (!availableProxies || availableProxies.length === 0) return null;

        const key = this.comboKey(providerId, comboId);
        const now = Date.now();
        const entry = this.entries.get(key);

        if (entry) {
            // Check cooldown (bị 429)
            if (entry.cooldownUntil > now) {
                return this.rotate(key, availableProxies);
            }

            // Check time-based rotation
            if (now - entry.lastRotate < this.rotateIntervalMs) {
                return entry.current;
            }
        }

        // Lần đầu hoặc hết interval → rotate
        return this.rotate(key, availableProxies);
    }

    /**
     * Rotate to next proxy
     */
    rotate(key, availableProxies) {
        let entry = this.entries.get(key) || { index: 0 };
        const nextIndex = (entry.index || 0) % availableProxies.length;
        const proxy = availableProxies[nextIndex];

        entry.current = proxy;
        entry.lastRotate = Date.now();
        entry.index = (nextIndex + 1) % availableProxies.length;
        entry.cooldownUntil = 0;
        this.entries.set(key, entry);

        console.log(`[ProxyManager] ${key} → ${proxy} (index=${entry.index})`);

        return proxy;
    }

    /**
     * Mark proxy as rate-limited (429)
     */
    mark429(providerId, comboId) {
        const key = this.comboKey(providerId, comboId);
        const entry = this.entries.get(key);
        if (entry) {
            entry.cooldownUntil = Date.now() + this.cooldownMs;
            this.entries.set(key, entry);
            console.log(`[ProxyManager] ${key} cooldown ${this.cooldownMs / 1000}s`);
        }
    }

    /**
     * Mark proxy success (reset cooldown)
     */
    markSuccess(providerId, comboId) {
        const key = this.comboKey(providerId, comboId);
        const entry = this.entries.get(key);
        if (entry) {
            entry.cooldownUntil = 0;
            this.entries.set(key, entry);
        }
    }

    /**
     * Reset all state
     */
    reset() {
        this.entries.clear();
    }
}

// Singleton instance
let instance = null;

export function getProxyManager(options) {
    if (!instance) {
        instance = new ProxyManager(options);
    }
    return instance;
}

export function resetProxyManager() {
    if (instance) {
        instance.reset();
        instance = null;
    }
}

export { ProxyManager };
export default ProxyManager;
