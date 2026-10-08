"""One fresh local PostgreSQL 17.11 validation cluster; runtime qualification pending."""
import argparse
from collections import Counter
import fcntl
import html
import importlib.util
import json
import os
from pathlib import Path
import pwd
import shutil
import stat
import subprocess
import sys
import time
import uuid

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(HERE.parent))
spec = importlib.util.spec_from_file_location("managed_validation_common", HERE.parent / "run.py")
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)
sys.path.insert(0, str(HERE))
import owned_postgres as cluster


def runtime_dependencies(node, configs):
    values = shared.dependency_inventory(node, configs)
    values["postgres_fixture_dependencies"] = shared.tree_inventory(HERE / "node_modules", time.monotonic() + 600,
        dependency_tree=True, linked_roots={HERE / "node_modules", ROOT / "node_modules"})
    values["postgres_tools"] = cluster.binary_pins()
    return values


def qualify(directory, phase):
    expected = json.loads((HERE / "title-inventory.json").read_text())["phases"][phase]
    if expected["expected_total_tests"] != {"receipt": 15, "admin": 10, "assignment": 4}[phase]:
        raise ValueError("Expected PostgreSQL phase case count changed")
    raw = json.loads((directory / "vitest.json").read_text())
    evidence = json.loads((directory / "concurrency-receipts.json").read_text())
    files = raw.get("testResults", [])
    assertions = [case for file in files for case in file.get("assertionResults", [])]
    titles = {str((ROOT / name).resolve()): values for name, values in expected["files"].items()}
    cases = evidence.get("cases", [])
    count = expected["expected_total_tests"]
    pids = list(evidence.get("pids", {}).values())
    environment = evidence.get("environment", {})
    checks = {
        "exact_file_title_multisets": shared.exact_title_inventory(titles, files),
        "all_exact_assertions_passed": len(assertions) == count and all(case.get("status") == "passed" for case in assertions),
        "vitest_success": raw.get("success") is True,
        "exact_summary_counts": raw.get("numTotalTests") == count and raw.get("numPassedTests") == count,
        "no_failed_pending_todo": all(raw.get(key) == 0 for key in ("numFailedTests", "numPendingTests", "numTodoTests")),
        "exact_real_case_receipts": len(cases) == count and all(case.get("state") == "passed" for case in cases)
            and Counter(case.get("name") for case in cases) == Counter(expected["case_evidence_names"]),
        "case_evidence_present": len(cases) == count and all(case.get("evidence") for case in cases),
        "independent_backends": len(pids) == expected["expected_backends"] and len(set(pids)) == len(pids)
            and all(type(pid) is int and pid > 1 for pid in pids),
        "postgres_17_11_no_tcp": str(environment.get("version", "")).startswith("PostgreSQL 17.11 ")
            and environment.get("listen_addresses") == "" and environment.get("database") == "artoo_concurrency"
            and environment.get("username") == "artoo_harness" and environment.get("isolation") == "read committed",
    }
    summary = {"assertion_count": len(assertions), "statuses": dict(Counter(case.get("status") for case in assertions)),
               "real_case_receipts": len(cases), "independent_backend_pids": pids}
    shared.write_json(directory / "qualification.json", {"scope": "Database/test assertions; run.json owns final source/runtime and cluster cleanup acceptance",
        "checks": checks, "summary": summary, "passed": all(checks.values())})
    return checks, summary


