-- Failed-save tracking for the app's "Failed" stash.
--
-- A tapped Save that fails DEFINITIVELY — the work was removed at the source (404 /
-- "cannot find"), or it's members-only/restricted — is flagged failed=true and taken
-- out of the wanted-retry loop (wanted=false). Instead of retrying forever or
-- vanishing silently, it surfaces in the app's Failed section, where the user can
-- Retry it (clears the flag, re-queues the save) or Dismiss it. Transient failures
-- (throttling, network) are NOT flagged — they stay wanted and keep auto-retrying.
--
-- Idempotent (db-setup re-applies every migration): IF NOT EXISTS throughout.
alter table tag_matches
  add column if not exists failed boolean not null default false,
  add column if not exists fail_reason text;

-- Partial index for the Failed-stash read (only the handful of failed rows).
create index if not exists tag_matches_failed_idx on tag_matches (failed) where failed = true;
