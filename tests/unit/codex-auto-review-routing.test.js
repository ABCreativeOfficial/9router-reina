import { describe, expect, it } from "vitest";

import {
  getDefaultModel,
  getModelQuotaFamily,
  getModelUpstreamId,
  getProviderModels,
  getPublicModelsByProviderId,
} from "../../open-sse/config/providerModels.js";
import { getModelInfoCore } from "../../open-sse/services/model.js";

// Codex CLI's auto-review sends the bare model id "codex-auto-review". Before #1398 it fell
// through prefix inference to the "openai" default and failed with
// "No active credentials for provider: openai".
describe("codex auto-review routing (#1398)", () => {
  it("routes the bare Codex auto-review model to the OAuth Codex provider", async () => {
    await expect(getModelInfoCore("codex-auto-review", {})).resolves.toEqual({
      provider: "codex",
      model: "codex-auto-review",
    });
  });

  it("keeps auto-review routable but out of the public model list", () => {
    const autoReview = getProviderModels("cx").find(
      (model) => model.id === "codex-auto-review",
    );

    expect(autoReview).toBeTruthy();
    expect(autoReview.name).toBe("Codex Auto Review");
    // Official Codex ships this entry with visibility "hide": it stays routable
    // (Codex CLI sends the bare id) without being offered as a selectable model.
    expect(autoReview.internal).toBe(true);
    expect(getPublicModelsByProviderId("codex").some((m) => m.id === "codex-auto-review")).toBe(false);
    expect(getModelQuotaFamily("cx", "codex-auto-review")).toBe("review");
  });

  // The id is not a derived "<base>-review" variant, so it must go out verbatim
  // rather than being rewritten as a virtual reasoning alias.
  it("forwards the id upstream without rewriting it", () => {
    expect(getModelUpstreamId("cx", "codex-auto-review")).toBe(
      "codex-auto-review",
    );
  });

  // Registering it must not push it to the front of the cx list — getDefaultModel takes models[0].
  it("does not become the default Codex model", () => {
    expect(getDefaultModel("cx")).not.toBe("codex-auto-review");
  });
});
