import { writeFileSync } from "node:fs";
import { join } from "node:path";
export default class EvidenceReporter {
  cases = [];
  onTestCaseResult(testCase) {
    const result = testCase.result();
    this.cases.push({ name: testCase.name, state: result.state,
      errors: (result.errors ?? []).map(error => ({ name: error.name, message: error.message, stack: error.stack })) });
  }
  onTestRunEnd(modules, unhandledErrors, reason) {
    writeFileSync(join(process.env.ARTOO_STORAGE_HARNESS_EVIDENCE, "run-end.json"), JSON.stringify({
      modules: modules.length, reason, cases: this.cases, unhandledErrors: unhandledErrors.map(error => ({ name: error.name, message: error.message, stack: error.stack })),
    }, null, 2) + "\n", { flag: "wx" });
  }
}
