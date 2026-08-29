"use client";

import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import ProviderIcon from "@/shared/components/ProviderIcon";
import Toggle from "@/shared/components/Toggle";
import Tooltip from "@/shared/components/Tooltip";
import NewApiCheckin from "./NewApiCheckin";
import NewApiReferral from "./NewApiReferral";
import { getRemainingPercentage } from "./utils";

function readBalance(quota) {
  if (!quota) return { amount: null, unit: "", percentage: 0 };
  const total = Number(quota.total);
  const used = Number(quota.used);
  const amount = Number.isFinite(total) && Number.isFinite(used) ? Math.max(0, total - used) : null;
  const unit = String(quota.name || "").match(/\(([^)]+)\)\s*$/)?.[1] || "";
  return { amount, unit, percentage: getRemainingPercentage(quota) };
}

function formatBalance(amount, unit) {
  if (!Number.isFinite(amount)) return "Unavailable";
  const value = amount.toLocaleString(undefined, { maximumFractionDigits: 4 });
  if (unit === "USD") return `$${value}`;
  return unit ? `${value} ${unit}` : value;
}

export default function NewApiQuotaCard({
  connection,
  quota,
  loading,
  error,
  providerName,
  providerInitials,
  connectionLabel,
  secondaryLabel,
  busy,
  deleting,
  onRefresh,
  onEdit,
  onDelete,
  onToggleActive,
}) {
  const inactive = connection.isActive === false;
  const balance = readBalance(quota?.quotas?.[0]);

  return (
    <Card padding="none" className={`min-w-0 overflow-hidden ${inactive ? "opacity-60" : ""}`}>
      <div className="px-3 py-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <ProviderIcon
              alt={providerName}
              size={32}
              className="size-8 rounded-md object-contain"
              fallbackText={providerInitials}
            />
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-text-primary">{providerName}</h3>
              {connectionLabel && <p className="truncate text-xs text-text-muted">{connectionLabel}</p>}
              {secondaryLabel && <p className="truncate text-[11px] text-text-muted/80">{secondaryLabel}</p>}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            <Tooltip text="Refresh quota"><button type="button" onClick={onRefresh} disabled={loading || busy} aria-label="Refresh quota" className="flex size-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-black/5 hover:text-primary disabled:opacity-50 dark:hover:bg-white/5"><span className={`material-symbols-outlined text-[18px] ${loading ? "animate-spin" : ""}`}>refresh</span></button></Tooltip>
            <Tooltip text="Edit connection"><button type="button" onClick={onEdit} disabled={busy} aria-label="Edit connection" className="flex size-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-black/5 hover:text-primary disabled:opacity-50 dark:hover:bg-white/5"><span className="material-symbols-outlined text-[18px]">edit</span></button></Tooltip>
            <Tooltip text="Delete connection"><button type="button" onClick={onDelete} disabled={busy} aria-label="Delete connection" className="flex size-8 items-center justify-center rounded-lg text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-50"><span className={`material-symbols-outlined text-[18px] ${deleting ? "animate-pulse" : ""}`}>delete</span></button></Tooltip>
            <div className="inline-flex items-center pl-0.5" title={inactive ? "Enable connection" : "Disable connection"}>
              <Toggle size="sm" checked={!inactive} disabled={busy} onChange={onToggleActive} />
            </div>
          </div>
        </div>

        <div className="mt-5">
          {loading ? (
            <div className="flex justify-center py-5 text-text-muted"><span className="material-symbols-outlined animate-spin text-[28px]">progress_activity</span></div>
          ) : error ? (
            <div className="py-4 text-center"><p className="text-xs text-red-500">{error}</p></div>
          ) : quota?.message ? (
            <div className="py-4 text-center"><p className="text-xs text-text-muted">{quota.message}</p></div>
          ) : (
            <>
              <div className="flex items-end justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-2xl font-semibold tracking-tight text-text-primary">{formatBalance(balance.amount, balance.unit)}</p>
                  <p className="mt-0.5 text-[11px] text-text-muted">Account balance</p>
                </div>
                <p className="shrink-0 text-sm font-semibold tabular-nums text-text-primary">{balance.percentage}%</p>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/10 dark:bg-white/10" role="progressbar" aria-label="Account balance remaining" aria-valuemin="0" aria-valuemax="100" aria-valuenow={balance.percentage}>
                <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${Math.min(100, Math.max(0, balance.percentage))}%` }} />
              </div>
            </>
          )}
        </div>

        <NewApiCheckin connection={connection} onQuotaRefresh={onRefresh} embedded />
      </div>

      <NewApiReferral connection={connection} onQuotaRefresh={onRefresh} footer />
    </Card>
  );
}

NewApiQuotaCard.propTypes = {
  connection: PropTypes.object.isRequired,
  quota: PropTypes.object,
  loading: PropTypes.bool,
  error: PropTypes.string,
  providerName: PropTypes.string.isRequired,
  providerInitials: PropTypes.string.isRequired,
  connectionLabel: PropTypes.string,
  secondaryLabel: PropTypes.string,
  busy: PropTypes.bool,
  deleting: PropTypes.bool,
  onRefresh: PropTypes.func.isRequired,
  onEdit: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
  onToggleActive: PropTypes.func.isRequired,
};
