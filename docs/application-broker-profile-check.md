# Windows broker profile inspection

`node apps/artood/dist/main.js --check-application-broker-profile` performs an
explicit, standalone local inspection before runtime adapters or a server
connection are constructed. It does not open SQLite, create a database, start a
broker, run generated code, or enable an application capability. The fixed Windows
ACL collectors do run to inspect the local installation and storage boundaries.

This command is a component preflight. Its successful output always contains
`qualified_for_product: false`. It does not qualify compiler provenance, the
source-to-artifact relationship, LPAC isolation, application execution, migration,
backup/recovery, a persistent service, or publication. A successful diagnostic is
not a process token or release authorization.

## Local selection

Set these settings through the same trusted local environment used for the node:

- `ARTOO_NODE_ID`: the declared node identity.
- `ARTOO_ALLOWED_ROOTS`: the complete declared local node write roots, separated
  by semicolons. Each must already be a canonical physical directory.
- `ARTOO_WINDOWS_PROCESS_BUNDLE` and `ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256`:
  the existing protected native Windows process installation and its manifest
  digest. The lifetime Supervisor capability is required.
- `ARTOO_APPLICATION_BROKER_PROFILE_FILE`: an absolute protected local JSON file.

The command accepts no configuration in argv or task text. It rejects additional
selectors, desktop IPC, managed-journal settings and worktree allocation settings.
It does not require `ARTOO_NODE_URL`. Setting the profile environment variable
alone does not select this operation or change ordinary node startup.

The roots are checked against the profile and original native installation. This
does not discover or prove every model's actual filesystem write scope. The
operator must supply the actual local node settings; remote declarations cannot
establish this authority. Existing ACL policy trusts the current node SID and
system principals. It is not isolation from generated code with the same ordinary
Windows token. The generated-application gate remains closed.

## Profile version 1

The JSON shape below is illustrative; replace the paths, sizes and digest strings
with the exact installed values. It cannot be used with placeholder digests.

```json
{
  "version": 1,
  "format": "artoo.application-broker-profile.v1",
  "node_id": "local-node",
  "writable_workspace_roots": ["C:\\Products\\workspace"],
  "node": { "path": "C:\\Artoo\\runtime\\node.exe", "bytes": 123, "sha256": "sha256:<64 lowercase hex characters>" },
  "entry": { "path": "C:\\Artoo\\broker\\application-broker.mjs", "bytes": 123, "sha256": "sha256:<64 lowercase hex characters>" },
  "configuration": { "path": "C:\\Artoo\\settings\\broker.json", "bytes": 123, "sha256": "sha256:<64 lowercase hex characters>" },
  "storage_directory": "C:\\Artoo\\application-data"
}
```

The configuration file follows the existing `artoo.application-broker.v1`
configuration schema. This check accepts only `mode: "open"` and
`maximumAccess: "read"`. It checks the schema declaration and complete declared
scope (`product_id`, `data_generation`, `service_generation`, `artifact_digest`).
The artifact digest is a protected local declaration, not compiler evidence.
Read access is a broker operation policy: the eventual broker implementation uses
a read/write SQLite handle, so this is not a filesystem read-only claim.

The database must already be a single-link physical file directly inside the
declared storage directory. Only its identity and metadata are inspected; this
command does not validate its SQLite structure, schema or persisted scope.
Installation/configuration directories must be separate from that mutable store
and outside all declared write roots. Use dedicated, already protected local
directories. The check never creates directories or changes existing ACLs.

Preparation uses the fixed Windows code and mutable-storage ACL policies,
canonical NTFS paths, exact bigint identities and bounded file reads. It compares
the profile and installed bytes twice, re-audits ACLs and checks the database
identity again before returning. It discards the low-level process preparation;
no usable process or storage authority is serialized.

## Result

A successful invocation prints one local JSON diagnostic with
`qualified_for_product: false`, `broker_started: false`, `database_opened: false`,
and the remaining compiler/source/artifact, LPAC and effective-write-scope gaps.
A failed check exits nonzero and prints no success diagnostic. Correct the local
installation or configuration rather than weakening a failed policy.

Controlled regression tests cover CLI separation and mutation/failure paths.
Any separately recorded NTFS test is component inspection evidence only; it is
not an actual provider run or product acceptance evidence.
