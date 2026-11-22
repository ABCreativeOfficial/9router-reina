import crypto from "node:crypto";
/** Privacy-preserving bounded telemetry: counts/status only, no prompts or keys. */
import { continuitySettings } from "./config.js";
import { estimateKiroTokens } from "./estimator.js";
const measurements = [];
const MAX = 200;
export function inspectContinuityRequest(payload, { scope = "kiro", sessionId = "", phase = "request" } = {}) {
  const opts = continuitySettings();
  if (opts.mode === "off") return { status: "disabled", tokens: null };
  const tokens = estimateKiroTokens(payload);
  // Leave output headroom; Kiro's maxTokens is a requested generation ceiling,
  // NOT a measurement of actual output usage. Bound the reserve to avoid
  // treating a very high configured max as guaranteed consumption.
  const requested = Number(payload?.inferenceConfig?.maxTokens);
  const reservedOutputTokens = Number.isFinite(requested) && requested > 0
    ? Math.min(16000, Math.max(4096, Math.ceil(requested))) : 4096;
  const estimatedTotalBudget = tokens + reservedOutputTokens;
  const status = estimatedTotalBudget >= opts.stopTokens ? "critical" : estimatedTotalBudget >= opts.warnTokens ? "warning" : "ok";
  const record = { at: new Date().toISOString(), scope, phase, status, estimatedTokens: tokens,
    reservedOutputTokens, estimatedTotalBudget,
    contextWindow: opts.contextWindow, sessionHash: sessionId ? crypto.createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 12) : null };
  measurements.push(record);
  if (measurements.length > MAX) measurements.shift();
  if (status !== "ok") console.warn(`[Kiro continuity] ${status}: estimated input ${tokens} + reserved output ${reservedOutputTokens} / ${opts.contextWindow} tokens; estimate only, client compaction recommended`);
  else if (process.env.KIRO_CONTINUITY_LOG === "1") console.info(`[Kiro continuity] session=${record.sessionHash || "ephemeral"} estimated=${tokens} status=${status}`);
  return { status, tokens, record };
}
export function recentContinuityTelemetry() { return measurements.map(({ sessionHash, ...rest }) => rest); }
export function resetContinuityTelemetryForTests() { measurements.length = 0; }

export function recordKiroContinuityResponse({ contextUsagePercentage, providerTokens, stopReason, eventCounts } = {}) {
  if (continuitySettings().mode === "off") return;
  const percent = Number(contextUsagePercentage);
  const record = {
    at: new Date().toISOString(), phase: "response", scope: "kiro",
    contextUsagePercentage: contextUsagePercentage != null && Number.isFinite(percent) ? percent : null,
    providerReportedTokens: typeof providerTokens === "number" ? providerTokens : null,
    stopReason: String(stopReason || "unknown").slice(0, 80),
    eventCounts: eventCounts && typeof eventCounts === "object" ? { ...eventCounts } : {},
  };
  measurements.push(record);
  if (measurements.length > MAX) measurements.shift();
  if (process.env.KIRO_CONTINUITY_LOG === "1") console.info(`[Kiro continuity] stop=${record.stopReason} context=${record.contextUsagePercentage ?? "unknown"}% tokens=${record.providerReportedTokens ?? "not-reported"}`);
  if (record.contextUsagePercentage != null && record.contextUsagePercentage >= 85) {
    console.warn(`[Kiro continuity] provider reports ${record.contextUsagePercentage}% context used; compact/resume recommended`);
  }
}
