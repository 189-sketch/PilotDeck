import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("sync", Path(__file__).with_name("release_to_obs.py"))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = os.getcwd()
        os.chdir(self.temp.name)
        Path("release-assets").mkdir()
        payload = b"installer"
        manifest = {"tag": "v1", "assets": [{"name": "app.exe", "size": len(payload),
                      "sha256": hashlib.sha256(payload).hexdigest()}]}
        self.files = {"app.exe": payload, "release.json": json.dumps(manifest).encode()}
        for name, content in self.files.items():
            (Path("release-assets") / name).write_bytes(content)
        self.assets = [{"name": name, "size": len(content)} for name, content in self.files.items()]
        Path("release.json").write_text(json.dumps({"tag_name": "v1", "assets": self.assets}))
        self.env = patch.dict(os.environ, {"OBS_CREDENTIALS_BEARER_TOKEN": "test",
            "OBS_BUCKET": "n00069-minicpm-5-0", "OBS_PREFIX": "PilotDeck/v1/", "OBS_ENDPOINT": "https://example.test"})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        os.chdir(self.previous)
        self.temp.cleanup()

    def test_local_manifest_and_same_size_corruption(self):
        self.assertEqual(set(sync.local_hashes(self.assets)), set(self.files))
        Path("release-assets/app.exe").write_bytes(b"corrupted")
        with self.assertRaisesRegex(RuntimeError, "manifest"):
            sync.local_hashes(self.assets)

    def test_deadline_tracks_expiration_and_caps_at_fifty_minutes(self):
        for minutes, expected in [(6, 240), (60, 3000)]:
            expiration = (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat()
            with patch.object(sync.time, "monotonic", return_value=100):
                self.assertAlmostEqual(sync.upload_deadline(expiration), 100 + expected, delta=1)
        with self.assertRaises(RuntimeError):
            sync.upload_deadline((datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat())

    def run_sync(self, corrupt=False, fail=False, timeout=False):
        published = []
        manifest = []
        auth = {"access_key_id": "ak", "secret_access_key": "sk", "security_token": "st",
                "expiration": (datetime.now(timezone.utc) + timedelta(minutes=6)).isoformat()}

        def aws(command, **kwargs):
            self.assertNotIn("OBS_CREDENTIALS_BEARER_TOKEN", kwargs["env"])
            self.assertLessEqual(kwargs["timeout"], 240)
            if fail:
                return SimpleNamespace(returncode=1, stdout="")
            if timeout:
                raise sync.subprocess.TimeoutExpired(command, 1)
            args = command[1:]
            output = ""
            if args[:2] == ["s3api", "list-objects-v2"]:
                output = json.dumps({"Contents": [{"Key": "PilotDeck/v1/" + a["name"], "Size": a["size"]} for a in self.assets]})
            elif args[:2] == ["s3", "cp"]:
                if kwargs.get("input") is not None:
                    published.append(args[3]); manifest.append(kwargs["input"])
                elif kwargs["stdout"] != sync.subprocess.PIPE:
                    name = args[2].rsplit("/", 1)[1]
                    kwargs["stdout"].write(b"corrupted" if corrupt and name == "app.exe" else self.files[name])
                else:
                    output = manifest[0]
            return SimpleNamespace(returncode=0, stdout=output)

        with patch.object(sync, "credentials", return_value=auth), patch.object(sync.subprocess, "run", side_effect=aws):
            if corrupt or fail or timeout:
                with self.assertRaises(RuntimeError):
                    sync.main()
                self.assertEqual(published, [])
            else:
                sync.main()
                self.assertEqual(len(published), 1)

    def test_verified_contents_publish_latest(self):
        self.run_sync()

    def test_remote_same_size_corruption_blocks_latest(self):
        self.run_sync(corrupt=True)

    def test_upload_failure_blocks_latest(self):
        self.run_sync(fail=True)

    def test_deadline_timeout_blocks_latest(self):
        self.run_sync(timeout=True)

    def test_missing_token(self):
        with patch.dict(os.environ, {"OBS_CREDENTIALS_BEARER_TOKEN": ""}):
            with self.assertRaisesRegex(RuntimeError, "missing"):
                sync.main()

    def test_broker_rejection(self):
        error = sync.urllib.error.HTTPError("https://example.test", 403, "denied", {}, None)
        with patch.object(sync.urllib.request, "urlopen", side_effect=error):
            with self.assertRaisesRegex(RuntimeError, "HTTP 403"):
                sync.credentials("test")

    def test_expired_broker_credentials(self):
        response = {"access_key_id": "ak", "secret_access_key": "sk", "security_token": "st",
                    "bucket": "n00069-minicpm-5-0", "object_prefix": "PilotDeck/",
                    "expiration": (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()}
        with patch.object(sync.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(response).encode())):
            with self.assertRaisesRegex(RuntimeError, "expired"):
                sync.credentials("test")


if __name__ == "__main__":
    unittest.main()
