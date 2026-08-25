"use client";

import { useState, useMemo } from "react";
import PropTypes from "prop-types";
import Input from "@/shared/components/Input";
import Button from "@/shared/components/Button";
import Badge from "@/shared/components/Badge";
import SegmentedControl from "@/shared/components/SegmentedControl";
import { getModelsByProviderId } from "@/shared/constants/models";
import { getProviderAlias, isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";

/** Split `m(level)` → `{ base, level }`; level is null when no suffix. */
function splitLevel(id) {
  const m = String(id ?? "").trim().match(/^(.*)\(([^()]+)\)\s*$/);
  return m ? { base: m[1].trim(), level: m[2].trim().toLowerCase() } : { base: String(id ?? "").trim(), level: null };
}

/**
 * Per-account Model Access editor.
 * Persists to `providerSpecificData.enabledModels` — an empty list means "all models".
 *
 * Entries are per-level: a bare `m` grants every thinking level, `m(level)` grants only
 * that one — matching the request-time `(...)` suffix the router parses.
 *
 * Choices come from the per-connection discovery endpoint, the static registry, and the
 * custom-models store, so a manually added id can be selected like any built-in one.
 */
export default function ModelAccessSection({ connection, value, onChange }) {
  const [fetched, setFetched] = useState(null);
  const [customIds, setCustomIds] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(() => new Set());
  // "Selected models only" with nothing checked yet is a valid transient UI state,
  // while persistence still reads empty as "all models" — so the mode needs its own flag.
  const [selectedMode, setSelectedMode] = useState(false);
  // Reset-on-prop-change without an effect (React's recommended pattern).
  const [seenConnectionId, setSeenConnectionId] = useState(connection?.id);
  if (connection?.id !== seenConnectionId) {
    setSeenConnectionId(connection?.id);
    setFetched(null);
    setCustomIds([]);
    setLoadError("");
    setQuery("");
    setExpanded(new Set());
    setSelectedMode((value || []).length > 0);
  }

  const providerId = connection?.provider;
  const selected = useMemo(() => new Set(value || []), [value]);
  const mode = selectedMode || (value || []).length > 0 ? "selected" : "all";

  const staticModels = useMemo(
    () => getModelsByProviderId(providerId).map((m) => m.id).filter(Boolean),
    [providerId]
  );

  // Custom models key off the same alias the dashboard stores them under.
  const storageAlias = useMemo(() => (
    isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId)
      ? providerId
      : getProviderAlias(providerId)
  ), [providerId]);

  const loadModels = async () => {
    if (!connection?.id) return;
    setLoading(true);
    setLoadError("");
    const [live, custom] = await Promise.allSettled([
      fetch(`/api/providers/${connection.id}/models`).then((r) => r.json()),
      fetch("/api/models/custom", { cache: "no-store" }).then((r) => r.json()),
    ]);

    if (custom.status === "fulfilled") {
      setCustomIds(
        (custom.value?.models || [])
          .filter((m) => m?.providerAlias === storageAlias && (m.kind || m.type || "llm") === "llm")
          .map((m) => m.id)
          .filter((id) => typeof id === "string" && id.trim() !== "")
      );
    }

    const ids = live.status === "fulfilled"
      ? (live.value?.models || [])
          .map((m) => (typeof m === "string" ? m : m?.id || m?.name || m?.model))
          .filter((id) => typeof id === "string" && id.trim() !== "")
      : [];
    if (ids.length > 0) setFetched(ids);
    else if (staticModels.length === 0) {
      setLoadError(
        (live.status === "fulfilled" ? live.value?.error : null) || "No models discoverable for this provider"
      );
    }
    setLoading(false);
  };

  // Base model ids: discovered (or static) + custom + any base already selected, so a
  // stored entry never disappears from the list even if discovery stops returning it.
  const baseModels = useMemo(() => {
    const selectedBases = (value || []).map((id) => splitLevel(id).base);
    return Array.from(new Set([...(fetched || staticModels), ...customIds, ...selectedBases])).filter(Boolean);
  }, [fetched, staticModels, customIds, value]);

  // One group per model: the bare id plus its level variants.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return baseModels
      .map((base) => {
        const levels = getThinkingLevels(providerId, base);
        return {
          base,
          levelIds: (Array.isArray(levels) ? levels : [])
            .filter((l) => l !== "none")
            .map((l) => `${base}(${l})`),
        };
      })
      .filter((g) => !q || g.base.toLowerCase().includes(q));
  }, [baseModels, providerId, query]);

  const toggle = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(Array.from(next));
  };

  const toggleExpanded = (base) => {
    const next = new Set(expanded);
    if (next.has(base)) next.delete(base);
    else next.add(base);
    setExpanded(next);
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
            Only the checked entries may route through this account. Checking a model grants every
            thinking level; expand it to allow specific levels only. Other accounts are unaffected.
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
            {groups.length === 0 && (
              <p className="text-xs text-text-muted">No models to show. Try &ldquo;Refresh list&rdquo;.</p>
            )}
            {groups.map(({ base, levelIds }) => {
              const isOpen = expanded.has(base);
              const levelCount = levelIds.filter((id) => selected.has(id)).length;
              return (
                <div key={base} className="flex flex-col">
                  <div className="flex items-center gap-2 text-sm py-0.5">
                    <input
                      type="checkbox"
                      id={`ma-${base}`}
                      checked={selected.has(base)}
                      onChange={() => toggle(base)}
                      className="accent-accent"
                    />
                    <label htmlFor={`ma-${base}`} className="truncate cursor-pointer" title={base}>{base}</label>
                    {levelIds.length > 0 && (
                      <button
                        type="button"
                        onClick={() => toggleExpanded(base)}
                        aria-expanded={isOpen}
                        className="ml-auto shrink-0 text-xs text-text-muted hover:text-text-main"
                      >
                        {levelCount > 0 ? `${levelCount} level${levelCount > 1 ? "s" : ""}` : "levels"}
                        <span className="material-symbols-outlined text-[14px] align-middle">
                          {isOpen ? "expand_less" : "expand_more"}
                        </span>
                      </button>
                    )}
                  </div>
                  {isOpen && levelIds.map((id) => (
                    <div key={id} className="flex items-center gap-2 text-xs py-0.5 pl-6">
                      <input
                        type="checkbox"
                        id={`ma-${id}`}
                        checked={selected.has(id)}
                        onChange={() => toggle(id)}
                        disabled={selected.has(base)}
                        className="accent-accent"
                      />
                      <label htmlFor={`ma-${id}`} className="truncate cursor-pointer" title={id}>
                        {splitLevel(id).level}
                      </label>
                    </div>
                  ))}
                </div>
              );
            })}
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
