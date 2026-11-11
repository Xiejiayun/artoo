# Azure Container Apps + Supabase

This deployment runs the browser UI, HTTP API and WebSocket control plane in one
Linux container. Execution remains on paired `artood` computers. Use a dedicated
Supabase project for PostgreSQL and a private Storage bucket for artifacts and
source capsules. Container-local disk is not a backup or durable workspace.

## Runtime and persistence

- Start with Consumption, **0.25 vCPU / 0.5 GiB**, **min 1 / max 1** replicas in
  Southeast Asia (Singapore). Confirm memory and response latency under your
  actual workload before relying on that size. The application cannot scale
  horizontally or normally scale to zero: schedulers and node sockets are local
  to the owning server process.
- PostgreSQL uses one persistent session, including complete transactions and a
  database advisory lock. A second server fails startup. Connection loss fences
  every query and closes the server; restart acquires a new lock. There is no
  automatic transaction retry or failover inside the old process.
- The production image refuses to start without remote database and blob
  configuration. Ordinary local development and existing PGlite deployments keep
  their current defaults. `ARTOO_DATABASE_URL` and `ARTOO_DB_DIR` are mutually
  exclusive.
- Use a **Session pooler URL on port 5432** from Supabase's Connect dialog for an
  IPv4 Azure deployment. Port 6543 (transaction pooling) is rejected. TLS verifies
  the certificate and hostname. If needed, mount the Supabase CA PEM and set
  `ARTOO_DATABASE_CA_FILE` to its container path; never disable TLS verification.
- Remote event publication polls every 1 second instead of the local 200 ms
  default. `ARTOO_EVENT_POLL_MS` can configure 200–60000 ms. Budget enforcement and
  job scheduling retain their existing timing.
- Blob reads are bounded by the recorded size and verify SHA-256. The existing
  limits remain 10 MiB for normal artifacts and 12 MiB for source capsules.
  Requests time out; credentials and provider response bodies are not logged.

## Supabase prerequisites

1. Use a **dedicated, initially empty** project. The migration journal refuses an
   untracked existing application schema. It does not import an old PGlite DB.
2. Before starting Artoo, run
   [`supabase-private-schema.sql`](../deploy/azure/supabase-private-schema.sql)
   through the project's SQL editor as the database owner. It removes `public`
   schema access from `PUBLIC`, `anon`, and `authenticated` so the Data API cannot
   bypass Artoo authorization, including through newly created tables/functions.
   It does not modify Supabase's `auth` or `storage` schemas. Startup verifies
   effective privileges and refuses migration if these roles still have access.
   Keep the project's Data API disabled if it is otherwise unnecessary.
3. Create a Storage bucket named `artoo`, **Public bucket off**, with no client
   access policies. Use the server-only legacy `service_role` API key as
   `SUPABASE_SERVICE_ROLE_KEY`; never use an `anon`/publishable key or expose this
   credential in the Web build. Startup verifies the bucket exists and is private.
4. Save the Session pooler URL (with a URL-encoded database password) and service
   key in a private local configuration file **outside Git**. Do not put secret
   values into shell command arguments, screenshots, PRs or build arguments.

Supabase Free has database/storage/egress quotas and can pause inactive projects;
check the current plan in its dashboard. It does not provide the managed backup
guarantees of a paid production database. Preventing container data loss does not
replace a tested backup policy.

## Authentication and environment

Artoo keeps its existing Google OIDC login; Supabase Auth is not used. Create a
Google **Web application** OAuth client and register exactly
`https://<app-host>/auth/google/callback`. While Google's app is in testing, add
the allowed Google accounts as test users. A custom domain requires updating
both the registered callback and `GOOGLE_REDIRECT_URI`.

| Setting | Source / purpose |
| --- | --- |
| `ARTOO_DATABASE_URL` | Secret: Supabase Session pooler URL |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret: server-only Storage credential |
| `ARTOO_SUPABASE_STORAGE_BUCKET` | Private bucket, e.g. `artoo` |
| `GOOGLE_CLIENT_ID` | Google Web OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Secret: Google Web OAuth client secret |
| `GOOGLE_REDIRECT_URI` | Exact registered HTTPS callback |
| `AUTH_ALLOWED_EMAILS` | Comma-separated allowed Google account emails |
| `AUTH_OWNER_EMAILS` | Explicit owners; each must also be allowed |
| `ARTOO_PAIRING_PEPPER` | Secret: generate once, preserve through upgrades |
| `ARTOO_AI_DATA_SHARING_POLICY` | Optional public JSON disclosure matching the actual executor providers; required by the existing consent flow before relevant AI work |

