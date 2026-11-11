The PostgreSQL adapter's integration suite is separate from the ordinary PGlite
suite. It is not a mock and does not silently skip when PostgreSQL is absent.

Start a private, disposable PostgreSQL cluster on loopback with TLS disabled.
Use a cluster owned by this test run, not a local tunnel to a hosted database or
a shared development cluster. The supplied administrator needs CREATE DATABASE,
CREATE ROLE, and permission to terminate its own test backends. The suite creates
randomly named databases and, if absent, NOLOGIN `anon`/`authenticated` role
fixtures. It marks every created resource with a random ownership comment and
checks that marker before deletion; it never adopts or changes existing roles.

From the repository root in PowerShell:

```powershell
$env:ARTOO_POSTGRES_TEST_ADMIN_URL = 'postgresql://test_admin:test_password@127.0.0.1:55432/postgres'
$env:ARTOO_POSTGRES_TEST_ISOLATED = '1'
npm run build
npx vitest run --config packages/storage/src/db/postgres.integration.config.ts
```

Select the actual port and credentials from the owned cluster launcher. The URL
is only read from the environment, is never logged, and must be loopback without
query parameters. Remove these environment variables after the run. The ordinary
connection-admission and PGlite regression suites can be run with:

```powershell
npx vitest run packages/storage/src/db/postgres-db-client.test.ts packages/storage/src/db/pglite-db-client.test.ts --maxWorkers=2
```

The live suite covers transactional isolation, direct Drizzle transaction
options, savepoints, checkout-scope expiry, migration rollback/history checks,
the complete production migration history, the actual Supabase prerequisite SQL,
schema privilege admission, exclusive ownership, idle and active connection loss,
queued write rejection, close with a suspended or abandoned checkout, recoverable
SQL errors, handover, and refusal to downgrade TLS. The build is required because
the full migration case loads the built production database package, without
adding a circular source dependency from the storage package to the db package.
A pass does not establish Supabase connectivity, certificate trust, deployment
health, or a full Artoo product acceptance run. Those require separate deployment
checks against the intended environment.
