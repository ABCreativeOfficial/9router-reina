"use client";

import PropTypes from "prop-types";

/** Status-only indicator in the provider-card header; quota rows remain below. */
export default function TokenHarborUsageDetails({ details }) {
  if (!details) return null;

  const status = details.freeModelsEnabled === false
    ? { label: "Free models disabled", icon: "block", color: "text-red-600 dark:text-red-400" }
    : details.freeExhausted
      ? { label: "Free quota exhausted", icon: "error", color: "text-red-600 dark:text-red-400" }
      : details.activated === false
        ? { label: "Free quota not started", icon: "schedule", color: "text-amber-600 dark:text-amber-400" }
        : details.freeModelsEnabled === true
          ? { label: "Free models enabled", icon: "verified", color: "text-emerald-600 dark:text-emerald-400" }
          : { label: "Free model status unknown", icon: "help_outline", color: "text-text-muted" };

  return (
    <span
      className={`inline-flex shrink-0 items-center ${status.color}`}
      role="img"
      aria-label={status.label}
      title={status.label}
      tabIndex={0}
    >
      <span aria-hidden="true" className="material-symbols-outlined text-[16px] leading-none">
        {status.icon}
      </span>
    </span>
  );
}

TokenHarborUsageDetails.propTypes = {
  details: PropTypes.shape({
    activated: PropTypes.bool,
    freeModelsEnabled: PropTypes.bool,
    freeExhausted: PropTypes.bool,
  }),
};
