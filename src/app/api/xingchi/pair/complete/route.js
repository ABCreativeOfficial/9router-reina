import { claimPairing, endPairing } from "@/lib/xingchi/pairing.js";
import { getAccount, saveAccount, sealTokens } from "@/lib/xingchi/hybridStore.js";
import { validateXingchiSession } from "@/lib/xingchi/checkin.js";
import { isAcceptableCompletionOrigin, readRequestOrigin } from "@/lib/newapi/routerOrigin.js";

export const dynamic = "force-dynamic";
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const BRIDGE_HEADER = "xingchi-chrome-extension-v1";

function cors(request) {
  const origin = request.headers.get("origin") || "";
  const headers = { "Cache-Control": "no-store", Vary: "Origin" };
  if (EXTENSION_ORIGIN.test(origin)) Object.assign(headers, {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-9Router-Bridge",
  });
  return headers;
}

export function OPTIONS(request) {
  return new Response(null, { status: EXTENSION_ORIGIN.test(request.headers.get("origin") || "") ? 204 : 403, headers: cors(request) });
}

export async function POST(request) {
  const headers = cors(request);
  const fail = (message, status = 403) => Response.json({ error: message }, { status, headers });
  if (!EXTENSION_ORIGIN.test(request.headers.get("origin") || "") || request.headers.get("x-9router-bridge") !== BRIDGE_HEADER) {
    return fail("A compatible Chrome bridge is required.");
  }
  const data = await request.json().catch(() => null);
  if (!data || Object.keys(data).some((k) => !["pairingId", "pairingSecret", "accessToken", "refreshToken"].includes(k))
    || typeof data.pairingId !== "string" || typeof data.pairingSecret !== "string"
    || typeof data.accessToken !== "string" || data.accessToken.length < 20 || data.accessToken.length > 8192
    || (data.refreshToken != null && (typeof data.refreshToken !== "string" || data.refreshToken.length > 8192))) {
    return fail("Invalid session payload.", 400);
  }
  const record = claimPairing(data.pairingId, data.pairingSecret, readRequestOrigin(request));
  if (!record || !isAcceptableCompletionOrigin(record.routerOrigin, readRequestOrigin(request))) {
    return fail("Pairing expired, not approved, or already used.");
  }
  try {
    const account = await getAccount(record.accountId);
    if (!account) { endPairing(data.pairingId, false); return fail("Account was deleted.", 404); }
    const identity = await validateXingchiSession(data.accessToken);
    if (identity.email.trim().toLowerCase() !== account.email) {
      endPairing(data.pairingId, false);
      return fail("Wrong Xingchi account. Log in using the email selected in 9Router.", 409);
    }
    const refreshToken = data.refreshToken || "";
    await saveAccount({ ...account, status: "paired", claimedToday: false, renewable: !!refreshToken,
      sealed: sealTokens(account.id, { accessToken: data.accessToken, refreshToken }),
      pairedAt: new Date().toISOString(), lastError: null });
    endPairing(data.pairingId, true);
    return Response.json({ success: true, email: account.email }, { headers });
  } catch (error) {
    endPairing(data.pairingId, false);
    return fail("Could not verify Xingchi session. Sign in and retry pairing.", 502);
  }
}
