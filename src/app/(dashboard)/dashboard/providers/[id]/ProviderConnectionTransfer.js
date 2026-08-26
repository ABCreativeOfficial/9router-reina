"use client";

import { useRef, useState } from "react";
import PropTypes from "prop-types";
import { Button } from "@/shared/components";
import { EXPORT_FORMAT, EXPORT_VERSION } from "@/lib/providerConnectionTransfer";

/**
 * Per-provider connection import/export (custom fork feature).
 *
 * Export goes through POST /api/providers/export because the dashboard's
 * connection state has credentials stripped — a backup built from it would be
 * useless. Import reads a file with a native picker; no textarea.
 */
export default function ProviderConnectionTransfer({ providerId, selectedConnectionIds, onImported }) {
  const fileInputRef = useRef(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState(null);

  const selectedCount = selectedConnectionIds.length;

  const handleExport = async () => {
    if (selectedCount === 0 || busy) return;
    setBusy("export");
    setMessage(null);
    try {
      const res = await fetch("/api/providers/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId, connectionIds: selectedConnectionIds }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setMessage({ error: data?.error || `Export failed (${res.status})` });
        return;
      }
      const blob = new Blob([JSON.stringify(data.export, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = data.filename || `9router-${providerId}-connections.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMessage({
        ok: `Exported ${data.export?.connections?.length || 0} connection(s). This file contains provider credentials/tokens — store it securely.`,
      });
    } catch (error) {
      setMessage({ error: error?.message || "Export failed" });
    } finally {
      setBusy("");
    }
  };

  const handleFileChange = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setBusy("import");
    setMessage(null);
    try {
      if (file.size > 5 * 1024 * 1024) {
        setMessage({ error: "File is too large (max 5 MB)" });
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        setMessage({ error: "Invalid JSON file" });
        return;
      }

      if (parsed?.format !== EXPORT_FORMAT || parsed?.version !== EXPORT_VERSION) {
        setMessage({ error: `Not a 9Router connection export (expected format "${EXPORT_FORMAT}" v${EXPORT_VERSION})` });
        return;
      }
      if (parsed.provider !== providerId) {
        setMessage({ error: `This file belongs to provider "${parsed.provider}", not "${providerId}"` });
        return;
      }

      const res = await fetch("/api/providers/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId, export: parsed }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setMessage({ error: data?.error || `Import failed (${res.status})` });
        return;
      }

      const parts = [`${data.success} imported`];
      if (data.skipped) parts.push(`${data.skipped} skipped (duplicate)`);
      if (data.failed) parts.push(`${data.failed} failed`);
      setMessage({ ok: parts.join(", ") });
      if (data.success > 0 && typeof onImported === "function") await onImported();
    } catch (error) {
      setMessage({ error: error?.message || "Import failed" });
    } finally {
      setBusy("");
    }
  };

  return (
    <>
      {selectedCount > 0 && (
        <Button
          size="sm"
          variant="secondary"
          icon="download"
          onClick={handleExport}
          disabled={busy === "export"}
          title="Download the selected connections as a JSON backup (contains credentials)"
        >
          {busy === "export" ? "Exporting..." : `Export Selected (${selectedCount})`}
        </Button>
      )}
      <Button
        size="sm"
        variant="secondary"
        icon="upload"
        onClick={() => fileInputRef.current?.click()}
        disabled={busy === "import"}
        title="Restore connections from a 9Router connection export file"
      >
        {busy === "import" ? "Importing..." : "Import JSON"}
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        onChange={handleFileChange}
        className="hidden"
      />
      {message && (
        <span className={`text-xs break-words ${message.error ? "text-red-500" : "text-text-muted"}`}>
          {message.error || message.ok}
        </span>
      )}
    </>
  );
}

ProviderConnectionTransfer.propTypes = {
  providerId: PropTypes.string.isRequired,
  selectedConnectionIds: PropTypes.array.isRequired,
  onImported: PropTypes.func,
};
