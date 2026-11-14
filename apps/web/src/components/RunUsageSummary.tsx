import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import type { Run } from "@artoo/domain";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { usePollMs } from "../app/RealtimeContext.js";

/** Display runtime usage snapshots without asserting billing accuracy or scope. */
export function RunUsageSummary({ run }: { run: Run }): React.ReactNode {
  const descriptionId = useId();
  const api = useApi();
  const poll8s = usePollMs(8000);
  const result = useQuery({
    queryKey: queryKeys.runUsage(run.id),
    queryFn: () => api.getRunUsage(run.id),
    refetchInterval: ["completed", "failed", "cancelled"].includes(run.status) ? false : poll8s,
  });
  if (result.isLoading) return <p className="t-subtle">Loading usage…</p>;
  if (result.error) return <p className="t-subtle">Usage unavailable: could not sync with the server.</p>;
  const usage = result.data?.usage;
  const count = (value: number | null | undefined): string => (value == null ? "unavailable" : value.toLocaleString());
  const cost =
    usage?.cost_usd == null
      ? "unavailable"
      : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(
          usage.cost_usd,
        );
  return (
    <>
      <dl className="run-usage" aria-label="Run usage" aria-describedby={descriptionId}>
        <div>
          <dt>Input tokens</dt>
          <dd>{count(usage?.input_tokens)}</dd>
        </div>
        <div>
          <dt>Output tokens</dt>
          <dd>{count(usage?.output_tokens)}</dd>
        </div>
        <div>
          <dt>Cached input</dt>
          <dd>{count(usage?.cached_input_tokens)}</dd>
        </div>
        <div>
          <dt>Reported cost</dt>
          <dd>{cost}</dd>
        </div>
      </dl>
      <details className="t-subtle">
        <summary>Cost reporting limits</summary>
        <p id={descriptionId}>
          Runtime-reported usage. Costs may be estimates and include earlier session activity. Billing accuracy and Goal
          totals are unverified.
        </p>
      </details>
    </>
  );
}
