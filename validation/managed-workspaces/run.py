"""Run one repository managed phase; new wrapper runtime qualification is pending."""
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
import fcntl
import hashlib
import html
import json
import os
import pwd
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid

sys.dont_write_bytecode = True
from support.owned_phase import run_phase, write_json

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
MANAGED = HERE / "managed"
SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"
PHASE_TIMEOUT = 600
CLEANUP_TIMEOUT = 10
PHASES = {
    "live": {"files": ["validation/managed-workspaces/managed/live.git.test.ts"], "counts": [20],
             "tests": 20, "fixture_prefix": "artoo-live-journal-validation-", "evidence": "live-observations.json"},
    "ws": {"files": ["validation/managed-workspaces/managed/managed-transport.test.ts",
                     "validation/managed-workspaces/managed/managed-writer.test.ts"], "counts": [10, 16],
           "tests": 26, "fixture_prefix": "artoo-ws-journal-validation-", "evidence": "writer-observations.json"},
    "journal": {"files": ["validation/managed-workspaces/journal/journal.git.test.ts"], "counts": [11],
                "tests": 11, "directory": "journal", "test_timeout": 420,
                "fixture_prefix": "artoo-journal-validation-", "evidence": "journal-observations.json"},
    "history": {"files": ["validation/managed-workspaces/journal/history.git.test.ts"], "counts": [1],
                "tests": 1, "directory": "journal", "test_timeout": 3720, "case_timeout": 3600,
                "vitest_config": "history.vitest.config.ts",
                "fixture_prefix": "artoo-journal-validation-", "evidence": "journal-observations.json"},
    "correction": {"files": ["validation/managed-workspaces/correction/correction.git.test.ts"], "counts": [12],
                   "tests": 12, "directory": "correction", "test_timeout": 600,
                   "fixture_prefix": "artoo-journal-correction-validation-", "evidence": "journal-observations.json"},
}


PHASE_REPORTS = {'live': {'title': '实时 Node 与持久日志回归验证',
          'intro': '本阶段使用真实NodeClient、SQLite worker、canonical producer及限定Git '
                   'fixture验证实时日志与实际进程边界。收据channel和上传是明确标记的本地fixture；本阶段没有真实WebSocket或服务端接收连接。',
          'boundary': '这是本地Node与持久日志回归，没有GUI照片，不代表实际服务端接收、Mac/iOS原生E2E、打包daemon或商用资格。'},
 'ws': {'title': '持久日志与真实 WebSocket 集成验证',
        'intro': 'W用例通过真实HTTP认证、设备注册、管理员配置、任务分配和NodeBinding调度，连接实际接收服务与canonical '
                 'producer。OIDC外部提供方、上传和明确标记的网络故障是本地fixture。T01连接实际接收端；T02–T10的协议对端是脚本fixture，不是qualified receiver。',
        'boundary': '这是后端与Node连接集成切片，没有GUI照片，不代表Mac/iOS原生E2E、打包daemon、生产OIDC或商用资格。原生流程与照片由root的独立E2E报告审核。'},
 'journal': {'title': '持久日志基础11项与真实进程边界验证',
             'intro': '11个基础用例使用独立SQLite客户端、真实Git及canonical producer。独立history阶段保留原10000条真实API历史用例；交付回执是本地fixture。',
             'boundary': '源码要求5个physical边界与4组CLI/guardian。3条正常路径等待ready；实际program_entries仍为null。家族验收还要求history通过且完整source/runtime inventories完全相同；本阶段不单独代表完整家族、服务端或GUI验收。'},
 'history': {'title': '10000条真实日志历史独立验证',
             'intro': '一个原始用例在真实producer闭合后，通过父进程逐条调用现有append、live-claim和精确live-receipt命令完成10000条历史；不直接写入SQL或声称真实服务端接受。',
             'boundary': '源码要求1个physical边界、1组CLI/guardian和1条ready等待路径；没有durable settlement，实际program_entries为null。3600秒case/3720秒phase只是有限工作预算，不是性能SLA。家族验收还要求journal11通过且完整source/runtime inventories完全相同。'},
 'correction': {'title': '已闭合日志交付修正验证',
                'intro': '12个用例验证真实物理settlement后的有限claim、精确回执、修正、重启和实际30秒窗口。SQL故障、交付结果及两种非成功settlement策略是明确标记的fixture。',
                'boundary': '源码要求14个真实physical边界与14组CLI/guardian。14条路径等待ready，但现有receipt未独立保留program-entry证据，实际entry数量记为null；不代表真实服务器交付或GUI验收。'}}


def exact_title_inventory(expected, files):
    """Full-name multisets are compared per file; duplicate each-titles count."""
    actual = {}
    for file in files:
        name = str(Path(file['name']).resolve())
        if name in actual: return False
        titles = [case.get('fullName') for case in file.get('assertionResults', [])]
        if any(not isinstance(title, str) or not title for title in titles): return False
        actual[name] = Counter(titles)
    return actual == {name: Counter(titles) for name, titles in expected.items()}


