import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.length !== 4 || process.argv[2] !== '--out-dir') throw Error('Usage: build-application-broker.mjs --out-dir <new directory>');
const directory = resolve(process.argv[3]);
await mkdir(directory); // Exclusive fresh output: never overwrite installed/previous evidence.
const result = await build({ entryPoints: [fileURLToPath(new URL('../src/application-broker-entry.ts', import.meta.url))],
  bundle: true, platform: 'node', target: 'node24', format: 'esm', write: false, metafile: true,
  outfile: join(directory, 'application-broker.mjs'), logLevel: 'silent' });
if (result.outputFiles.length !== 1 || Object.values(result.metafile.outputs).some(output =>
  output.imports.some(imported => !imported.external || !imported.path.startsWith('node:')))) throw Error('Broker bundle contains a runtime file dependency');
const output = result.outputFiles[0];
await writeFile(output.path, output.contents, { flag: 'wx' });
const pin = { path: output.path, bytes: output.contents.length,
  sha256: 'sha256:' + createHash('sha256').update(output.contents).digest('hex') };
await writeFile(join(directory, 'build.json'), JSON.stringify({ version: 1, protocol: 'artoo.application-broker-build.v1',
  entry: pin, metafile: result.metafile }, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify(pin) + '\n');
