/** Always join the original owner's closure. A second failure must preserve
 * the delivery failure instead of replacing it through a throwing finally. */
export async function joinRunDeliveryClosure(deliver: () => Promise<void>, close: () => Promise<void>): Promise<void> {
  let deliveryFailed = false;
  let deliveryFailure: unknown;
  try {
    await deliver();
  } catch (error) {
    deliveryFailed = true;
    deliveryFailure = error;
  }
  try {
    await close();
  } catch (closureFailure) {
    if (deliveryFailed)
      throw new AggregateError(
        [deliveryFailure, closureFailure],
        "Run delivery and original owner closure both failed",
      );
    throw closureFailure;
  }
  if (deliveryFailed) throw deliveryFailure;
}
