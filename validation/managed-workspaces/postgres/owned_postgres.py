#!/usr/bin/env python3
"""Task-owned PostgreSQL lifecycle. Never targets an existing user cluster."""
import argparse
import hashlib
import json
import stat
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[2]
BIN = RUNS = PHASE = ENV = None
PORT = 55479


def path_identity(path):
    value = Path(path).lstat()
    return {"device": str(value.st_dev), "inode": str(value.st_ino)}


def assert_owned(path, expected, directory):
    path = Path(path)
    value = path.lstat()
    if path.is_symlink() or path.resolve(strict=True) != path or value.st_uid != os.getuid():
        raise RuntimeError("Owned cluster path changed")
    if (directory and not stat.S_ISDIR(value.st_mode)) or (not directory and (not stat.S_ISREG(value.st_mode) or value.st_nlink != 1)):
        raise RuntimeError("Owned cluster path kind changed")
    if stat.S_IMODE(value.st_mode) != (0o700 if directory else 0o600) or path_identity(path) != expected:
        raise RuntimeError("Owned cluster inode or private mode changed")


def configure(bin_directory, phase, environment):
    global BIN, RUNS, PHASE, ENV
    requested = Path(bin_directory)
    if not requested.is_absolute() or phase not in ("receipt", "admin", "assignment"):
        raise ValueError("Use an explicit absolute PostgreSQL 17.11 bin directory and one phase")
    BIN = requested.resolve(strict=True)
    if not BIN.is_dir():
        raise ValueError("PostgreSQL bin directory is missing")
    for name in ("postgres", "initdb", "pg_ctl", "createdb"):
        path = BIN / name
        if not path.is_file() or path.resolve(strict=True).parent != BIN or not os.access(path, os.X_OK):
            raise ValueError("All PostgreSQL tools must be executable files in the same explicit bin directory")
    PHASE = phase
    RUNS = REPO / "artifacts/managed-workspaces/postgres" / phase
    ENV = dict(environment)
    if any(key.startswith("PG") or key.endswith("DATABASE_URL") or key.endswith("DB_URL") for key in ENV):
        raise ValueError("External database settings are forbidden")


def binary_pins():
    return {name: hashlib.sha256((BIN / name).read_bytes()).hexdigest()
            for name in ("postgres", "initdb", "pg_ctl", "createdb")}


def write_receipt(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")
    path.chmod(0o600)


def load_owned(path):
    path = Path(path).resolve(strict=True)
    relative = path.relative_to(RUNS.resolve(strict=True))
    if not re.fullmatch(r"run-[a-f0-9]{32}/cluster\.json", relative.as_posix()):
        raise RuntimeError("Not a task-owned run receipt")
    value = json.loads(path.read_text())
    cluster = Path(value["clusterRoot"])
    if (value["artifactRoot"] != str(ROOT) or value["uid"] != os.getuid()
            or value["runId"] != relative.parts[0]
            or not re.fullmatch(r"/private/tmp/artoo-repo-pg-[A-Za-z0-9_]+", str(cluster))
            or cluster.resolve(strict=True) != cluster):
        raise RuntimeError("Task ownership or private cluster path mismatch")
    assert_owned(cluster, value["clusterIdentity"], True)
    assert_owned(Path(value["socketDir"]), value["socketIdentity"], True)
    assert_owned(cluster / "owner.json", value["ownerIdentity"], False)
    if value.get("dataIdentity") is not None:
        assert_owned(Path(value["dataDir"]), value["dataIdentity"], True)
    metadata = cluster.stat()
    if metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
        raise RuntimeError("Cluster must be owned by this user with mode 0700")
    owner = json.loads((cluster / "owner.json").read_text())
    if any(owner.get(key) != value.get(key) for key in ("runId", "token", "artifactRoot", "uid", "phase", "binaryDirectory")):
        raise RuntimeError("Ownership marker mismatch")
    if (value["dataDir"] != str(cluster / "data") or value["socketDir"] != str(cluster / "socket")
            or value["port"] != PORT or value["user"] != "artoo_harness" or value["database"] != "artoo_concurrency"
            or value["binaryDirectory"] != str(BIN) or value["phase"] != PHASE
            or value["binaryPins"] != binary_pins()):
        raise RuntimeError("Fixed cluster configuration mismatch")
    return path, value


def postmaster_identity(value):
    pidfile = Path(value["dataDir"]) / "postmaster.pid"
    if not pidfile.exists():
        return None
    lines = pidfile.read_text().splitlines()
    if len(lines) < 6 or not lines[0].isdigit():
        raise RuntimeError("Incomplete postmaster identity; inspect retained files")
    pid = int(lines[0])
    if (pid <= 1 or Path(lines[1]).resolve() != Path(value["dataDir"])
            or int(lines[3]) != PORT or lines[4] != value["socketDir"] or lines[5] != ""):
        raise RuntimeError("Postmaster PID, data directory or no-TCP boundary mismatch")
    if value.get("postmasterPid") not in (None, pid) or value.get("postmasterStartSeconds") not in (None, int(lines[2])):
        raise RuntimeError("Postmaster PID/start time changed; refusing to touch process")
    check = subprocess.run(["/bin/ps", "-p", str(pid), "-o", "uid=", "-o", "command="],
                           text=True, capture_output=True, timeout=5, env=ENV)
    fields = check.stdout.strip().split(None, 1)
    if check.returncode or len(fields) != 2 or fields[0] != str(os.getuid()):
        raise RuntimeError("Recorded postmaster is not running as this user")
    expected = f"{BIN / 'postgres'} -D {value['dataDir']}"
    if not fields[1].startswith(expected):
        raise RuntimeError("Recorded PID is not the private postgres/data process")
    return {"pid": pid, "started": int(lines[2])}


def command(argv, log, timeout):
    with Path(log).open("ab") as output:
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=output,
                                   stderr=subprocess.STDOUT, start_new_session=True,
                                   env=ENV)
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            # This new group belongs only to the command just launched here.
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
            raise
        if code:
            raise subprocess.CalledProcessError(code, argv)


