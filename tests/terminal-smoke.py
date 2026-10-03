"""Optional Unix PTY smoke test: python3 tests/terminal-smoke.py.

Uses only temporary state and a fake Herdr executable. Never prompts real agents
or starts a recorder. Python is not a runtime dependency of Agent Town.
"""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time


with tempfile.TemporaryDirectory(prefix="town-pty-test-") as directory:
    root = Path(directory)
    mock = root / "herdr"
    mock.write_text("#!" + sys.executable + "\n" + r'''
import os, sys, json
from pathlib import Path
args = sys.argv[1:]
if args[:2] == ['agent', 'list']:
    print(json.dumps({'result': {'agents': [{'pane_id': 'p1', 'workspace_id': 'w1', 'agent': 'claude', 'agent_status': 'blocked', 'terminal_title': 'Reply smoke test'}]}}))
elif args[:2] == ['workspace', 'list']:
    print(json.dumps({'result': {'workspaces': [{'workspace_id': 'w1', 'label': 'Smoke town', 'number': 1}]}}))
elif args[:2] == ['agent', 'read']:
    print('Please review this change before continuing.')
elif args[:2] == ['agent', 'prompt']:
    with Path(os.environ['MOCK_PROMPT_LOG']).open('a') as log:
        log.write(json.dumps(args[2:]) + '\n')
    print(json.dumps({'result': {'ok': True}}))
else:
    print(json.dumps({'result': {'ok': True}}))
''')
    mock.chmod(0o755)
    now = int(time.time() * 1000)
    # A live test-owned lock suppresses ensureRecorder() without mocking the UI.
    (root / "recorder.lock").write_text(json.dumps({"pid": os.getpid(), "beat": now}))
    activity = {
        "epoch": "smoke", "seq": 1, "startedAt": now, "at": now,
        "workers": {}, "buildings": {},
        "events": [{"id": 1, "at": now, "type": "blocked", "townId": "w1",
                    "town": "Smoke town", "task": "Reply smoke test",
                    "name": "claude", "paneId": "p1", "state": "blocked"}],
    }
    (root / "progress.json").write_text(json.dumps({"version": 1, "features": {}, "activity": activity}))
    log = root / "sent.jsonl"
    env = dict(os.environ, HERDR_BIN_PATH=str(mock), HERDR_PLUGIN_STATE_DIR=str(root),
               MOCK_PROMPT_LOG=str(log))
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    repo = Path(__file__).resolve().parent.parent
    child = subprocess.Popen(["node", "src/main.js"], cwd=repo, stdin=slave,
                             stdout=slave, stderr=slave, env=env)
    os.close(slave)
    captured = bytearray()

    def read_available():
        if select.select([master], [], [], 0.05)[0]:
            try:
                data = os.read(master, 65536)
                captured.extend(data)
                return data
            except OSError:
                pass  # PTY closed after exit.
        return b""

    def wait_for(text, timeout=8):
        deadline = time.time() + timeout
        local = bytearray()
        while time.time() < deadline:
            local.extend(read_available())
            if text.encode() in local:
                return
        raise AssertionError("Did not render " + text + "; tail=" + local[-1500:].decode(errors="replace"))

    def send(text):
        os.write(master, text.encode())

    try:
        wait_for("WHILE YOU WERE AWAY")
        send("c")
        wait_for("TOWN OF")
        assert json.loads((root / "summary-seen.json").read_text())["seq"] == 1
        send("\r")
        wait_for("Please review this change")
        send("r")
        wait_for("WRITE REPLY")
        scroll_text = "\n".join(f"Scroll row {i + 1}" for i in range(60))
        send("\x1b[200~" + scroll_text + "\x1b[201~")
        wait_for("rows 44-60/60")
        send("\x1b[<64;20;10M")
        wait_for("rows 41-57/60")
        wait_for("rows 41-57/60")  # A later repaint must not snap back to the cursor.
        send("\x1b[5~")
        wait_for("rows 25-41/60")
        send("\x1b[6~")
        wait_for("rows 41-57/60")
        send("\x15")
        wait_for("rows 1-1/1")
        assert not log.exists()
        send("\x1b[20")
        send("0~  first line\nsecond 世界\x1b[201~")
        wait_for("second 世界")
        assert not log.exists()
        send("\x13")
        wait_for("CONFIRM REPLY")
        send("\x1b[200~\r\n\x1b[201~")
        wait_for("CONFIRM REPLY")
        assert not log.exists()
        send("\r")
        wait_for("sent to p1")
        assert [json.loads(line) for line in log.read_text().splitlines()] == [
            ["p1", "  first line\nsecond 世界"]
        ]
        send("q")
        # Keep draining: TTY writes are synchronous, so waiting without reading
        # can fill the PTY buffer and prevent even the quit key from being read.
        deadline = time.time() + 8
        while child.poll() is None and time.time() < deadline:
            read_available()
        assert child.poll() == 0, "town did not quit cleanly"
        read_available()
        assert b"\x1b[?2004l" in captured and b"\x1b[?1004l" in captured
        print("PTY smoke PASS: summary, wheel/page scrolling, UTF-8 multiline paste, confirmation, one mock delivery, terminal cleanup")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)
        os.close(master)
