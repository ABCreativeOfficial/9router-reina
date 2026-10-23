import { CODEBUDDY_CONTEXT, normalizeCodeBuddyContextPolicy } from "../config/codebuddyContext.js";
import { PROVIDER_CAPABILITIES } from "../providers/capabilities.js";
import { ROLE } from "../translator/schema/roles.js";
import { CLAUDE_BLOCK, OPENAI_BLOCK } from "../translator/schema/blocks.js";
import { FORMATS } from "../translator/formats.js";
import { CODEBUDDY_CONTEXT_OVERFLOW_MARKER } from "../config/errorConfig.js";

export function parseCodeBuddyContextError(bodyText) {
  let data;
  try { data = JSON.parse(bodyText); } catch { data = { message: bodyText }; }
  const error = data?.error;
  const code = data?.code ?? error?.code;
  const message = [data?.msg, data?.message, error?.message, typeof error === "string" ? error : null]
    .find((v) => typeof v === "string" && v.trim()) || "";
  const overflowText = /context_length_exceeded|prompt\s+is\s+too\s+long|context\s+(?:window|length|limit).*(?:exceed|overflow)|maximum\s+context\s+length|too\s+many\s+(?:input\s+)?tokens|input.*token.*(?:exceed|maximum)/i;
  const counts = message.match(/([\d,]+)\s*tokens?\s*>\s*([\d,]+)\s*(?:tokens?\s*)?(?:maximum|max|limit)/i);
  const inputLimit = message.match(/(?:max(?:imum)?\s+input\s+tokens?|input\s+token\s+limit)\s*(?:is|of|:)?\s*([\d,]+)/i);
  if (Number(code) !== CODEBUDDY_CONTEXT.upstreamCode && !overflowText.test(`${code || ""} ${message}`) && !counts && !inputLimit) return null;
  const maxMatch = message.match(/maximum\s+context\s+length\s+(?:is|of)\s*([\d,]+)/i);
  return {
    message: `prompt is too long: ${CODEBUDDY_CONTEXT.marker} (${code || CODEBUDDY_CONTEXT.upstreamCode}). ${message || "Upstream context limit exceeded."}`,
    classification: CODEBUDDY_CONTEXT_OVERFLOW_MARKER,
    inputTokens: counts ? Number(counts[1].replaceAll(",", "")) : null,
    contextLimit: counts ? Number(counts[2].replaceAll(",", "")) : inputLimit ? Number(inputLimit[1].replaceAll(",", "")) : maxMatch ? Number(maxMatch[1].replaceAll(",", "")) : null,
    inputTokenLimit: !!(counts || inputLimit),
  };
}

export function estimateCodeBuddyContext(body) {
  // UTF-8 byte heuristic includes final system/history/tools/arguments; not a tokenizer.
  if (!body || typeof body !== "object") throw new Error("Cannot estimate an empty context payload");
  let serialized;
  try { serialized = JSON.stringify(body); } catch { throw new Error("Cannot estimate an unserializable context payload"); }
  if (typeof serialized !== "string") throw new Error("Cannot estimate an unserializable context payload");
  return Math.ceil(Buffer.byteLength(serialized, "utf8") / 3);
}

