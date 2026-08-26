import { NextResponse } from "next/server";
import { getProviderConnections } from "@/models";
import { buildExportPayload, buildExportFilename } from "@/lib/providerConnectionTransfer";

export const dynamic = "force-dynamic";

/**
 * POST /api/providers/export
 * Body: { provider: string, connectionIds: string[] }
 *
 * Returns the full persisted connection records (credentials included) for the
 * requested IDs — the only endpoint that does. POST, never GET-with-query, so the
 * selection never lands in a URL/history. Every requested ID must belong to the
 * requested provider: IDs are matched against that provider's own rows only, so a
 * provider-A page can never read a provider-B secret by ID.
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const provider = typeof body?.provider === "string" ? body.provider.trim() : "";
  if (!provider) {
    return NextResponse.json({ error: "provider is required" }, { status: 400 });
  }

  const connectionIds = Array.isArray(body?.connectionIds) ? body.connectionIds : null;
  if (!connectionIds || connectionIds.length === 0) {
    return NextResponse.json({ error: "connectionIds is required" }, { status: 400 });
  }

  try {
    const owned = await getProviderConnections({ provider });
    const byId = new Map(owned.map((c) => [c.id, c]));

    const selected = [];
    const missing = [];
    for (const rawId of connectionIds) {
      const id = typeof rawId === "string" ? rawId : String(rawId ?? "");
      const conn = byId.get(id);
      if (conn) selected.push(conn);
      else missing.push(id);
    }

    if (missing.length > 0) {
      return NextResponse.json(
        { error: `${missing.length} connection(s) do not belong to provider "${provider}"` },
        { status: 404 }
      );
    }

    return NextResponse.json({
      filename: buildExportFilename(provider),
      export: buildExportPayload(provider, selected),
    });
  } catch (error) {
    console.log("Error exporting connections:", error?.message || error);
    return NextResponse.json({ error: "Failed to export connections" }, { status: 500 });
  }
}
