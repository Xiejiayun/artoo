"""One isolated genuine journal-failure phase; prepared source, not runtime qualification."""
import argparse
from collections import Counter
import hashlib
import html
import importlib.util
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
spec = importlib.util.spec_from_file_location("mixed_failure_validation_common", HERE.parent / "run.py")
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)


def physical_checks(phase, observations, parent):
    if phase != "mixed-failure":
        raise ValueError("Only the explicit mixed-failure phase is supported")
    fixtures = [row for row in observations if row.get("case") == "mixed-failure-cleanup"]
    by_id = {row.get("id"): row for row in fixtures}
    idle, active = by_id.get("F01", {}), by_id.get("F02", {})
    valid_pid = lambda value: type(value) is int and value > 0
    closed = lambda row: all(row.get(key) is True for key in ("exitObserved", "stdioCloseObserved", "childAbsent", "groupAbsent"))
    processes = [item for fixture in fixtures for item in fixture.get("lifetimes", [])]
    workers = [item for fixture in fixtures for item in fixture.get("workers", [])]
    def error_messages(error):
        if not isinstance(error, dict):
            return [str(error)]
        nested = error.get("errors")
        return [message for child in nested for message in error_messages(child)] if isinstance(nested, list) else [error.get("message")]
    def worker_boundary(fixture):
        owned = fixture.get("workers", [])
        if len(owned) != 2 or Counter(row.get("action") for row in owned) != Counter(["provision", "open"]):
            return False
        opened = next(row for row in owned if row["action"] == "open")
        provisioned = next(row for row in owned if row["action"] == "provision")
        fault, automatic = fixture.get("fault", {}), fixture.get("automaticClosure", {})
        stop_errors = error_messages(fixture.get("expectedStopFailure"))
        first = "Journal worker exited with code 1; ownership is unknown"
        return (all(row.get("entry") == (shared.ROOT / "apps/artood/dist/managed/journal-worker.js").as_uri()
                    and row.get("directory") == str(Path(fixture["root"]) / "journal") and valid_pid(row.get("threadId"))
                    and row.get("ready", {}).get("namespace") == fixture.get("namespace") and not row.get("errors") for row in owned)
                and provisioned.get("ready", {}).get("kind") == "provisioned" and provisioned.get("exit", {}).get("code") == 0
                and opened.get("ready", {}).get("kind") == "ready" and opened.get("exit", {}).get("code") == 1
                and fault.get("threadId") == opened.get("threadId") and fault.get("terminationCode") == fault.get("exitCode") == 1
                and opened.get("ready", {}).get("tick", -1) <= fixture.get("ready", {}).get("tick", -2) <= fault.get("requested", {}).get("tick", -3)
                <= opened.get("exit", {}).get("tick", -4)
                <= fixture.get("failureObserved", {}).get("tick", -3) <= automatic.get("tick", -4)
                < fixture.get("explicitStopJoin", {}).get("tick", -5)
                and fixture.get("failureObserved", {}).get("error", {}).get("message") == first
                and first in stop_errors and all(message in {first, "Journal unavailable; no execution authority is granted", "Journal worker closed with code 1"} for message in stop_errors)
                and fixture.get("journalExitObserved") is True
                and automatic.get("connections") == fixture.get("connectionCount") == 1
                and automatic.get("sockets") == [{"generation": 1, "clientState": 3, "upstreamState": 3}]
                and all(closed(row) for row in automatic.get("physical", [])))
    selected = active.get("selectedRuns", [])
    ordinary = [row for row in selected if row.get("allocated") is False]
    allocated = [row for row in selected if row.get("allocated") is True]
    ordinary_id = ordinary[0]["command"]["payload"]["run_id"] if len(ordinary) == 1 else None
    allocated_id = allocated[0]["command"]["payload"]["run_id"] if len(allocated) == 1 else None
    before, after = active.get("beforeStorage", {}), active.get("afterStorage", {})
    before_physical = active.get("activeBeforeFault", {}).get("physical", [])
    automatic_physical = active.get("automaticClosure", {}).get("physical", [])
    active_physical = [row for row in before_physical if row.get("role") != "git"]
    identities = lambda rows: Counter((row.get("role"), row.get("pid"), row.get("runId")) for row in rows)
    checks = {
        "exact_two_passed_cases": Counter(row.get("case") for row in observations if row.get("passed") is True) == Counter(["F01", "F02"]),
        "two_owned_fixtures_removed_without_unexpected_cleanup_failure": len(fixtures) == 2 and set(by_id) == {"F01", "F02"}
            and all(row.get("removed") is True and Path(row["root"]).parent == parent and row.get("sourceUnchanged") is True
                    and not row.get("cleanupFailures") and row.get("photos") == [] for row in fixtures),
        "actual_native_worker_failure_precedes_automatic_closure_and_explicit_join": len(fixtures) == 2 and all(worker_boundary(row) for row in fixtures),
        "idle_opt_out_has_no_repository_or_producer": idle.get("allowNewAllocations") is False and idle.get("hasBaseRepository") is False
            and idle.get("expectedWriters") == 0 and idle.get("entries") == [] and idle.get("physical") == []
            and idle.get("automaticClosure", {}).get("physical") == []
            and idle.get("beforeStorage") == idle.get("afterStorage") == {"runs": [], "receipts": [], "outbox": []},
        "two_distinct_route_owned_producers": len(selected) == 2 and bool(ordinary_id) and bool(allocated_id) and ordinary_id != allocated_id
            and active.get("expectedWriters") == 2 and active.get("allowNewAllocations") is True and active.get("hasBaseRepository") is True
            and all(hashlib.sha256(row["wireText"].encode()).hexdigest() == row.get("wireSha256") for row in selected),
        "both_pairs_alive_before_fault_without_release": len(active_physical) == 4
            and Counter(row.get("role") for row in active_physical) == Counter({"cli": 2, "guardian": 2})
            and all(valid_pid(row.get("pid")) and all(row.get(key) is False for key in ("exitObserved", "stdioCloseObserved", "childAbsent", "groupAbsent")) for row in active_physical)
            and active.get("activeBeforeFault", {}).get("releasesAbsent") is True,
        "same_processes_automatically_closed_before_explicit_stop": bool(automatic_physical)
            and identities(automatic_physical) == identities(before_physical) == identities(active.get("physical", []))
            and all(closed(row) for row in automatic_physical)
            and active.get("activeBeforeFault", {}).get("tick", -1) <= active.get("fault", {}).get("requested", {}).get("tick", -2),
        "all_observed_children_and_groups_closed": bool(processes) and all(valid_pid(row.get("pid"))
            and all(row.get(key) for key in ("spawnedAt", "exitedAt", "closedAt", "groupAbsentAt")) for row in processes)
            and all(closed(row) for fixture in fixtures for row in fixture.get("physical", [])),
        "exact_two_actual_entries_and_two_cli_guardian_pairs": len(active.get("entries", [])) == 2
            and Counter(row.get("runId") for row in active.get("entries", [])) == Counter([ordinary_id, allocated_id])
            and Counter(row.get("role") for row in processes if row.get("role") != "git") == Counter({"cli": 2, "guardian": 2})
            and all(valid_pid(row.get("pid")) and sum(item.get("role") == "cli" and item.get("pid") == row["pid"] for item in processes) == 1 for row in active.get("entries", [])),
        "loss_does_not_invent_durable_settlement": before.get("runs") == after.get("runs") and before.get("receipts") == after.get("receipts")
            and len(after.get("runs", [])) == 2 and all(row.get("final_outcome_json") is None for row in after.get("runs", []))
            and [(row.get("mode"), row.get("phase"), row.get("receipt_id")) for row in after.get("runs", []) if row.get("run_id") == ordinary_id] == [("legacy", "admitted", None)]
            and len([row for row in after.get("runs", []) if row.get("run_id") == allocated_id and row.get("mode") == "per-run" and row.get("phase") == "started" and row.get("receipt_id")]) == 1
            and [(row.get("run_id"), row.get("kind")) for row in after.get("receipts", [])] == [(allocated_id, "accepted")]
            and bool(after.get("outbox")) and all(row.get("run_id") == allocated_id and row.get("role") == "event"
                and (json.loads(row["content_json"]).get("type") != "run.lifecycle" or json.loads(row["content_json"])["payload"].get("phase") == "started") for row in after.get("outbox", []))
            and not any(row.get("direction") == "up" and row.get("frame", {}).get("kind") == "run.event" and row["frame"].get("run_id") == allocated_id
                and row["frame"].get("event", {}).get("type") == "run.lifecycle" and row["frame"]["event"]["payload"].get("phase") != "started" for row in active.get("wire", [])),
        "real_qualified_wire_and_http_routes_retained": len(fixtures) == 2 and all(row.get("routes")
            and any(item.get("frame", {}).get("type") == "node.session.ready" for item in row.get("wire", []))
            and any(item.get("frame", {}).get("type") == "node.session.pong" for item in row.get("wire", [])) for row in fixtures),
    }
    return checks, {"fixture_cleanups": len(fixtures), "journal_workers": len(workers),
                    "injected_worker_terminations": sum(bool(row.get("fault", {}).get("requested")) and row.get("fault", {}).get("terminationCode") == 1 for row in fixtures),
                    "program_entries": sum(len(row.get("entries", [])) for row in fixtures), "process_records": len(processes), "photos": []}


