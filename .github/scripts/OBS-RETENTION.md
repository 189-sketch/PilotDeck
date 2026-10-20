# OBS release retention

Keep every version from the last 30 days and at least the newest three dated
versions. Always retain the version referenced by PilotDeck/latest.json, even
when older than both limits. If any object in an older version was recently
uploaded, retain that whole version for 30 days from its newest object timestamp.

Only direct objects inside PilotDeck/vYYYY.MM.DD/ participate. The manifest,
debug files, access logs, legacy directories and unknown prefixes are excluded.
Objects in an expired version directory are removed together, including its
update metadata, so partial obsolete releases are not advertised as usable.

The workflow runs weekly on Monday at 05:30 Beijing time after merging into
main. Scheduled runs default to dry run. Set repository variable
OBS_RETENTION_ENABLED=true only after real test-object deletion acceptance and
the first approved obsolete-release cleanup have passed. Keep it false until then.
Manual dispatch also defaults to dry run; apply=true explicitly requests deletion.
Deletion may be irreversible depending on bucket versioning; this workflow does
not change versioning, lifecycle rules or public access policies.

The workflow uses the existing production Environment and broker secret, fetching
fresh temporary credentials each run. Listing and deletion require corresponding
broker permissions. An AccessDenied result is a failed cleanup, never success.
Production sync and cleanup share concurrency group release-to-obs. Before each
batch deletion, cleanup rechecks the latest tag and stops if it has changed.

The exact planned object keys and sizes are retained as retention-plan.json for
30 days. Initial rollout must review this artifact before deleting release assets.
This PR does not restore the reverted production release sync or change latest.

The isolated debug workflow has a separate delete-check job. It creates exactly
two small objects under PilotDeck/_debug/retention-delete/<run_id>/, confirms
their names and sizes, calls the same batch deletion helper as production
retention, and lists the prefix again to confirm absence. Existing objects cause
an abort before any overwrite or deletion. Failures retain a residual inventory;
there is no fallback deletion. This job uses the already-authorized debug
Environment broker secret and shares the release-to-obs lock. Even if deletion
fails, it runs read-only production retention without --apply, saving both
retention-delete-check.json and retention-plan.json as an artifact.

Test-object deletion proves that the real batch API works on those objects. It
does not prove that obsolete production releases have been cleaned up, and does
not enable production synchronization. The first real release cleanup requires
review and confirmation of the exact planned keys before running apply=true,
followed by verification of the removed and protected objects.

Validation:

```sh
python3 -m unittest discover -s .github/scripts -p 'test_obs*retention*.py'
actionlint .github/workflows/obs-release-retention.yml .github/workflows/obs-sync-debug.yml
```
