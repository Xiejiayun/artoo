import { expect, it } from "vitest";
import { ProductSourceTransferUploadResponseV1Schema } from "./product-source-transfer.js";
import { adapterRunEventBodySchema, commandSchema } from "./node-messages.js";

it("only accepts a versioned transport receipt without leaking control credentials", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const response = { transfer: { version: 1, transfer_id: "transfer", request_digest: digest, capsule_digest: digest,
    status: "available", execution_authorized: false } };
  expect(ProductSourceTransferUploadResponseV1Schema.safeParse(response).success).toBe(true);
  expect(ProductSourceTransferUploadResponseV1Schema.safeParse({ ...response, control_token: "forbidden" }).success).toBe(false);
  expect(commandSchema.safeParse({ type: "product.source.transfer", ...response }).success).toBe(false);
  expect(adapterRunEventBodySchema.safeParse({ type: "product.source.transfer", payload: response }).success).toBe(false);
});
