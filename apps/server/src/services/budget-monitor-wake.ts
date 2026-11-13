import type { DbClient } from "@artoo/storage";

// Request contexts share the database client. Observers are process-local and
// only shorten a scan delay; durable state is always read again by the monitor.
const observers = new WeakMap<DbClient, Set<() => void>>();

export function observeGoalBudgetActivity(db: DbClient, wake: () => void): () => void {
  let listeners = observers.get(db);
  if (!listeners) { listeners = new Set(); observers.set(db, listeners); }
  listeners.add(wake);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    listeners.delete(wake);
    if (listeners.size === 0) observers.delete(db);
  };
}

/** Call only after a start/resume transaction has committed successfully. */
export function wakeGoalBudgetMonitors(db: DbClient): void {
  for (const wake of observers.get(db) ?? []) wake();
}