def physical_checks(phase, observations, parent):
    cleanup_case = 'writer-fixture-cleanup' if phase == 'ws' else 'fixture-cleanup'
    fixtures = [row for row in observations if row.get('case') == cleanup_case]
    physical = [row for row in fixtures if row.get('expectedWriters') == 1]
    expected_fixtures, expected_writers = (16, 16) if phase == 'ws' else (20, 18)
    all_processes = [p for row in fixtures for p in row.get('lifetimes', [])]
    checks = {
        'exact_fixture_cleanups': len(fixtures) == expected_fixtures and len({row.get('root') for row in fixtures}) == expected_fixtures,
        'owned_fixtures_removed': bool(fixtures) and all(row.get('removed') is True and Path(row['root']).parent == parent for row in fixtures),
        'all_journals_closed_and_sources_unchanged': bool(fixtures) and all(row.get('journalClosed') is True and row.get('sourceUnchanged') is True for row in fixtures),
        'exact_writer_fixtures': len(physical) == expected_writers,
        'one_cli_and_guardian_per_writer': len(physical) == expected_writers and all(
            len([p for p in row.get('lifetimes', []) if p.get('role') == 'cli']) == 1 and
            len([p for p in row.get('lifetimes', []) if p.get('role') == 'guardian']) == 1 for row in physical),
        'every_owned_process_closed': bool(all_processes) and all(type(p.get('pid')) is int and p['pid'] > 0 and
            p.get('exitedAt') and p.get('closedAt') and p.get('groupAbsentAt') for p in all_processes),
        'entries_match_real_spawn_records': all(type(entry.get('pid')) is int and entry['pid'] > 0 and
            any(p.get('role') == 'cli' and p.get('pid') == entry['pid'] for p in row.get('lifetimes', []))
            for row in physical for entry in row.get('launches', [])),
    }
    if phase == 'ws':
        checks['sixteen_actual_program_entries'] = len(physical) == 16 and all(len(row.get('launches', [])) == 1 for row in physical)
        checks['sixteen_passed_w_case_observations'] = {row.get('case') for row in observations if row.get('passed') is True} == {f'W{i:02d}' for i in range(1, 17)}
        checks['real_routes_and_wire_observed'] = len(physical) == 16 and all(row.get('routes') and row.get('wire') for row in physical)
    else:
        mandatory = [row for row in physical if row.get('expectProgramLaunch') is True]
        optional = [row for row in physical if row.get('expectProgramLaunch') is False]
        checks['seventeen_required_program_entries'] = len(mandatory) == 17 and all(len(row.get('launches', [])) == 1 for row in mandatory)
        checks['one_optional_preentry_startup_abort'] = len(optional) == 1 and len(optional[0].get('launches', [])) in (0, 1)
        zero = [row for row in fixtures if row.get('expectedWriters') == 0]
        checks['two_no_writer_boundaries'] = len(zero) == 2 and all(not row.get('launches') and not [p for p in row.get('lifetimes', []) if p.get('role') != 'git'] for row in zero)
    actual = {'fixture_cleanups': len(fixtures), 'cli_spawn_records': sum(p.get('role') == 'cli' for p in all_processes),
              'guardian_spawn_records': sum(p.get('role') == 'guardian' for p in all_processes),
              'program_entries': sum(len(row.get('launches', [])) for row in physical), 'process_records': len(all_processes)}
    return checks, actual


