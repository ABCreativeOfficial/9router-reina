import { getAccount, publicAccount } from "@/lib/xingchi/hybridStore.js";
import { checkinAccount } from "@/lib/xingchi/checkin.js";

export const dynamic = "force-dynamic";
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
