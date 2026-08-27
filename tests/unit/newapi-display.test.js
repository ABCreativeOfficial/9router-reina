import { describe, expect, it } from "vitest";
import {
  getNewApiInitials,
  getProviderDisplayInitials,
  getProviderDisplayName,
} from "../../src/shared/utils/newApiDisplay.js";
import { getProviderOptions } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const dynamicConnection = (prefix = "tbt", label = "TabiToken") => ({
  provider: "openai-compatible-chat-730b7f20-generated-id",
  providerSpecificData: {
    newApiOrigin: "https://example.com",
    newApiLabel: label,
    prefix,
  },
});

describe("dynamic New API display metadata", () => {
  it.each([
    ["tbt", "TabiToken", "TB"],
    ["gor", "GoRouter", "GO"],
    ["abc", "Example", "AB"],
    ["x", "Example", "X"],
  ])("uses the first two alias characters: %s → %s", (alias, name, expected) => {
    expect(getNewApiInitials(alias, name)).toBe(expected);
  });

  it("falls back to the display name when alias is unexpectedly missing", () => {
    expect(getNewApiInitials("", "TabiToken")).toBe("TA");
    expect(getNewApiInitials(null, "GoRouter")).toBe("GO");
  });

  it("uses persisted New API metadata instead of the generated provider id", () => {
    const connection = dynamicConnection();
    expect(getProviderDisplayName(connection)).toBe("TabiToken");
    expect(getProviderDisplayInitials(connection)).toBe("TB");
    expect(getProviderDisplayName(connection)).not.toContain("openai-compatible-chat");
  });

  it("keeps the existing id-based fallback for ordinary providers", () => {
    const connection = { provider: "codex", providerSpecificData: {} };
    expect(getProviderDisplayName(connection)).toBe("codex");
    expect(getProviderDisplayInitials(connection)).toBe("CO");
  });

  it("keeps provider-option ids while applying display metadata", () => {
    expect(getProviderOptions(["codex"])).toEqual([
      { id: "codex", label: "codex", initials: "CO", isNewApi: false },
    ]);
  });

  it("resolves New API option labels without changing the internal id", () => {
    const id = "openai-compatible-chat-generated-id";
    expect(getProviderOptions([id], {
      [id]: { label: "GoRouter", initials: "GO", isNewApi: true },
    })).toEqual([{ id, label: "GoRouter", initials: "GO", isNewApi: true }]);
  });
});