def journal_physical_checks(phase, observations, parent):
    """Verify retained journal-family receipts; never infer program entries."""
    fixtures = [row for row in observations if row.get("case") == "fixture-cleanup"]
    records = [row for row in observations if "physical" in row]
    physical = [row["physical"] for row in records]
    expected_cases = (
        ["real-started-unsettled-reopen", "atomic-genuine-terminal", "actual-startup-cancellation",
         "not-spawned-is-not-global-absence", "output-sequence-replay"]
        if phase == "journal" else ["backlog-after-acknowledged-history"] if phase == "history" else ["physical:" + name for name in
            ["hold", "exposure", "concurrent", "budget", "timeout", "crashreply", "rollback", "authority",
             "failed", "cancelled", "capacity", "sequence", "clock", "clock-already-claimed"]])
    expected_boundaries, expected_pairs, expected_ready_paths = (5, 4, 3) if phase == "journal" else (1, 1, 1) if phase == "history" else (14, 14, 14)
    expected_fixtures = 11 if phase == "journal" else 1 if phase == "history" else 12
    expected_settlements = 2 if phase == "journal" else 0 if phase == "history" else 14
    clients = [client for fixture in fixtures for client in fixture.get("clients", [])]
    lifetimes = [row for item in physical for row in item.get("lifetimes", [])]
    normal = [item for item in physical if item.get("case") in {"real-producer-not-settled", "real-producer-settled"}]
    spawned = [item for item in physical if item.get("case") != "startup-not-spawned"]
    settled = [item["settled"] for item in physical if item.get("settled")]
    valid_pid = lambda value: type(value) is int and value > 0
    checks = {
        "exact_fixture_cleanups_confirmed": len(fixtures) == expected_fixtures and len({row.get("root") for row in fixtures}) == expected_fixtures
            and all(row.get("confirmed") is True and row.get("removed") is True and Path(row["root"]).parent == parent
                    and not row.get("error") and row.get("clients") for row in fixtures),
        "every_fixture_client_closed": bool(clients) and all(valid_pid(client.get("lifetime", {}).get("pid"))
            and all(client["lifetime"].get(key) for key in ["spawnedAt", "exitedAt", "closedAt", "childAbsentAt", "groupAbsentAt"])
            and client["lifetime"].get("signal") is None for client in clients),
        "exact_physical_case_inventory": Counter(row.get("case") for row in records) == Counter(expected_cases),
        "physical_boundaries_confirmed": len(physical) == expected_boundaries and all(
            row.get("physicalCleanupConfirmed") is True and row.get("sourceUnchanged") is True for row in physical),
        # Physical JSON is evidence, not authority. Its exact reply must belong
        # to one client of an independently closed, owned fixture in this run.
        "physical_replies_belong_to_owned_fixtures": bool(physical) and all(sum(any(
            reply.get("ok") is True and reply.get("value") == item
            for client in fixture.get("clients", []) for reply in client.get("replies", []))
            for fixture in fixtures) == 1 for item in physical),
        "exact_cli_and_guardian_pairs": len(spawned) == expected_pairs and all(
            len([row for row in item.get("lifetimes", []) if row.get("role") == "cli"]) == 1
            and len([row for row in item.get("lifetimes", []) if row.get("role") == "guardian"]) == 1
            for item in spawned),
        "every_physical_lifetime_closed": bool(lifetimes) and all(valid_pid(row.get("pid"))
            and row.get("exit") and row.get("close") for row in lifetimes),
        "physical_passive_snapshots_cover_all_processes": bool(physical) and all(
            item.get("closureObservation", {}).get("processes")
            and Counter((row.get("role"), row.get("pid")) for row in item.get("lifetimes", []))
                == Counter((row.get("role"), row.get("pid")) for row in item["closureObservation"]["processes"])
            and all(valid_pid(row.get("pid")) and row.get("exit") and row.get("close")
                    and row.get("childAbsent") is True and row.get("groupAbsent") is True
                    for row in item["closureObservation"]["processes"]) for item in physical),
        "normal_physical_start_and_closure_receipts": len(normal) == expected_ready_paths and all(
            item.get("started", {}).get("phase") == "started"
            and item["started"].get("receipt", {}).get("kind") == "accepted"
            and item.get("terminal", {}).get("payload", {}).get("phase") == "completed"
            and item.get("actualProof", {}).get("kind") == "confirmed_closed"
            and item["actualProof"].get("facts", {}).get("childSpawned") is True
            and all(row.get("code") == 0 and row.get("signal") is None
                    for row in item.get("lifetimes", []) if row.get("role") == "guardian") for item in normal),
        "durable_physical_settlements_retained": len(settled) == expected_settlements and all(
            row.get("phase") == "closed" and row.get("ownership") == "fenced" and row.get("stopRequested") is True
            and row.get("receipt", {}).get("kind") == "process_exit_confirmed" and row.get("finalOutcomeJson")
            for row in settled),
    }
    if phase == "journal":
        stopped = [item for item in physical if item.get("case") == "startup-cancel"]
        absent = [item for item in physical if item.get("case") == "startup-not-spawned"]
        checks["journal_physical_modes_match"] = Counter(item.get("case") for item in physical) == Counter(
            {"real-producer-not-settled": 2, "real-producer-settled": 1, "startup-cancel": 1, "startup-not-spawned": 1})
        checks["startup_cancellation_has_genuine_settlement_without_started"] = len(stopped) == 1 and stopped[0].get("actualWriterChildren") == 1 \
            and stopped[0].get("noStartedEvent") is True and stopped[0].get("settled", {}).get("receipt", {}).get("kind") == "process_exit_confirmed"
        checks["not_spawned_does_not_invent_execution_or_settlement"] = len(absent) == 1 and absent[0].get("actualWriterChildren") == 0 \
            and absent[0].get("noStartedEvent") is True and not absent[0].get("settled") \
            and all(row.get("role") == "git" for row in absent[0].get("lifetimes", []))
        checks["unsettled_runs_have_no_durable_settlement"] = all(not item.get("settled") for item in normal if item["case"] == "real-producer-not-settled")
        checks["journal_settled_outcomes_preserved"] = sorted(
            json.loads(row["finalOutcomeJson"])["terminal"]["payload"]["phase"] for row in settled) == ["cancelled", "completed"]
    elif phase == "history":
        checks["history_one_genuine_unsettled_writer"] = len(normal) == 1 and len(physical) == 1 \
            and normal[0].get("case") == "real-producer-not-settled" and not normal[0].get("settled")
        history_rows = [row for row in records if row.get("case") == "backlog-after-acknowledged-history"]
        progress = [row for row in observations if row.get("case") == "history-workload-progress"]
        expected_history = {"appended": 10000, "claimed": 10000, "receiptsRecorded": 10000,
                            "directSqlCommittedRows": 0, "firstSequence": 0, "lastSequence": 9999,
                            "serverAcceptanceClaimed": False}
        checks["history_full_workload_and_final_assertions"] = len(history_rows) == 1 and len(progress) == 1 \
            and history_rows[0].get("history") == expected_history and progress[0].get("history") == expected_history \
            and progress[0].get("status") == "completed" and progress[0].get("finalAssertionsPassed") is True \
            and progress[0].get("fixtureCleanupCompleted") is True \
            and history_rows[0].get("appended", {}).get("sequence") == 10000
        # Existing raw replies are linked in JSON, never duplicated into HTML.
        values = [reply["value"] for client in clients for reply in client.get("replies", [])
                  if reply.get("ok") is True and isinstance(reply.get("value"), dict)]
        appended = [value for value in values if isinstance(value.get("eventId"), str)
                    and value["eventId"].startswith("acknowledged-fixture-")]
        claims = [value for value in values if value.get("kind") == "claimed"]
        receipts = [value for value in values if value == {"state": "pending", "abort": None}]
        checks["history_10000_actual_append_claim_receipt_results"] = len(appended) == len(claims) == len(receipts) == 10000 \
            and all(event.get("sequence") == index and event.get("eventId") == f"acknowledged-fixture-{index}"
                    for index, event in enumerate(appended)) \
            and all(claim.get("event") == event and isinstance(claim.get("attemptId"), str) and claim["attemptId"]
                    for claim, event in zip(claims, appended)) \
            and len({claim.get("attemptId") for claim in claims}) == 10000
    else:
        policy = [item for item in physical if item.get("settlementPolicyFixture") is True]
        checks["all_correction_runs_have_real_closed_settlement"] = len(normal) == 14 and all(
            item.get("case") == "real-producer-settled" and item.get("settled", {}).get("phase") == "closed"
            and item["settled"].get("ownership") == "fenced" and item["settled"].get("stopRequested") is True
            and item["settled"].get("receipt", {}).get("kind") == "process_exit_confirmed" for item in physical)
        checks["two_explicit_settlement_policy_fixtures"] = len(policy) == 2 and sorted(
            json.loads(item["settled"]["finalOutcomeJson"])["terminal"]["payload"]["phase"] for item in policy) == ["cancelled", "failed"]
    actual = {"fixture_cleanups": len(fixtures), "fixture_clients": len(clients), "physical_boundaries": len(physical),
              "cli_spawn_records": sum(row.get("role") == "cli" for row in lifetimes),
              "guardian_spawn_records": sum(row.get("role") == "guardian" for row in lifetimes),
              "process_records": len(lifetimes), "program_entries": None,
              "program_entry_evidence": "Not independently retained by these fixtures; spawn/startup receipts are not program-entry receipts",
              "source_expectations": {"physical_boundaries": expected_boundaries, "cli_guardian_pairs": expected_pairs,
                                      "required_ready_wait_paths": expected_ready_paths}}
    return checks, actual


