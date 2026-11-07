import { z } from "zod";
import { ProductSourceTransferReceiptV1Schema } from "@artoo/domain";

/** Dedicated paired-node HTTP response; deliberately absent from run.start/adapter output. */
export const ProductSourceTransferUploadResponseV1Schema = z.object({
  transfer: ProductSourceTransferReceiptV1Schema,
}).strict();
export const PRODUCT_SOURCE_TRANSFER_CONTENT_ROUTE_V1 = "/api/v1/node/product-source-transfers/:id/content";
export const PRODUCT_SOURCE_TRANSFER_REQUEST_HEADER_V1 = "x-artoo-transfer-request-digest";
export const PRODUCT_SOURCE_TRANSFER_CHECKSUM_HEADER_V1 = "x-artoo-checksum";
