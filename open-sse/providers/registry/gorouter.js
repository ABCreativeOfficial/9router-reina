const gorouter = {
  id: "gorouter",
  priority: 116,
  alias: "gor",
  display: {
    name: "GoRouter",
    icon: "route",
    color: "#2563EB",
    textIcon: "GR",
    website: "https://gorouter.app",
    notice: {
      text: "OpenAI-compatible inference with account-specific models and quota tracking.",
      apiKeyUrl: "https://gorouter.app",
    },
  },
  category: "apikey",
  authType: "apikey",
  transport: {
    baseUrl: "https://gorouter.app/v1/chat/completions",
    validateUrl: "https://gorouter.app/v1/models",
    auth: { combined: true, header: "Authorization", scheme: "bearer" },
  },
  models: [],
  passthroughModels: true,
  features: {
    usage: true,
    usageApikey: true,
  },
};

export default gorouter;