The image sets `NODE_ENV=production`, `ARTOO_HOST=0.0.0.0`, port 4000, same-origin
Web assets, `ARTOO_BLOB_BACKEND=supabase` and `ARTOO_REQUIRE_REMOTE_STORAGE=1`.
`PORT` is also supported outside the image when `ARTOO_PORT` is absent. Leave
`ARTOO_TRUSTED_PROXIES` unset for ACA unless exact proxy addresses are deliberately
configured; do not broadly trust incoming forwarded headers. HTTPS cookies and
the OAuth callback use explicit production configuration.

## Build and first deployment

Run the repository checks in `AGENTS.md` and the PostgreSQL deployment workflow
before deploying. Build from the reviewed commit, preserve its full SHA, and
deploy an immutable **image digest**, not `latest`. Do not merge a PR merely to
obtain an image.

Example for the already-created resources (every Azure command must explicitly
select the intended subscription; do not change the global CLI default):

```powershell
$subscription = 'REPLACE_WITH_SUBSCRIPTION_ID'
$releaseSha = git rev-parse HEAD
az acr build --subscription $subscription --registry REPLACE_WITH_ACR_NAME --image "artoo:$releaseSha" --build-arg "SOURCE_REVISION=$releaseSha" --file Dockerfile .
az acr repository show --subscription $subscription --name REPLACE_WITH_ACR_NAME --image "artoo:$releaseSha" --query digest -o tsv
```

Use the existing Basic registry rather than creating another. The configured
registry is in Japan East, so pulls to Singapore can incur cross-region traffic.
Build input is restricted by `.dockerignore`; do not store deployment credentials
anywhere in the source tree. No secrets are passed to Docker build.

Enable the app's system-assigned managed identity and grant **AcrPull** at the
existing registry scope. Configure its registry authentication to use that
identity. Add the named secrets in the Container App's Secrets screen or apply a
private manifest file with CLI output suppressed. Never pass secret values in
`--set-env-vars`, `--secrets`, or build arguments.

Make a private copy of [`containerapp.yaml`](../deploy/azure/containerapp.yaml)
outside Git and replace every `REPLACE_WITH_…` value. The existing target is app
`artoo` in Southeast Asia; select its actual resource group and environment. Set
the full environment resource ID and immutable ACR digest. Before editing,
export the existing configuration to a private file:

```powershell
az containerapp show --subscription $subscription --resource-group REPLACE_WITH_RESOURCE_GROUP --name REPLACE_WITH_APP_NAME --output yaml > C:\private\artoo-before.yaml
```

Merge the **complete** existing `properties.configuration.secrets` list into the
private release manifest, including secrets unrelated to this deployment. The
template's four names must already exist on the app. For ordinary existing
secrets, keep their names and omit values: `az containerapp update --yaml` reads
the stored values for entries present in the submitted list. It does not merge
omitted secret names into that list. Preserve any Key Vault entry's `keyVaultUrl`
and `identity` instead of converting it to a value secret. Never use an empty
secret list or assume omission of the whole field preserves existing secrets.

Review other existing configuration before applying the template, including
domains, identity, registry authentication, volumes and environment variables.
For CA certificates, retain the secret and its volume, and set
`ARTOO_DATABASE_CA_FILE` to the mounted container path. Apply the reviewed
manifest only after this merge:

```powershell
az containerapp update --subscription $subscription --resource-group REPLACE_WITH_RESOURCE_GROUP --name REPLACE_WITH_APP_NAME --yaml C:\private\artoo-release.yaml --output none
```

The first rollout replaces the quickstart sample. It does not change `canvas`,
the VPN VM, its public IPs, security groups or network interfaces. Keep a copy of
the previous Container App configuration and revision/image reference before
the change. An Azure configuration export does not export secret values; retain
the matching private secrets separately.

## Later releases and recovery

**Single revision mode and max 1 do not prevent overlap during a rollout.** Artoo
deliberately refuses the second process. Plan a short maintenance window:

1. Stop submitting work; verify active execution is safely drained or stopped.
   Record the old revision, image digest, full migration version, and private
   configuration. Take and verify the external backup described below.
