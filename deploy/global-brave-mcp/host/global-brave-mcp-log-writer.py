#!/usr/bin/python3

import json
import os
import re
import sys
from datetime import datetime, timezone

LOG_BASE = os.environ.get("BRAVE_MCP_LOG_BASE", "/logs/Brave_MCP/searches")
MAX_EVENT_BYTES = 16 * 1024 * 1024
SESSION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$")


def validate_cwd(value):
    if (
        not isinstance(value, str)
        or not value.startswith("/")
        or len(value) > 4096
        or any(character in value for character in ("\0", "\r", "\n"))
    ):
        raise ValueError("Rejected audit event with invalid cwd metadata")
    return value


def validate_session_id(value):
    if not isinstance(value, str) or not SESSION_PATTERN.fullmatch(value) or value == "..":
        raise ValueError("Rejected audit event with invalid sessionId metadata")
    return value


def main():
    os.umask(0o022)
    payload = sys.stdin.buffer.read(MAX_EVENT_BYTES + 1)
    if len(payload) > MAX_EVENT_BYTES:
        raise ValueError(f"Rejected audit event larger than {MAX_EVENT_BYTES} bytes")

    event = json.loads(payload)
    if not isinstance(event, dict):
        raise ValueError("Rejected audit event that is not a JSON object")

    cwd = validate_cwd(event.get("cwd"))
    session_id = validate_session_id(event.get("sessionId"))
    project_directory = cwd.replace("/", "-")
    project_path = os.path.join(LOG_BASE, project_directory)
    destination_directory = os.path.join(project_path, session_id)
    timestamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    destination = os.path.join(destination_directory, f"{timestamp}.jsonl")

    os.makedirs(project_path, mode=0o755, exist_ok=True)
    os.chmod(project_path, 0o755)
    os.makedirs(destination_directory, mode=0o755, exist_ok=True)
    os.chmod(destination_directory, 0o755)
    line = (json.dumps(event, separators=(",", ":"), ensure_ascii=False) + "\n").encode()
    descriptor = os.open(
        destination,
        os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW,
        0o644,
    )
    try:
        os.fchmod(descriptor, 0o644)
        written = os.write(descriptor, line)
        if written != len(line):
            raise OSError(f"short audit write: {written} of {len(line)} bytes")
    finally:
        os.close(descriptor)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
