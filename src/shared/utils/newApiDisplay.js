/**
 * Display-only metadata for a dynamic New API provider.
 *
 * Internal provider ids are generated (`openai-compatible-chat-<uuid>`) and must
 * never leak into user-facing labels. The bootstrap already copies the persisted
 * node name + alias into each connection as `newApiLabel` + `prefix`, so no new
 * persisted field or DB lookup is needed here.
 */

/** First two alias characters, uppercase; provider-name fallback when missing. */
export function getNewApiInitials(alias, name) {
  const source = (typeof alias === "string" && alias.trim())
    || (typeof name === "string" && name.trim())
    || "";
  return source.slice(0, 2).toUpperCase();
}

/** Persisted New API label, falling back to the internal id only for non-family rows. */
export function getProviderDisplayName(connection) {
  const label = connection?.providerSpecificData?.newApiLabel;
  return (typeof label === "string" && label.trim()) || connection?.provider || "Provider";
}

/** Alias-first initials for New API; existing provider-id rule otherwise. */
export function getProviderDisplayInitials(connection) {
  const data = connection?.providerSpecificData;
  if (data?.newApiOrigin) {
    return getNewApiInitials(data.prefix, data.newApiLabel);
  }
  return String(connection?.provider || "PR").slice(0, 2).toUpperCase();
}
