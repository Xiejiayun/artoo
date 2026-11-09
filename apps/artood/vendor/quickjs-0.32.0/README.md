# Fixed QuickJS distribution inputs

This directory retains the exact 0.32.0 synchronous WebAssembly distribution used
by the application runtime work. It contains only the eight selected ESM modules,
one Wasm binary, and the original three package metadata and MIT license files.
It is a partial distribution for the fixed Artoo loader, not a general npm install.
The umbrella package, asyncify/debug variants, CommonJS entry points and source
maps are not part of this selection. No application capability is enabled here.

`manifest.json` binds each file's original URL, byte length, SHA-256 and per-file
SRI. The copied bytes were independently checked against the retained UNPKG
metadata. The official npm registry requests failed a TLS handshake using both
PowerShell and Node with ordinary certificate verification. No TLS check was
disabled. These files have CDN content-integrity evidence; they do not have a
verified npm tarball integrity record, publisher attestation or reproducible-build
claim. Original license text and package bytes remain unchanged.

The fixed loading closure is:

- `core/dist/index.mjs`, its two named chunks and `module-ES6BEMUI.mjs`;
- `ffi-types/dist/index.mjs`, selected only by the fixed FFI package alias;
- `release-sync/dist/index.mjs`, `ffi.mjs`, `emscripten-module.mjs` and
  `emscripten-module.wasm`.

The loader must pin this complete set and resolve only those exact files. It must
provide the actual captured Wasm bytes and guarded imports before instantiation,
including the binary's start function. The original Emscripten defaults have
host output, environment, clock, module-loader and callback paths; these bytes
alone are not an application sandbox. Generated code may execute only inside the
separately admitted QuickJS guest. It must never become Node imports or callbacks.

The development compiler diagnostic previously exercised these same distribution
bytes, but did not exercise generated application modules or hostile inputs. The
new ESM session and import-boundary components, actual process ownership, resource
limits, broker integration and product acceptance require their own validation.
`qualified_for_product` therefore remains false. The existing Windows LPAC gate
remains independently closed; this distribution is not an LPAC fallback.

The local attributes preserve original distribution bytes. The local ignore rules
include only this deliberately retained `dist` selection despite the repository's
general generated-output ignore rule. Adding or updating a member requires a new
reviewed complete manifest and corresponding loader and qualification checks.
