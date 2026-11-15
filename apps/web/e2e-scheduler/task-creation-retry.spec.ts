import { test } from "@playwright/test";
import { verifyLostTaskCreationResponse } from "../e2e/task-creation-retry.js";

test("an unchanged delegated creation retry recovers one child and one tree slot after response loss", async ({
  page,
  request,
}, testInfo) => {
  await verifyLostTaskCreationResponse(page, request, testInfo, true);
});
