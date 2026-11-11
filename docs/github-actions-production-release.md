# Web portal publication with GitHub Actions

The **Publish Web portal to Azure** workflow publishes the merged `main` commit
to the existing Singapore Container App. It does not create another VM,
database, registry or public IP. Production credentials are not used in PR jobs.

## Configure the production boundary once

Create the GitHub environment `production` with a deployment branch rule that
allows only `main`. Use a dedicated Entra application/service principal or
user-assigned managed identity with this federated credential:

```json
{
  "name": "artoo-github-production",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:Xiejiayun/artoo:environment:production",
  "audiences": ["api://AzureADTokenExchange"]
}
```

Grant **Container Apps Contributor** only on the `artoo` Container App and
**AcrPush** only on the existing `jiaxie` registry. The deployment identity must
read the app's stored secrets to back up its external database and objects.
It does not need subscription Contributor/Owner, role-assignment permissions,
or access to `canvas`, the VPN VM or its networking. The existing app identity
continues to pull images; this workflow does not modify that identity.

`Container Apps Contributor` includes `containerApps/*/action`, including secret
listing. Assign it at the app resource, not the resource group. The workflow does
not change the workload profile; the reviewed CLI image-update path therefore
does not read the sibling managed environment. Start with these two scoped
assignments. If a future CLI/API version reports a specific linked-resource
authorization error, review that exact action before granting another role.

Add these **environment variables** in GitHub:

| Variable | Existing production value |
| --- | --- |
| `AZURE_CLIENT_ID` | The new dedicated deployment identity's client ID |
| `AZURE_TENANT_ID` | `f96ee2a9-58b9-488e-9f4c-795a42231294` |
| `AZURE_SUBSCRIPTION_ID` | `a79d7fcd-8b10-426b-82e2-6a1655a9096e` |
| `AZURE_RESOURCE_GROUP` | `jiaxie_group` |
| `AZURE_CONTAINER_APP` | `artoo` |
| `AZURE_CONTAINER_REGISTRY` | `jiaxie` |
| `AZURE_REGISTRY_HOST` | `jiaxie-gub0emb9hub9e4f5.azurecr.io` |
| `ARTOO_ORIGIN` | `https://artoo.jeremyxie.com` |

Generate a cryptographically random 32-byte key and store its base64 encoding
in the environment **secret** `ARTOO_BACKUP_KEY`. Retain another protected copy
outside GitHub and outside the Supabase project. Do not print it in workflow
output or put it in a shell command argument. Losing it makes the encrypted
backups unusable. Azure OIDC uses no persistent client secret. Database,
Storage, Google and pairing secrets remain on the existing Container App;
the workflow reads them in memory and into a runner-private directory only.

## Release a reviewed version

1. Complete the repository checks, review and merge the change to `main`.
   Wait for **Preview gates / shared** and **Azure deployment validation /
   postgres + image** on that exact main SHA. The shared aggregate verifies
   the complete test partitions; optional Apple job outcomes are retained but
   are not substituted for the Web release gates.
2. Drain active runs, assistant turns and autonomous goals. The workflow refuses
   to interrupt them. Announce/accept a brief maintenance window; min=max=1 and
   the database's single-writer lock intentionally preclude rolling overlap.
3. Dispatch `.github/workflows/azure-release.yml` on `main` with the full
   `source_sha` and `maintenance_confirmed=true`. The source must still be the
   current main commit both before and after the image build.
4. The workflow builds a unique ACR image from that SHA, resolves its immutable
   digest, and records the public build identity at `/artoo-release.json`.
   It preserves the app's domains, secrets, volumes, resource limits and
   registry identity while updating the image.
5. Before any new migration, it moves to Multiple revision mode, stops the old
   revision, waits for all replicas and database ownership to drain, and holds
   the advisory lock while backing up. It exports `public` and `artoo_meta`,
   all private bucket objects, and the previous configuration/secrets. A fresh
   PostgreSQL 17 container with no network or host ports performs an actual
   restore rehearsal; the restored migration journal must match. Preparation
   checks the source PostgreSQL major version and pins both dump and restore to
   the same resolved tool-image digest, recorded with the source server version.
