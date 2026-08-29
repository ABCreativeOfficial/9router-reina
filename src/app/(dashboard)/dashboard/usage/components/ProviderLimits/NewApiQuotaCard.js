"use client";

import PropTypes from "prop-types";
import { useCallback, useState } from "react";
import Card from "@/shared/components/Card";
import ProviderIcon from "@/shared/components/ProviderIcon";
import Toggle from "@/shared/components/Toggle";
import Tooltip from "@/shared/components/Tooltip";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import QuotaTable from "./QuotaTable";
import NewApiCheckin from "./NewApiCheckin";
import NewApiReferral from "./NewApiReferral";

/**
 * Quota Tracker card for a runtime New API account.
 *
 * Deliberately mirrors the standard tracker card in `ProviderLimits/index.js`:
 * same header block, same action row, same compact QuotaTable body and spacing.
 * The only addition is the New API footer (check-in status, referral rewards),
 * so a New API account reads as the normal card plus one extra section.
 */
export default function NewApiQuotaCard({
  connection,
  quota,
  quotas,
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
  const isInactive = connection.isActive === false;
  const { copied, copy } = useCopyToClipboard();
  const [referralCode, setReferralCode] = useState("");
  const handleReferralCodeChange = useCallback((code) => setReferralCode(code), []);
  const copyId = `newapi-referral-${connection.id}`;

  return (
    <Card padding="none" className={`min-w-0 ${isInactive ? "opacity-60" : ""}`}>
      <div className="px-3 py-2 border-b border-black/10 dark:border-white/10">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 shrink-0 rounded-md flex items-center justify-center overflow-hidden">
              <ProviderIcon
                alt={providerName}
                size={32}
                className="object-contain"
                fallbackText={providerInitials}
              />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-text-primary capitalize truncate">
                {providerName}
              </h3>
              {connectionLabel ? (
                <p className="text-xs text-text-muted truncate">{connectionLabel}</p>
              ) : null}
              {secondaryLabel ? (
                <p className="text-[11px] text-text-muted/80 truncate">{secondaryLabel}</p>
              ) : null}
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {referralCode && (
              <Tooltip text={copied === copyId ? "Copied" : "Copy referral code"}>
                <button
                  type="button"
                  onClick={() => copy(referralCode, copyId)}
                  aria-label="Copy referral code"
                  className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-text-muted hover:text-primary transition-colors"
                >
                  <span className="material-symbols-outlined text-[18px]">
                    {copied === copyId ? "check" : "content_copy"}
                  </span>
                </button>
              </Tooltip>
            )}
            <Tooltip text="Refresh quota">
              <button
                type="button"
                onClick={onRefresh}
                disabled={loading || busy}
                aria-label="Refresh quota"
                className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
              >
                <span className={`material-symbols-outlined text-[18px] text-text-muted ${loading ? "animate-spin" : ""}`}>
                  refresh
                </span>
              </button>
            </Tooltip>
            <Tooltip text="Edit connection">
              <button
                type="button"
                onClick={onEdit}
                disabled={busy}
                aria-label="Edit connection"
                className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-text-muted hover:text-primary transition-colors disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[18px]">edit</span>
              </button>
            </Tooltip>
            <Tooltip text="Delete connection">
              <button
                type="button"
                onClick={onDelete}
                disabled={busy}
                aria-label="Delete connection"
                className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-red-500/10 text-red-500 transition-colors disabled:opacity-50"
              >
                <span className={`material-symbols-outlined text-[18px] ${deleting ? "animate-pulse" : ""}`}>
                  delete
                </span>
              </button>
            </Tooltip>
            <div
              className="inline-flex items-center pl-0.5"
              title={isInactive ? "Enable connection" : "Disable connection"}
            >
              <Toggle size="sm" checked={!isInactive} disabled={busy} onChange={onToggleActive} />
            </div>
          </div>
        </div>
      </div>

      <div className="px-2 py-1.5">
        {loading ? (
          <div className="text-center py-5 text-text-muted">
            <span className="material-symbols-outlined text-[28px] animate-spin">progress_activity</span>
          </div>
        ) : error ? (
          <div className="text-center py-5">
            <span className="material-symbols-outlined text-[28px] text-red-500">error</span>
            <p className="mt-1.5 text-xs text-text-muted">{error}</p>
          </div>
        ) : quota?.message ? (
          <div className="text-center py-5">
            <p className="text-xs text-text-muted">{quota.message}</p>
          </div>
        ) : (
          <QuotaTable quotas={quotas} compact sortMode="default" />
        )}

        <NewApiCheckin connection={connection} onQuotaRefresh={onRefresh} embedded />
      </div>

      <NewApiReferral
        connection={connection}
        onQuotaRefresh={onRefresh}
        footer
        onReferralCodeChange={handleReferralCodeChange}
      />
    </Card>
  );
}

NewApiQuotaCard.propTypes = {
  connection: PropTypes.object.isRequired,
  quota: PropTypes.object,
  quotas: PropTypes.array,
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
