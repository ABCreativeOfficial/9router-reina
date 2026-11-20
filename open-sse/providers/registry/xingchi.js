// Xingchi API: API-key integration using the OpenAI Responses streaming wire
// format. This is a separate API-key provider, not ChatGPT Codex OAuth.
import { CODEX_CLI_VERSION } from "../../config/codexModels.js";

export default {
  id: "xingchi",
  priority: 125,
  alias: "xc",
  uiAlias: "xc",
  display: {
    name: "Xingchi API",
    icon: "terminal",
    color: "#0EA5E9",
    textIcon: "XC",
    website: "https://api.xingchiapi.com",
    notice: {
      text: "Uses OpenAI Responses streaming with an API key. Xingchi may restrict third-party integrations; confirm your integration is authorized.",
      apiKeyUrl: "https://xingchiapi.com",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://api.xingchiapi.com/v1/responses",
    validateUrl: "https://api.xingchiapi.com/v1/models",
    format: "openai-responses",
    forceStream: true,
    headers: {
      // Explicitly supplied by the authorized Xingchi Codex configuration.
      "x-openai-actor-authorization": "local-image-extension",
      // Codex CLI identity headers, following codex-rs/login/src/auth/default_client.rs.
      // The release version is shared with the existing 9router Codex provider.
      originator: "codex_cli_rs",
      "User-Agent": `codex_cli_rs/${CODEX_CLI_VERSION}`,
      version: CODEX_CLI_VERSION,
    },
    quirks: { disableResponseStorage: true },
  },
  // Durable offline catalog provided for Xingchi: keep these models visible
  // even when the upstream catalog is empty, partial, or temporarily offline.
  // Live discoveries and user-added models are merged on the dashboard.
  // Context/output limits and reasoning variants are catalog hints, not an
  // assertion that every API-key group is entitled to use every model.
  models: [
    { id: "gpt-6", name: "GPT-6 (Astra)", contextWindow: 1050000, maxOutput: 128000, reasoning: ["low", "medium", "high", "xhigh", "max"] },
    { id: "gpt-6-astra", name: "GPT-6 Astra", contextWindow: 1050000, maxOutput: 128000, reasoning: ["low", "medium", "high", "xhigh", "max"] },
    { id: "gpt-5.2", name: "GPT-5.2", contextWindow: 400000, maxOutput: 128000, reasoning: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5.6", name: "GPT-5.6 (Sol)", contextWindow: 1050000, maxOutput: 128000, reasoning: ["low", "medium", "high", "xhigh", "max"] },
    { id: "gpt-6.1-terra", name: "GPT-6.1 Terra", contextWindow: 1050000, maxOutput: 128000, reasoning: ["none", "low", "medium", "high", "xhigh", "max"] },
    { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", contextWindow: 1050000, maxOutput: 128000, reasoning: ["low", "medium", "high", "xhigh", "max"] },
    { id: "gpt-6-sol", name: "GPT-6 Sol", contextWindow: 1050000, maxOutput: 128000, reasoning: ["none", "low", "medium", "high", "xhigh", "max"] },
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", contextWindow: 1050000, maxOutput: 128000, reasoning: ["low", "medium", "high", "xhigh", "max"] },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", contextWindow: 1050000, maxOutput: 128000, reasoning: ["low", "medium", "high", "xhigh", "max"] },
    { id: "gpt-6-luna", name: "GPT-6 Luna", contextWindow: 1050000, maxOutput: 128000, reasoning: ["none", "low", "medium", "high", "xhigh", "max"] },
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", contextWindow: 1050000, maxOutput: 128000, reasoning: ["low", "medium", "high", "xhigh", "max"] },
    { id: "gpt-5.5", name: "GPT-5.5", contextWindow: 1050000, maxOutput: 128000, reasoning: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5.4", name: "GPT-5.4", contextWindow: 1050000, maxOutput: 128000, reasoning: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", contextWindow: 400000, maxOutput: 128000, reasoning: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark", contextWindow: 128000, maxOutput: 32000, reasoning: ["low", "medium", "high", "xhigh"] },
    { id: "codex-mini-latest", name: "Codex Mini", contextWindow: 200000, maxOutput: 100000, reasoning: ["low", "medium", "high"] },
  ],
  passthroughModels: true,
};