def report(directory, result):
    links = ["run.json", "invocation.json", "cluster.json", "vitest.json", "qualification.json", "concurrency-receipts.json",
             "source-before.json", "source-after.json", "runtime-before.json", "runtime-after.json",
             "build/build.log", "typecheck/typecheck.log", "tests/tests.log", "lifecycle.log", "postgres.log"]
    links = " · ".join('<a href="' + name + '">' + name + "</a>" for name in links if (directory / name).is_file())
    evidence_path = directory / "concurrency-receipts.json"
    evidence = evidence_path.read_text() if evidence_path.is_file() else "No completed database case evidence was produced."
    text = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Owned PostgreSQL validation</title><style>body{font:16px/1.6 system-ui;max-width:1100px;margin:36px auto;padding:0 24px;color:#183048}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f6fa;padding:20px}</style><h1>Owned PostgreSQL '
    text += html.escape(result["phase"]) + " — " + ("PASS" if result["passed"] else "FAIL") + "</h1><p>" + links + "</p>"
    text += "<p>Real independent PostgreSQL 17.11 transactions, row/advisory locks, rollback and product route/service or binding calls. The PostgreSQL DbClient is a test adapter. Qualified session metadata is an explicit fixture prerequisite; this does not prove real WebSocket negotiation, a production PostgreSQL adapter, providers or native clients.</p><p>No GUI screenshots were taken. New wrapper and exceptional cleanup paths remain pending runtime qualification. Counts below are actual observations, not planned pass counts.</p><pre>"
    text += html.escape(json.dumps(result, indent=2)) + "</pre><h2>Database evidence</h2><pre>" + html.escape(evidence) + "</pre></html>"
    (directory / "report.html").write_text(text)


def main(phase, pg_bin):
    directory = ROOT / "artifacts/managed-workspaces/postgres" / phase / ("run-" + uuid.uuid4().hex)
    if directory.resolve() != directory:
        raise ValueError("Report parent must be a plain repository path")
    directory.mkdir(parents=True, mode=0o700)
    result = {"phase": phase, "passed": False, "started_at": shared.stamp(), "errors": [], "checks": {},
              "phase_receipts": {}, "cleanup": None, "photos": [], "exceptional_cleanup_runtime_qualified": False}
    invocation = {"phase": phase, "pg_bin_argument": pg_bin, "commands": {}, "timeouts": {
        "build_typecheck_test_seconds_each": 600, "owned_command_cleanup_seconds": 10,
        "initdb_seconds": 90, "pg_ctl_start_stop_seconds_each": 40, "createdb_seconds": 25,
        "pg_command_timeout_term_kill_seconds": [5, 5]}}
    source_before = dependencies_before = runtime_before = configs = outputs = node = lock = None
    receipt = directory / "cluster.json"
    env = {"PATH": shared.SYSTEM_PATH, "LANG": "C", "LC_ALL": "C", "CI": "1", "NO_COLOR": "1", "NODE_OPTIONS": "",
           "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0"}
    print(json.dumps({"attempt": str(directory), "phase": phase}), flush=True)

    def command(name, argv, selected_env):
        output = directory / name
        output.mkdir()
        invocation["commands"][name] = argv
        shared.write_json(directory / "invocation.json", invocation)
        value = shared.run_phase(name, argv, cwd=ROOT, env=selected_env, output_dir=output,
                                 phase_timeout_s=600, cleanup_timeout_s=10)
        result["phase_receipts"][name] = value
        result["checks"][name + "_zero_closed"] = value["passed"] is True and value["receipt_written"] is True
        if name != "tests" and not result["checks"][name + "_zero_closed"]:
            raise RuntimeError(name + " failed; later stages were not launched")

    try:
        if sys.platform != "darwin" or sys.version_info < (3, 10) or os.getuid() == 0 or os.getpriority(os.PRIO_PROCESS, 0) != 10:
            raise ValueError("Run as the local non-root user on macOS under nice -n 10")
        descriptor = os.open(ROOT / "artifacts/managed-workspaces/.run.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        lock = os.fdopen(descriptor, "r+")
        if not stat.S_ISREG(os.fstat(descriptor).st_mode) or os.fstat(descriptor).st_uid != os.getuid():
            raise ValueError("Build lock is not an owned regular file")
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for name in ("home", "tmp", "cache", "xdg-cache"):
            (directory / name).mkdir(mode=0o700)
        account = pwd.getpwuid(os.getuid()).pw_name
        env.update(HOME=str(directory / "home"), USER=account, LOGNAME=account, TMPDIR=str(directory / "tmp"),
                   TMP=str(directory / "tmp"), TEMP=str(directory / "tmp"), NODE_COMPILE_CACHE=str(directory / "cache"),
                   XDG_CACHE_HOME=str(directory / "xdg-cache"))
        source_before = shared.source_inventory(env)
        shared.write_json(directory / "source-before.json", source_before)
        selected = shutil.which("node", path=os.environ.get("PATH", ""))
        if not selected:
            raise ValueError("Node 24.19.0 is required on PATH")
        node = Path(selected).resolve(strict=True)
        env["PATH"] = str(node.parent) + ":" + shared.SYSTEM_PATH
        version = subprocess.run([str(node), "--version"], cwd=ROOT, env=env, check=True,
                                 text=True, capture_output=True, timeout=10).stdout.strip()
        if version != "v24.19.0":
            raise ValueError("Expected Node v24.19.0")
        cluster.configure(pg_bin, phase, env)
        configs, outputs = shared.project_graph()
        dependencies_before = runtime_dependencies(node, configs)
        shared.write_json(directory / "dependencies-before.json", dependencies_before)
        tsc = ROOT / "node_modules/typescript/bin/tsc"
        vitest = ROOT / "node_modules/vitest/vitest.mjs"
        invocation.update(node=str(node), node_version=version, postgres_bin=str(cluster.BIN),
                          environment_keys=sorted(env), inventory=shared.pin(HERE / "title-inventory.json"))
        command("build", [str(node), str(tsc), "-b", "--force"], env)
        if shared.source_inventory(env) != source_before:
            raise RuntimeError("Source changed during forced build")
        command("typecheck", [str(node), str(tsc), "-p", str(HERE / "tsconfig.json"), "--noEmit"], env)
        runtime_before = {"compiled": shared.compiled_inventory(outputs), "dependencies": runtime_dependencies(node, configs)}
        shared.write_json(directory / "runtime-before.json", runtime_before)
        if runtime_before["dependencies"] != dependencies_before or shared.source_inventory(env) != source_before:
            raise RuntimeError("Source/dependencies changed during preparation")
        result["cluster_start"] = cluster.start(directory)
        owned = json.loads(receipt.read_text())
        test_env = dict(env, ARTOO_PG_HARNESS_RECEIPT=str(receipt), ARTOO_PG_VALIDATION_PHASE=phase,
                        ARTOO_PG_RUN_TOKEN=owned["token"])
        command("tests", [str(node), str(vitest), "run", "--config", str(HERE / "vitest.config.ts")], test_env)
        checks, summary = qualify(directory, phase)
        result["checks"].update(checks)
        result["actual_summary"] = summary
        result["qualification_complete"] = True
    except BaseException as error:
        result["errors"].append({"where": "orchestration", "type": type(error).__name__, "message": str(error)})
    finally:
        try:
            if receipt.is_file():
                result["cleanup"] = cluster.stop(receipt)
        except BaseException as error:
            result["errors"].append({"where": "cluster_cleanup", "type": type(error).__name__, "message": str(error)})
        try:
            if source_before is not None:
                after = shared.source_inventory(env)
                shared.write_json(directory / "source-after.json", after)
                result["checks"]["source_unchanged"] = after == source_before
            if dependencies_before is not None:
                after = runtime_dependencies(node, configs)
                shared.write_json(directory / "dependencies-after.json", after)
                result["checks"]["dependencies_unchanged"] = after == dependencies_before
            if runtime_before is not None:
                after = {"compiled": shared.compiled_inventory(outputs), "dependencies": after}
                shared.write_json(directory / "runtime-after.json", after)
                result["checks"]["runtime_unchanged"] = after == runtime_before
        except BaseException as error:
            result["errors"].append({"where": "input_audit", "type": type(error).__name__, "message": str(error)})
        cleanup = result["cleanup"] or {}
        result["checks"]["owned_cluster_closed"] = all(cleanup.get(key) is True for key in ("pidFileAbsent", "socketAbsent", "recordedPidAbsent"))
        result["passed"] = bool(result.get("qualification_complete") and all(result["checks"].values()) and not result["errors"])
        result["finished_at"] = shared.stamp()
        try:
            shared.write_json(directory / "invocation.json", invocation)
            shared.write_json(directory / "run.json", result)
            report(directory, result)
        except BaseException as error:
            result["passed"] = False
            result["errors"].append({"where": "report", "type": type(error).__name__, "message": str(error)})
            try:
                shared.write_json(directory / "run.json", result)
                report(directory, result)
            except BaseException:
                pass
        finally:
            if lock is not None:
                lock.close()
        print(json.dumps({"report": str(directory / "report.html"), "passed": result["passed"], "errors": result["errors"]}), flush=True)
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("receipt", "admin", "assignment"))
    parser.add_argument("--pg-bin", required=True, help="Absolute directory containing the selected local PostgreSQL 17.11 tools; no PATH search")
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    if not args.execute:
        parser.error("Add --execute for this one explicit owned-cluster phase")
    raise SystemExit(main(args.phase, args.pg_bin))
