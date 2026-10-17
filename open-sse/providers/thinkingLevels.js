// Resolve valid thinking levels per model — drives UI level picker (suffix "model(level)").
// Reuses capabilities.js (thinkingFormat/canDisable) so this file only maps format→levels (DRY).
import { getCapabilitiesForModel } from "./capabilities.js";
import { matchPattern } from "./pricing.js";
import { resolveKiroEffortPath } from "../config/kiroConstants.js";
import { getCodexModelCapabilities, matchCodexBaseModel } from "../config/codexModels.js";

// Shared level sets (deduped) — verified against provider docs + wire in thinkingUnified.applyFormat.
const L = {
  base: ["none", "low", "medium", "high"],                          // qwen, step, hunyuan, gemini-budget
  onOff: ["none", "thinking"],                                      // zai (binary), minimax (adaptive)
  openai: ["none", "minimal", "low", "medium", "high", "xhigh"],    // GPT-5.x / o-series (no "max")
  levelMax: ["none", "low", "medium", "high", "max"],               // kimi
  budgetX: ["none", "low", "medium", "high", "xhigh", "max"],       // claude-budget, claude-adaptive
  gemini: ["minimal", "low", "medium", "high"],                     // gemini-3 thinkingLevel (no disable)
  hiMax: ["none", "high", "max"],                                   // deepseek (low/med→high, xhigh→max)
};

// thinkingFormat → valid selectable levels (source of truth for UI options).
const FORMAT_LEVELS = {
  openai: L.openai,
  "claude-adaptive": L.budgetX,
  "claude-budget": L.budgetX,
  "gemini-level": L.gemini,
  "gemini-budget": L.base,
  zai: L.onOff,
  qwen: L.base,
  kimi: L.levelMax,
  deepseek: L.hiMax,
  commandcode: ["none", "low", "medium", "high", "xhigh", "max"],
  minimax: L.onOff,
  hunyuan: L.base,
  step: L.base,
  nous: L.base,
};

// Opus/Sonnet 4.6 lack xhigh (Anthropic + Kiro docs) — keep the 4-level+max set.
const CLAUDE_NO_XHIGH = ["none", "low", "medium", "high", "max"];

