import { expect, it } from "vitest";
import { SchedulerQueueMetadataV1Schema } from "./scheduler-queue-metadata.js";

const plain = { version: 1, not_before_ms: 0, preferred_computer_id: null, prefer_until_ms: null };

it("keeps explicit version 1 timing and paired affinity without inventing authorization", () => {
  expect(SchedulerQueueMetadataV1Schema.parse(plain)).toEqual(plain);
  const affinity = { ...plain, not_before_ms: 1000, preferred_computer_id: "computer", prefer_until_ms: 2000 };
  expect(SchedulerQueueMetadataV1Schema.parse(affinity)).toEqual(affinity);
  expect(SchedulerQueueMetadataV1Schema.parse({ ...plain, not_before_ms: 8_640_000_000_000_000 })).toBeDefined();
});

it("rejects unsafe times, incomplete affinity, unsupported versions and extra authority", () => {
  for (const extra of [
    { version: 2 },
    { not_before_ms: -1 },
    { not_before_ms: 0.1 },
    { not_before_ms: "1" },
    { not_before_ms: 8_640_000_000_000_001 },
    { not_before_ms: Number.MAX_SAFE_INTEGER + 1 },
    { preferred_computer_id: "computer" },
    { prefer_until_ms: 2000 },
    { preferred_computer_id: "", prefer_until_ms: 2000 },
    { preferred_computer_id: "computer", prefer_until_ms: -1 },
    { execution_authorized: true },
    { organization_id: "other" },
    { epoch: 1 },
  ])
    expect(SchedulerQueueMetadataV1Schema.safeParse({ ...plain, ...extra }).success).toBe(false);
});
