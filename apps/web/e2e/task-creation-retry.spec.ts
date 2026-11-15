import { test } from "@playwright/test";
import { verifyLostTaskCreationResponse } from "./task-creation-retry.js";

test("an unchanged ordinary creation retry recovers its original committed task after response loss", async ({
  page,
  request,
}, testInfo) => {
  await verifyLostTaskCreationResponse(page, request, testInfo, false);
});