// Model-name pattern overrides (glob, first match wins) — more precise than format default.
// Codex has no entry here: its reasoning sets are per model in the official
// catalog (Luna stops at `max`, GPT-5.5 at `xhigh`), resolved from the shared
// capability map in open-sse/config/codexModels.js below.
const PATTERN_THINKING = [
  // Gemini 4 (Argon) rejects "minimal" with 400 — LOW is the floor; cannot disable thinking.
  { pattern: "*gemini-4*", levels: ["low", "medium", "high"] },
  { pattern: "*claude*4.6*", levels: CLAUDE_NO_XHIGH },
  { pattern: "*claude*4-6*", levels: CLAUDE_NO_XHIGH },
  { pattern: "*codex*", levels: ["low", "medium", "high", "xhigh"] }, // codex cannot disable thinking
  // OpenCode Free lane (/inference/v1, probed live): these ids accept every level
  // they are given, including ones the generic patterns withhold from their paid
  // siblings. Provider-scoped on purpose — the opencode-go entries further down
  // are narrower because THOSE backends 400 on "max". A declared set is both the
  // picker's option list and the fitting target, so a wrong ceiling silently
  // rewrites a client's native level (max → xhigh) instead of sending it.
  // Verified on /inference: deepseek-v4.1-flash-free and glm-5.3-flash-free answer
  // 200 for every level including "minimal" and "max"; mimo-v2.6-flash-free for max.
  { provider: "opencode", pattern: "*mimo*v2.6*", levels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] },
  { provider: "opencode", pattern: "*deepseek-v4.1-flash-free*", levels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] },
  { provider: "opencode", pattern: "*glm-5.3-flash-free*", levels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] },
  // Same gateway on the Zen lane: mimo-v2.6-flash-free answers 200 for max there too.
  { provider: "opencode-zen", pattern: "*mimo*v2.6*", levels: ["none", "low", "medium", "high", "xhigh", "max"] },
  // Zen lane GLM-5.3-Flash: vendor docs and the reference proxy
  // (OnesoftQwQ/opencode-go-copilot v1.11.1) both state low|high|max only, and
  // the lane could not be probed cleanly (every level request answered the
  // transient route 429). Declaring the documented set keeps "max" intact rather
  // than letting the openai format default silently fit it down to "xhigh".
  { provider: "opencode-zen", pattern: "*glm-5.3-flash-free*", levels: ["low", "high", "max"] },
  // big-pickle's own enum is none|low|medium|high — the old format default offered
  // "minimal" and "xhigh", and upstream answers 400: `reasoning_effort must be one
  // of 'none', 'low', 'medium' or 'high'.` (probed live, retried; the free lane is
  // what was probed, and the enum comes from the model server).
  { pattern: "*big-pickle*", levels: ["none", "low", "medium", "high"] },
  { pattern: "*mimo*v2.6*", levels: ["none", "low", "medium", "high", "xhigh"] },
  // mimo-v2.5-pro on opencode-go rejects reasoning_effort "max" (probed live); v2.5 accepts it.
  { pattern: "*mimo*v2.5-pro*", levels: ["none", "low", "medium", "high", "xhigh"] },
  // DeepSeek v4.* (Alibaba MaaS, probed live): effort low|medium|high|xhigh|max
  // all 200 via output_config.effort; "none" is a 400 on the anthropic route
  // (disable thinking instead). none kept for the picker = disable.
  // ⚠️ The codebuddy-cn exact ids below MUST stay above this unqualified glob —
  // PATTERN_THINKING is first-match-wins, so a later provider-qualified entry
  // would never fire for dotted ids like deepseek-v4.1-flash.
  { provider: "codebuddy-cn", pattern: "deepseek-v4-pro",     levels: ["low", "high", "xhigh"] },
  { provider: "codebuddy-cn", pattern: "deepseek-v4.1-flash", levels: ["low", "high", "max"] },
  // OpenCode Zen free tier (oc / ocz) — the free id of the same v4.1-flash model
  // publishes low|high|max as well, and unlike DeepSeek's own API the upstream
  // forwards the level verbatim (no low→high collapse). The generic
  // *deepseek-v4.* glob below would advertise medium/xhigh, which the model does
  // not serve, so this entry MUST stay above it.
  { pattern: "*deepseek-v4.1-flash-free*", levels: ["low", "high", "max"] },
  { pattern: "*deepseek-v4.*", levels: ["none", "low", "medium", "high", "xhigh", "max"] },
  // codebuddy-cn per-model effort sets — the server's product-config payload
  // publishes `reasoning.supportedEfforts` per model. NOTE: the chat endpoint
  // accepts any level you send (probed none/minimal/low/medium/high/xhigh/max
  // → all 200), but values outside a model's supportedEfforts are silently
  // clamped, so the declared set stays authoritative for the picker. Models
  // that publish no supportedEfforts (glm-5.1 / kimi-k3-1 / minimax-m3)
  // fall through to the openai format default.
  { provider: "codebuddy-cn", pattern: "glm-5.3",      levels: ["low", "high", "max"] },
  { provider: "codebuddy-cn", pattern: "glm-5.3-flash", levels: ["low", "high", "max"] },
  { provider: "codebuddy-cn", pattern: "glm-5.2",      levels: ["high", "xhigh"] },
  { provider: "codebuddy-cn", pattern: "kimi-k2.8-preview",  levels: ["low", "medium", "high"] },
  { provider: "codebuddy-cn", pattern: "hy3",          levels: ["low", "high"] },
  { provider: "codebuddy-cn", pattern: "hy4-preview",  levels: ["high"] },
  // codebuddy-intl rides the same gateway catalog, so its deepseek levels match.
  { provider: "codebuddy-intl", pattern: "deepseek-v4*", levels: ["low", "high", "xhigh"] },
  // MiniMax Code (mcode) — adaptive effort via output_config.effort. M3.1
  // always thinks (no none); M3 is switchable with none/high only, per the
  // magpie static catalog. M2.7 pair falls through to the claude-adaptive
  // set minus none (canDisable: false).
  { provider: "minimax-code", pattern: "MiniMax-M3.1*", levels: ["low", "medium", "high", "xhigh", "max"] },
  { provider: "minimax-code", pattern: "MiniMax-M3", levels: ["none", "high"] },
  { provider: "minimax-code-global", pattern: "MiniMax-M3.1*", levels: ["low", "medium", "high", "xhigh", "max"] },
  { provider: "minimax-code-global", pattern: "MiniMax-M3", levels: ["none", "high"] },
];

// Returns valid thinking levels for a model, or null when the model has no reasoning.
export function getThinkingLevels(provider, model) {
  if (provider === "kiro" && resolveKiroEffortPath(model) === null) return null;
  // Codex reasoning sets are per model in the official catalog (Luna stops at
  // `max`, GPT-5.5 at `xhigh`), so they come from the shared capability map
  // instead of a broad family pattern that would flatten them together.
  if (provider === "codex") {
    const codexMatch = matchCodexBaseModel(
      typeof model === "string" ? model.replace(/\([^()]+\)\s*$/, "").trim() : model
    );
    const codexCaps = codexMatch ? getCodexModelCapabilities(codexMatch.base) : null;
    if (codexCaps) return ["none", "minimal", ...codexCaps.reasoning];
  }
  const caps = getCapabilitiesForModel(provider, model);
  if (!caps.reasoning) return null;
  const hit = PATTERN_THINKING.find((entry) =>
    (!entry.provider || entry.provider === provider) && matchPattern(entry.pattern, model)
  );
  let levels = hit?.levels || FORMAT_LEVELS[caps.thinkingFormat] || L.base;
  if (caps.thinkingCanDisable === false) levels = levels.filter((l) => l !== "none");
  return levels;
}
