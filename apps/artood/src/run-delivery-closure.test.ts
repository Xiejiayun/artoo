import { describe, expect, it, vi } from "vitest";
import { joinRunDeliveryClosure } from "./run-delivery-closure.js";

describe("original run delivery and closure join", () => {
  it("joins the original close even when delivery fails, preserving both exact failures", async () => {
    const delivery = new Error("event delivery failed"),
      closure = new Error("native closure remains uncertain"),
      order: string[] = [];
    const result = await joinRunDeliveryClosure(
      async () => {
        order.push("delivery");
        throw delivery;
      },
      async () => {
        await Promise.resolve();
        order.push("closure");
        throw closure;
      },
    ).catch((error) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect(result.errors).toEqual([delivery, closure]);
    expect(order).toEqual(["delivery", "closure"]);
  });
  it.each([undefined, null, false, new Error("original stream failure")])(
    "preserves a sole original failure, including %s",
    async (failure) => {
      const close = vi.fn(async () => {});
      const outcome = await joinRunDeliveryClosure(async () => {
        throw failure;
      }, close).then(
        () => ({ rejected: false }),
        (error) => ({ rejected: true, error }),
      );
      expect(outcome).toEqual({ rejected: true, error: failure });
      expect(close).toHaveBeenCalledTimes(1);
    },
  );
  it("does not report success until actual asynchronous closure completes", async () => {
    let resolve!: () => void;
    const closure = new Promise<void>((yes) => {
        resolve = yes;
      }),
      settled = vi.fn();
    const pending = joinRunDeliveryClosure(
      async () => {},
      () => closure,
    ).then(settled);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    resolve();
    await pending;
    expect(settled).toHaveBeenCalledTimes(1);
  });
  it("retains a sole native closure error after successful delivery", async () => {
    const closure = new Error("original owner remains open");
    await expect(
      joinRunDeliveryClosure(
        async () => {},
        async () => {
          throw closure;
        },
      ),
    ).rejects.toBe(closure);
  });
});
