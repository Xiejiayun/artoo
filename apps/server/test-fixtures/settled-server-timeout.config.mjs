import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('.', import.meta.url));
const output = process.env.ARTOO_SETTLED_FIXTURE_OUTPUT;
if (!output) throw new Error('Run the parent harness');
export default {
  root,
  cacheDir: join(output, 'cache'),
  test: {
    include: ['settled-server-timeout-child.ts'],
    pool: 'threads', maxWorkers: 1, environment: 'node', globals: false,
    testTimeout: 30000, hookTimeout: 30000,
    reporters: ['json', fileURLToPath(new URL('./settled-server-timeout-reporter.mjs', import.meta.url))],
    outputFile: { json: join(output, 'vitest-report.json') },
    attachmentsDir: join(output, 'attachments'),
  },
};
