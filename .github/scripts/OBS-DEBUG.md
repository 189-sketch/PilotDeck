# Isolated OBS sync diagnosis

## Credential configuration

The user explicitly authorized the desktop .env OBS_STS_TOKEN and OBS_STS_ROUTE.
The debug Environment now uses those existing credentials. They authorize
PilotDeck/, so isolation is enforced by fixed PilotDeck/_debug/<tag>/<run-id>/
paths, NOT by cloud permissions. No production denial probe is performed.
Review the exact commit before approving the job: branch code can read this
credential after approval. No production latest pointer or schedule is restored.
The Environment reviewer, no-self-review and no-admin-bypass protections remain.
OBS_DEBUG_ENABLED enables live tests after configuration, not new provisioning.

This branch does not restore the production workflow. Only pushes to
`codex/obs-sync-debug` start the debug workflow; there is no schedule or dispatch.
The tests job is credential-free. Until repository variable `OBS_DEBUG_ENABLED`
is `true`, it explicitly reports that live acceptance has NOT run and skips it.

The `obs-release-debug` Environment allows only branch `codex/obs-sync-debug`,
requires Gucc111's review, prohibits self-review, and disables admin bypass.
Put the authorized desktop token in Environment Secret `OBS_DEBUG_BEARER_TOKEN`
and route in Environment Variable `OBS_DEBUG_ROUTE`. No short-lived credentials
are saved as secrets. Set repository variable `OBS_DEBUG_ENABLED=true` only after
both exist; push the branch to request a reviewed live run. Production Environment
and secrets remain unchanged.

## Diagnostic behavior

The tests job freezes the current latest formal release JSON as an artifact. The
live job downloads that pinned release and validates local files before requesting
credentials. Returned credential scope must exactly match `PilotDeck/`.

The first diagnostic uses serial readback, a five-minute per-object limit and a
shared fifteen-minute OBS budget (also bounded by credential expiry minus two
minutes). Each operation logs start/end, file name, byte count and elapsed time;
every thirty seconds it emits a heartbeat. Raw AWS stderr and credentials are not
logged; failures report only a category and allowlisted AWS error-code format.

A small debug upload/readback precedes the full sync. Artifacts are written to
`PilotDeck/_debug/<tag>/<run-id>/`. The same path is synced twice in one run to
exercise idempotence; smoke objects and the isolated latest.json are excluded
from the exact release-object listing check. Every release object is read back
and hashed before publishing the isolated latest.json, which is also read back.
No delete option is used. Diagnostic logs are retained as artifacts for seven days.

If the first real run proves readback is slow, raise the AWS constructor's worker
count to four and budget to 45 minutes in a reviewed branch commit. Concurrent
verification is tested but deliberately disabled until live evidence warrants
it. If upload is slow, implement and test bounded per-object upload separately.
Do not increase budget or change concurrency based only on the old generic timeout.

Live acceptance requires full content checks and same-path repeat, with each full
sync under 45 minutes. Test success alone or a green workflow with the live job
skipped is not live acceptance. Preserve isolated objects to diagnose failures.
Only prepare a separate production restoration PR after full acceptance; do not
merge this debug workflow or enable production scheduling.

```sh
python3 -m unittest discover -s .github/scripts -p 'test_obs_sync_debug.py'
actionlint .github/workflows/obs-sync-debug.yml
```