def stamp():
    return datetime.now(timezone.utc).isoformat()


def pin(path, deadline=None):
    """Hash content, mode and link identity without trusting an old inventory."""
    path = Path(path)
    before = path.lstat()
    mode = oct(stat.S_IMODE(before.st_mode))
    if stat.S_ISLNK(before.st_mode):
        value = os.readlink(path)
        return {"kind": "symlink", "target": value, "resolved": str(path.resolve()), "mode": mode}
    if not stat.S_ISREG(before.st_mode):
        raise ValueError("Input is not a regular file: " + str(path))
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError("Input inventory exceeded its finite 600 second budget")
            block = handle.read(1024 * 1024)
            if not block:
                break
            digest.update(block)
    after = path.lstat()
    identity = lambda row: (row.st_dev, row.st_ino, row.st_size, row.st_mtime_ns, row.st_mode)
    if identity(before) != identity(after):
        raise ValueError("Input changed while hashing: " + str(path))
    return {"kind": "file", "bytes": after.st_size, "sha256": digest.hexdigest(), "mode": mode}


def source_inventory(env):
    def git(*args):
        return subprocess.run(["/usr/bin/git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
                               *args], cwd=ROOT, env=env, check=True, capture_output=True, timeout=10).stdout
    names = git("ls-files", "--cached", "--others", "--exclude-standard", "-z").decode().split("\0")
    deadline = time.monotonic() + 600
    files = {}
    for name in sorted(set(filter(None, names))):
        if name.startswith("artifacts/"):
            continue
        path = ROOT / name
        files[name] = pin(path, deadline) if path.exists() or path.is_symlink() else {"kind": "missing"}
    return {"head": git("rev-parse", "HEAD").decode().strip(), "files": files}


def project_graph():
    """The same root references passed to the complete TypeScript build."""
    projects = {}
    def visit(config):
        config = config.resolve(strict=True)
        config.relative_to(ROOT)
        if config in projects:
            return
        value = json.loads(config.read_text())
        projects[config] = value
        for reference in value.get("references", []):
            child = config.parent / reference["path"]
            visit(child / "tsconfig.json" if child.is_dir() else child)
    visit(ROOT / "tsconfig.json")
    outputs = []
    for config, value in projects.items():
        output = value.get("compilerOptions", {}).get("outDir")
        if output:
            path = config.parent / output
            path.relative_to(ROOT)
            if path.resolve() != path:
                raise ValueError("Build output must be a plain repository path: " + str(path))
            outputs.append(path)
    if not outputs:
        raise ValueError("Root TypeScript graph has no output projects")
    return sorted(projects), sorted(outputs)


