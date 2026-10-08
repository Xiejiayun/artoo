"""Finite observations and conservative cleanup for a trusted local validation phase.

Repository wrapper preparation: exceptional cleanup has not been runtime qualified. Numeric
process identities are a cooperating-worker model, not a process sandbox.
"""
from datetime import datetime, timezone
from pathlib import Path
import json
import math
import os
import signal
import subprocess
import time


def stamp():
    return datetime.now(timezone.utc).isoformat()


def write_json(path, value):
    temporary = path.with_name(path.name + ".new")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    temporary.replace(path)


def read_process_table(timeout_s):
    """The real observer bounds ps itself, including its pipe collection."""
    result = subprocess.run(
        ["/bin/ps", "-axo", "pid=,ppid=,pgid=,nice=,lstart=,stat=,comm="],
        capture_output=True, text=True, check=True, timeout=timeout_s,
        env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C", "LC_ALL": "C"},
    )
    rows = {}
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        parts = line.split(None, 10)
        if len(parts) != 11:
            raise ValueError("Process observer returned an incomplete identity")
        pid = int(parts[0])
        rows[pid] = {
            "pid": pid, "ppid": int(parts[1]), "pgid": int(parts[2]),
            "nice": int(parts[3]), "started": " ".join(parts[4:9]), "state": parts[9], "command": parts[10],
        }
    return rows


def same_identity(first, second):
    return second is not None and all(
        first[key] == second[key] for key in ("pid", "pgid", "started", "command")
    )


