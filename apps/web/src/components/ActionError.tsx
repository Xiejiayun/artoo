/** Consistent mutation feedback; preserve server validation and conflict details. */
export function ActionError({ error }: { error: unknown }): React.ReactNode {
  if (error == null) return null;
  return <p role="alert" className="action-error">{error instanceof Error ? error.message : String(error)}</p>;
}