def tree_inventory(directory, deadline, *, dependency_tree=False, linked_roots=()):
    """Record all files and links; never walk a linked workspace source tree."""
    if not directory.is_dir() or directory.is_symlink():
        raise ValueError("Expected an existing plain directory: " + str(directory))
    rows = {}
    for current, directories, files in os.walk(directory, followlinks=False):
        if time.monotonic() >= deadline:
            raise TimeoutError("Input inventory exceeded its finite 600 second budget")
        current = Path(current)
        # Build/test caches belong to the attempt or configured artifacts cache.
        # They are not executable dependency inputs.
        directories[:] = sorted(name for name in directories if name not in {".cache", ".vite", "__pycache__"})
        for name in sorted(files + [name for name in directories if (current / name).is_symlink()]):
            path = current / name
            if path.is_symlink():
                resolved = path.resolve(strict=True)
                try:
                    resolved.relative_to(directory)
                except ValueError:
                    pinned_dependency = dependency_tree and any(resolved.is_relative_to(root) for root in linked_roots)
                    workspace_link = dependency_tree and (path.parent.name == "@artoo") and (
                        resolved.parent in {ROOT / "apps", ROOT / "packages"})
                    if not pinned_dependency and not workspace_link:
                        raise ValueError("Runtime link escapes its pinned tree: " + str(path))
            rows[str(path.relative_to(ROOT))] = pin(path, deadline)
    return rows


def dependency_inventory(node, configs):
    deadline = time.monotonic() + 600
    directories = {ROOT / "node_modules"}
    directories.update(config.parent / "node_modules" for config in configs if (config.parent / "node_modules").exists())
    files = {}
    for directory in sorted(directories):
        files.update(tree_inventory(directory, deadline, dependency_tree=True, linked_roots=directories))
    tools = {str(path): pin(path, deadline) for path in sorted({node, Path(sys.executable).resolve(),
                                                              Path("/usr/bin/git"), Path("/bin/ps")})}
    return {"tools": tools, "installed_files": files}


def compiled_inventory(outputs):
    deadline = time.monotonic() + 600
    files = {}
    for output in outputs:
        rows = tree_inventory(output, deadline)
        if not rows:
            raise ValueError("Compiled project output is empty: " + str(output))
        files.update(rows)
        for cache in output.parent.glob("*.tsbuildinfo"):
            files[str(cache.relative_to(ROOT))] = pin(cache, deadline)
    required = ["apps/artood/dist/node-client.js", "apps/artood/dist/process-adapter.js",
                "apps/artood/dist/managed/journal.js", "apps/artood/dist/managed/journal-worker.js",
                "apps/artood/dist/managed/managed-node-runner.js", "apps/artood/dist/managed/managed-ws-transport.js",
                "apps/server/dist/test-support.js", "apps/server/dist/services/run-event-receipt.js"]
    for name in required:
        if files.get(name, {}).get("kind") != "file":
            raise ValueError("Required freshly built module is absent: " + name)
    return files


def journal_harness_inventory(phase):
    """Pin the complete generated family tree, including any cache-like paths."""
    directory = HERE / PHASES[phase]["directory"] / "dist"
    if not directory.is_dir() or directory.is_symlink() or directory.resolve() != directory:
        raise ValueError("Harness output must be an existing plain family dist directory")
    deadline = time.monotonic() + PHASE_TIMEOUT
    files = {}
    for current, directories, names in os.walk(directory, followlinks=False):
        if time.monotonic() >= deadline:
            raise TimeoutError("Harness inventory exceeded its finite 600 second budget")
        current = Path(current)
        directories.sort()
        for name in sorted(names + [name for name in directories if (current / name).is_symlink()]):
            path = current / name
            if path.is_symlink():
                path.resolve(strict=True).relative_to(directory)
            files[str(path.relative_to(ROOT))] = pin(path, deadline)
    for name in ["journal-child.mjs", "child-bundle-inputs.json"]:
        if files.get(str((directory / name).relative_to(ROOT)), {}).get("kind") != "file":
            raise ValueError("Fresh harness bundle output is absent: " + name)
    return files


def expected_inventory(phase):
    spec = PHASES[phase]
    path = HERE / spec.get("directory", "managed") / "title-inventory.json"
    inventory = json.loads(path.read_text())
    if inventory.get("schema_version") != 1:
        raise ValueError("Expected-title inventory version differs")
    selected = inventory["phases"][phase]
    files = selected["files"]
    if selected.get("expected_total_tests") != spec["tests"] or set(files) != set(spec["files"]):
        raise ValueError("Expected-title phase/files/count differs")
    for name, count in zip(spec["files"], spec["counts"]):
        titles = files[name]
        if not isinstance(titles, list) or len(titles) != count or any(not isinstance(t, str) or not t for t in titles):
            raise ValueError("Expected-title list differs")
        if len(set(titles)) != count:
            raise ValueError("Duplicate expected titles are not allowed in these phases")
    return {str((ROOT / name).resolve()): titles for name, titles in files.items()}


def verify_parent(parent, identity, marker):
    current = parent.lstat()
    if not stat.S_ISDIR(current.st_mode) or parent.is_symlink() or parent.resolve() != parent:
        raise ValueError("Fixture parent is not a plain physical directory")
    if (current.st_dev, current.st_ino) != identity or current.st_uid != os.getuid() or stat.S_IMODE(current.st_mode) != 0o700:
        raise ValueError("Fixture parent identity/owner/mode changed")
    owner = parent / ".validation-owner"
    value = owner.lstat()
    if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_uid != os.getuid() or stat.S_IMODE(value.st_mode) != 0o600:
        raise ValueError("Fixture owner marker identity changed")
    if owner.read_text() != marker:
        raise ValueError("Fixture owner marker differs")