def run_phase(name, argv, *, cwd, env, output_dir, phase_timeout_s,
              cleanup_timeout_s=10, observer=read_process_table):
    """Run once and always attempt a bounded finalizer and a phase receipt.

    An injected observer is trusted and must honor its timeout argument; arbitrary
    Python callback preemption is not claimed. The production observer is above.
    No shell is used. Observers receive only the remaining finite budget.
    """
    if os.getpriority(os.PRIO_PROCESS, 0) != 10:
        raise ValueError("Launch this task-owned harness under nice 10; children inherit it exactly once")
    if not name or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-_" for c in name):
        raise ValueError("A simple phase name is required")
    command = list(argv)
    if not command or any(not isinstance(item, str) or "\0" in item for item in command):
        raise ValueError("A trusted nonempty argv is required")
    for label, value, maximum in (("Phase", phase_timeout_s, 4500), ("Cleanup", cleanup_timeout_s, 600)):
        if not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 < value <= maximum:
            raise ValueError(f"{label} deadline must be finite and at most {maximum} seconds")
    cwd, output_dir = Path(cwd), Path(output_dir)
    if not cwd.is_absolute() or not output_dir.is_absolute():
        raise ValueError("Absolute cwd and output paths are required")
    environment = dict(env)
    started = time.monotonic()
    deadline = started + phase_timeout_s
    child = None
    known, groups = {}, {}
    errors, signals_sent = [], []
    errors_dropped = 0
    uncertain = False
    trigger = None
    observer_calls = 0
    timed_out = False
    initial_pgid = None
    log = None
    cleanup_deadline = None
    cleanup_deadline_exceeded = False

    def error_record(where, error, makes_uncertain=True):
        nonlocal uncertain, errors_dropped, trigger
        uncertain = uncertain or makes_uncertain
        trigger = trigger or where
        row = {"where": where, "type": type(error).__name__, "message": str(error), "at": stamp()}
        if len(errors) < 64:
            errors.append(row)
        else:
            errors_dropped += 1

    def add_group(pgid, authority):
        if pgid <= 0:
            raise ValueError("An owned group must have a positive PGID")
        groups.setdefault(pgid, {"pgid": pgid, "authority": authority, "state": "unknown",
                                 "checks": 0, "absence_observed_at": None,
                                 "last_probe_error": None, "signals_attempted": [],
                                 "unsafe_signal_skips": 0})

    def remember(row):
        key = f"{row['pid']}:{row['pgid']}:{row['started']}:{row['command']}"
        if key not in known:
            if len(known) >= 2048:
                raise ValueError("Owned identity observation limit exceeded")
            known[key] = dict(row)
            add_group(row["pgid"], "observed descendant identity")

    def observe(until, timeout_cap=2.0):
        nonlocal observer_calls
        remaining = until - time.monotonic()
        if remaining <= 0:
            return None
        observer_calls += 1
        try:
            current = observer(min(timeout_cap, remaining))
            # An unreaped direct child cannot have its PID reused. Once reaped,
            # its row must match the identity already recorded before exit.
            if child is not None and child.returncode is None and child.pid in current:
                row = current[child.pid]
                if row["pgid"] != initial_pgid:
                    raise ValueError("Launched process no longer has its anchored group")
                remember(row)
            reachable = {row["pid"] for row in known.values()
                         if same_identity(row, current.get(row["pid"]))}
            changed = True
            while changed:
                changed = False
                for pid, row in current.items():
                    if pid not in reachable and row["ppid"] in reachable:
                        remember(row)
                        reachable.add(pid)
                        changed = True
            return current
        except BaseException as error:
            # Sticky: a later successful table cannot prove the missed graph.
            error_record("observer_failed", error)
            return None

    def probe_groups():
        for pgid, record in groups.items():
            if record["state"] == "absent":
                continue
            record["checks"] += 1
            try:
                os.killpg(pgid, 0)
                record["state"] = "present"
                record["last_probe_error"] = None
            except ProcessLookupError:
                record["state"] = "absent"
                record["absence_observed_at"] = stamp()
                record["last_probe_error"] = "ESRCH"
            except PermissionError:
                record["state"] = "unknown"
                record["last_probe_error"] = "EPERM"
            except BaseException as error:
                record["state"] = "unknown"
                record["last_probe_error"] = type(error).__name__
                error_record("group_probe_failed", error)

    def signal_owned(sig, current):
        for pgid, record in groups.items():
            if record["state"] == "absent" or sig.name in record["signals_attempted"]:
                continue
            unreaped_initial = child is not None and child.returncode is None and pgid == initial_pgid
            witnessed_live = current is not None and any(
                row["pgid"] == pgid and same_identity(row, current.get(row["pid"]))
                and not current[row["pid"]]["state"].startswith("Z") for row in known.values()
            )
            if not unreaped_initial and not witnessed_live:
                record["unsafe_signal_skips"] += 1
                continue
            entry = {"pgid": pgid, "signal": sig.name, "at": stamp(), "outcome": "sent"}
            record["signals_attempted"].append(sig.name)
            try:
                os.killpg(pgid, sig)
            except ProcessLookupError:
                record["state"] = "absent"
                record["absence_observed_at"] = stamp()
                record["last_probe_error"] = "ESRCH"
                entry["outcome"] = "already_absent"
            except BaseException as error:
                entry["outcome"] = "error"
                entry["error"] = type(error).__name__
                error_record("owned_signal_failed", error)
            signals_sent.append(entry)

    def finalize_child():
        nonlocal trigger, cleanup_deadline, cleanup_deadline_exceeded, initial_pgid
        if child is None:
            return
        # Recover the launch authority if an interrupt occurred after Popen
        # returned but before the immediately following ledger initialization.
        if initial_pgid is None:
            initial_pgid = child.pid
        add_group(initial_pgid, "direct child launched with start_new_session")
        cleanup_started = time.monotonic()
        cleanup_deadline = cleanup_started + cleanup_timeout_s
        while time.monotonic() < cleanup_deadline:
            current = observe(cleanup_deadline)
            probe_groups()
            elapsed = time.monotonic() - cleanup_started
            all_absent = bool(groups) and all(row["state"] == "absent" for row in groups.values())
            # A normal exit receives only a short observational drain; failures
            # start cleanup immediately. Observations never reset the deadline.
            if trigger or elapsed >= min(0.25, cleanup_timeout_s / 4):
                if not all_absent:
                    trigger = trigger or "residual_owned_group"
                    signal_owned(signal.SIGTERM, current)
                    if elapsed >= min(1.0, cleanup_timeout_s / 2):
                        signal_owned(signal.SIGKILL, current)
            child.poll()
            if child.returncode is not None and all_absent:
                return
            remaining = cleanup_deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                if child.returncode is None:
                    child.wait(timeout=min(0.05, remaining))
                else:
                    time.sleep(min(0.05, remaining))
            except subprocess.TimeoutExpired:
                pass
            except BaseException as error:
                error_record("reap_wait_failed", error)
        child.poll()
        probe_groups()
        cleanup_deadline_exceeded = True
        trigger = trigger or "cleanup_timeout"

    try:
        log = (output_dir / f"{name}.log").open("w")
        child = subprocess.Popen(command, cwd=cwd, env=environment,
                                 stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                 start_new_session=True)
        initial_pgid = child.pid
        add_group(initial_pgid, "direct child launched with start_new_session")
        write_json(output_dir / f"{name}-launch.json", {"pid": child.pid, "initial_pgid": initial_pgid,
                   "argv": command, "started_at": stamp(), "phase_timeout_s": phase_timeout_s})
        while True:
            if time.monotonic() >= deadline:
                timed_out = True
                trigger = "phase_timeout"
                break
            observe(deadline, timeout_cap=5.0)
            if uncertain:
                break
            child.poll()
            if time.monotonic() >= deadline:
                timed_out = True
                trigger = "phase_timeout"
                break
            if child.returncode is not None:
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                continue
            try:
                child.wait(timeout=min(0.2, remaining))
            except subprocess.TimeoutExpired:
                pass
    except BaseException as error:
        error_record("phase_exception", error)
    finally:
        try:
            finalize_child()
        except BaseException as error:
            error_record("cleanup_exception", error)
            # Keep one bounded stop/reap attempt within the same cleanup budget.
            # With no fresh table, only an unreaped direct-child group is signalable.
            if child is not None:
                try:
                    remaining = max(0, (cleanup_deadline or time.monotonic()) - time.monotonic())
                    if remaining > 0:
                        signal_owned(signal.SIGTERM, None)
                        try:
                            child.wait(timeout=min(0.25, remaining))
                        except subprocess.TimeoutExpired:
                            pass
                    remaining = max(0, (cleanup_deadline or time.monotonic()) - time.monotonic())
                    if remaining > 0 and child.returncode is None:
                        signal_owned(signal.SIGKILL, None)
                        child.wait(timeout=remaining)
                    child.poll()
                    probe_groups()
                except BaseException as final_error:
                    error_record("final_reap_failed", final_error)
        finally:
            if log is not None:
                try:
                    log.close()
                except BaseException as error:
                    error_record("log_close_failed", error)
            reaped = child is not None and child.returncode is not None
            initial_absent = initial_pgid in groups and groups[initial_pgid]["state"] == "absent"
            closure = bool(groups) and reaped and initial_absent and not uncertain and all(
                row["state"] == "absent" for row in groups.values())
            result = {"name": name, "argv": command, "spawned": child is not None,
                      "pid": child.pid if child else None, "initial_pgid": initial_pgid,
                      "exit": child.returncode if child else None, "direct_child_reaped": reaped,
                      "initial_group_absence_confirmed": initial_absent,
                      "closure_confirmed": bool(closure), "observer_uncertainty_sticky": uncertain,
                      "observer_calls": observer_calls, "observed_owned_processes": list(known.values()),
                      "groups": list(groups.values()), "signals_sent": signals_sent,
                      "timed_out": timed_out, "trigger": trigger, "errors": errors,
                      "cleanup_deadline_exceeded": cleanup_deadline_exceeded,
                      "errors_dropped": errors_dropped, "elapsed_seconds": time.monotonic() - started,
                      "finished_at": stamp(), "receipt_written": True,
                      "exceptional_cleanup_runtime_qualified": False}
            result["observed_nice_ten"] = bool(known) and all(row["nice"] == 10 for row in known.values())
            result["passed"] = bool(closure and child.returncode == 0 and trigger is None and result["observed_nice_ten"])
            result["retain_fixture_parent"] = not result["passed"]
            try:
                write_json(output_dir / f"{name}-result.json", result)
            except BaseException as error:
                error_record("receipt_write_failed", error)
                result.update(receipt_written=False, passed=False, closure_confirmed=False,
                              observer_uncertainty_sticky=True, retain_fixture_parent=True,
                              trigger=trigger, errors_dropped=errors_dropped)
                # A filesystem failure cannot be made into durable success.
                # Return the in-memory failure so orchestration can try its own
                # separate final result and retain the marked fixture parent.
    return result