def start(run_dir):
    if os.uname().sysname != "Darwin":
        raise RuntimeError("This prepared lifecycle is scoped to the current macOS host")
    if os.getuid() == 0:
        raise RuntimeError("Never initialize or run this harness as root")
    if os.getpriority(os.PRIO_PROCESS, 0) != 10:
        raise RuntimeError("The owned PostgreSQL launcher requires nice 10")
    binary = BIN / "postgres"
    if not binary.is_file():
        raise RuntimeError("Private PostgreSQL has not been built; database startup did not run")
    versions = {}
    for name in ("postgres", "initdb", "pg_ctl", "createdb"):
        versions[name] = subprocess.check_output([str(BIN / name), "--version"], text=True, timeout=10, env=ENV).strip()
        if versions[name] != f"{name} (PostgreSQL) 17.11":
            raise RuntimeError(f"Expected {name} (PostgreSQL) 17.11; found {versions[name]}")
    version = versions["postgres"]
    run_dir = Path(run_dir).resolve(strict=True)
    if run_dir.parent != RUNS or not re.fullmatch(r"run-[a-f0-9]{32}", run_dir.name) or (run_dir / "cluster.json").exists():
        raise RuntimeError("Start requires a new selected owned run directory")
    run_id = run_dir.name
    cluster = Path(tempfile.mkdtemp(prefix="artoo-repo-pg-", dir="/private/tmp")).resolve()
    cluster.chmod(0o700)
    socket = cluster / "socket"
    socket.mkdir(mode=0o700)
    value = {"schemaVersion": 1, "runId": run_id, "token": secrets.token_hex(32), "artifactRoot": str(ROOT),
             "uid": os.getuid(), "createdAtUnix": time.time(), "status": "prepared", "clusterRoot": str(cluster),
             "dataDir": str(cluster / "data"), "socketDir": str(socket), "port": PORT,
             "user": "artoo_harness", "database": "artoo_concurrency", "binaryDirectory": str(BIN),
             "postmasterPid": None, "postmasterStartSeconds": None, "version": version,
             "phase": PHASE, "binaryPins": binary_pins(), "toolVersions": versions,
             "clusterIdentity": path_identity(cluster), "socketIdentity": path_identity(socket), "dataIdentity": None}
    receipt = run_dir / "cluster.json"
    write_receipt(cluster / "owner.json", {key: value[key] for key in ("runId", "token", "artifactRoot", "uid", "phase", "binaryDirectory")})
    value["ownerIdentity"] = path_identity(cluster / "owner.json")
    write_receipt(receipt, value)
    try:
        command([str(BIN / "initdb"), "-D", value["dataDir"], "--username=artoo_harness",
                 "--auth-local=trust", "--auth-host=reject", "--encoding=UTF8", "--locale=C", "--no-instructions"],
                run_dir / "lifecycle.log", 90)
        value["dataIdentity"] = path_identity(Path(value["dataDir"]))
        write_receipt(receipt, value)
        config = ("listen_addresses = ''\n" + f"unix_socket_directories = '{socket}'\n" +
                  f"port = {PORT}\n" + "unix_socket_permissions = 0700\nmax_connections = 16\n" +
                  "shared_buffers = '16MB'\nstatement_timeout = '20s'\nlock_timeout = '12s'\n" +
                  "idle_in_transaction_session_timeout = '30s'\nlog_parameter_max_length_on_error = 0\n")
        (Path(value["dataDir"]) / "harness.conf").write_text(config)
        with (Path(value["dataDir"]) / "postgresql.conf").open("a") as output:
            output.write("\ninclude = 'harness.conf'\n")
        value["status"] = "starting"
        write_receipt(receipt, value)
        command([str(BIN / "pg_ctl"), "-D", value["dataDir"], "-l", str(run_dir / "postgres.log"),
                 "-w", "-t", "30", "start"], run_dir / "lifecycle.log", 40)
        identity = postmaster_identity(value)
        if identity is None:
            raise RuntimeError("Started cluster has no checked postmaster identity")
        value.update({"postmasterPid": identity["pid"], "postmasterStartSeconds": identity["started"], "status": "running"})
        write_receipt(receipt, value)
        command([str(BIN / "createdb"), "-h", value["socketDir"], "-p", str(PORT), "-U", value["user"],
                 "--maintenance-db=postgres", value["database"]], run_dir / "lifecycle.log", 25)
        return {"receipt": str(receipt), "status": "running", "runId": run_id, "postmasterPid": identity["pid"]}
    except BaseException as startup_error:
        # Startup may have produced a live postmaster even if its command failed.
        # Stop only after validating the ownership marker and actual PID/data.
        try:
            stop(receipt)
        except BaseException as cleanup_error:
            # Preserve an identity stop() may have checked and persisted before
            # cleanup failed, rather than overwriting it with earlier metadata.
            failed = json.loads(receipt.read_text())
            failed["cleanupError"] = str(cleanup_error)
            failed["status"] = "startup-failed-cleanup-required"
            write_receipt(receipt, failed)
        raise RuntimeError(f"Owned startup failed; preserved cluster receipt: {receipt}") from startup_error


