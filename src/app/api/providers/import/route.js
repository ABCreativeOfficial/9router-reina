import { NextResponse } from "next/server";
import {
  getProviderConnections,
  createProviderConnection,
  getProviderNodeById,
  getProxyPoolById,
} from "@/models";
import {
  isOpenAICompatibleProvider,
  isAnthropicCompatibleProvider,
  isCustomEmbeddingProvider,
} from "@/shared/constants/providers";
import {
  validateImportPayload,
  prepareConnectionForImport,
  connectionIdentityKey,
} from "@/lib/providerConnectionTransfer";

export const dynamic = "force-dynamic";

function requiresProviderNode(provider) {
  return (
    isOpenAICompatibleProvider(provider) ||
    isAnthropicCompatibleProvider(provider) ||
    isCustomEmbeddingProvider(provider)
  );
}

/**
 * POST /api/providers/import
 * Body: { provider: string, export: <export wrapper> }
 *
 * Restores connections produced by /api/providers/export. Provider identity is
 * re-validated server-side; a file for another provider is rejected. Records are
 * created serially (createProviderConnection assigns priority as max+1 inside a
 * transaction, so parallel creates would race). Credentials are never echoed back.
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

  const payload = body?.export ?? body?.payload;
  const validated = validateImportPayload(payload, provider);
  if (validated.error) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  try {
    // A custom-compatible provider is only a set of connections on top of a node
    // definition; v1 does not transfer the node itself.
    if (requiresProviderNode(provider)) {
      const node = await getProviderNodeById(provider);
      if (!node) {
        return NextResponse.json(
          { error: "Provider definition must exist before importing connections." },
          { status: 400 }
        );
      }
    }

    const existing = await getProviderConnections({ provider });
    const existingKeys = new Set(existing.map(connectionIdentityKey).filter(Boolean));

    const results = [];
    let success = 0;
    let failed = 0;
    let skipped = 0;

    for (let i = 0; i < validated.connections.length; i++) {
      const prepared = prepareConnectionForImport(validated.connections[i], provider);
      if (prepared.error) {
        results.push({ index: i, ok: false, error: prepared.error });
        failed++;
        continue;
      }

      const key = connectionIdentityKey(prepared.data);
      if (key && existingKeys.has(key)) {
        results.push({ index: i, ok: false, skipped: true, error: "Duplicate account already exists" });
        skipped++;
        continue;
      }

      // Local-only reference: keep the binding only if that pool exists here.
      if (prepared.proxyPoolId) {
        try {
          const pool = await getProxyPoolById(prepared.proxyPoolId);
          if (pool) {
            prepared.data.providerSpecificData = {
              ...(prepared.data.providerSpecificData || {}),
              proxyPoolId: prepared.proxyPoolId,
            };
          }
        } catch {
          // Missing/unreadable pool must not fail an otherwise valid account.
        }
      }

      try {
        const created = await createProviderConnection(prepared.data);
        if (key) existingKeys.add(key);
        results.push({ index: i, ok: true, id: created?.id });
        success++;
      } catch {
        results.push({ index: i, ok: false, error: "Failed to create connection" });
        failed++;
      }
    }

    return NextResponse.json({ success, failed, skipped, results });
  } catch {
    return NextResponse.json({ error: "Failed to import connections" }, { status: 500 });
  }
}
