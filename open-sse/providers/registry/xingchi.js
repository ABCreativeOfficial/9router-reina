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
  // Offline seeds only. The dashboard fetches the account's live /v1/models
  // catalog using its saved API key, so other supported ids need no source edit.
  models: [
    { id: "gpt-6.1-sol", name: "GPT 6.1 Sol" },
    { id: "gpt-6-astra", name: "GPT 6 Astra" },
  ],
  passthroughModels: true,
};