export function getCodeBuddyBudget(model, body, policy, upstreamLimit = null, upstreamIsInputLimit = false) {
  const requestedModel = String(model || body.model || "");
  const slash = requestedModel.indexOf("/");
  const provider = slash > 0 ? requestedModel.slice(0, slash) : "codebuddy-intl";
  const baseModel = slash > 0 ? requestedModel.slice(slash + 1) : requestedModel;
  const providerLimits = PROVIDER_CAPABILITIES[provider] || {};
  const canonical = baseModel.replace(/\((?:minimal|low|medium|high|xhigh|max|ultra)\)$/i, "");
  const providerModelCaps = providerLimits[requestedModel] || providerLimits[baseModel] || providerLimits[canonical];
  const hasExactProviderModel = Number.isSafeInteger(providerModelCaps?.contextWindow)
    && providerModelCaps.contextWindow > 0;
  const hasUpstreamLimit = Number.isSafeInteger(upstreamLimit) && upstreamLimit > 0;
  const hasExplicitLimit = Number.isSafeInteger(policy.contextLimit) && policy.contextLimit > 0;
  const inputOnlyLimit = Number.isSafeInteger(providerModelCaps?.maxInputTokens) && providerModelCaps.maxInputTokens > 0
    ? providerModelCaps.maxInputTokens : null;
  const contextLimit = hasUpstreamLimit ? upstreamLimit
    : hasExplicitLimit ? policy.contextLimit
      : inputOnlyLimit ?? (hasExactProviderModel ? providerModelCaps.contextWindow : null);
  // Keep the winning limit's semantics: catalog maxInputTokens must not replace
  // an upstream/explicit ceiling or suppress its combined-window output reserve.
  const isInputLimit = hasUpstreamLimit ? upstreamIsInputLimit : !hasExplicitLimit && inputOnlyLimit != null;
  if (contextLimit == null) return { contextLimit: null, budget: null, uncertain: true };
  const requestedOutput = body.max_completion_tokens ?? body.max_tokens ?? 0;
  const outputReserve = isInputLimit ? 0 : Math.max(requestedOutput, policy.outputReserveTokens);
  if (!Number.isSafeInteger(outputReserve) || outputReserve < 0 || outputReserve >= contextLimit) {
    throw new CodeBuddyContextError(`Requested output leaves no valid input token budget. Context limit: ${contextLimit}.`);
  }
  const budget = Math.floor(contextLimit * (1 - policy.safetyMargin)) - outputReserve;
  if (budget <= 0) throw new CodeBuddyContextError("Safety margin and output reserve leave no input token budget.");
  return { contextLimit, budget, uncertain: false };
}

export class CodeBuddyContextError extends Error {
  constructor(message) {
    super(`prompt is too long: ${CODEBUDDY_CONTEXT.marker}. ${message}`);
    this.name = "CodeBuddyContextError";
    this.status = 400;
  }
}

export function protectedToolResultIds(source) {
  const ids = new Set();
  for (const m of source?.messages || []) {
    if (m?.role === ROLE.TOOL && (m.is_error || m.status === "error")) ids.add(m.tool_call_id);
    for (const b of Array.isArray(m?.content) ? m.content : []) {
      if (b?.type === CLAUDE_BLOCK.TOOL_RESULT && (b.is_error || b.status === "error")) ids.add(b.tool_use_id);
    }
  }
  return ids;
}

function getCycleGroups(messages) {
  const pending = new Set();
  const seen = new Set();
  let active = null;
  const groups = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.tool_calls != null && (!Array.isArray(m.tool_calls) || m.role !== ROLE.ASSISTANT)) return { groups: null, reason: "invalid-tool-calls" };
    if (m?.role === ROLE.ASSISTANT && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      if (pending.size || active) return { groups: null, reason: "interleaved-tool-cycles" };
      active = [];
      for (const call of m.tool_calls) {
        if (typeof call?.id !== "string" || !call.id || seen.has(call.id)) return { groups: null, reason: "duplicate-or-missing-tool-id" };
        seen.add(call.id);
        pending.add(call.id);
      }
      active.push(i);
    } else if (m?.role === ROLE.TOOL) {
      if (!pending.has(m.tool_call_id) || !active) return { groups: null, reason: "orphan-tool-result" };
      pending.delete(m.tool_call_id);
      active.push(i);
      if (!pending.size) { groups.push(active); active = null; }
    } else if (pending.size) {
      return { groups: null, reason: "interrupted-tool-cycle" };
    }
  }
  return pending.size || active ? { groups: null, reason: "unfinished-tool-cycle" } : { groups, reason: null };
}

function textParts(content) {
  if (typeof content === "string") return [{ type: OPENAI_BLOCK.TEXT, text: content }];
  if (Array.isArray(content) && content.every((b) => b?.type === OPENAI_BLOCK.TEXT && typeof b.text === "string")) {
    return content.map(({ text }) => ({ type: OPENAI_BLOCK.TEXT, text }));
  }
  return null;
}

