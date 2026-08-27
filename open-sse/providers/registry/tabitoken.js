const tabitoken = {
  id: "tabitoken",
  priority: 117,
  alias: "tbt",
  display: {
    name: "TabiToken",
    icon: "route",
    color: "#7C3AED",
    textIcon: "TT",
    website: "https://tabitoken.com",
    notice: {
      text: "OpenAI-compatible. Account-specific models and quota tracking.",
      apiKeyUrl: "https://tabitoken.com",
    },
  },
  category: "apikey",
  authType: "apikey",
  transport: {
    baseUrl: "https://tabitoken.com/v1/chat/completions",
    validateUrl: "https://tabitoken.com/v1/models",
    auth: { combined: true, header: "Authorization", scheme: "bearer" },
  },
  models: [],
  passthroughModels: true,
  features: {
    usage: true,
    usageApikey: true,
  },
};

export default tabitoken;
