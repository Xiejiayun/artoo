import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDaemon } from "../../apps/desktop/scripts/bundle-daemon.mjs";
import { verifyPackage } from "./verify.mjs";
import { SUPPORTED_PLATFORMS } from "./platforms.mjs";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(sourceDirectory, "../..");
const namePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseBuildArguments(args) {
  const names = { "--name": "name", "--version": "version", "--output-directory": "outputDirectory",
    "--repo-root": "repoRoot", "--windows-process-bundle": "directory", "--windows-process-manifest-sha256": "manifestSha256" };
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = names[args[index]], value = args[index + 1];
    if (!key || Object.hasOwn(values, key) || !value || value.startsWith("--")) throw Error("Invalid or duplicate npm daemon build argument.");
    values[key] = value;
  }
  if (!namePattern.test(values.name ?? "") || values.name.length > 214 || !versionPattern.test(values.version ?? ""))
    throw Error("An explicit valid npm --name and --version are required.");
  if (!values.outputDirectory || !isAbsolute(values.outputDirectory)) throw Error("--output-directory must be a new absolute directory.");
  if (!values.directory || !isAbsolute(values.directory) || !/^sha256:[a-f0-9]{64}$/.test(values.manifestSha256 ?? ""))
    throw Error("Supply the freshly built Windows native host directory and pinned manifest SHA-256.");
  return { name: values.name, version: values.version, outputDirectory: values.outputDirectory, repoRoot: values.repoRoot ?? defaultRoot,
    windowsProcessBundle: { directory: values.directory, manifestSha256: values.manifestSha256 } };
}

export async function buildNpmDaemon({ name, version, outputDirectory, repoRoot = defaultRoot, windowsProcessBundle }) {
  // Apply the same validation to programmatic calls as the release command.
  parseBuildArguments(["--name", name, "--version", version, "--output-directory", outputDirectory,
    "--windows-process-bundle", windowsProcessBundle?.directory, "--windows-process-manifest-sha256", windowsProcessBundle?.manifestSha256]);
  outputDirectory = resolve(outputDirectory);
  if (existsSync(outputDirectory)) throw Error("npm daemon output already exists; choose a fresh release directory.");
  mkdirSync(outputDirectory, { recursive: false });
  const result = await buildDaemon({ repoRoot, outputDirectory: join(outputDirectory, "runtime"), windowsProcessBundle });
  mkdirSync(join(outputDirectory, "bin"));
  for (const [source, target] of [["cli.mjs", "artood.mjs"], ["verify.mjs", "verify.mjs"], ["platforms.mjs", "platforms.mjs"],
    ["local-config.mjs", "local-config.mjs"], ["managed.mjs", "managed.mjs"], ["onboarding.mjs", "onboarding.mjs"], ["team-config.mjs", "team-config.mjs"]])
    copyFileSync(join(sourceDirectory, source), join(outputDirectory, "bin", target));
  copyFileSync(join(repoRoot, "LICENSE"), join(outputDirectory, "LICENSE"));
  const metadata = { name, version, description: "Connect Windows, macOS and Linux computers to the Artoo agent platform", license: "MIT", type: "module",
    bin: { artood: "bin/artood.mjs" }, files: ["bin/", "runtime/", "README.md", "LICENSE"],
    engines: { node: ">=24.0.0" }, os: ["win32", "darwin", "linux"], cpu: ["x64", "arm64"],
    repository: { type: "git", url: "git+https://github.com/Xiejiayun/artoo.git" },
    homepage: "https://github.com/Xiejiayun/artoo", bugs: { url: "https://github.com/Xiejiayun/artoo/issues" },
    publishConfig: { access: "public", registry: "https://registry.npmjs.org/" },
    artoo: { format: "artoo.npm-daemon.v1", runtimeManifestSha256: result.manifestSha256, platforms: [...SUPPORTED_PLATFORMS] } };
  writeFileSync(join(outputDirectory, "package.json"), `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx" });
  writeFileSync(join(outputDirectory, "README.md"), readFileSync(join(sourceDirectory, "README.md"), "utf8")
    .replaceAll("{{PACKAGE_NAME}}", name).replaceAll("{{PACKAGE_VERSION}}", version), { flag: "wx" });
  const verification = await verifyPackage(outputDirectory);
  return { outputDirectory, ...verification };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => buildNpmDaemon(parseBuildArguments(process.argv.slice(2))))
    .then(value => console.log(JSON.stringify(value)), error => { console.error(error.message); process.exitCode = 1; });
}
