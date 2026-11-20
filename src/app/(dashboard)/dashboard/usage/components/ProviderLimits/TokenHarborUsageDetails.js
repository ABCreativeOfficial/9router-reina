"use client";

import PropTypes from "prop-types";

/** Compact status footer inside the standard 9router Quota Tracker card. */
export default function TokenHarborUsageDetails({ details }) {
  if (!details) return null;

  const status = details.freeModelsEnabled === false
    ? { label: "Free models disabled", color: "bg-red-500/10 text-red-600 dark:text-red-400" }
    : details.freeExhausted
      ? { label: "Free quota exhausted", color: "bg-red-500/10 text-red-600 dark:text-red-400" }
      : details.activated === false
        ? { label: "Not started", color: "bg-amber-500/10 text-amber-600 dark:text-amber-400" }
        : details.freeModelsEnabled === true
          ? { label: "Free models enabled", color: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" }
          : { label: "Status unknown", color: "bg-surface-2 text-text-muted" };

  const models = Array.isArray(details.models) ? details.models : [];

  return (
    <div className="mt-2 space-y-2 border-t border-black/5 px-1 pt-2 text-[11px] dark:border-white/5">
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <span className="font-medium text-text-primary">Token Harbor free tier</span>
        <span className={`rounded-md px-1.5 py-0.5 text-[10px] ${status.color}`}>{status.label}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-text-muted">Requests used</span>
          <span className="font-medium tabular-nums text-text-primary">
            {typeof details.requestsUsed === "number" ? details.requestsUsed.toLocaleString() : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-text-muted">Free models</span>
          <span className="font-medium tabular-nums text-text-primary">{models.length}</span>
        </div>
      </div>
      {details.activated === false && (
        <p className="text-[10px] text-text-muted">The 7-day window starts with the first free request.</p>
      )}
      {details.freeExhausted && (
        <p className="text-[10px] text-red-600 dark:text-red-400">
          Free allowance is exhausted. The provider status takes precedence over the rounded percentage.
        </p>
      )}
      {details.onPlan && details.planName && (
        <div className="text-[10px] text-text-muted">
          Pass: <span className="font-medium text-text-primary">{details.planName}</span>
          {details.passExhausted && " · Pass allowance exhausted"}
        </div>
      )}
      {models.length > 0 && (
        <details className="rounded-md border border-black/5 px-2 py-1.5 dark:border-white/5">
          <summary className="cursor-pointer select-none text-text-muted">
            Available free model IDs ({models.length})
          </summary>
          <div className="mt-2 space-y-1">
            {models.map((model) => (
              <div key={model} className="break-all font-mono text-[10px] text-text-primary">{model}</div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

TokenHarborUsageDetails.propTypes = {
  details: PropTypes.shape({
    activated: PropTypes.bool,
    freeModelsEnabled: PropTypes.bool,
    freeExhausted: PropTypes.bool,
    requestsUsed: PropTypes.number,
    models: PropTypes.arrayOf(PropTypes.string),
    onPlan: PropTypes.bool,
    planName: PropTypes.string,
    passExhausted: PropTypes.bool,
  }),
};
