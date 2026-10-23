"use client";

import { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Card, Badge } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";

// Mirrors the server-side gate in /api/providers/[id]/overrides — client check is UX only
const BLOCKED_HEADERS = ["host", "content-length", "content-type", "connection", "transfer-encoding", "authorization", "cookie"];
const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;

export default function CustomConfigCard({ providerId }) {
  const notify = useNotificationStore();
  const [expanded, setExpanded] = useState(false);
  const [rows, setRows] = useState([{ name: "", value: "" }]);
  const [builtin, setBuiltin] = useState({});
  const [hasOverride, setHasOverride] = useState(false);
  const [saving, setSaving] = useState(false);
  const [context, setContext] = useState({
    enabled: false,
    contextLimit: null,
    triggerThreshold: 0.95,
    safetyMargin: 0.05,
    outputReserveTokens: 4096,
    fallbackCompression: false,
    preferNativeCompaction: true,
    keepRecentTurns: 2,
  });

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/providers/${providerId}/overrides`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        // Effective set = registry built-ins with user overrides layered on top
        const builtinHeaders = data.builtinHeaders || {};
        const effective = { ...builtinHeaders, ...(data.headers || {}) };
        const headerRows = Object.entries(effective).map(([name, value]) => ({ name, value }));
        setBuiltin(builtinHeaders);
        setContext(data.context || { enabled: false, contextLimit: null, triggerThreshold: 0.95, safetyMargin: 0.05, outputReserveTokens: 4096, fallbackCompression: false, preferNativeCompaction: true, keepRecentTurns: 2 });
        setRows(headerRows.length ? headerRows : [{ name: "", value: "" }]);
        setHasOverride(Object.keys(data.headers || {}).length > 0 || !!data.context?.enabled || !!data.context?.fallbackCompression);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [providerId]);

  const setRow = (i, field, value) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)));
  };

  const save = useCallback(async () => {
    // Diff-on-save: only rows differing from the registry default become overrides,
    // so a code-side registry bump still wins for everything the user left alone.
    const headers = {};
    for (const r of rows.filter((r) => r.name.trim())) {
      const name = r.name.trim();
      if (!HEADER_NAME_RE.test(name)) {
        notify.error(`Invalid header name: ${name}`);
        return;
      }
      if (BLOCKED_HEADERS.includes(name.toLowerCase())) {
        notify.error(`Header ${name} cannot be overridden`);
        return;
      }
      if (name in headers) {
        notify.error(`Duplicate header name: ${name}`);
        return;
      }
      if (r.value !== builtin[name]) headers[name] = r.value;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/providers/${providerId}/overrides`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ headers, ...(providerId === "codebuddy-intl" ? { context } : {}) }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        notify.error(err.error || "Failed to save");
        return;
      }
      setHasOverride(Object.keys(headers).length > 0 || (providerId === "codebuddy-intl" && (!!context.enabled || !!context.fallbackCompression)));
      notify.success("Custom headers saved");
    } finally {
      setSaving(false);
    }
  }, [rows, builtin, providerId, context, notify]);

  const resetToBuiltin = () => {
    setRows(Object.entries(builtin).map(([name, value]) => ({ name, value })));
  };

  // Only render when there is something to customize: registry headers or existing overrides
  if (Object.keys(builtin).length === 0 && !hasOverride) return null;

  return (
    <Card padding="xs">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary text-[20px]">tune</span>
          <span className="text-sm font-semibold">Custom Headers</span>
          {hasOverride && (
            <Badge variant="success" size="sm">Active</Badge>
          )}
        </div>
        <span className="material-symbols-outlined text-text-muted">
          {expanded ? "expand_less" : "expand_more"}
        </span>
      </button>

      {expanded && (
        <div className="mt-3 border-t border-border pt-3">
          {providerId === "codebuddy-intl" && (
            <fieldset className="mb-4 rounded-md border border-border p-3">
              <legend className="px-1 text-xs font-semibold">Context handling</legend>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={context.enabled} onChange={(e) => setContext((p) => ({ ...p, enabled: e.target.checked }))} />
                Enable final-payload context preflight (default off)
              </label>
              <p className="mt-1 text-xs text-text-muted">Uses verified model limits only. A rough estimate never overrides an upstream limit response.</p>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="text-xs">Context limit override (tokens, blank = model metadata)
                  <input type="number" min="32768" max="1048576" step="1024" value={context.contextLimit ?? ""} onChange={(e) => setContext((p) => ({ ...p, contextLimit: e.target.value === "" ? null : Number(e.target.value) }))} className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
                </label>
                <label className="text-xs">Trigger threshold (% of limit)
                  <input type="number" min="50" max="100" step="1" value={Math.round(context.triggerThreshold * 100)} onChange={(e) => setContext((p) => ({ ...p, triggerThreshold: Number(e.target.value) / 100 }))} className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
                </label>
                <label className="text-xs">Safety margin (%)
                  <input type="number" min="0" max="30" step="1" value={Math.round(context.safetyMargin * 100)} onChange={(e) => setContext((p) => ({ ...p, safetyMargin: Number(e.target.value) / 100 }))} className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
                </label>
                <label className="text-xs">Reserve for output tokens
                  <input type="number" min="0" max="1048576" step="1024" value={context.outputReserveTokens} onChange={(e) => setContext((p) => ({ ...p, outputReserveTokens: Number(e.target.value) }))} className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
                </label>
                <label className="text-xs">Recent turns to protect
                  <input type="number" min="1" max="20" step="1" value={context.keepRecentTurns} onChange={(e) => setContext((p) => ({ ...p, keepRecentTurns: Number(e.target.value) }))} className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
                </label>
              </div>
              <label className="mt-3 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={context.fallbackCompression} onChange={(e) => setContext((p) => ({ ...p, fallbackCompression: e.target.checked }))} />
                Lossless duplicate historical tool-output compression (opt-in)
              </label>
              <label className="mt-2 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={context.preferNativeCompaction} onChange={(e) => setContext((p) => ({ ...p, preferNativeCompaction: e.target.checked }))} />
Avoid proxy compression for Claude clients; native compaction remains client-owned
              </label>
            </fieldset>
          )}
          <div className="flex flex-col gap-2">
            {rows.map((row, i) => {
              const overridden = row.name.trim() in builtin && row.value !== builtin[row.name.trim()];
              return (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={row.name}
                    onChange={(e) => setRow(i, "name", e.target.value)}
                    placeholder="Header-Name"
                    spellCheck={false}
                    className="w-44 rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-primary focus:outline-none"
                  />
                  <input
                    value={row.value}
                    onChange={(e) => setRow(i, "value", e.target.value)}
                    placeholder="Value"
                    spellCheck={false}
                    title={overridden ? "Overridden" : row.name.trim() in builtin ? "Registry default" : ""}
                    className={`min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 text-sm focus:border-primary focus:outline-none ${
                      overridden ? "border-amber-400/60" : "border-border"
                    }`}
                  />
                  <button
                    type="button"
                    title="Remove header"
                    onClick={() => setRows((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : [{ name: "", value: "" }]))}
                    className="shrink-0 text-text-muted hover:text-red-500"
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </div>
              );
            })}
          </div>

          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setRows((prev) => [...prev, { name: "", value: "" }])}
              className="flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <span className="material-symbols-outlined text-[16px]">add</span>
              Add header
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={saving}
                onClick={resetToBuiltin}
                className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-black/[0.03] dark:hover:bg-white/[0.03] disabled:opacity-50"
              >
                Reset
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={save}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

CustomConfigCard.propTypes = {
  providerId: PropTypes.string.isRequired,
};