6. The backup is encrypted with AES-256-GCM, then decrypted in a verification
   stream to check exact plaintext bytes. Only the encrypted archive and safe
   envelope are uploaded as `production-backup-<run>-<attempt>` for 30 days.
   The workflow requires a confirmed artifact ID before starting the new image.
   Download important recovery points into independent durable backup storage
   before Actions retention expires.
7. The new revision must serve HTTPS liveness/readiness, Web HTML, reject
   unauthenticated API calls, and expose the exact source SHA. Exactly one
   healthy revision must remain before restoring Single revision mode.
   `production-release-<run>-<attempt>` records these checks and their source.

These public checks are not complete product acceptance. After publication,
verify a real Google sign-in, a paired computer reconnect, existing-Agent
instance creation, a small authorized task and an application artifact round
trip. Record the deployment URL, image digest, revision and Actions run link.
Do not call a mock task or a successful image build a production acceptance run.

## Failure and recovery

If preparation or publication fails, the recovery step stops candidate
revisions and obtains the database lock. It restores the previous image in a
fresh revision **only if the complete ordered migration journal is unchanged**.
The original deployment stays failed even if this recovery succeeds.

If a new migration completed, automatic image rollback is refused and all
revisions remain stopped. Use a validated forward fix or a separately approved
restore into a separate empty database/bucket. Never point an older image at
the newer schema or restore over production without a reviewed recovery plan.
A cancelled/timed-out runner can leave maintenance active: inspect revision
activity and the database lock before resuming; never terminate an unknown
database session to force deployment.

The encrypted artifact contains `database.dump`, `configuration.json` and
`objects.json` plus numbered object files. `configuration.json` contains
production secrets. To recover locally, use a private directory, put the
retained key in the process environment without printing it, and run:

```text
node scripts/azure-release/decrypt-backup.mjs <downloaded-artifact-directory> <new-private-path>/backup.tar.gz
```

The helper verifies ciphertext and authenticated plaintext checksums and will
not overwrite an existing destination. Extract only into a new private
directory. Restore the database with PostgreSQL 17 clients, restore each object
under its original key from `objects.json`, apply the private-schema access
prerequisite, and verify login, ownership, artifacts and a paired node against
the recovered environment before switching production. The workflow's isolated
database rehearsal does not prove a full Supabase/Google disaster recovery.

## Publish the computer installer before presenting it in Web

1. Run **Build and verify cross-platform npm daemon** on the exact current main
   SHA for `0.1.0-rc.3`. Require the build, all three Windows/Linux package jobs
   and their aggregate. Each package job performs a real loopback pairing and
   enrollment, managed start/status/stop/restart, workspace-root advertisement
   and identity reuse after the disposable installation is removed. No model is
   invoked by the connection fixture. Optional Mac jobs remain separate evidence.
2. Dispatch `.github/workflows/daemon-github-release.yml` on that same `main`
   with `source_sha`, the matrix `candidate_run_id` and `version=0.1.0-rc.3`.
   The workflow checks actual attempt-specific jobs, exact package hashes/size,
   source and platform receipts, and refuses an existing version tag. It renders
   both installers with the package version, SHA-256 and length before uploading
   all assets to a draft and making the complete release public.
3. Confirm `artood-v0.1.0-rc.3` exposes `install.ps1`, `install.sh`, the exact tgz
   and verification receipts before the matching Web publication. The command
   supplied by Web contains only the server and short-lived pairing code.
4. npm publication is separate: follow
   [staged publishing](../scripts/npm-daemon/STAGED-PUBLISHING.md), then run the
   registry verification workflow. GitHub installer availability alone does not
   establish that the package is published or freshly installable from npm.
