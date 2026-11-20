import { statusPairing } from "@/lib/xingchi/pairing.js";
export const dynamic = "force-dynamic";
export function GET(request) {
  const pairingId = new URL(request.url).searchParams.get("id") || "";
  if (!/^[A-Za-z0-9_-]{12,128}$/.test(pairingId)) return Response.json({ error: "Invalid pairing ID." }, { status: 400 });
  return Response.json({ status: statusPairing(pairingId) }, { headers: { "Cache-Control": "no-store" } });
}
