/**
 * Placeholder for v1 product views whose data contracts are still being frozen
 * (Phase A). Explicit about what it is waiting on; no invented server fields.
 */
export function PlaceholderPage({
  title,
  waitingFor,
}: {
  title: string;
  waitingFor: string;
}): React.ReactNode {
  return (
    <section className="placeholder-page" aria-label={title}>
      <h1>{title}</h1>
      <p className="placeholder-note">Coming in v1 — waiting on the {waitingFor} contract.</p>
    </section>
  );
}
