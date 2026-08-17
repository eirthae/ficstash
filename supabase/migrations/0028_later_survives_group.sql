-- The Later stash belongs to the USER, not to the tag group that surfaced it.
--
-- Before this, a work you'd set aside for Later vanished if you edited the group
-- (updateGroup deleted every row for the group before re-discovering) or deleted
-- it (group_id cascades). Neither is "I deleted it" or "I downloaded it", which
-- are the only two ways a Later item is supposed to leave the stash.
--
-- Making group_id nullable lets a Later row outlive its group: deleteGroup
-- detaches those rows first, so the cascade takes only the un-acted-on
-- suggestions. Everything else still cascades exactly as before.
alter table public.tag_matches
  alter column group_id drop not null;

-- The old `unique (group_id, source, source_work_id)` no longer constrains
-- detached rows: Postgres treats NULLs as distinct, so two deleted groups could
-- each leave an orphan for the same work. This partial index makes a work unique
-- among the detached rows, so the stash can't show the same story twice.
create unique index if not exists tag_matches_orphan_uniq
  on public.tag_matches (source, source_work_id)
  where group_id is null;

-- The Later stash reads across groups, including detached rows.
create index if not exists tag_matches_later_idx
  on public.tag_matches (first_seen_at desc)
  where later = true;
