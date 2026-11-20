import { getAccount } from "@/lib/xingchi/hybridStore.js";
import { startPairing } from "@/lib/xingchi/pairing.js";
import { resolveRouterOrigin } from "@/lib/newapi/routerOrigin.js";

export const dynamic = "force-dynamic";
export async function POST(request) {
  const body = await request.json().catch(() => null);
  const account = typeof body?.accountId === "string" && await getAccount(body.accountId);
  if (!account) return Response.json({ error: "Import the account first." }, { status: 404 });
  try {
    // The extension content script runs on the exact dashboard origin the user
    // opened. Prefer the browser's Origin to a configured backend baseUrl that
    // may refer to a different port/tunnel endpoint.
    const fromBrowser = (request.headers.get("origin") || "").trim();
    let routerOrigin = await resolveRouterOrigin(request);
    try {
      const parsed = new URL(fromBrowser);
      if (parsed.origin === fromBrowser && (parsed.protocol === "https:"
        || (parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname)))) {
        routerOrigin = fromBrowser;
      }
    } catch { /* use configured origin */ }
    const { protocol, pairingId, pairingSecret, expiresAt, providerOrigin } = startPairing(account.id, routerOrigin);
    return Response.json({ pairing: { protocol, pairingId, pairingSecret, expiresAt, routerOrigin,
      providerOrigin, accountEmail: account.email, launchUrl: `${providerOrigin}/` } },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 429 });
  }
}
