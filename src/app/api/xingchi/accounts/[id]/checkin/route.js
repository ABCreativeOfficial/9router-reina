import { getAccount, publicAccount } from "@/lib/xingchi/hybridStore.js";
import { checkinAccount, getCheckinStatus } from "@/lib/xingchi/checkin.js";

export const dynamic = "force-dynamic";
const HEADERS = { "Cache-Control": "no-store" };

export async function GET(_request, { params }) {
  const { id } = await params;
  if (!await getAccount(id)) return Response.json({ error: "Account not found." }, { status: 404, headers: HEADERS });
  try {
    const status = await getCheckinStatus(id);
    return Response.json({ status, account: publicAccount(await getAccount(id)) }, { headers: HEADERS });
  } catch (error) {
    const message = /session|pair|refresh/i.test(error.message)
      ? error.message : "Unable to refresh Xingchi check-in status. Try again shortly.";
    return Response.json({ error: message }, { status: 502, headers: HEADERS });
  }
}

export async function POST(_request, { params }) {
  const { id } = await params;
  if (!await getAccount(id)) return Response.json({ error: "Account not found." }, { status: 404 });
  try {
    const result = await checkinAccount(id, { manual: true });
    return Response.json({ result, account: publicAccount(await getAccount(id)) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = /session|pair|refresh/i.test(error.message)
      ? error.message : "Unable to perform Xingchi check-in. Try again shortly.";
    return Response.json({ error: message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
