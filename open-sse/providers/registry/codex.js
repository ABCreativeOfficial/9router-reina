import {
  CODEX_CLI_VERSION,
  CODEX_MODEL_CAPABILITIES,
  CODEX_INTERNAL_MODEL_CAPABILITIES,
  CODEX_FAST_SUFFIX,
  CODEX_EXTENDED_CONTEXT_WINDOW,
} from "../../config/codexModels.js";

export default {
  id: "codex",
  priority: 30,
  alias: "cx",
  uiAlias: "cx",
  display: {
    name: "OpenAI Codex",
    icon: "code",
    color: "#3B82F6",
    website: "https://chatgpt.com/codex",
    notice: {
      signupUrl: "https://chatgpt.com/codex",
    },
    deprecated: true,
    deprecationNotice: "RISK_NOTICE",
    kindNotice: {
      image: "Requires a ChatGPT Plus (or higher) account. Free accounts are not supported for image generation.",
    },
  },
  category: "oauth",
  thinkingConfig: {
    options: [
      "auto",
      "none",
      "low",
      "medium",
      "high",
    ],
    defaultMode: "auto",
  },
  transport: {
    baseUrl: "https://chatgpt.com/backend-api/codex/responses",
    format: "openai-responses",
    forceStream: true,
    cliVersion: CODEX_CLI_VERSION,
    headers: {
      originator: "codex_cli_rs",
      "User-Agent": `codex_cli_rs/${CODEX_CLI_VERSION}`,
      version: CODEX_CLI_VERSION,
    },
    usage: {
      url: "https://chatgpt.com/backend-api/wham/usage",
      resetCreditsUrl: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
      resetCreditsConsumeUrl: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
    },
  },
  models: [
    // Public chat models come from the official Codex catalog (visibility "list"
    // + supported_in_api) via the shared capability map, so the registry, the
    // reasoning picker and alias validation cannot drift. Virtual aliases
    // (`<base>-<effort>`, `<base>-(fast)`) are generated from the same map and
    // resolved back to the canonical slug by the Codex executor.
    ...Object.entries(CODEX_MODEL_CAPABILITIES).flatMap(([base, caps]) => {
      const canonical = {
        id: base,
        name: caps.name,
        contextLength: caps.contextWindow,
        // Consumed by the executor (isCodexResponsesLiteModel) to pick the
        // Codex 0.155 wire shape; must be emitted or those models regress.
        ...(caps.responsesLite ? { responsesLite: true } : {}),
      };
      const aliases = [];
      // Extended-context variant: the official catalog serves the same weights
      // with an 872k window under `<base>[1m]`, so it maps back to the base id.
      if (caps.extendedContext) {
        aliases.push({
          id: `${base}[1m]`,
          name: `${caps.name} (extended context)`,
          upstreamModelId: base,
          contextLength: CODEX_EXTENDED_CONTEXT_WINDOW,
          ...(caps.responsesLite ? { responsesLite: true } : {}),
        });
      }
      if (caps.fast) {
        aliases.push({ id: `${base}${CODEX_FAST_SUFFIX}`, name: `${caps.name} (Fast)`, upstreamModelId: base, serviceTier: "fast" });
      }
      for (const effort of caps.reasoning) {
        aliases.push({ id: `${base}-${effort}`, name: `${caps.name} ${effort}`, upstreamModelId: base, reasoningEffort: effort });
        if (caps.fast) {
          aliases.push({
            id: `${base}-${effort}${CODEX_FAST_SUFFIX}`,
            name: `${caps.name} ${effort} (Fast)`,
            upstreamModelId: base,
            reasoningEffort: effort,
            serviceTier: "fast",
          });
        }
      }
      return [canonical, ...aliases];
    }),
    // Official catalog entry with `visibility: "hide"` — kept routable because
    // Codex CLI sends the bare id for its automatic approval review, but never
    // part of a public model list (`internal: true` is filtered by the listing
    // surfaces). See CODEX_INTERNAL_MODEL_CAPABILITIES.
    ...Object.entries(CODEX_INTERNAL_MODEL_CAPABILITIES).map(([id, caps]) => ({
      id,
      name: caps.name,
      contextLength: caps.contextWindow,
      internal: true,
      // Auto-review draws on the review quota bucket upstream, so the internal
      // quota-family marker stays even though the id is no longer a public model.
      quotaFamily: "review",
    })),
    { id: "gpt-image-2.5", name: "GPT Image 2.5", capabilities: ["text2img","edit","multiImage"], params: ["size","quality","background","image_detail","output_format"], kind: "image" },
    { id: "gpt-image-2.5-flare", name: "GPT Image 2.5 Flare", capabilities: ["text2img","edit","multiImage"], params: ["size","quality","background","image_detail","output_format"], kind: "image" },
    { id: "gpt-image-2.5-sunburst", name: "GPT Image 2.5 Sunburst", capabilities: ["text2img","edit","multiImage"], params: ["size","quality","background","image_detail","output_format"], kind: "image" },
    { id: "gpt-image-2", name: "GPT Image 2", capabilities: ["text2img","edit","multiImage"], params: ["size","quality","background","image_detail","output_format"], kind: "image" },
    { id: "gpt-image-1.5", name: "GPT Image 1.5", capabilities: ["text2img","edit","multiImage"], params: ["size","quality","background","image_detail","output_format"], kind: "image" },
    { id: "gpt-5.6-sol-image", name: "GPT 5.6 Sol Image", capabilities: ["text2img","edit"], params: ["size","quality","background","image_detail","output_format"], kind: "image" },
    { id: "gpt-5.6-terra-image", name: "GPT 5.6 Terra Image", capabilities: ["text2img","edit"], params: ["size","quality","background","image_detail","output_format"], kind: "image" },
    { id: "gpt-5.6-luna-image", name: "GPT 5.6 Luna Image", capabilities: ["text2img","edit"], params: ["size","quality","background","image_detail","output_format"], kind: "image" },
    { id: "gpt-5.5-image", name: "GPT 5.5 Image", capabilities: ["text2img","edit"], params: ["size","quality","background","image_detail","output_format"], kind: "image" },
    // gpt-5.4-image removed alongside gpt-5.4 (both are dead on the backend) (#4202).
    { id: "gpt-5.3-image", name: "GPT 5.3 Image", capabilities: ["text2img","edit"], params: ["size","quality","background","image_detail","output_format"], kind: "image" },
  ],
  serviceKinds: ["llm","image"],
  oauth: {
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    scope: "openid profile email offline_access",
    codeChallengeMethod: "S256",
    fixedPort: 1455,
    callbackPath: "/auth/callback",
    extraParams: {
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "codex_cli_rs",
    },
    // Access tokens live ~1h; a 5d lead rotated the refresh token on EVERY call —
    // reuse of a rotated token revokes the whole OpenAI session (account logout).
    refreshLeadMs: 600000,
    refresh: {
      encoding: "form",
      scope: "openid profile email offline_access",
    },
    maxRefreshAgeMs: 691200000,
    trackRefreshAt: true,
  },
  features: {
    usage: true,
  },
};