def qualify(phase, attempt, result, assertions, expected_titles, parent):
    spec = PHASES[phase]
    directory = attempt / "tests"
    raw = json.loads((directory / "vitest.json").read_text())
    files = raw.get("testResults", [])
    for file in files:
        for case in file.get("assertionResults", []):
            assertions.append({"name": case.get("fullName", case.get("title", "")), "status": case.get("status", "unknown")})
    statuses = Counter(case["status"] for case in assertions)
    expected_files = {str((ROOT / path).resolve()): count for path, count in zip(spec["files"], spec["counts"])}
    actual_files = {str(Path(file["name"]).resolve()): len(file.get("assertionResults", [])) for file in files}
    process = result["process"]
    checks = {"actual_process_exit_zero_and_closed": process["passed"] is True and process["receipt_written"] is True,
              "exact_files_and_counts": actual_files == expected_files and len(files) == len(expected_files),
              "exact_title_inventory_per_file": exact_title_inventory(expected_titles, files),
              "exact_passed_assertions": len(assertions) == spec["tests"] and statuses.get("passed") == spec["tests"],
              "report_success": raw.get("success") is True,
              "exact_summary_counts": raw.get("numTotalTests") == spec["tests"] and raw.get("numPassedTests") == spec["tests"],
              "no_failed_pending_todo": all(raw.get(key) == 0 for key in ("numFailedTests", "numPendingTests", "numTodoTests"))}
    result["actual_summary"] = {"assertion_statuses": dict(statuses), "reported_tests": len(assertions)}
    result["checks"].update(checks)
    evidence = json.loads((directory / spec["evidence"]).read_text())
    observations = evidence if isinstance(evidence, list) else evidence.get("observations", [])
    verifier = journal_physical_checks if phase in {"journal", "history", "correction"} else physical_checks
    extra, actual = verifier(phase, observations, parent)
    result["checks"].update(extra)
    result["actual_summary"].update(actual)
    if phase == "history":
        progress = [row for row in observations if row.get("case") == "history-workload-progress"]
        result["history_progress"] = progress[0] if len(progress) == 1 else {"error": "Missing or duplicate history progress"}
    if phase == "ws":
        result["checks"]["transport_evidence_present"] = (directory / "transport-observations.json").is_file()
    result["checks"]["owned_parent_marker_only"] = sorted(path.name for path in parent.iterdir()) == [".validation-owner"]
    result["counts"] = {key: raw.get(key) for key in ("numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests", "numTodoTests")}
    write_json(directory / "qualification.json", {"scope": "Phase assertions only; result.json owns final input stability and parent cleanup acceptance",
                                               "checks": result["checks"], "actual_summary": result["actual_summary"],
                                               "passed": all(result["checks"].values())})
    result["qualification_complete"] = True


def report(attempt, result, assertions):
    description = PHASE_REPORTS[result["phase"]]
    rows = "".join("<tr><td>" + html.escape(str(row["name"])) + "</td><td>" + html.escape(str(row["status"])) + "</td></tr>" for row in assertions)
    links = ["result.json", "invocation.json", "source-before.json", "source-after.json",
             "dependencies-before.json", "runtime-before.json", "runtime-after.json",
             "build/build-result.json", "build/build.log", "typecheck/typecheck-result.json", "typecheck/typecheck.log",
             "child-build/child-build-result.json", "child-build/child-build.log",
             "tests/tests-result.json", "tests/tests.log", "tests/vitest.json", "tests/qualification.json",
             "tests/live-observations.json", "tests/writer-observations.json", "tests/transport-observations.json",
             "tests/journal-observations.json", "tests/history-progress.json"]
    links = " · ".join('<a href="' + html.escape(name) + '">' + html.escape(name) + "</a>" for name in links if (attempt / name).is_file())
    status = "通过" if result["passed"] else "未通过"
    (attempt / "report.html").write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'
        + html.escape(description["title"]) + '</title><style>body{font:16px/1.6 system-ui;max-width:1200px;margin:32px auto;padding:0 24px;color:#183048}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f6fa;padding:20px}table{border-collapse:collapse;width:100%}td{padding:8px;border:1px solid #ccd6df}a{color:#1759b8}</style><h1>'
        + html.escape(description["title"]) + " — " + status + "</h1><p>记录本次尝试的实际结果；计划数量不替代执行数量，准备失败也保留报告。</p><p>"
        + html.escape(description["intro"]) + "</p><p>" + links + "</p><p>" + html.escape(description["boundary"])
        + "</p><p>本报告没有 GUI 照片。新外层脚本的异常清理路径尚未取得运行资格。</p><table>" + rows
        + "</table><pre>" + html.escape(json.dumps(result, indent=2, ensure_ascii=False)) + "</pre></html>")


