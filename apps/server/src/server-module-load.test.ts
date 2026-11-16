import { describe, expect, it, vi } from "vitest";
import { startServer } from "./main.js";

const controlled = vi.hoisted(() => {
  let entered!: () => void;
  return {
    createDatabase: vi.fn(),
    applicationFailure: new Error("Controlled application module failure"),
    applicationEntered: new Promise<void>((resolve) => {
      entered = resolve;
    }),
    entered: () => entered(),
  };
});

// Failure-only resource lifecycle test. No real database, process or Provider.
vi.mock("@artoo/storage", () => ({
  PgliteDbClient: { create: controlled.createDatabase },
  PostgresDbClient: { create: controlled.createDatabase },
  SupabaseContentAddressedBlobStore: { create: vi.fn() },
}));
vi.mock("./app.js", () => {
  controlled.entered();
  throw controlled.applicationFailure;
});

const env = { ARTOO_PORT: "0", ARTOO_PAIRING_PEPPER: "module-load-fixture-pepper" };

describe("server module loading failure cleanup", () => {
  it("joins a pending database creation and closes it after application loading fails", async () => {
    let opened!: (database: { close: () => Promise<void> }) => void;
    controlled.createDatabase.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          opened = resolve;
        }),
    );
    let settled = false;
    const startup = startServer(env).then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await controlled.applicationEntered;
    expect(controlled.createDatabase).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    const close = vi.fn().mockResolvedValue(undefined);
    opened({ close });
    const error = await startup;
    expect(error === controlled.applicationFailure || (error as Error)?.cause === controlled.applicationFailure).toBe(
      true,
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("retains both errors when database creation and application loading fail", async () => {
    const databaseFailure = new Error("Controlled database creation failure");
    controlled.createDatabase.mockRejectedValueOnce(databaseFailure);
    const error = await startServer(env).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).cause).toBe(databaseFailure);
    const failures = (error as AggregateError).errors;
    expect(failures).toHaveLength(2);
    expect(failures[0]).toBe(databaseFailure);
    expect(failures[1] === controlled.applicationFailure || failures[1]?.cause === controlled.applicationFailure).toBe(
      true,
    );
  });

  it("still rejects invalid access before trying to create a database", async () => {
    const calls = controlled.createDatabase.mock.calls.length;
    await expect(startServer({ ...env, ARTOO_PAIRING_PEPPER: "" })).rejects.toThrow("ARTOO_PAIRING_PEPPER");
    expect(controlled.createDatabase).toHaveBeenCalledTimes(calls);
  });

  it("retains the application failure when database cleanup also fails", async () => {
    const cleanupFailure = new Error("Controlled database close failure");
    const close = vi.fn().mockRejectedValue(cleanupFailure);
    controlled.createDatabase.mockResolvedValueOnce({ close });
    const error = await startServer(env).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(AggregateError);
    const failures = (error as AggregateError).errors;
    expect(failures).toHaveLength(2);
    expect((error as AggregateError).cause).toBe(failures[0]);
    expect(failures[0] === controlled.applicationFailure || failures[0]?.cause === controlled.applicationFailure).toBe(
      true,
    );
    expect(failures[1]).toBe(cleanupFailure);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
