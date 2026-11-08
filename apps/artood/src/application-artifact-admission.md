# Immutable application content capture

`createApplicationArtifactOwner(expected)` belongs to trusted local host code. Its
expectation contains version 1 and three complete pin sets: `source`, `artifacts`
and `toolchain`. Each set contains `files: [{path, bytes, sha256}]` and a `digest`.
The digest uses the existing kernel convention: sort by logical path, serialize
objects in exactly `path`, `bytes`, `sha256` order with JSON.stringify, then hash
the UTF-8 bytes with SHA-256. All digests have the `sha256:` prefix. The owner copies
the expected pins immediately; later caller mutations do not select a new version.

Expected pins must come from the trusted caller's independent selection and build
validation. A compiler/model manifest is data and cannot establish that authority.
This component does not recompile code, prove that TypeScript produced particular
JavaScript, validate compiler provenance, or authenticate a physical installation.
It verifies the complete **declared** toolchain set, not whether that declaration
actually covers every future runtime dependency. Toolchain paths are explicit
portable logical IDs, never paths to read, discover or execute on the host.

`owner.capture({source, artifacts, toolchain})` accepts complete arrays of
`{path, bytes: Uint8Array}`. It checks every count, intrinsic view length and total
before copying or hashing payloads. SharedArrayBuffer, resizable and detached backing,
fake views and accessor metadata reject. Own properties cannot conceal the real
TypedArray buffer/offset/length. Capture is synchronous and never yields. Private
copies are checked against every expected pin and complete digest, and the original
views are rechecked before a handle is returned. Source/artifacts must decode as
strict UTF-8 and re-encode to the exact admitted bytes, including any BOM.

Source limits remain 256 files, 128 KiB per file and 8 MiB total; artifacts remain
256 files and 16 MiB total. Toolchain capture is bounded to 1,024 files and 256 MiB.
These are per-capture byte bounds, not host RSS ceilings: text decoding, copying,
hashing, returned toolchain copies and multiple retained captures require additional memory. The future owner
must limit capture count, concurrency and lifetime. It must separately establish
protected filesystem identities/ACLs and qualified execution resources.

Capture paths must be canonical, portable, unique and free of case collisions.
Source and artifact paths must have the kernel's complete one-to-one output
footprint; copied HTML/CSS must retain identical bytes. This footprint check does
not prove compilation causality for TypeScript outputs. The opaque returned token
works only with the original owner. Copied, serialized, foreign and revoked tokens
reject. No internal byte array is returned; `revoke` removes content access and is
not a process-stop, memory-reclamation or storage-deletion receipt.

The trusted fixed loader uses `owner.readToolchain(captured, logicalId)` to consume
the measured toolchain bytes. It returns a fresh Uint8Array from the private snapshot,
with no filesystem reread. IDs must match exact captured members; no aliases or case
normalization are accepted. Mutating a returned copy cannot change later reads.
Keep this API and its fixed logical selections off the guest/task surface. Returning
bytes does not authorize dynamic host evaluation, imports or product execution.

`owner.clientReader(captured)` creates a separate opaque reader of the original
capture's `client/` files. `readApplicationClientArtifact(reader, canonical)`
returns a fresh byte copy for an exact admitted client path, or `undefined` when
that client member is absent. It cannot read server, toolchain or filesystem
paths. `revokeApplicationClientReader(reader)` revokes only that reader; revoking
the parent capture also invalidates all its readers. The same-origin listener
owns and revokes its reader. This adds content access only, with no broker,
process, build-provenance or publication authority.

The future isolated loader connects through:

```ts
runtime.setModuleLoader(
  name => owner.load(captured, name),
  (base, request) => owner.resolve(captured, base, request),
);
// After separate native/profile admission, the guest owner loads the fixed entry
// under the exact filename owner.entry(captured): "server/handler.js".
```

The importer must already be an exact member of the private server map. Relative
`.js` requests use the compiler's exact `/__source/product/` virtual prefix and
POSIX final normalization. This preserves existing `././`, repeated separators
and relative traversal that ultimately returns to a captured server member. Import
requests have the source-file 128 KiB ceiling; the 512-character canonical path
ceiling is not incorrectly imposed on their spelling. Node/bare packages, URLs,
absolute/UNC/drive/backslash paths, percent encoding, client modules, case variants
and absent final targets reject. Loader names themselves must be exact canonical
server members. No filesystem/module/package/network fallback exists.

This increment does not instantiate QuickJS, import packages or evaluate product
code. The already reviewed compiler parity fixture evaluated only fixed compiler
globals; it supplies no product ESM, namespace, top-level-await or job-pump evidence.
The actual QuickJS callbacks decode guest strings before reaching these functions,
so this component does not supply FFI preallocation guards or sanitize upstream
callback logging. Isolated loader/import admission, runtime guest embedding, native
resource/closure ownership, broker process enrollment, HTTP and release remain
separate work. New tests are unexecuted content fixtures, not native/product qualification.
