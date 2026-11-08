"use strict";
// The original Node resolver exists only inside this closure. No resolve property or
// resolver alias is exposed to bundle code, including TypeScript's dormant sys.require.
require = ((loadBuiltin) => Object.freeze(function builtinOnly(specifier) {
  switch (specifier) {
    case "fs": case "node:fs": return loadBuiltin("node:fs");
    case "path": case "node:path": return loadBuiltin("node:path");
    case "os": case "node:os": return loadBuiltin("node:os");
    case "crypto": case "node:crypto": return loadBuiltin("node:crypto");
    case "perf_hooks": case "node:perf_hooks": return loadBuiltin("node:perf_hooks");
    case "util": case "node:util": return loadBuiltin("node:util");
    default: throw Error("application_compiler_runtime_dependency_denied");
  }
}))(require);
