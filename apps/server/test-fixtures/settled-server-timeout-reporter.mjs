import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export default class SettledFixtureReporter {
  onTestRunEnd(modules, errors, reason) {
    const cases = modules.flatMap(module => [...module.children.allTests()].map(test => ({
      name: test.name, state: test.result().state,
      errors: (test.result().errors ?? []).map(error => ({ name: error.name, message: error.message })),
    })));
    writeFileSync(join(process.env.ARTOO_SETTLED_FIXTURE_OUTPUT, 'run-end.json'), JSON.stringify({
      reason, modules: modules.length, cases, unhandledErrors: errors.map(error => ({ name: error.name, message: error.message })),
    }, null, 2) + '\n', { flag: 'wx' });
  }
}
