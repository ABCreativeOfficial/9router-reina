"use client";

import { useState, useMemo } from "react";
import PropTypes from "prop-types";
import Input from "@/shared/components/Input";
import Button from "@/shared/components/Button";
import Badge from "@/shared/components/Badge";
import SegmentedControl from "@/shared/components/SegmentedControl";
import { getModelsByProviderId } from "@/shared/constants/models";

/**
 * Per-account Model Access editor.
 * Persists to `providerSpecificData.enabledModels` — an empty list means "all models".
 * Choices come from the existing per-connection discovery endpoint
 * (`/api/providers/[id]/models`) with the static registry as the fallback.
 */
export default function ModelAccessSection({ connection, value, onChange }) {
  const [fetched, setFetched] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  // "Selected models only" with nothing checked yet is a valid transient UI state,
  // while persistence still reads empty as "all models" — so the mode needs its own flag.
  const [selectedMode, setSelectedMode] = useState(false);
  // Reset-on-prop-change without an effect (React's recommended pattern).
  const [seenConnectionId, setSeenConnectionId] = useState(connection?.id);
  if (connection?.id !== seenConnectionId) {
    setSeenConnectionId(connection?.id);
    setFetched(null);
    setLoadError("");
    setQuery("");
    setSelectedMode((value || []).length > 0);
  }

  const selected = useMemo(() => new Set(value || []), [value]);
  const mode = selectedMode || (value || []).length > 0 ? "selected" : "all";

  const staticModels = useMemo(
    () => getModelsByProviderId(connection?.provider).map((m) => m.id).filter(Boolean),
    [connection?.provider]
  );

  const loadModels = async () => {
    if (!connection?.id) return;
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch(`/api/providers/${connection.id}/models`);
      const data = await res.json();
      const ids = (data?.models || [])
        .map((m) => (typeof m === "string" ? m : m?.id || m?.name || m?.model))
        .filter((id) => typeof id === "string" && id.trim() !== "");
      if (ids.length > 0) setFetched(ids);
      else if (staticModels.length === 0) {
        setLoadError(data?.error || "No models discoverable for this provider");
      }
    } catch {
      if (staticModels.length === 0) setLoadError("Could not load models");
    } finally {
      setLoading(false);
    }
  };

  // Always offer already-selected ids, even if discovery no longer returns them.
  const options = useMemo(() => {
    const all = Array.from(new Set([...(value || []), ...(fetched || staticModels)]));
    const q = query.trim().toLowerCase();
    return q ? all.filter((id) => id.toLowerCase().includes(q)) : all;
  }, [fetched, staticModels, value, query]);

  const toggle = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(Array.from(next));
  };

  return (
    <div className="bg-sidebar/50 p-4 rounded-lg border border-accent/20 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold text-sm">Model Access</h3>
        {mode === "selected" && <Badge variant="success">{(value || []).length} selected</Badge>}
      </div>

      <SegmentedControl
        size="sm"
        value={mode}
        options={[
          { value: "all", label: "All models (default)" },
          { value: "selected", label: "Selected models only" },
        ]}
        onChange={(next) => {
          if (next === "all") {
            setSelectedMode(false);
            onChange([]);
          } else {
            setSelectedMode(true);
            loadModels();
          }
        }}
      />

      {mode === "all" ? (
        <p className="text-xs text-text-muted">
          This account can serve any model of this provider. Routing behavior is unchanged.
        </p>
      ) : (
        <>
          <p className="text-xs text-text-muted">
            Only the checked models may route through this account. Other accounts of this provider are unaffected.
          </p>
          <div className="flex gap-2 items-end">
            <Input
              label="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter models"
              className="flex-1"
            />
            <div className="pt-6">
              <Button onClick={loadModels} variant="secondary" disabled={loading}>
                {loading ? "Loading..." : "Refresh list"}
              </Button>
            </div>
          </div>
          {loadError && <p className="text-xs text-red-500">{loadError}</p>}
          <div className="max-h-56 overflow-y-auto flex flex-col gap-1 pr-1">
            {options.length === 0 && (
              <p className="text-xs text-text-muted">No models to show. Try &ldquo;Refresh list&rdquo;.</p>
            )}
            {options.map((id) => (
              <label key={id} className="flex items-center gap-2 text-sm cursor-pointer py-0.5">
                <input
                  type="checkbox"
                  checked={selected.has(id)}
                  onChange={() => toggle(id)}
                  className="accent-accent"
                />
                <span className="truncate" title={id}>{id}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

ModelAccessSection.propTypes = {
  connection: PropTypes.shape({
    id: PropTypes.string,
    provider: PropTypes.string,
  }),
  value: PropTypes.arrayOf(PropTypes.string),
  onChange: PropTypes.func.isRequired,
};
