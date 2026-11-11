#!/bin/sh
# Immutable GitHub release bootstrap; no npm registry or root access required.
set -eu
umask 077
artoo_version='{{PACKAGE_VERSION}}'
artoo_hash='{{PACKAGE_SHA256}}'
artoo_size='{{PACKAGE_SIZE}}'
artoo_server='' artoo_code='' artoo_workspace=''
fail() { printf '%s\n' "$1" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || fail 'Each installer option needs a value.'
  case "$1" in
    --server) [ -z "$artoo_server" ] || fail 'Duplicate --server'; artoo_server=$2 ;;
    --code) [ -z "$artoo_code" ] || fail 'Duplicate --code'; artoo_code=$2 ;;
    --workspace) [ -z "$artoo_workspace" ] || fail 'Duplicate --workspace'; artoo_workspace=$2 ;;
    *) fail 'Use --server, --code and optionally --workspace.' ;;
  esac
  shift 2
done
[ -n "$artoo_server" ] && [ -n "$artoo_code" ] || fail 'Use the connection command from Artoo Web.'
printf '%s\n' "$artoo_version" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$' || fail 'Unrendered installer version.'
printf '%s\n' "$artoo_hash" | LC_ALL=C grep -Eq '^[a-f0-9]{64}$' || fail 'Unrendered installer hash.'
printf '%s\n' "$artoo_size" | LC_ALL=C grep -Eq '^[0-9]+$' || fail 'Unrendered installer size.'
command -v curl >/dev/null 2>&1 || fail 'Install curl first.'
command -v tar >/dev/null 2>&1 || fail 'Install tar first.'
case "$(uname -s):$(uname -m)" in
  Linux:x86_64) artoo_platform=linux-x64 ;;
  Linux:aarch64|Linux:arm64) artoo_platform=linux-arm64 ;;
  Darwin:x86_64) artoo_platform=darwin-x64; printf '%s\n' 'macOS qualification is deferred for this release.' ;;
  Darwin:arm64) artoo_platform=darwin-arm64; printf '%s\n' 'macOS qualification is deferred for this release.' ;;
  *) fail 'Supported: Linux x64/arm64; macOS x64/arm64 is not release-qualified.' ;;
esac
download() { curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --output "$2" "$1"; }
hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}';
  else fail 'Install sha256sum or shasum first.'; fi
}
case "${HOME:-}" in /*) ;; *) fail 'HOME must be an absolute directory.' ;; esac
artoo_base="${ARTOO_HOME:-$HOME/.artoo}"
case "$artoo_base" in /*) ;; *) fail 'ARTOO_HOME must be an absolute private directory.' ;; esac
artoo_bootstrap="$artoo_base/bootstrap"
[ ! -L "$artoo_base" ] && [ ! -L "$artoo_bootstrap" ] || fail 'Installation directories must not be links.'
mkdir -p "$artoo_bootstrap"
chmod 700 "$artoo_base" "$artoo_bootstrap"
# Keep unique staging paths for diagnosis and for a private Node runtime's lifetime.
artoo_stage=$(mktemp -d "$artoo_bootstrap/install.XXXXXXXX")
artoo_node=''
if command -v node >/dev/null 2>&1; then
  artoo_node=$(node -p 'Number(process.versions.node.split(".")[0]) >= 24 ? process.execPath : ""' 2>/dev/null) || artoo_node=''
fi
if [ -z "$artoo_node" ]; then
  printf '%s\n' 'Installing a private Node.js 24 runtime from nodejs.org...'
  download 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt' "$artoo_stage/node-SHASUMS256.txt"
  artoo_node_line=$(LC_ALL=C grep -E "^[a-f0-9]{64}[[:space:]]+node-v24\.[0-9]+\.[0-9]+-$artoo_platform\.tar\.gz$" "$artoo_stage/node-SHASUMS256.txt") || fail 'Official Node.js archive not found.'
  [ "$(printf '%s\n' "$artoo_node_line" | wc -l | tr -d ' ')" = 1 ] || fail 'Ambiguous official Node.js archive.'
  artoo_node_hash=$(printf '%s\n' "$artoo_node_line" | awk '{print $1}')
  artoo_node_name=$(printf '%s\n' "$artoo_node_line" | awk '{print $2}')
  artoo_node_version=${artoo_node_name#node-}; artoo_node_version=${artoo_node_version%-$artoo_platform.tar.gz}
  download "https://nodejs.org/dist/$artoo_node_version/$artoo_node_name" "$artoo_stage/$artoo_node_name"
  [ "$(hash_file "$artoo_stage/$artoo_node_name")" = "$artoo_node_hash" ] || fail 'Node.js hash mismatch; no package executed.'
  tar -xzf "$artoo_stage/$artoo_node_name" -C "$artoo_stage"
  artoo_node="$artoo_stage/node-$artoo_node_version-$artoo_platform/bin/node"
fi
"$artoo_node" --version || fail 'Node.js cannot run here; Linux requires a supported glibc-based distribution.'
"$artoo_node" --input-type=module - "$artoo_server" <<'ARTOO_ORIGIN'
try {
  const url = new URL(process.argv[2]);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error();
} catch { console.error('Server must be an HTTPS website origin (HTTP is allowed only on localhost).'); process.exitCode = 1; }
ARTOO_ORIGIN
artoo_archive="$artoo_stage/artood.tgz"
printf 'Downloading Artoo %s from its GitHub release...\n' "$artoo_version"
download "https://github.com/Xiejiayun/artoo/releases/download/artood-v$artoo_version/jiayunxie-artood-$artoo_version.tgz" "$artoo_archive"
[ "$(wc -c < "$artoo_archive" | tr -d ' ')" = "$artoo_size" ] || fail 'Package size mismatch; no package executed.'
[ "$(hash_file "$artoo_archive")" = "$artoo_hash" ] || fail 'Package hash mismatch; no package executed.'
tar -xzf "$artoo_archive" -C "$artoo_stage"
artoo_package="$artoo_stage/package"
"$artoo_node" "$artoo_package/bin/verify.mjs" --package-directory "$artoo_package" >/dev/null
set -- connect --server "$artoo_server" --code "$artoo_code"
if [ -n "$artoo_workspace" ]; then set -- "$@" --workspace "$artoo_workspace"; fi
exec "$artoo_node" "$artoo_package/bin/artood.mjs" "$@"