2. In the private release manifest, set
   `properties.configuration.activeRevisionsMode: Multiple`. Switch the app to
   Multiple before deactivating the old revision. Single keeps the old process
   alive until the replacement is ready, so applying a Single manifest during
   maintenance would reintroduce the lock conflict.

   ```powershell
   $oldRevision = 'REPLACE_WITH_RECORDED_ACTIVE_REVISION'
   az containerapp revision set-mode --subscription $subscription --resource-group REPLACE_WITH_RESOURCE_GROUP --name REPLACE_WITH_APP_NAME --mode multiple --output none
   az containerapp revision list --subscription $subscription --resource-group REPLACE_WITH_RESOURCE_GROUP --name REPLACE_WITH_APP_NAME --query "[?properties.active].name" --output tsv
   az containerapp revision deactivate --subscription $subscription --resource-group REPLACE_WITH_RESOURCE_GROUP --name REPLACE_WITH_APP_NAME --revision $oldRevision --output none
   az containerapp replica list --subscription $subscription --resource-group REPLACE_WITH_RESOURCE_GROUP --name REPLACE_WITH_APP_NAME --revision $oldRevision --output table
   ```

   Confirm every previously active Artoo revision is stopped and there are no
   running replicas. In the database, confirm the old `artoo-server` session and
   its advisory lock are gone. Do not terminate an unknown session. Allow a
   maintenance outage while no revision is serving traffic.
3. Apply the merged manifest with the validated immutable image and a unique
   revision suffix, still in Multiple mode. Keep latest-revision traffic at 100
   and min=max=1. Confirm only the new revision is active and exercise the health
   and acceptance checks below before reopening work.

   ```powershell
   az containerapp update --subscription $subscription --resource-group REPLACE_WITH_RESOURCE_GROUP --name REPLACE_WITH_APP_NAME --yaml C:\private\artoo-release.yaml --output none
   az containerapp revision list --subscription $subscription --resource-group REPLACE_WITH_RESOURCE_GROUP --name REPLACE_WITH_APP_NAME --query "[?properties.active].{name:name,health:properties.healthState}" --output table
   az containerapp revision set-mode --subscription $subscription --resource-group REPLACE_WITH_RESOURCE_GROUP --name REPLACE_WITH_APP_NAME --mode single --output none
   ```

   Run the final command only when the latest revision is the healthy validated
   release. Mode changes alone do not create a revision. Keep the saved release
   configuration consistent with the final Single mode; repeat the explicit
   Multiple transition for the next maintenance deployment.
4. If startup fails, stay in Multiple mode and deactivate the failed revision.
   Confirm it has stopped and released the database lock. Create a **new**
   revision using the last compatible image/configuration and a new suffix;
   verify it before returning to Single. Do not activate old and new Artoo
   revisions concurrently. A startup migration is transactional, but a
   **successful** newer migration cannot be downgraded by an older image: its
   shorter history is rejected. Use a compatible forward fix or a separately
   approved database and object restore. Reverting an image is not a data rollback.

## Health, acceptance, and backups

Check `/health/live` and `/health/ready`, the login page, an actual Google login,
unauthenticated API rejection, a paired computer's WebSocket connection, and
artifact upload/download. Create a small record, restart the revision, and
verify both that record and its artifact remain. Observe memory, OOM/restart
counts and latency during representative work before accepting 0.5 GiB. Keep
the previous compatible revision recoverable until these checks pass.

The database health check verifies session identity and ownership of the lock;
the private bucket is checked at startup. A healthy endpoint alone does not
prove Google configuration, storage round trips or a live executor are correct.
Controlled fixtures and the Linux image build are separate from live Azure /
Supabase acceptance.

The image workflow checks production-only imports, bundled migration/Web files,
and refusal to start without remote storage under a 512 MiB / 0.25 CPU Docker
limit. These checks do **not** establish working-set capacity: they do not start
the complete remote service or exercise concurrent sessions and artifact traffic.
At the candidate ACA size, record peak memory and p95 request latency during a
representative session, artifact/source uploads near their limits, and a restart.
Require no OOM kills or unexpected restarts and enough memory headroom for the
observed peaks. Increase to 0.5 vCPU / 1 GiB if that acceptance fails, then repeat
the checks and recalculate cost before enabling normal use.

For backups, stop writes and export `public` **and `artoo_meta`** using a suitable
`pg_dump` version over the Session pooler. Separately export every object from
the private bucket and preserve its content-addressed key. Store database dump,
bucket contents, image digest, configuration and checksum manifest together in
encrypted storage outside the container and Supabase project. Verify restore
into a separate empty project and private bucket, apply the schema-access
prerequisite, then exercise login and artifact checks before treating it as a
usable recovery point. Do not overwrite the live project during a rehearsal.

`npm run storage` remains the **local PGlite** backup/adoption tool; it does not
back up the remote PostgreSQL database or Supabase bucket.

## Cost limits

The starting replica is always on. Compute is only one part of the bill: the
existing ACR, image builds, Log Analytics ingestion/retention, outbound traffic
and any Supabase usage beyond the free plan also count. Set an Azure budget
alert and review the already-enabled environment logging. Do not enable extra
paid networking, databases or monitoring just for this deployment. A pricing
estimate is not evidence that the full account stays below its monthly budget.
