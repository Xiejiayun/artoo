import { describe, expect, it } from "vitest";
import { validateManagedJournalBinding, validateManagedJournalPreparation } from "./managed-bootstrap.js";

const profile = { version: 1, serverOrigin: "https://paired.example", nodeId: "node", controllerScope: "controller", directory: "C:\\Users\\operator\\Artoo\\journal" };
const connection = { url: "wss://paired.example/api/v1/node?token=private", nodeId: "node" };

describe("portable saved journal profile structure", () => {
  it("preserves exact local Windows path and scope without qualifying storage or execution", () => {
    expect(validateManagedJournalPreparation(profile)).toEqual(profile);
    const binding = { ...profile, expectedNamespace: "saved-namespace" };
    expect(validateManagedJournalBinding(binding, connection)).toEqual(binding);
    expect(() => validateManagedJournalBinding(binding, { ...connection, nodeId: "other" })).toThrow("origin or node ID");
    expect(() => validateManagedJournalBinding(binding, { ...connection, url: "wss://other.example/api/v1/node" })).toThrow("origin or node ID");
  });
  it.each(["C:\\", "C:relative", "C:/Artoo/journal", "C:\\Artoo\\..\\journal", "C:\\Artoo\\journal\\", "C:\\Artoo\\CON", "C:\\Artoo\\data:stream", "C:\\Artoo\\name.", "\\\\server\\share\\journal", "\\\\?\\C:\\journal", "/", "/tmp/../journal"])("rejects ambiguous or nonlocal directory %s", (directory) => {
    expect(() => validateManagedJournalPreparation({ ...profile, directory })).toThrow("canonical absolute local path");
  });
  it("preserves canonical POSIX profiles for the existing runtime boundary", () => {
    expect(validateManagedJournalPreparation({ ...profile, directory: "/Users/operator/Artoo/journal" }).directory).toBe("/Users/operator/Artoo/journal");
  });
});