function sourceHistory(source, sourceFormat) {
  if (!Array.isArray(source?.messages)) return null;
  const isClaude = sourceFormat === FORMATS.CLAUDE || source.messages.some((m) =>
    Array.isArray(m?.content) && m.content.some((b) => b?.type === CLAUDE_BLOCK.TOOL_USE || b?.type === CLAUDE_BLOCK.TOOL_RESULT));
  if (!isClaude) return !sourceFormat || sourceFormat === FORMATS.OPENAI ? source.messages : null;
  const messages = [];
  for (const m of source.messages) {
    if (!m || ![ROLE.SYSTEM, ROLE.DEVELOPER, ROLE.USER, ROLE.ASSISTANT].includes(m.role)) return null;
    if (!Array.isArray(m.content)) { messages.push(m); continue; }
    const calls = m.content.filter((b) => b?.type === CLAUDE_BLOCK.TOOL_USE);
    const results = m.content.filter((b) => b?.type === CLAUDE_BLOCK.TOOL_RESULT);
    if ((calls.length && m.role !== ROLE.ASSISTANT) || (results.length && m.role !== ROLE.USER)) return null;
    // ponytail: only text/tool histories have verified 1:1 correspondence; skip
    // multimodal/special blocks until their translator mapping is explicitly covered.
    if (m.content.some((b) => ![CLAUDE_BLOCK.TEXT, CLAUDE_BLOCK.TOOL_USE, CLAUDE_BLOCK.TOOL_RESULT].includes(b?.type))) return null;
    const parts = m.content.filter((b) => b.type === CLAUDE_BLOCK.TEXT);
    if (results.length) {
      if (parts.length) return null; // Mixed result/text turns have ambiguous human-turn boundaries.
      if (results.some((b) => !textParts(b.content))) return null;
      messages.push(...results.map((b) => ({ role: ROLE.TOOL, tool_call_id: b.tool_use_id })));
    } else {
      messages.push({ ...m, content: parts, ...(calls.length ? { tool_calls: calls.map(({ id }) => ({ id })) } : {}) });
    }
  }
  return messages;
}

function historyLandmarks(messages) {
  const landmarks = [];
  let started = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || ![ROLE.SYSTEM, ROLE.DEVELOPER, ROLE.USER, ROLE.ASSISTANT, ROLE.TOOL].includes(m.role)) return null;
    if (m.role === ROLE.SYSTEM || m.role === ROLE.DEVELOPER) {
      if (!started) continue;
      const parts = textParts(m.content);
      if (!parts) return null;
      landmarks.push({ key: JSON.stringify([ROLE.USER, parts]), i, instruction: true });
    } else {
      started = true;
      if (m.role === ROLE.USER) {
        const parts = textParts(m.content);
        if (!parts) return null;
        landmarks.push({ key: JSON.stringify([ROLE.USER, parts]), i });
      } else if (m.role === ROLE.TOOL) {
        landmarks.push({ key: JSON.stringify([ROLE.TOOL, m.tool_call_id]), i });
      } else if (m.tool_calls?.length) {
        landmarks.push({ key: JSON.stringify([ROLE.ASSISTANT, m.tool_calls.map(({ id }) => id)]), i });
      }
    }
  }
  return landmarks;
}

export function compressCompletedToolOutputs(body, { keepRecentTurns, protectedIds = new Set(), contextSource = null, sourceFormat = null, minDuplicateChars = 256 }) {
  const messages = body.messages;
  if (!Array.isArray(messages)) return { body, changed: 0, reason: "unsupported-message-shape" };
  const cycleInfo = getCycleGroups(messages);
  if (!cycleInfo.groups) return { body, changed: 0, reason: cycleInfo.reason };
  const sourceMessages = contextSource ? sourceHistory(contextSource, sourceFormat) : messages;
  if (!sourceMessages || !getCycleGroups(sourceMessages).groups) return { body, changed: 0, reason: "invalid-source-history" };
  const sourceMarks = historyLandmarks(sourceMessages);
  const targetMarks = historyLandmarks(messages);
  if (!sourceMarks || !targetMarks || sourceMarks.length !== targetMarks.length
    || sourceMarks.some((mark, i) => mark.key !== targetMarks[i].key)) {
    return { body, changed: 0, reason: "ambiguous-source-correspondence" };
  }
  const turns = sourceMarks.flatMap((mark, i) => sourceMessages[mark.i].role === ROLE.USER && !mark.instruction ? [targetMarks[i].i] : []);
  const cutoff = turns.at(-keepRecentTurns);
  if (cutoff == null || cutoff === 0) return { body, changed: 0, reason: "no-old-complete-turn" };
  const sourceErrorToolIds = protectedToolResultIds(contextSource);
  const eligible = new Set();
  for (const group of cycleInfo.groups) {
    if (group.some((i) => i >= cutoff || protectedIds.has(messages[i].tool_call_id) || sourceErrorToolIds.has(messages[i].tool_call_id)
      || messages[i].is_error || messages[i].status === "error")
      || group.slice(1).some((i) => typeof messages[i].content !== "string")) continue;
    for (const i of group.slice(1)) eligible.add(i);
  }
  const firstOutput = new Map();
  const next = messages.map((m, i) => {
    if (!eligible.has(i) || m?.role !== ROLE.TOOL || protectedIds.has(m.tool_call_id) || m.is_error || m.status === "error" || typeof m.content !== "string" || m.content.length < minDuplicateChars) return m;
    const first = firstOutput.get(m.content);
    if (first === undefined) { firstOutput.set(m.content, m.tool_call_id); return m; }
    const reference = `[Exact duplicate tool output; full content retained earlier at tool_call_id=${JSON.stringify(first)}]`;
    if (reference.length >= m.content.length) return m;
    return { ...m, content: reference };
  });
  const changed = next.reduce((n, m, i) => n + (m !== messages[i] ? 1 : 0), 0);
  return changed ? { body: { ...body, messages: next }, changed, reason: "exact-duplicate-tool-output" }
    : { body, changed: 0, reason: "no-lossless-compression" };
}

