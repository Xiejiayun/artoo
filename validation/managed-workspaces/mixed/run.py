"""One isolated real mixed-writer phase. Source prepared; runtime qualification pending."""
import argparse
from collections import Counter
import html
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
spec = importlib.util.spec_from_file_location("mixed_validation_common", HERE.parent / "run.py")
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)


def physical_checks(phase, observations, parent):
    if phase != "mixed":
        raise ValueError("Only the explicit mixed phase is supported")
    fixtures = [row for row in observations if row.get("case") == "mixed-fixture-cleanup"]
    runs = [row for row in observations if row.get("case") == "mixed-run"]
    processes = [item for fixture in fixtures for item in fixture.get("lifetimes", [])]
    entries = [item for fixture in fixtures for item in fixture.get("launches", [])]
    injection_rows = [item for fixture in fixtures for item in fixture.get("injections", [])]
    valid_pid = lambda value: type(value) is int and value > 0
    checks = {
        "two_passed_case_observations": Counter(row.get("case") for row in observations if row.get("passed") is True) == Counter(["M01", "M02"]),
        "exact_two_cleaned_owned_fixtures": len(fixtures) == 2 and len({row.get("root") for row in fixtures}) == 2
            and all(row.get("removed") is True and Path(row["root"]).parent == parent and row.get("journalClosed") is True
                    and row.get("sourceUnchanged") is True and not row.get("failures") and not row.get("dispatchErrors") for row in fixtures),
        "exact_four_then_three_actual_entries": [len(row.get("launches", [])) for row in fixtures] == [4, 3]
            and [row.get("expectedWriters") for row in fixtures] == [4, 3],
        "exact_seven_cli_guardian_pairs": Counter(item.get("role") for item in processes if item.get("role") != "git") == Counter({"cli": 7, "guardian": 7}),
        "every_process_observed_closed": bool(processes) and all(valid_pid(item.get("pid")) and all(item.get(key) for key in ("spawnedAt", "exitedAt", "closedAt", "groupAbsentAt")) for item in processes),
        "entries_match_actual_cli_spawns": len(entries) == 7 and all(valid_pid(item.get("pid")) and sum(process.get("role") == "cli" and process.get("pid") == item["pid"] for process in processes) == 1 for item in entries),
        "exact_per_run_entry_and_closure_evidence": len(runs) == 7 and len({(row.get("fixtureRoot"), row.get("command", {}).get("payload", {}).get("run_id")) for row in runs}) == 7
            and all(row.get("entry", {}).get("runId") == row.get("command", {}).get("payload", {}).get("run_id")
                    and len(row.get("physical", [])) == 2 and all(all(item.get(key) is True for key in ("exitObserved", "stdioCloseObserved", "childAbsent", "groupAbsent")) for item in row["physical"]) for row in runs),
        "exact_route_run_kinds": Counter(row.get("kind") for row in runs) == Counter({"assistant": 1, "discussion-contribution": 1, "allocated-task": 2, "ordinary-task": 3}),
        "single_socket_then_explicit_reopen": [row.get("runnerCount") for row in fixtures] == [1, 2] and [row.get("connectionCount") for row in fixtures] == [1, 2]
            and [len(set(row.get("incarnations", []))) for row in fixtures] == [1, 2],
        "eight_labelled_injections_no_new_writers_or_files": len(injection_rows) == 8
            and all(row.get("label") and isinstance(row.get("originalWireText"), str) and isinstance(row.get("injectedWireText"), str)
                    and hashlib.sha256(row["originalWireText"].encode()).hexdigest() == row.get("originalSha256")
                    and hashlib.sha256(row["injectedWireText"].encode()).hexdigest() == row.get("injectedSha256")
                    and row.get("before") == row.get("after") for row in injection_rows)
            and Counter(row.get("ack", {}).get("status") for row in injection_rows) == Counter({"accepted": 1, "rejected": 7}),
        "only_allocated_runs_have_outbox_and_physical_receipts": len(fixtures) == 2 and all(
            {row["run_id"] for row in fixture.get("finalStorage", {}).get("outbox", [])} == {row["command"]["payload"]["run_id"] for row in fixture.get("selectedRuns", []) if row.get("kind") == "allocated-task"}
            and {row["run_id"] for row in fixture.get("finalStorage", {}).get("receipts", [])} == {row["command"]["payload"]["run_id"] for row in fixture.get("selectedRuns", []) if row.get("kind") == "allocated-task"}
            and Counter(row.get("kind") for row in fixture.get("finalStorage", {}).get("receipts", [])) == Counter({"accepted": 1, "process_exit_confirmed": 1})
            and all(row.get("committed") == 1 for row in fixture.get("finalStorage", {}).get("outbox", [])) for fixture in fixtures),
        "legacy_rows_remain_identity_only": len([row for row in runs if row.get("kind") != "allocated-task"]) == 5 and all(
            row.get("snapshot", {}).get("journal", {}).get("mode") == "legacy" and row["snapshot"]["journal"].get("phase") == "admitted"
            and row["snapshot"]["journal"].get("receipt") is None and row["snapshot"]["journal"].get("finalOutcomeJson") is None
            for row in runs if row.get("kind") != "allocated-task"),
        "real_routes_wire_and_no_photos": len(fixtures) == 2 and all(row.get("routes") and row.get("wire") and row.get("photos") == [] for row in fixtures),
    }
    actual = {"fixture_cleanups": len(fixtures), "program_entries": len(entries), "per_run_evidence": len(runs),
              "cli_spawn_records": sum(row.get("role") == "cli" for row in processes), "guardian_spawn_records": sum(row.get("role") == "guardian" for row in processes),
              "process_records": len(processes), "injected_commands": len(injection_rows), "photos": []}
    return checks, actual


