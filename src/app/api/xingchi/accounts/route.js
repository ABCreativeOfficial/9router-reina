import { createProviderConnection, getProviderConnections } from "@/models";
import { ensureAccount, listAccounts, normalizeEmail, publicAccount, saveAccount } from "@/lib/xingchi/hybridStore.js";
import { probeXingchiApiKey } from "open-sse/services/xingchiValidation.js";

export const dynamic = "force-dynamic";
const HEADERS = { "Cache-Control": "no-store" };
const json = (body, status = 200) => Response.json(body, { status, headers: HEADERS });

export async function GET() {
  const accounts = await listAccounts();
  return json({ accounts: accounts.map(publicAccount) });
}

export async function POST(request) {
  const body = await request.json().catch(() => null);
  if (!Array.isArray(body?.accounts) || body.accounts.length < 1 || body.accounts.length > 300) {
    return json({ error: "Provide 1–300 accounts with email and optional API key." }, 400);
  }
  if (body.accounts.some((a) => !normalizeEmail(a?.email) || (a?.apiKey != null &&
      (typeof a.apiKey !== "string" || a.apiKey.length > 1000)) || (a?.name != null &&
      (typeof a.name !== "string" || a.name.length > 120)))) {
    return json({ error: "Invalid email or API key in import." }, 400);
  }
  const existingKeys = await getProviderConnections({ provider: "xingchi" });
  const usedNames = new Set(existingKeys.map((c) => (c.name || "").trim().toLowerCase()));
  const uniqueName = (base) => {
    let name = base;
    if (usedNames.has(name.toLowerCase())) {
      let index = 2;
      while (usedNames.has(`${base} ${index}`.toLowerCase())) index++;
      name = `${base} ${index}`;
    }
    return name;
  };
  // Probe without consuming model quota, and keep write order deterministic.
  // Parallelize only the independent network reads; the DB writes below remain
  // serial so imported connection priorities match CSV order.
  const toProbe = [...new Set(body.accounts.map((a) => a.apiKey?.trim()).filter(Boolean))]
    .filter((key) => !existingKeys.some((c) => c.apiKey === key || c.accessToken === key));
  const probeResults = new Map();
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(6, toProbe.length) }, async () => {
    while (cursor < toProbe.length) {
      const key = toProbe[cursor++];
      let result;
      try { result = await probeXingchiApiKey(key); }
      catch { result = { valid: false, inconclusive: true }; }
      probeResults.set(key, result);
    }
  }));
  const created = [];
  const errors = [];
  for (const item of body.accounts) {
    const email = normalizeEmail(item.email);
    let account = await ensureAccount(email);
    const incomingName = item.name?.trim() || email;
    if (account.name !== incomingName) account = await saveAccount({ ...account, name: incomingName });
    let keyImported = false;
    if (item.apiKey?.trim()) {
      const key = item.apiKey.trim();
      if (!existingKeys.some((c) => c.apiKey === key || c.accessToken === key)) {
        try {
          const name = uniqueName(incomingName);
          const probe = probeResults.get(key);
          const testStatus = probe?.valid ? "active" : probe?.inconclusive ? "unknown" : "error";
          const connection = await createProviderConnection({ provider: "xingchi", authType: "apikey", apiKey: key,
            name, email, testStatus, allowOverwrite: false, isActive: true });
          existingKeys.push(connection);
          usedNames.add(name.toLowerCase());
          keyImported = true;
        } catch (error) {
          errors.push({ email, message: error.code === "PROVIDER_NAME_CONFLICT"
            ? "A Xingchi connection with this name already exists; key not overwritten." : "Unable to import API key." });
        }
      }
    }
    created.push({ email, id: account.id, keyImported });
  }
  return json({ accounts: created, errors });
}
