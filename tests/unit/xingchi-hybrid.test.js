import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { parseXingchiCsv } from "../../src/shared/utils/xingchiCsv.js";
import { startPairing, claimPairing, endPairing, statusPairing } from "../../src/lib/xingchi/pairing.js";
import { sealTokens, unsealTokens } from "../../src/lib/xingchi/hybridStore.js";

describe("Xingchi CSV + account bridge", () => {
  it("maps onboarding CSV key_name to account name without persisting passwords", () => {
    const input = 'email,password,api_key,group_id,key_name,account_id\n'
      + 'USER@example.com,"P@ss, With Comma",sk-111,group,"Project, A",100\n'
      + 'user2@example.com,never-export-me,sk-222,group,Team,101';
    expect(parseXingchiCsv(input)).toEqual([
      { email: "user@example.com", name: "Project, A", apiKey: "sk-111" },
      { email: "user2@example.com", name: "Team", apiKey: "sk-222" },
    ]);
  });

  it("prioritizes a specific name over key_name and deduplicates account identities", () => {
    expect(parseXingchiCsv("email,name,key_name,api_key\na@b.com,Friendly,Token,sk-a\na@b.com,Duplicate,,sk-b"))
      .toEqual([{ email: "a@b.com", name: "Friendly", apiKey: "sk-a" }]);
  });

  it("requires email column, rejects malformed addresses", () => {
    expect(() => parseXingchiCsv("name,api_key\nA,sk-a")).toThrow(/email column/);
    expect(() => parseXingchiCsv("email,api_key\nno-at-sign,sk-a")).toThrow(/Invalid CSV email/);
  });

  it("encrypts sessions with AES-GCM and binds ciphertext to the account ID", () => {
    const before = process.env.XINGCHI_BRIDGE_ENCRYPTION_KEY;
    process.env.XINGCHI_BRIDGE_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
    try {
      const sealed = sealTokens("account-1", { accessToken: "secret-access", refreshToken: "secret-refresh" });
      expect(JSON.stringify(sealed)).not.toContain("secret-access");
      expect(unsealTokens("account-1", sealed)).toEqual({ accessToken: "secret-access", refreshToken: "secret-refresh" });
      expect(() => unsealTokens("account-2", sealed)).toThrow();
      const tampered = { ...sealed, data: crypto.randomBytes(24).toString("base64") };
      expect(() => unsealTokens("account-1", tampered)).toThrow();
    } finally {
      if (before === undefined) delete process.env.XINGCHI_BRIDGE_ENCRYPTION_KEY;
      else process.env.XINGCHI_BRIDGE_ENCRYPTION_KEY = before;
    }
  });

  it("enforces single-use per-account pairing secrets and exact router origin", () => {
    const pair = startPairing("account-1", "http://localhost:20127");
    expect(claimPairing(pair.pairingId, "wrong-secret", pair.routerOrigin)).toBeNull();
    expect(claimPairing(pair.pairingId, pair.pairingSecret, "http://127.0.0.1:20127")).toBeNull();
    expect(claimPairing(pair.pairingId, pair.pairingSecret, pair.routerOrigin)?.accountId).toBe("account-1");
    expect(claimPairing(pair.pairingId, pair.pairingSecret, pair.routerOrigin)).toBeNull();
    endPairing(pair.pairingId, true);
    expect(statusPairing(pair.pairingId)).toBe("success");
  });
});
