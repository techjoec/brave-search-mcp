#!/usr/bin/python3

import argparse
import fcntl
import json
import os
import re
import tempfile
import time
import urllib.request
import uuid
from contextlib import contextmanager
from pathlib import Path

CORRELATION_URL = "http://127.0.0.1:3001/session-correlation"
SESSION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$")


def process_info(pid):
    raw = Path(f"/proc/{pid}/stat").read_text()
    fields = raw[raw.rfind(")") + 2 :].split()
    return int(fields[1]), fields[19]


def is_claude_process(pid):
    try:
        argv0 = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0", 1)[0].decode()
        executable = os.readlink(f"/proc/{pid}/exe")
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        return False

    return (
        Path(argv0).name == "claude"
        or Path(executable).name == "claude"
        or "/.local/share/claude/versions/" in argv0
        or "/.local/share/claude/versions/" in executable
    )


def find_claude_ancestor():
    pid = os.getppid()
    ancestors = []
    while pid > 1:
        try:
            parent_pid, start_ticks = process_info(pid)
        except (FileNotFoundError, ProcessLookupError, ValueError):
            break
        ancestors.append((pid, start_ticks))
        pid = parent_pid

    configured_pid = os.environ.get("CLAUDE_PID")
    if configured_pid and configured_pid.isdigit():
        configured = int(configured_pid)
        for ancestor in ancestors:
            if ancestor[0] == configured:
                return ancestor

    candidates = [ancestor for ancestor in ancestors if is_claude_process(ancestor[0])]
    if not candidates:
        raise RuntimeError("Could not find a Claude ancestor process")
    return candidates[-1]


def runtime_directory():
    base = Path(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"))
    directory = base / "global-brave-mcp"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)
    return directory


@contextmanager
def state_lock(directory, claude_pid):
    descriptor = os.open(
        directory / f"{claude_pid}.lock",
        os.O_WRONLY | os.O_CREAT,
        0o600,
    )
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        os.close(descriptor)


def read_state(path, claude_pid, start_ticks):
    try:
        state = json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    if state.get("claudePid") != claude_pid or state.get("claudeStartTicks") != start_ticks:
        return None
    return state


def write_state(path, state):
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w") as output:
            json.dump(state, output, separators=(",", ":"))
            output.write("\n")
        os.replace(temporary_name, path)
    except Exception:
        try:
            os.close(descriptor)
        except OSError:
            pass
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def state_location():
    claude_pid, start_ticks = find_claude_ancestor()
    directory = runtime_directory()
    return directory, directory / f"{claude_pid}.json", claude_pid, start_ticks


def emit_headers():
    directory, path, claude_pid, start_ticks = state_location()
    with state_lock(directory, claude_pid):
        state = read_state(path, claude_pid, start_ticks)
        if state is None:
            state = {
                "version": 1,
                "claudePid": claude_pid,
                "claudeStartTicks": start_ticks,
                "startupId": str(uuid.uuid4()),
            }
            write_state(path, state)

    headers = {"X-Brave-Startup-ID": state["startupId"]}
    if state.get("sessionId") and state.get("cwd"):
        headers["X-Brave-Session"] = state["sessionId"]
        headers["X-Brave-Cwd"] = state["cwd"]
    print(json.dumps(headers, separators=(",", ":")))


def correlate_session(session_id, cwd):
    if not SESSION_PATTERN.fullmatch(session_id) or session_id == "..":
        raise ValueError("Invalid Claude session ID")
    if not cwd.startswith("/") or len(cwd) > 4096 or any(char in cwd for char in ("\0", "\r", "\n")):
        raise ValueError("Invalid Claude working directory")

    directory, path, claude_pid, start_ticks = state_location()
    state = None
    deadline = time.monotonic() + 2
    while state is None and time.monotonic() < deadline:
        with state_lock(directory, claude_pid):
            state = read_state(path, claude_pid, start_ticks)
        if state is None:
            time.sleep(0.05)
    if state is None:
        raise RuntimeError("Claude MCP startup state was not created")

    with state_lock(directory, claude_pid):
        state = read_state(path, claude_pid, start_ticks)
        if state is None:
            raise RuntimeError("Claude MCP startup state changed during correlation")
        state["sessionId"] = session_id
        state["cwd"] = cwd
        state["updatedAt"] = time.time()
        write_state(path, state)

    body = json.dumps(
        {
            "startupId": state["startupId"],
            "sessionId": session_id,
            "cwd": cwd,
        },
        separators=(",", ":"),
    ).encode()
    request = urllib.request.Request(
        CORRELATION_URL,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Brave-Startup-ID": state["startupId"],
        },
    )
    with urllib.request.urlopen(request, timeout=2) as response:
        if response.status != 204:
            raise RuntimeError(f"Session correlation returned HTTP {response.status}")


def main():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command")
    correlate = subparsers.add_parser("correlate")
    correlate.add_argument("--session-id", required=True)
    correlate.add_argument("--cwd", required=True)
    args = parser.parse_args()

    if args.command == "correlate":
        correlate_session(args.session_id, args.cwd)
    else:
        emit_headers()


if __name__ == "__main__":
    main()
