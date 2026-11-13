# Audit export signatures

Task and Goal exports support an explicit Ed25519 format. This establishes that
the exported, redacted evidence was signed by a trusted server key. It does not
prove the truth or completeness of its evidence, successful execution, process
closure, publication, or an independently certified signing time.

## Compatibility and format

`GET /api/v1/{tasks,goals}/:id/audit-bundle/export` retains the exact unsigned
`v1alpha1` envelope by default, including `signature: null` and `signing.deferred`.
Add `?signing=ed25519-v1` to request `artoo.audit-signed.v1`. Without configured
keys the original deferred envelope is returned. Unknown/repeated signing
parameters are rejected. The Web evidence download buttons request the new
format; older consumers, including the default iOS download, retain the old API.
Inspect the returned format/status before treating a download as signed.

The signed envelope contains `kind: task|goal`, `exported_at`, the complete
`bundle`, its `bundle_sha256`, a Base64 `signature`, and `signing` metadata:
`status: signed`, `algorithm: Ed25519`, `canonicalization: artoo-json-v1`,
`issuer`, and `key_id`. Existing organization lookups, authentication and
redaction run before signing. Neither the request nor the bundle chooses a key.

The signature covers **all fields except `signature`**, including all signing
metadata. Signing bytes are UTF-8 of `Artoo audit export signature v1\n` followed
by `artoo-json-v1` canonical JSON. The digest is `sha256:` plus lowercase hex
SHA-256 of the canonical bundle. This is a new digest format; legacy hashing
has not changed.

Canonicalization recursively sorts object keys in JavaScript UTF-16 lexical
order, emits dense arrays in their original order, and uses ECMAScript
`JSON.stringify` escaping/number representation for JSON scalars (including
`-0` as `0`). It preserves keys such as `__proto__`; it performs no Unicode
normalization. Nonfinite numbers, undefined, BigInt, sparse arrays, cycles,
custom prototypes, enumerable accessors and symbol keys are rejected. Whitespace,
escape spelling and object key order do not affect a semantic JSON signature.
Contract validation must not strip unknown nested data or insert defaults
before verification: the original parsed JSON is signed and verified.

## Configure a server

Use a persistent instance issuer, such as `artoo:server-01`. Generate a distinct
Ed25519 PKCS8 private key and its SPKI public key in an operator-controlled
directory outside repositories, artifacts, backups shared with users and web
roots. Protect the private directory with OS permissions/Windows ACLs so only
the server operator/service identity can read or replace its files. The loader
does not install ACLs or provision a production key.

For example, after choosing a protected parent directory, run this PowerShell
snippet with a **new** child directory. Exclusive file creation prevents reuse
from silently overwriting a key; an error leaves its partial directory for the
operator to inspect. The command prints only the configuration path.

```powershell
@'
import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const root = resolve(process.argv[2]), issuer = process.argv[3];
if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(issuer)) throw Error('Invalid issuer');
await mkdir(root, { mode: 0o700 });
const pair = generateKeyPairSync('ed25519');
const key_id = 'ed25519-spki-sha256:' + createHash('sha256')
  .update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
const private_key_file = join(root, 'private.pem');
const public_keyring_file = join(root, 'public-keyring.json');
await writeFile(private_key_file, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
await writeFile(public_keyring_file, JSON.stringify({ version: 1, issuer, keys: [{ key_id,
  status: 'active', public_key_spki_pem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] }, null, 2), { flag: 'wx' });
const config = join(root, 'signing.json');
await writeFile(config, JSON.stringify({ version: 1, issuer, active_key_id: key_id,
  private_key_file, public_keyring_file }, null, 2), { flag: 'wx', mode: 0o600 });
console.log(config);
'@ | node --input-type=module - C:/secure/artoo-audit/server-01 artoo:server-01
```

Set `ARTOO_AUDIT_SIGNING_CONFIG` to the absolute `signing.json` path and restart
the server using its normal runbook. All referenced paths must be absolute.
The private key must match the configured active fingerprint and the keyring's
issuer. Malformed files, missing keys, mismatches, non-Ed25519 keys, duplicate
key IDs and retired/revoked signing keys reject startup **before opening the
database**. Errors omit file contents and parser diagnostics. Unset the variable
to run without signing; an explicitly invalid/empty value cannot downgrade.

## Distribute trust, rotate and revoke

Distribute only `public-keyring.json` through an independently authenticated
operator/organization channel. Auditors must verify its issuer and key
fingerprint against that channel. A public key supplied by the same untrusted
export or an unauthenticated server response cannot establish issuer identity.
No embedded key or network discovery is automatically trusted by the verifier.

For rotation, add a newly generated public key as `active`, change the previous
key to `retired`, configure the new private key/fingerprint, and restart after
reviewing all three files. Preserve the issuer for the same instance and keep
retired public keys so historical exports remain verifiable. Multiple active
public keys are allowed during a transition, but the server signs with exactly
its configured active key. A restart is required to change its signing policy.

Mark a compromised key `revoked` and distribute the updated trusted ring to
auditors; all signatures under it are rejected, including historical ones. Stop
using it on the server and rotate/restart. Retired keys verify history but cannot
sign new server exports. `exported_at` is an issuer assertion, so this format
cannot prove that a signature predates retirement/compromise. Offline verification
cannot discover a newer revocation than the trusted ring it was given. Back up
private keys using the operator's secret-recovery procedure, separately from
ordinary downloadable audit bundles; do not restore a revoked key into service.

## Offline verification

Build the server dependencies with `npm run build --workspace @artoo/server`,
then run against the downloaded **envelope**, rather than the HTTP `{export: ...}`
wrapper, and an independently trusted public keyring:

```powershell
node scripts/audit-verify.mjs C:/audit/task-export.json C:/audit/trusted-public-keyring.json
```

The verifier makes no network request. Success exits 0 and prints public issuer,
key ID, kind and digest with `verified: true`. Unsigned/unsupported envelopes,
wrong/unknown/revoked keys, digest mismatch, malformed signature encodings and
any changed covered value exit 1. Its diagnostics do not print bundle contents.
Use a current trusted keyring and inspect the evidence separately before acting
on it. Validation scope and intermediate failures are recorded in
[the opportunities progress record](opportunities-progress.md).
