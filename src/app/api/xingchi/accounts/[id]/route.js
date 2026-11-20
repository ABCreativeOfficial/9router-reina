import { deleteAccount, getAccount, publicAccount, saveAccount } from "@/lib/xingchi/hybridStore.js";

export const dynamic = "force-dynamic";
const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function PATCH(request, { params }) {
  const { id } = await params;
  const item = await getAccount(id);
  if (!item) return json({ error: "Account not found." }, 404);
  const body = await request.json().catch(() => null);
  if (typeof body?.autoCheckin !== "boolean" || Object.keys(body).length !== 1) {
    return json({ error: "Expected autoCheckin boolean." }, 400);
  }
  if (body.autoCheckin && !item.renewable) {
    return json({ error: "No refresh token available. Re-pair this account before enabling auto check-in." }, 400);
  }
  const saved = await saveAccount({ ...item, autoCheckin: body.autoCheckin });
  return json({ account: publicAccount(saved) });
}

export async function DELETE(_request, { params }) {
  const { id } = await params;
  if (!await getAccount(id)) return json({ error: "Account not found." }, 404);
  await deleteAccount(id);
  return json({ success: true });
}
