"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Button, Input, Modal } from "@/shared/components";

/**
 * Add a New API provider definition (custom fork).
 *
 * Intentionally three fields: Name, Origin, Alias. `/v1` is derived from the
 * origin server-side, and the server also runs a bounded `/api/status`
 * compatibility probe and resolves alias collisions, so nothing endpoint-specific
 * belongs here. Alias may be left blank — the server derives a free one.
 */
export default function AddNewApiProviderModal({ isOpen, onClose, onCreated }) {
  const [name, setName] = useState("");
  const [origin, setOrigin] = useState("");
  const [alias, setAlias] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const reset = () => {
    setName("");
    setOrigin("");
    setAlias("");
    setError("");
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/new-api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          origin: origin.trim(),
          alias: alias.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Could not add the provider.");
        return;
      }
      onCreated(data.provider);
      reset();
    } catch {
      setError("Could not add the provider.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title="Add New API Provider" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-xs text-text-muted">
          For any deployment built on New API. Inference is OpenAI-compatible, and 9Router
          additionally manages the account credential, dynamic models and quota. The base URL
          is derived from the origin — do not include <code>/v1</code>.
        </p>
        <Input
          label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Example API"
          hint="Required. Shown on the provider card."
        />
        <Input
          label="Origin"
          value={origin}
          onChange={(event) => setOrigin(event.target.value)}
          placeholder="https://example.com"
          hint="Required. A bare https origin — no path, query or fragment."
        />
        <Input
          label="Alias"
          value={alias}
          onChange={(event) => setAlias(event.target.value)}
          placeholder="ex"
          hint="Optional. Model-id prefix (ex/gpt-4o). Derived from the name when blank."
        />

        {error && <p className="text-xs text-red-500 break-words">{error}</p>}

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            onClick={handleSubmit}
            fullWidth
            disabled={!name.trim() || !origin.trim() || submitting}
          >
            {submitting ? "Checking…" : "Add Provider"}
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth disabled={submitting}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

AddNewApiProviderModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onCreated: PropTypes.func.isRequired,
};
