# OBS release synchronization

The `obs-release` GitHub Environment must allow deployment only from the branch
`main`. Store `OBS_CREDENTIALS_BEARER_TOKEN` only in that Environment, never as a
Repository Secret. A job-level branch condition alone is not a security boundary:
branch authors can edit it. The Environment policy enforces credential access
outside workflow code. Keep main protected by normal pull-request review.

The workflow runs only on main and checks out main. Other branches cannot run a
credentialed live test; merge through normal review before testing the complete
workflow. Do not add a push trigger or restore a repository-wide broker secret.

Before requesting credentials, verify local files against GitHub asset digests
when present and the release's embedded manifest. After sync, download each OBS
object and compare its SHA-256 with the verified local file, including manifest
and auxiliary assets. A same-size stale object causes failure without publishing
latest.json; replace the incorrect versioned object before rerunning.

All AWS operations share a monotonic deadline capped at 50 minutes and at the
credential expiration minus two minutes. Reading back objects adds download
traffic and runtime. The latest pointer is published only after content checks.

Focused checks:

```sh
python3 -m unittest discover -s .github/scripts -p 'test_release_to_obs.py'
actionlint .github/workflows/release-to-obs.yml
```