def report(attempt, result, assertions):
    links = ["result.json", "invocation.json", "source-before.json", "source-after.json", "dependencies-before.json", "dependencies-after.json",
             "runtime-before.json", "runtime-after.json", "build/build.log", "typecheck/typecheck.log", "tests/tests.log",
             "tests/vitest.json", "tests/qualification.json", "tests/mixed-failure-observations.json"]
    links = " · ".join('<a href="' + name + '">' + name + "</a>" for name in links if (attempt / name).is_file())
    rows = "".join("<tr><td>" + html.escape(row["name"]) + "</td><td>" + html.escape(row["status"]) + "</td></tr>" for row in assertions)
    (attempt / "report.html").write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Real journal failure</title>'
        '<style>body{font:16px/1.6 system-ui;max-width:1100px;margin:32px auto;padding:0 24px;color:#183048}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f6fa;padding:20px}td{padding:10px;border:1px solid #ddd}</style><h1>真实日志线程故障 — '
        + ("通过" if result["passed"] else "未通过") + "</h1><p>" + links + "</p>"
        + "<p>原生 Worker 构造参数原样转发，只终止当前 fixture 的实际日志线程。先独立观察产品自动关闭 WebSocket 与真实 CLI/guardian，再加入 bootstrap Stop 的预期失败；没有伪造收据或持久终态。</p>"
        + "<p>photos=[]：无 GUI 照片。这是 Node/SQLite/bootstrap 切片，不覆盖 main IPC、OS daemon 退出、桌面状态、installed Electron、Mac/iOS 客户端 E2E 或商用验收。接收端为真实业务代码与 PGlite，OIDC/provider 为本地 fixture。外层异常清理仍需独立运行资格。</p><table>"
        + rows + "</table><pre>" + html.escape(json.dumps(result, indent=2, ensure_ascii=False)) + "</pre></html>")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    if not parser.parse_args().execute:
        parser.error("Add --execute for this one explicit phase; no retries or automatic later phases")
    shared.PHASES["mixed-failure"] = {"files": ["validation/managed-workspaces/mixed-failure/mixed-failure.test.ts"], "counts": [2], "tests": 2,
        "directory": "mixed-failure", "fixture_prefix": "artoo-ws-journal-validation-", "evidence": "mixed-failure-observations.json", "test_timeout": 240}
    shared.PHASE_REPORTS["mixed-failure"] = {"intro": "Actual journal Worker failure and automatic bootstrap/mixed producer closure; no main IPC or installed client acceptance"}
    shared.physical_checks = physical_checks
    shared.report = report
    raise SystemExit(shared.main("mixed-failure"))