export function prepareCodeBuddyContext(body, state, model, log) {
  const estimate = estimateCodeBuddyContext(body);
  if (!state.policy.enabled) {
    log?.info?.("CONTEXT", `codebuddy-intl estimate=${estimate} budget=unknown action=disabled`);
    return body;
  }
  const { budget, contextLimit, uncertain } = getCodeBuddyBudget(model, body, state.policy, state.upstreamLimit);
  if (uncertain) {
    log?.info?.("CONTEXT", `codebuddy-intl estimate=${estimate} budget=unknown action=passthrough reason=no-verified-model-limit`);
    return body;
  }
  const trigger = Math.floor(contextLimit * state.policy.triggerThreshold);
  const target = state.targetBudget ? Math.min(budget, state.targetBudget) : budget;
  log?.info?.("CONTEXT", `codebuddy-intl estimate=${estimate} trigger=${trigger} budget=${target} limit=${contextLimit} action=preflight`);
  if (estimate <= target) {
    if (estimate >= trigger) log?.info?.("CONTEXT", `codebuddy-intl estimate=${estimate} trigger=${trigger} action=near-limit native_compaction_preferred=${state.nativeCompaction && state.policy.preferNativeCompaction}`);
    return body;
  }
  const canCompress = state.policy.fallbackCompression && !(state.nativeCompaction && state.policy.preferNativeCompaction);
  if (canCompress) {
    const candidate = structuredClone(body);
    const reduced = compressCompletedToolOutputs(candidate, { ...state.policy, protectedIds: state.protectedIds, contextSource: state.contextSource, sourceFormat: state.sourceFormat });
    if (reduced.changed > 0) {
      const after = estimateCodeBuddyContext(reduced.body);
      log?.info?.("CONTEXT", `codebuddy-intl estimate=${after} budget=${target} action=${reduced.reason} changed=${reduced.changed}`);
      if (after < estimate && after <= target) { state.compressed = true; return reduced.body; }
      if (after < estimate && state.upstreamLimit && state.recoveryAttempts < CODEBUDDY_CONTEXT.maxRecoveryRetries) {
        state.recoveryAttempts++;
        state.targetBudget = after;
        return reduced.body;
      }
    }
  }
  throw new CodeBuddyContextError(`Estimated input ${estimate} exceeds input budget ${target} for this model's declared context limit ${contextLimit}. Estimation is approximate. Native client compaction is preferred; safe lossy compression is disabled or unavailable. No messages were dropped.`);
}

export function createCodeBuddyContextState(options) {
  return {
    policy: normalizeCodeBuddyContextPolicy(options.contextPolicy || options.providerOverrides?.context),
    nativeCompaction: options.clientTool === "claude",
    sourceFormat: options.requestContext?.sourceFormat || null,
    contextSource: options.requestContext?.sourceBody || null,
    protectedIds: protectedToolResultIds(options.requestContext?.sourceBody),
    compressed: false,
    upstreamLimit: null,
    targetBudget: null,
    recoveryAttempts: 0,
  };
}