def report(attempt, result, assertions):
    links = ["result.json", "invocation.json", "source-before.json", "source-after.json", "dependencies-before.json", "dependencies-after.json",
             "runtime-before.json", "runtime-after.json", "build/build-result.json", "build/build.log", "typecheck/typecheck-result.json", "typecheck/typecheck.log",
             "tests/tests-result.json", "tests/tests.log", "tests/vitest.json", "tests/qualification.json", "tests/mixed-observations.json"]
    links = " · ".join('<a href="' + name + '">' + name + "</a>" for name in links if (attempt / name).is_file())
    cases = "".join("<tr><td>" + html.escape(row["name"]) + "</td><td>" + html.escape(row["status"]) + "</td></tr>" for row in assertions)
    (attempt / "report.html").write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mixed worker validation</title>'
        '<style>body{font:16px/1.6 system-ui;max-width:1100px;margin:32px auto;padding:0 24px;color:#183048}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f6fa;padding:20px}td{padding:10px;border:1px solid #ddd}</style><h1>单连接混合执行 — '
        + ("通过" if result["passed"] else "未通过") + "</h1><p>" + links + "</p>"
        + "<p>真实 HTTP 认证、设备/实例配置、普通对话、讨论贡献和任务分配；一个 NodeClient 与 qualified WebSocket 连接驱动真实 CLI/guardian 及 SQLite 日志。接收端使用生产业务路径和 PGlite；OIDC 与提供方文本为明确标记的本地 fixture。</p>"
        + "<p>讨论只执行首个真实贡献，再通过真实接口取消，没有完成或接受计划。重启负例在已认证的测试 socket 上注入已捕获命令的重复或修改版本；原始/修改哈希、实际 ACK、前后 producer 数量与文件内容保留在 JSON 中。普通日志行仅为身份栅栏，不是物理闭合证明。</p>"
        + "<p>photos=[]：本次没有 GUI 照片，不代表 Mac/iOS 原生 E2E、打包程序、真实模型、生产 PostgreSQL 或商用验收。异常清理路径仍待独立运行资格；准备失败同样保留本报告。</p><table>"
        + cases + "</table><pre>" + html.escape(json.dumps(result, indent=2, ensure_ascii=False)) + "</pre></html>")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    if not args.execute:
        parser.error("Add --execute for this one explicit phase; no retries or automatic later phases")
    # Reuse the existing nice/lock/owned-phase, full forced build, noEmit,
    # complete source+runtime inventories, bounded cleanup and failure reporting.
    shared.PHASES["mixed"] = {"files": ["validation/managed-workspaces/mixed/mixed-writer.test.ts"], "counts": [2], "tests": 2,
        "directory": "mixed", "fixture_prefix": "artoo-ws-journal-validation-", "evidence": "mixed-observations.json", "test_timeout": 240}
    shared.PHASE_REPORTS["mixed"] = {"intro": "Real mixed NodeClient and qualified receiver; local OIDC/provider fixtures; no GUI acceptance"}
    shared.physical_checks = physical_checks
    shared.report = report
    raise SystemExit(shared.main("mixed"))