def recorded_pid_absent(value):
    pid = value.get("postmasterPid")
    if pid is None:
        return None  # No successful start identity was recorded; never PASS proof.
    if not isinstance(pid, int) or pid <= 1:
        raise RuntimeError("Invalid recorded postmaster PID")
    try:
        os.kill(pid, 0)  # Observation only; never signal a reused/mismatched PID.
    except ProcessLookupError:
        return True
    except PermissionError as error:
        raise RuntimeError("Cannot establish recorded postmaster PID absence (EPERM)") from error
    return False


def stop(receipt):
    path, value = load_owned(receipt)
    identity = postmaster_identity(value)
    if identity is not None:
        # Startup failure may have reached a live postmaster before persisting
        # its PID. Preserve that checked identity before requesting shutdown.
        value.update({"postmasterPid": identity["pid"], "postmasterStartSeconds": identity["started"]})
        write_receipt(path, value)
        command([str(BIN / "pg_ctl"), "-D", value["dataDir"], "-m", "fast", "-w", "-t", "30", "stop"],
                path.parent / "lifecycle.log", 40)
    if (Path(value["dataDir"]) / "postmaster.pid").exists():
        raise RuntimeError("Owned postmaster PID file remains; cleanup failed")
    if (Path(value["socketDir"]) / f".s.PGSQL.{PORT}").exists():
        raise RuntimeError("Owned socket remains; cleanup failed")
    absent = recorded_pid_absent(value)
    if absent is False:
        raise RuntimeError("Recorded postmaster PID still exists; cleanup unconfirmed. No signal was sent to that PID")
    value.update({"status": "stopped", "stoppedAtUnix": time.time(), "pidFileAbsent": True,
                  "socketAbsent": True, "recordedPidAbsent": absent})
    write_receipt(path, value)
    return {"receipt": str(path), "status": "stopped", "pidFileAbsent": True, "socketAbsent": True,
            "recordedPidAbsent": absent, "recordedPostmasterPid": value.get("postmasterPid"),
            "retainedCluster": value["clusterRoot"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Inspect or stop only a retained owned PostgreSQL cluster")
    parser.add_argument("action", choices=("status", "stop"))
    parser.add_argument("--phase", choices=("receipt", "admin", "assignment"), required=True)
    parser.add_argument("--pg-bin", required=True)
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    if args.action == "stop" and (not args.execute or os.getpriority(os.PRIO_PROCESS, 0) != 10):
        parser.error("Owned shutdown requires --execute under nice 10")
    configure(args.pg_bin, args.phase, {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C", "LC_ALL": "C", "HOME": "/dev/null"})
    if args.action == "stop":
        result = stop(args.receipt)
    else:
        path, value = load_owned(args.receipt)
        result = {"receipt": str(path), "status": value["status"], "identity": postmaster_identity(value),
                  "recordedPidAbsent": recorded_pid_absent(value)}
    print(json.dumps(result))
