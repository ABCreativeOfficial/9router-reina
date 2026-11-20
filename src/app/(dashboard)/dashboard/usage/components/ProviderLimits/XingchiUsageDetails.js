"use client";

import PropTypes from "prop-types";

function readableNumber(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : "—";
}

function currencyAmount(value, currency = "USD") {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const amount = value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
  return currency === "USD" ? `$${amount}` : `${amount} ${currency}`;
}

/** A compact footer in the existing standard Quota Tracker card, not a new
 * tracker flow. Wallet spending is deliberately separate from quota bars. */
export default function XingchiUsageDetails({ details }) {
  if (!details) return null;

  const unit = details.unit || "USD";
  const today = details.today || {};
  const total = details.total || {};
  const hasActual = typeof total.actualCost === "number";
  const hasTodayActual = typeof today.actualCost === "number";
  const models = Array.isArray(details.models) ? details.models : [];
  const items = [
    [hasTodayActual ? "Today charged" : "Today cost", currencyAmount(today.actualCost ?? today.cost, unit)],
    [hasActual ? "Total charged" : "Reported cost", currencyAmount(total.actualCost ?? total.cost, unit)],
    ["Requests today", readableNumber(today.requests)],
    ["Tokens today", readableNumber(today.totalTokens)],
  ];

  return (
    <div className="mt-2 space-y-2 border-t border-black/5 px-1 pt-2 text-[11px] dark:border-white/5">
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <span className="min-w-0 truncate font-medium text-text-primary">
          Xingchi usage{details.plan ? ` · ${details.plan}` : ""}
        </span>
        {details.billingRate !== null && details.billingRate !== undefined && (
          <span className="rounded-md bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-600 dark:text-blue-400"
            title={details.billingScope ? `Billing scope: ${details.billingScope}` : "Effective billing multiplier"}>
            Billing {details.billingRate}×
          </span>
        )}
      </div>
      {typeof details.balance === "number" && (
        <div className="flex items-center justify-between gap-2 rounded-md bg-blue-500/5 px-2 py-1.5">
          <span className="text-text-muted">Wallet balance (exact)</span>
          <span className="font-semibold tabular-nums text-blue-600 dark:text-blue-400">
            {currencyAmount(details.balance, unit)}
          </span>
        </div>
      )}
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        {items.map(([label, value]) => (
          <div className="flex min-w-0 items-center justify-between gap-2" key={label}>
            <span className="truncate text-text-muted" title={label}>{label}</span>
            <span className="shrink-0 font-medium tabular-nums text-text-primary">{value}</span>
          </div>
        ))}
      </div>
      {models.length > 0 && (
        <details className="rounded-md border border-black/5 px-2 py-1.5 dark:border-white/5">
          <summary className="cursor-pointer select-none text-text-muted">
            Usage by model ({models.length})
          </summary>
          <div className="mt-2 space-y-1.5">
            {models.map((model) => (
              <div className="flex min-w-0 items-center justify-between gap-2" key={model.model}>
                <span className="truncate font-mono text-[10px] text-text-primary" title={model.model}>
                  {model.model}
                </span>
                <span className="shrink-0 tabular-nums text-text-muted"
                  title={`${readableNumber(model.requests)} requests · ${readableNumber(model.totalTokens)} tokens`}>
                  {currencyAmount(model.actualCost ?? model.cost, unit)} · {readableNumber(model.requests)} req
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

XingchiUsageDetails.propTypes = {
  details: PropTypes.shape({
    plan: PropTypes.string,
    balance: PropTypes.number,
    unit: PropTypes.string,
    today: PropTypes.object,
    total: PropTypes.object,
    models: PropTypes.array,
    billingRate: PropTypes.number,
    billingScope: PropTypes.string,
  }),
};
