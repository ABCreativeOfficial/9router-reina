"use client";

import { useState, useMemo } from "react";
import PropTypes from "prop-types";
import Modal from "@/shared/components/Modal";
import Input from "@/shared/components/Input";
import Button from "@/shared/components/Button";
import Badge from "@/shared/components/Badge";
import SegmentedControl from "@/shared/components/SegmentedControl";

/** Drop a request-time `(level)` suffix so a legacy entry maps onto its base model. */
function baseId(id) {
  const m = String(id ?? "").trim().match(/^(.*)\(([^()]+)\)\s*$/);
  return (m ? m[1] : String(id ?? "")).trim();
}

/**
 * Per-account Model Access modal.
 *
 * Writes `providerSpecificData.enabledModels` — empty means "all models". The policy is
 * per model: an entry grants its model at every thinking level, so no level variants are
 * listed here. Model choices come from the caller, which shares one catalog builder with
 * the provider page's Available Models grid.
 */
export default function ModelAccessModal({ isOpen, connection, entries, onSave, onClose }) {
  const [draft, setDraft] = useState([]);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  // Re-seed from the connection without an effect (React's recommended pattern).
  const [seenKey, setSeenKey] = useState(null);
  const key = `${connection?.id || ""}:${isOpen}`;
  if (key !== seenKey) {
    setSeenKey(key);
    const stored = Array.isArray(connection?.providerSpecificData?.enabledModels)
      ? connection.providerSpecificData.enabledModels
      : [];
    setDraft(Array.from(new Set(stored.map(baseId).filter(Boolean))));
    setQuery("");
  }

  const value = draft;
  const selected = useMemo(() => new Set(value), [value]);
  const mode = value.length > 0 ? "selected" : "all";

  // A stored id stays listed even when the catalog no longer offers it, so saving
  // never silently drops a selection.
  const options = useMemo(() => {
    const known = new Map((entries || []).map((e) => [e.id, e]));
    for (const id of value) {
      if (!known.has(id)) known.set(id, { id, name: id, source: "stored", disabled: false });
    }
    const q = query.trim().toLowerCase();
    const list = [...known.values()];
    return q ? list.filter((e) => e.id.toLowerCase().includes(q) || String(e.name).toLowerCase().includes(q)) : list;
  }, [entries, value, query]);

  const toggle = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setDraft(Array.from(next));
  };

  const handleSubmit = async () => {
    setSaving(true);
    try {
      await onSave({ providerSpecificData: { enabledModels: value } });
    } finally {
      setSaving(false);
    }
  };

  if (!connection) return null;

  const accountLabel = connection.name?.trim()
    || connection.email?.trim()
    || connection.displayName?.trim()
    || connection.id;

  return (
    <Modal isOpen={isOpen} title="Model Access" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="bg-sidebar/50 p-3 rounded-lg">
          <p className="text-sm text-text-muted mb-1">Account</p>
          <p className="font-medium truncate" title={accountLabel}>{accountLabel}</p>
        </div>

        <div className="flex items-center justify-between gap-2">
          <SegmentedControl
            size="sm"
            value={mode}
            options={[
              { value: "all", label: "All models (default)" },
              { value: "selected", label: "Selected models only" },
            ]}
            onChange={(next) => { if (next === "all") setDraft([]); }}
          />
          {mode === "selected" && <Badge variant="success">{value.length} selected</Badge>}
        </div>

        <p className="text-xs text-text-muted">
          {mode === "all"
            ? "This account can serve any model of this provider. Routing behavior is unchanged."
            : "Only the checked models may route through this account. Thinking levels are covered automatically. Other accounts of this provider are unaffected."}
        </p>

        <Input
          label="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter models"
        />

        <div className="max-h-64 overflow-y-auto flex flex-col gap-1 pr-1">
          {options.length === 0 && (
            <p className="text-xs text-text-muted">No models available for this provider.</p>
          )}
          {options.map((entry) => (
            <div key={entry.id} className="flex items-center gap-2 text-sm py-0.5">
              <input
                type="checkbox"
                id={`ma-${entry.id}`}
                checked={selected.has(entry.id)}
                onChange={() => toggle(entry.id)}
                className="accent-accent"
              />
              <label htmlFor={`ma-${entry.id}`} className="truncate cursor-pointer" title={entry.id}>
                {entry.id}
              </label>
              {entry.source === "custom" && <Badge size="sm">custom</Badge>}
              {entry.source === "legacyAlias" && <Badge size="sm">alias</Badge>}
              {entry.disabled && (
                <span className="ml-auto shrink-0 text-[10px] text-text-muted" title="Disabled for every account on this provider">
                  disabled globally
                </span>
              )}
            </div>
          ))}
        </div>

        <div className="flex gap-2">
          <Button onClick={handleSubmit} fullWidth disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
          <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

ModelAccessModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  connection: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    email: PropTypes.string,
    displayName: PropTypes.string,
    provider: PropTypes.string,
    providerSpecificData: PropTypes.object,
  }),
  entries: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    source: PropTypes.string,
    disabled: PropTypes.bool,
  })),
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
