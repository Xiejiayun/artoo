# Native Windows source and continuation nodes

This entrypoint uses native Windows and ordinary reserved workspaces. It does not use WSL or a managed execution journal. Each computer needs its own paired node identity, qualified Windows process helper, locally installed agent runtime, protected verifier/release configuration, and allowed write roots. Initial machine provisioning remains an administrator task.

Select a dedicated protected JSON file with `ARTOO_PRODUCT_SOURCE_CONFIG_FILE`. Keep its directory, source store, Git executable, verifier assets and research receipts outside every agent write root. The node validates the configuration directory using the existing Windows storage ACL qualification; it does not grant permissions or weaken ACLs. Use canonical absolute Windows paths. The standard entrypoint enables committed run-event receipts.

Startup and source capability publication re-audit this protected directory's ACLs. During a live session the node rechecks the fixed file identity and complete bytes. NTFS first-read access metadata may change, but a second complete read must keep its metadata and bytes stable; content or path changes reject admission.

The file has these fields:

| Field | Meaning |
| --- | --- |
| `version` | Must be `1`. |
| `storeRoot` | Existing protected local source journal and capsule directory. |
| `gitExecutable` | Existing protected native Git executable. |
| `sourceResearch` | Optional boolean. When true, reuses the author's existing `ARTOO_RESEARCH_ENABLED=1` and receipt-directory configuration. |
| `destinationResearchMappings` | Optional policy-v1 destination mappings with `sourceProfileDigest`, `destinationProfileId` and complete `commandPairs`. |
| `measurementV2` | Optional `{ version: 1, releaseProfileIds, destinationResearchMappings }`. IDs select original prepared local release profiles. Each mapping also contains the exact source `ReleaseCapabilitiesV1` as `sourceRelease`. |
| `operations` | Optional `{ version: 1, importedReview, importedDesign }`. Enables actual source-operation, imported-review and imported-design controllers. |

A source computer configured for policy-v2 research export can use this shape, replacing the paths and release-profile ID with its installed configuration:

```json
{
  "version": 1,
  "storeRoot": "C:\\ArtooNode\\source-store",
  "gitExecutable": "C:\\Program Files\\Git\\bin\\git.exe",
  "sourceResearch": true,
  "measurementV2": {
    "version": 1,
    "releaseProfileIds": ["product-static-site"]
  },
  "operations": { "version": 1 }
}
```

A destination computer may omit `sourceResearch`. Configure its complete source-to-destination measurement mapping using the source computer's actual prepared capability contract and its own local profile IDs. For policy-v2, each `sourceRelease` must match the source contract, source verifier digest, project and destination's prepared release contract. JSON contains selections and contracts; it cannot create a release reader or a prepared verification authority.

To enable imported design, set both `operations.importedReview` and `operations.importedDesign` to true, configure a policy-v2 destination mapping, and install a native Windows v3 browser Job verifier for every selected destination. Missing profiles, incomplete mappings, unsupported checks or uncommitted event delivery reject startup before hello. H3 ends after the imported design writer's verified result; it does not enable a later design-review or publication continuation.

The semantic-transfer client reuses the exact paired `ARTOO_NODE_URL`. It requires `/api/v1/node`, exactly one device token, no other query parameters, no user-info or fragment, and WSS except for loopback WS. There is no separate task-supplied URL or token setting. Tokens are kept out of hello and source runtime configuration.

Without this file, source transfer and continuation features are removed from caller-supplied hello metadata. With it, discovery is derived from the original prepared runtime and actual constructed controllers. Destination-only nodes can advertise semantic and policy-v2 roles without a research receipt store.

Source continuation authority belongs to one live connection. A disconnect ends that session, aborts its controllers, and reports node failure; this node does not reconnect automatically. After controllers settle, the source owner closes only if the runtime confirms no live or uncertain writer. Durable workspace claims and operation history remain. Do not delete lock or claim files to resume work: restarting cannot reconstruct accepted review authority from disk. Ordinary nodes without source configuration retain their existing reconnect behavior.

These entrypoint checks do not establish a live-provider, multi-computer or publication acceptance run. Follow the Agent Team guide for the current complete product-development acceptance scope.
