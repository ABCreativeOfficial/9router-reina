import { isNewApiConnection } from "./definition.js";
import { resolveOpenAICompatibleApiType } from "../provider.js";
import { isReasoningLevel } from "../../translator/concerns/thinking.js";
import { ROLE } from "../../translator/schema/roles.js";

export function isNewApiChat(provider, credentials) {
  return provider?.startsWith?.("openai-compatible-") === true
    && resolveOpenAICompatibleApiType(provider, credentials) === "chat"
    && isNewApiConnection(credentials);
}

// New API accepts OpenAI effort through its unified Chat DTO; downstream model
// support is still determined by the configured channel.
// Preserve an explicit effort or model suffix instead of losing it to a native
// model-name heuristic. Model-native thinking/defaults still use applyThinking.
export function applyNewApiThinking(body, intent) {
  const cfg = intent?.override || intent?.thinking;
  if (cfg?.mode === "level" && isReasoningLevel(cfg.level)) {
    body.reasoning_effort = cfg.level;
  }
  return body;
}

// Only content-free counts. No text, schemas, tool names/ids, URLs or secrets.
export function summarizeNewApiRequest(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return {
    bytes: new TextEncoder().encode(JSON.stringify(body) || "").byteLength,
    messages: messages.length,
    tools: tools.length,
    assistantToolCalls: messages.reduce((n, m) => n + (m?.role === ROLE.ASSISTANT && Array.isArray(m.tool_calls) ? m.tool_calls.length : 0), 0),
    toolResults: messages.filter(m => m?.role === ROLE.TOOL).length,
    stream: body?.stream === true,
    ...(Number.isFinite(body?.max_tokens) ? { max_tokens: body.max_tokens } : {}),
    ...(Number.isFinite(body?.max_completion_tokens) ? { max_completion_tokens: body.max_completion_tokens } : {}),
  };
}

export function sanitizeNewApiError(value, secrets = []) {
  let text = String(value ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret) text = text.split(secret).join("[REDACTED]");
  }
  return text
    .replace(/\b(?:request|response|headers|messages|prompt|tools|body)["\s]*[:=][\s\S]*/i, "[payload omitted]")
    .replace(/\bBearer\s+[^\s",}]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie)["\s]*[:=]\s*)[^\r\n,}]+/gi, "$1[REDACTED]")
    .slice(0, 2048);
}

// Never stringify a whole upstream envelope: it can echo requests/credentials.
export function parseNewApiError(response, bodyText, secrets = [], summary = null) {
  let payload;
  try { payload = JSON.parse(bodyText); } catch { /* non-JSON upstream */ }
  const error = payload?.error && typeof payload.error === "object" ? payload.error : payload;
  const scalar = value => typeof value === "string" || typeof value === "number";
  const message = scalar(error?.message) ? sanitizeNewApiError(error.message, secrets)
    : typeof payload?.error === "string" ? sanitizeNewApiError(payload.error, secrets)
      : `New API returned HTTP ${response.status} without a structured error message`;
  const details = ["code", "type", "param"].flatMap(key =>
    scalar(error?.[key]) && /^[A-Za-z0-9_.:[\]\/-]{1,128}$/.test(String(error[key]))
      ? [`${key}=${sanitizeNewApiError(error[key], secrets)}`] : []);
  const requestId = response.headers?.get("x-request-id") || response.headers?.get("x-oneapi-request-id");
  if (requestId && /^[A-Za-z0-9_.:-]{1,128}$/.test(requestId)) details.push(`request_id=${requestId}`);
  if (summary) details.push(`request=${JSON.stringify(summary)}`);
  return { status: response.status, message: `${message}${details.length ? ` [${details.join("; ")}]` : ""}` };
}
