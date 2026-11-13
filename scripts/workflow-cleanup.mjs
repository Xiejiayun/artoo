/** Always await owned cleanup, retaining both failures when a workflow also fails. */
export async function withWorkflowCleanup(workflow, cleanup) {
  let value;
  let failed = false;
  let workflowError;
  try {
    value = await workflow();
  } catch (error) {
    failed = true;
    workflowError = error;
  }
  try {
    await cleanup();
  } catch (cleanupError) {
    if (failed) {
      // Keep the top-level message independent of a case's expected failure text.
      throw new AggregateError([workflowError, cleanupError], "UI workflow cleanup failed", { cause: workflowError });
    }
    throw cleanupError;
  }
  if (failed) throw workflowError;
  return value;
}