def main(phase):
    if phase not in PHASES:
        raise ValueError("Choose exactly live, ws, journal, history or correction; phases never auto-chain or retry")
    spec = PHASES[phase]
    family = HERE / spec.get("directory", "managed")
    reports = ROOT / "artifacts/managed-workspaces"
    if reports.resolve() != reports:
        raise ValueError("Report directory must be inside the plain repository path")
    attempt = reports / (datetime.now(timezone.utc).strftime("attempt-%Y%m%dT%H%M%SZ-") + phase + "-" + uuid.uuid4().hex[:8])
    attempt.mkdir(parents=True, mode=0o700)
    result = {"phase": phase, "passed": False, "runtime_attempt": True, "started_at": stamp(),
              "runner_pid": os.getpid(), "phase_scope": PHASE_REPORTS[phase]["intro"], "errors": [], "checks": {},
              "phase_receipts": {}, "parent_removed": False, "photos": [],
              "exceptional_wrapper_cleanup_runtime_qualified": False}
    if phase in {"journal", "history"}:
        result["journal_family_acceptance"] = {"required_phases": ["journal", "history"], "this_report_only": phase,
                                               "identical_full_source_and_runtime_inventories_required": True,
                                               "combined_acceptance": "not_assessed"}
    assertions = []
    parent = parent_identity = lock = node = configs = outputs = None
    sources_before = dependencies_before = runtime_before = None
    marker = uuid.uuid4().hex
    env = {"PATH": SYSTEM_PATH, "LANG": "C", "LC_ALL": "C", "CI": "1", "NO_COLOR": "1",
           "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0"}
    invocation = {"phase": phase, "root": str(ROOT), "attempt": str(attempt), "commands": {},
                  "phase_timeout_seconds": spec.get("test_timeout", PHASE_TIMEOUT), "cleanup_timeout_seconds": CLEANUP_TIMEOUT,
                  "build_timeout_seconds": PHASE_TIMEOUT, "typecheck_timeout_seconds": PHASE_TIMEOUT,
                  "scope": "One explicit phase; forced build and noEmit first; no retry, installation or implicit later phase"}
    print(json.dumps({"attempt": str(attempt), "phase": phase}), flush=True)

    def owned(name, argv, child_env, timeout=PHASE_TIMEOUT):
        directory = attempt / name
        directory.mkdir()
        invocation["commands"][name] = argv
        write_json(attempt / "invocation.json", invocation)
        receipt = run_phase(name, argv, cwd=ROOT, env=child_env, output_dir=directory,
                            phase_timeout_s=timeout, cleanup_timeout_s=CLEANUP_TIMEOUT)
        result["phase_receipts"][name] = receipt
        result["checks"][name + "_process_zero_closed"] = receipt["passed"] is True and receipt["receipt_written"] is True
        if not result["checks"][name + "_process_zero_closed"] and name != "tests":
            raise RuntimeError(name + " failed or owned closure is uncertain; later commands were not started")
        return receipt

    try:
        if sys.platform != "darwin" or sys.version_info < (3, 10):
            raise ValueError("This physical validation requires macOS and Python 3.10 or newer")
        result["runner_nice"] = os.getpriority(os.PRIO_PROCESS, 0)
        if result["runner_nice"] != 10:
            raise ValueError("Invoke with nice -n 10 exactly once")
        descriptor = os.open(reports / ".run.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        lock = os.fdopen(descriptor, "r+")
        if not stat.S_ISREG(os.fstat(descriptor).st_mode) or os.fstat(descriptor).st_uid != os.getuid():
            raise ValueError("Checkout lock is not an owned regular file")
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for name in ("home", "cache", "xdg-cache"):
            (attempt / name).mkdir(mode=0o700)
        account = pwd.getpwuid(os.getuid()).pw_name
        env.update(HOME=str(attempt / "home"), USER=account, LOGNAME=account, NODE_OPTIONS="",
                   NODE_COMPILE_CACHE=str(attempt / "cache"), XDG_CACHE_HOME=str(attempt / "xdg-cache"))
        sources_before = source_inventory(env)
        write_json(attempt / "source-before.json", sources_before)
        selected = shutil.which("node", path=os.environ.get("PATH", ""))
        if not selected:
            raise ValueError("Node 24.19.0 must be available as node on PATH")
        node = Path(selected).resolve(strict=True)
        env["PATH"] = str(node.parent) + ":" + SYSTEM_PATH
        version = subprocess.run([str(node), "--version"], cwd=ROOT, env=env, check=True,
                                 capture_output=True, text=True, timeout=10).stdout.strip()
        if version != "v24.19.0":
            raise ValueError("Expected Node v24.19.0; found " + version)
        tsc = ROOT / "node_modules/typescript/bin/tsc"
        vitest = ROOT / "node_modules/vitest/vitest.mjs"
        if not tsc.is_file() or not vitest.is_file():
            raise ValueError("Install the project dependencies separately before validation")
        configs, outputs = project_graph()
        expected_titles = expected_inventory(phase)
        dependencies_before = dependency_inventory(node, configs)
        write_json(attempt / "dependencies-before.json", dependencies_before)
        parent = Path(tempfile.mkdtemp(prefix=spec["fixture_prefix"], dir="/private/tmp"))
        status = parent.lstat()
        parent_identity = (status.st_dev, status.st_ino)
        fd = os.open(parent / ".validation-owner", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write(marker)
        verify_parent(parent, parent_identity, marker)
        env.update(TMPDIR=str(parent), TMP=str(parent), TEMP=str(parent))
        result.update(fixture_parent=str(parent), fixture_parent_identity=parent_identity)
        invocation.update(node=str(node), node_version=version, expected_files=spec["files"], expected_tests=spec["tests"],
                          expected_titles=expected_titles, title_inventory_pin=pin(family / "title-inventory.json"),
                          environment=env, build_outputs=[str(path.relative_to(ROOT)) for path in outputs],
                          per_case_timeout_seconds=spec.get("case_timeout", 90), hook_timeout_seconds=20)
        owned("build", [str(node), str(tsc), "-b", "--force"], env)
        if source_inventory(env) != sources_before:
            raise ValueError("Source changed during the complete forced build")
        owned("typecheck", [str(node), str(tsc), "-p", str(family / "tsconfig.json"), "--noEmit"], env)
        if phase in {"journal", "history", "correction"}:
            owned("child-build", [str(node), str(family / "build-child.mjs")], env)
        runtime_before = {"compiled": compiled_inventory(outputs), "dependencies": dependency_inventory(node, configs)}
        if phase in {"journal", "history", "correction"}:
            runtime_before["harness"] = journal_harness_inventory(phase)
        write_json(attempt / "runtime-before.json", runtime_before)
        result["checks"]["source_unchanged_through_build"] = source_inventory(env) == sources_before
        result["checks"]["dependencies_unchanged_through_build"] = runtime_before["dependencies"] == dependencies_before
        if not all(result["checks"].values()):
            raise ValueError("Build input stability failed; tests were not started")
        verify_parent(parent, parent_identity, marker)
        if phase in {"journal", "history", "correction"}:
            test_env = dict(env, ARTOO_JOURNAL_REPORT_DIR=str(attempt / "tests"))
        else:
            test_env = dict(env, ARTOO_MANAGED_VALIDATION_PHASE=phase, ARTOO_NODE_PHYSICAL_REPORT_DIR=str(attempt / "tests"))
        invocation["test_environment"] = test_env
        process = owned("tests", [str(node), str(vitest), "run", "--config", str(family / spec.get("vitest_config", "vitest.config.ts"))],
                        test_env, spec.get("test_timeout", PHASE_TIMEOUT))
        result["process"] = process
        qualify(phase, attempt, result, assertions, expected_titles, parent)
    except BaseException as error:
        result["errors"].append({"where": "orchestration", "type": type(error).__name__, "message": str(error)})
    finally:
        try:
            if sources_before is not None:
                after = source_inventory(env)
                write_json(attempt / "source-after.json", after)
                result["checks"]["source_inputs_unchanged"] = after == sources_before
            if dependencies_before is not None:
                dependencies_after = dependency_inventory(node, configs)
                write_json(attempt / "dependencies-after.json", dependencies_after)
                result["checks"]["dependency_inputs_unchanged"] = dependencies_after == dependencies_before
            if runtime_before is not None:
                after = {"compiled": compiled_inventory(outputs), "dependencies": dependencies_after}
                if phase in {"journal", "history", "correction"}:
                    after["harness"] = journal_harness_inventory(phase)
                write_json(attempt / "runtime-after.json", after)
                result["checks"]["runtime_inputs_unchanged"] = after == runtime_before
        except BaseException as error:
            result["errors"].append({"where": "input_audit", "type": type(error).__name__, "message": str(error)})
        may_remove = bool(result.get("qualification_complete") and result["checks"] and all(result["checks"].values()) and not result["errors"])
        try:
            if parent is not None:
                verify_parent(parent, parent_identity, marker)
                entries = sorted(path.name for path in parent.iterdir())
                result["parent_entries_before_cleanup"] = entries
                if may_remove and entries == [".validation-owner"]:
                    write_json(attempt / "before-parent-removal.json", result)
                    (parent / ".validation-owner").unlink()
                    try:
                        parent.rmdir()
                    except BaseException:
                        status = parent.lstat()
                        if not parent.is_symlink() and (status.st_dev, status.st_ino) == parent_identity:
                            fd = os.open(parent / ".validation-owner", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                            with os.fdopen(fd, "w") as handle:
                                handle.write(marker)
                        raise
                    result["parent_removed"] = True
        except BaseException as error:
            result["errors"].append({"where": "parent_cleanup", "type": type(error).__name__, "message": str(error)})
        result["passed"] = bool(may_remove and result["parent_removed"] and not result["errors"])
        result["finished_at"] = stamp()
        try:
            write_json(attempt / "invocation.json", invocation)
            write_json(attempt / "result.json", result)
            report(attempt, result, assertions)
        except BaseException as error:
            result["passed"] = False
            result["errors"].append({"where": "report", "type": type(error).__name__, "message": str(error)})
            try:
                write_json(attempt / "result.json", result)
            except BaseException:
                pass
            try:
                # Still try a minimal failure HTML if a prior JSON/report write failed.
                report(attempt, result, [])
            except BaseException:
                pass
        finally:
            if lock is not None:
                lock.close()
        print(json.dumps({"attempt": str(attempt), "phase": phase, "passed": result["passed"],
                          "actual_summary": result.get("actual_summary"), "errors": result["errors"]}), flush=True)
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in PHASES:
        raise SystemExit("Usage: nice -n 10 python3 validation/managed-workspaces/run.py live|ws|journal|history|correction")
    raise SystemExit(main(sys.argv[1]))
