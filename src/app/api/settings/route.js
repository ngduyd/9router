import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { resetComboRotation } from "open-sse/services/combo.js";
import { PROXY_HEALTH_CHECK_CONFIG as PHC } from "@/shared/constants/config";
import bcrypt from "bcryptjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SETTINGS_RESPONSE_HEADERS = {
  "Cache-Control": "no-store"
};

// Secrets must never be mass-assigned from request body (CWE-915)
const PROTECTED_SETTING_KEYS = ["password", "mitmSudoEncrypted"];

export async function GET() {
  try {
    const settings = await getSettings();
    const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    
    const enableRequestLogs = process.env.ENABLE_REQUEST_LOGS === "true";
    const enableTranslator = process.env.ENABLE_TRANSLATOR === "true";
    
    return NextResponse.json({ 
      ...safeSettings, 
      enableRequestLogs,
      enableTranslator,
      hasPassword: !!password
    }, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error getting settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Whitelist + type/range coercion for proxyHealthCheck (drop unknown fields, no mass-assignment).
// Partial updates merge over the current value: settingsRepo.updateSettings is a shallow
// merge ({...current,...updates}), so a body like {enabled} would otherwise wipe sibling keys.
function normalizeProxyHealthCheck(raw, current) {
  const src = raw && typeof raw === "object" ? raw : {};
  const cur = current && typeof current === "object" ? current : {};
  const interval = Number(src.intervalMinutes);
  const curInterval = Number(cur.intervalMinutes);
  const threshold = Number(src.slowThresholdMs);
  const curThreshold = Number(cur.slowThresholdMs);
  return {
    enabled: typeof src.enabled === "boolean"
      ? src.enabled
      : (typeof cur.enabled === "boolean" ? cur.enabled : false),
    intervalMinutes: "intervalMinutes" in src
      ? (Number.isFinite(interval)
          ? Math.min(PHC.maxIntervalMinutes, Math.max(PHC.minIntervalMinutes, Math.round(interval)))
          : PHC.defaultIntervalMinutes)
      : (Number.isFinite(curInterval) ? curInterval : PHC.defaultIntervalMinutes),
    slowThresholdMs: Number.isFinite(threshold) && threshold > 0
      ? threshold
      : (Number.isFinite(curThreshold) && curThreshold > 0 ? curThreshold : PHC.slowThresholdMs),
  };
}

export async function PATCH(request) {
  try {
    const body = await request.json();

    // Strip protected secrets before any internal handling sets them
    for (const key of PROTECTED_SETTING_KEYS) delete body[key];

    // If updating password, hash it
    if (body.newPassword) {
      const settings = await getSettings();
      const currentHash = settings.password;

      // Verify current password if it exists
      if (currentHash) {
        if (!body.currentPassword) {
          return NextResponse.json({ error: "Current password required" }, { status: 400 });
        }
        const isValid = await bcrypt.compare(body.currentPassword, currentHash);
        if (!isValid) {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      } else {
        // First time setting password, no current password needed
        // Allow empty currentPassword or default "123456"
        if (body.currentPassword && body.currentPassword !== "123456") {
           return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      }

      const salt = await bcrypt.genSalt(10);
      body.password = await bcrypt.hash(body.newPassword, salt);
      delete body.newPassword;
      delete body.currentPassword;
    }

    if (Object.prototype.hasOwnProperty.call(body, "oidcClientSecret")) {
      if (!body.oidcClientSecret || !String(body.oidcClientSecret).trim()) {
        delete body.oidcClientSecret;
      }
    }

    // Normalize proxyHealthCheck BEFORE persisting so the DB never stores raw values
    // (out-of-range intervalMinutes, NaN, unknown fields).
    const hasProxyHealthCheck = Object.prototype.hasOwnProperty.call(body, "proxyHealthCheck");
    if (hasProxyHealthCheck) {
      const currentSettings = await getSettings();
      body.proxyHealthCheck = normalizeProxyHealthCheck(body.proxyHealthCheck, currentSettings?.proxyHealthCheck);
    }

    const settings = await updateSettings(body);

    // Apply outbound proxy settings immediately (no restart required)
    if (
      Object.prototype.hasOwnProperty.call(body, "outboundProxyEnabled") ||
      Object.prototype.hasOwnProperty.call(body, "outboundProxyUrl") ||
      Object.prototype.hasOwnProperty.call(body, "outboundNoProxy")
    ) {
      applyOutboundProxyEnv(settings);
    }

    // Invalidate combo rotation state when strategy settings change
    if (
      Object.prototype.hasOwnProperty.call(body, "comboStrategy") ||
      Object.prototype.hasOwnProperty.call(body, "comboStickyRoundRobinLimit") ||
      Object.prototype.hasOwnProperty.call(body, "comboStrategies")
    ) {
      resetComboRotation();
    }

    if (
      Object.prototype.hasOwnProperty.call(body, "claudeAutoPing") ||
      Object.prototype.hasOwnProperty.call(body, "codexAutoPing")
    ) {
      // Keep the scheduler absent when no account opted in; load its provider graph only on demand.
      import("@/shared/services/quotaAutoPing")
        .then(({ configureQuotaAutoPing }) => {
          configureQuotaAutoPing(settings);
        })
        .catch((error) => console.warn("[AutoPing] settings update failed:", error.message));
    }

    if (hasProxyHealthCheck) {
      // Persisted value above is already normalized; hand the same value to the scheduler.
      settings.proxyHealthCheck = body.proxyHealthCheck;
      import("@/shared/services/proxyHealthCheck")
        .then(({ configureProxyHealthCheck }) => {
          configureProxyHealthCheck(settings);
        })
        .catch((error) => console.warn("[ProxyHealthCheck] settings update failed:", error.message));
    }

    const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    return NextResponse.json(safeSettings, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error updating settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
