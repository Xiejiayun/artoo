import { useQuery } from "@tanstack/react-query";
import type { Run } from "@artoo/domain";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";

/** Display provider-reported measurements without inventing a cost estimate. */
export function RunUsageSummary({ run }: { run: Run }): React.ReactNode {
  const api = useApi();
  const result = useQuery({
    queryKey: queryKeys.runUsage(run.id), queryFn: () => api.getRunUsage(run.id),
    refetchInterval: ["completed", "failed", "cancelled"].includes(run.status) ? false : 8000,
  });
  if (result.isLoading) return <p className="t-subtle">Loading usage…</p>;
  if (result.error) return <p className="t-subtle">Usage unavailable: could not sync with the server.</p>;
  const usage = result.data?.usage;
  const count = (value: number | null | undefined): string => value == null ? "unavailable" : value.toLocaleString();
  const cost = usage?.cost_usd == null ? "unavailable" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(usage.cost_usd);
  return <dl className="run-usage" aria-label="Run usage">
    <div><dt>Input tokens</dt><dd>{count(usage?.input_tokens)}</dd></div>
    <div><dt>Output tokens</dt><dd>{count(usage?.output_tokens)}</dd></div>
    <div><dt>Cached input</dt><dd>{count(usage?.cached_input_tokens)}</dd></div>
    <div><dt>Cost</dt><dd>{cost}</dd></div>
  </dl>;
}
