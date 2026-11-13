import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
if (args.length > 1 || (args[0] !== undefined && (!args[0].startsWith("--since=") || args[0].length === 8))) {
  throw new Error("Usage: npm run check:changed -- [--since=<base-ref>]");
}
const base = args[0]?.slice(8) ?? "main";
// Biome 2.6.6 may report zero files with exit 0 for an unknown ref. Resolve it
// first so a shallow checkout or misspelling cannot turn the gate into a no-op.
const verified = spawnSync("git", ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`], {
  encoding: "utf8",
});
if (verified.error || verified.status !== 0 || !/^[a-f0-9]{40,64}\s*$/i.test(verified.stdout ?? "")) {
  console.error(`Cannot resolve code quality base: ${base}`);
  process.exitCode = 1;
} else {
  const require = createRequire(import.meta.url);
  const result = spawnSync(
    process.execPath,
    [
      require.resolve("@biomejs/biome/bin/biome"),
      "check",
      "--changed",
      `--since=${verified.stdout.trim()}`,
      "--error-on-warnings",
      "--no-errors-on-unmatched",
    ],
    { stdio: "inherit" },
  );
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}
