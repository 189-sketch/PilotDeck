import concurrent.futures
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("debug", Path(__file__).with_name("obs_sync_debug.py"))
debug = importlib.util.module_from_spec(spec)
spec.loader.exec_module(debug)


def auth(minutes=60):
    return {"access_key_id": "test-ak", "secret_access_key": "test-sk", "security_token": "test-st",
            "expiration": (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat(),
            "bucket": debug.BUCKET, "object_prefix": debug.ROOT}


class FakeAWS:
    def __init__(self, files, workers=1, corrupt=False, failure=None):
        self.workers, self.corrupt, self.failure = workers, corrupt, failure
        self.files = files
        self.deadline = time.monotonic() + 60
        self.calls, self.active, self.peak = [], 0, 0
        self.stopped = False
        self.lock = threading.Lock()

    def stop(self):
        self.stopped = True

    def run(self, stage, args, **kwargs):
        with self.lock:
            self.calls.append(stage)
        if stage == self.failure:
            raise debug.OperationFailure(stage, "timeout")
        if stage == "list":
            prefix = args[args.index("--prefix") + 1]
            entries = [{"Key": prefix + name, "Size": len(data)} for name, data in self.files.items()]
            entries += [{"Key": prefix + "latest.json", "Size": 1}, {"Key": prefix + "_smoke/probe", "Size": 1}]
            return json.dumps({"Contents": entries}).encode()
        if stage == "publish-debug-latest":
            self.files["latest.json"] = kwargs["stdin"].read()
        if stage == "readback":
            with self.lock:
                self.active += 1
                self.peak = max(self.peak, self.active)
            try:
                time.sleep(.01)
                name = kwargs["file"]
                data = self.files[name]
                if self.corrupt and name == "app.exe":
                    data = b"X" * len(data)
                kwargs["output"].write(data)
            finally:
                with self.lock:
                    self.active -= 1
        return b""


class DiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        data = b"installer"
        manifest = {"tag": "v1", "assets": [{"name": "app.exe", "size": len(data),
                    "sha256": hashlib.sha256(data).hexdigest()}]}
        self.files = {"app.exe": data, "release.json": json.dumps(manifest).encode()}
        self.release = {"tag_name": "v1", "assets": [{"name": name, "size": len(data)} for name, data in self.files.items()]}
        for name, data in self.files.items():
            (self.directory / name).write_bytes(data)
        self.hashes = {name: hashlib.sha256(data).hexdigest() for name, data in self.files.items()}
        self.output = redirect_stdout(io.StringIO())
        self.output.__enter__()

    def tearDown(self):
        self.output.__exit__(None, None, None)
        self.temp.cleanup()

    def test_local_release_and_same_size_corruption(self):
        self.assertEqual(debug.local_hashes(self.release, self.directory), self.hashes)
        (self.directory / "app.exe").write_bytes(b"X" * len(self.files["app.exe"]))
        with self.assertRaisesRegex(RuntimeError, "manifest"):
            debug.local_hashes(self.release, self.directory)

    def test_serial_and_concurrent_success(self):
        for workers in (1, 4):
            aws = FakeAWS(dict(self.files), workers=workers)
            debug.sync_release(aws, "PilotDeck-debug/v1/1/", self.directory, self.release, self.hashes)
            self.assertIn("publish-debug-latest", aws.calls)
            self.assertEqual(aws.peak, min(workers, len(self.files)))

    def test_corruption_and_timeouts_do_not_publish(self):
        for corrupt, stage in ((True, None), (False, "upload"), (False, "readback")):
            aws = FakeAWS(dict(self.files), workers=4, corrupt=corrupt, failure=stage)
            with self.assertRaises(RuntimeError):
                debug.sync_release(aws, "PilotDeck-debug/v1/1/", self.directory, self.release, self.hashes)
            self.assertNotIn("publish-debug-latest", aws.calls)

    def test_same_path_repeat_has_no_extra_release_keys(self):
        aws = FakeAWS(dict(self.files))
        for _ in range(2):
            debug.sync_release(aws, "PilotDeck-debug/v1/1/", self.directory, self.release, self.hashes)
        self.assertEqual(set(aws.files), set(self.files) | {"latest.json"})

    def test_credentials_require_debug_scope(self):
        with patch.object(debug.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(auth()).encode())):
            self.assertEqual(debug.credentials("debug-token", "debug-route")["object_prefix"], debug.ROOT)
        for scope in ("PilotDeck/", "", "PilotDeck-debug/sub/"):
            value = auth()
            value["object_prefix"] = scope
            with patch.object(debug.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(value).encode())):
                with self.assertRaisesRegex(RuntimeError, "scope"):
                    debug.credentials("debug-token", "debug-route")
        with self.assertRaisesRegex(RuntimeError, "Independent"):
            debug.credentials("", "")
        with self.assertRaisesRegex(RuntimeError, "Independent"):
            debug.credentials("token", "n00069-minicpm-5-0-pilotdeck")

    def test_broker_denied_and_short_lifetime(self):
        error = debug.urllib.error.HTTPError("https://example.test", 403, "denied", {}, None)
        with patch.object(debug.urllib.request, "urlopen", side_effect=error):
            with self.assertRaisesRegex(RuntimeError, "HTTP 403"):
                debug.credentials("token", "debug-route")
        with self.assertRaisesRegex(RuntimeError, "five minutes"):
            debug.AWS(auth(4))

    def test_lifetime_bounds(self):
        for minutes, budget, expected in ((6, 15, 240), (60, 15, 900), (60, 45, 2700)):
            before = time.monotonic()
            aws = debug.AWS(auth(minutes), minutes=budget)
            self.assertAlmostEqual(aws.deadline - before, expected, delta=1)

    def test_actual_child_timeout_and_heartbeat(self):
        aws = debug.AWS(auth(), heartbeat=.02, object_seconds=.08)
        real_popen = subprocess.Popen
        def start(*args, **kwargs):
            return real_popen([sys.executable, "-c", "import time; time.sleep(10)"], **kwargs)
        with patch.object(debug.subprocess, "Popen", side_effect=start):
            with self.assertRaisesRegex(debug.OperationFailure, "timeout"):
                aws.run("readback", [])
        self.assertEqual(aws.processes, set())
        self.assertIn("heartbeat", self.output._new_target.getvalue())

    def test_global_deadline_starts_no_child(self):
        aws = debug.AWS(auth())
        aws.deadline = time.monotonic() - 1
        with patch.object(debug.subprocess, "Popen") as popen:
            with self.assertRaisesRegex(debug.OperationFailure, "deadline"):
                aws.run("upload", [])
            popen.assert_not_called()

    def test_production_or_unisolated_destinations_rejected(self):
        for prefix in ("PilotDeck/v1/123/", "PilotDeck-debug/", "PilotDeck-debug/v1/../"):
            aws = FakeAWS(dict(self.files))
            with self.assertRaisesRegex(RuntimeError, "debug prefix"):
                debug.sync_release(aws, prefix, self.directory, self.release, self.hashes)
            self.assertEqual(aws.calls, [])

    def test_cancel_kills_active_children(self):
        aws = debug.AWS(auth(), heartbeat=.01)
        real_popen = subprocess.Popen
        def start(*args, **kwargs):
            return real_popen([sys.executable, "-c", "import time; time.sleep(10)"], **kwargs)
        with patch.object(debug.subprocess, "Popen", side_effect=start), concurrent.futures.ThreadPoolExecutor() as pool:
            future = pool.submit(aws.run, "readback", [])
            end = time.monotonic() + 3
            while not aws.processes and time.monotonic() < end:
                time.sleep(.01)
            self.assertTrue(aws.processes)
            aws.stop()
            with self.assertRaises(RuntimeError):
                future.result(timeout=3)
        self.assertEqual(aws.processes, set())

    def test_only_explicit_denial_passes_permission_probe(self):
        for code, should_pass in (("AccessDenied", True), ("InvalidAccessKeyId", False)):
            aws = FakeAWS({"permission-probe.txt": b"pilotdeck isolated debug permission probe\n"})
            original = aws.run
            def run(stage, args, **kwargs):
                if stage == "production-denial-probe":
                    raise debug.OperationFailure(stage, "service", code)
                return original(stage, args, **kwargs)
            aws.run = run
            if should_pass:
                debug.permission_smoke(aws, "PilotDeck-debug/v1/123/", self.directory)
            else:
                with self.assertRaisesRegex(RuntimeError, "inconclusive"):
                    debug.permission_smoke(aws, "PilotDeck-debug/v1/123/", self.directory)
        with self.assertRaisesRegex(RuntimeError, "revoke"):
            debug.permission_smoke(FakeAWS({}), "PilotDeck-debug/v1/123/", self.directory)

    def test_stderr_is_redacted_but_service_code_is_visible(self):
        aws = debug.AWS(auth())
        real_popen = subprocess.Popen
        script = "import sys;sys.stderr.write('An error occurred (AccessDenied) secret-token');sys.exit(1)"
        def start(*args, **kwargs):
            return real_popen([sys.executable, "-c", script], **kwargs)
        with patch.object(debug.subprocess, "Popen", side_effect=start):
            with self.assertRaisesRegex(debug.OperationFailure, "AccessDenied"):
                aws.run("probe", [])
        self.assertNotIn("secret-token", self.output._new_target.getvalue())
        self.assertNotIn("OBS_DEBUG_BEARER_TOKEN", aws.env)


if __name__ == "__main__":
    unittest.main()
