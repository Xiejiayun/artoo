import { configDefaults } from "vitest/config";
import base from "./vitest.config.ts";
import { windowsProcessFiles } from "./scripts/ci-vitest-coverage.mjs";

const partition = process.env.ARTOO_CI_TEST_PARTITION;
if (partition !== "parallel" && partition !== "windows-process") {
  throw new Error("ARTOO_CI_TEST_PARTITION must be parallel or windows-process");
}

// Keep the default local inventory intact. CI moves entire files, including
// their controlled cases, without changing any case's timeout or platform gate.
export default {
  ...base,
  test: {
    ...base.test,
    include: partition === "windows-process" ? windowsProcessFiles : base.test.include,
    exclude: [
      ...(base.test.exclude ?? configDefaults.exclude),
      ...(partition === "parallel" ? windowsProcessFiles : []),
    ],
  },
};
