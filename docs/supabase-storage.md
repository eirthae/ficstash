# Supabase storage: what filled the free tier, how we cleared it, and how to stop it recurring

_Incident date: 2026-07-14. Free plan limit: **0.5 GB** database size per project._

## TL;DR

FicStash's Supabase DB hit **102% of the 0.5 GB free limit**. Almost all of it was
in one table — `chapters` (full offline chapter text) — driven by two things that
quietly accumulate:

1. **Inlined images** — chatfic/social works store images as base64 data-URIs
   directly in `chapters.content`. ~196 chapters held ~231 MB.
2. **Soft-deleted works never freed their text** — "Remove from library" only sets
   `works.hidden = true`; the work row **and all its chapter text stay forever**.

We reclaimed space by (a) stripping inlined images to placeholders and
(b) hard-deleting hidden works + their chapters, dropping the DB from
**~510 MB → ~149 MB (30%)**. Nothing in the live library or the tracked tags was
touched.

The **durable fixes still need coding** (see [To implement](#to-implement-durable-fixes)).

---

## How we diagnosed it

Run in Supabase → SQL Editor. Table sizes + dead-row bloat:

```sql
select c.relname as table,
       pg_size_pretty(pg_total_relation_size(c.oid)) as total,
       pg_size_pretty(pg_relation_size(c.oid))       as table_only,
       s.n_live_tup as live_rows, s.n_dead_tup as dead_rows
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_stat_user_tables s on s.relid = c.oid
where n.nspname = 'public' and c.relkind = 'r'
order by pg_total_relation_size(c.oid) desc
limit 20;
```

Result (before cleanup): `chapters` = **431 MB** total but only 1.5 MB `table_only`
— i.e. ~429 MB was TOAST (the big `content` column), with only 724 dead rows. So it
was **not bloat** — it was real content. `tag_matches` = 25 MB / 10.8k rows.

How much of `chapters` was images vs text:

```sql
select pg_size_pretty(sum(length(content))::bigint) as all_content,
       pg_size_pretty(sum(case when content like '%data:image%' then length(content) else 0 end)::bigint) as image_bytes,
       count(*) filter (where content like '%data:image%') as chapters_with_images,
       count(*) as total_chapters
from chapters;
```

Result: **231 MB across just 196 chapters** were image-bearing (~half the DB).

---

## What we ran to reclaim space

> **Order matters and `VACUUM FULL` must run ALONE** (it can't run inside a
> transaction, and the Supabase SQL editor wraps multi-statement runs in one).
> `VACUUM FULL` takes an **exclusive lock** on the table and needs temporary extra
> disk while it rewrites — run it when no sync is active.

**1. Strip inlined images → placeholder (keeps all text):**
```sql
update chapters
set content = regexp_replace(content, '<img[^>]*data:image[^>]*>', '<span class="fs-img-missing">📷 image</span>', 'gi')
where content like '%data:image%';
```
The `<span class="fs-img-missing">` matches the reader's existing placeholder
(`neutralizeRemoteImages` in `app/src/lib/workskin.js`), so the reader renders it
cleanly. If the single big `UPDATE` times out, batch it:
```sql
update chapters
set content = regexp_replace(content, '<img[^>]*data:image[^>]*>', '<span class="fs-img-missing">📷 image</span>', 'gi')
where ctid in (select ctid from chapters where content like '%data:image%' limit 30);
```

**2. Hard-delete works you'd already removed (soft-deleted) + their chapters:**
```sql
-- measure first
select count(*) as hidden_works from works where hidden = true;
-- then delete
delete from chapters where work_id in (select id from works where hidden = true);
delete from works where hidden = true;
```
This was the **biggest win** — most of the DB was the text of works already removed
from the library.

**3. Reclaim the freed space (each ALONE, no sync running):**
```sql
vacuum full chapters;
```
```sql
vacuum full works;
```

Optional discovery-metadata trim (we did **not** run this — user wanted to keep
discovery suggestions):
```sql
delete from tag_matches where saved = false and later = false;  -- clears un-saved Discover suggestions (re-populate on next browse)
vacuum full tag_matches;
```

**Verify library intact (deletes nothing):**
```sql
select
  (select count(*) from works where hidden = false)  as your_library,
  (select count(*) from works where hidden = true)   as removed_leftover,
  (select count(*) from tracked_groups)              as tracked_tags,
  (select count(*) from followed_series)             as followed_series,
  (select count(*) from tag_matches)                 as discovery_suggestions;
```

Check current DB size:
```sql
select pg_size_pretty(pg_database_size(current_database()));
```

---

## Root causes

1. **Remove = soft delete.** `removeWork` in `app/src/lib/library.js` sets
   `hidden = true`; the worker respects it (`fetch_*` queries filter `hidden`).
   Chapter text is never freed. → Removed works accumulate forever.
2. **Images are inlined as base64.** Both the worker (`_inline_chapter_images` in
   `worker/ficstash_worker/sources/ao3.py`) and the on-device downloader
   (`app/src/lib/sources/ao3.js`, "capture work skin + inline images" commit)
   embed images into `chapters.content`. base64 is ~1.37× the raw bytes, and a
   handful of image-heavy chatfics dominate the table.
3. **Discovery hoards metadata.** Each tag search upserts every match into
   `tag_matches` (`upsert_tag_matches`). `TAG_SEED_LIMIT` (worker `ao3.py`, raised
   to 300) × ~30 tags = up to ~9k rows of suggestions you never saved.

---

## To implement (durable fixes)

Priority order. All are **worker/DB-side or optional app-side** — none strictly
requires an APK except where noted.

### 1. Make "remove" actually free space (root cause #1)
Two options:
- **App-side (needs APK):** in `removeWork` (`app/src/lib/library.js`), after
  setting `hidden = true`, also `delete from chapters where work_id = :id`. Keep the
  hidden `works` row as a lightweight tombstone so the worker still won't re-add it.
- **Worker-side (no APK) — recommended:** add a small pass in `worker/main.py` that,
  each run, deletes chapters for any `works.hidden = true` that still has chapter
  rows. Purges removed works' text within a day, no app change. (Add
  `delete_chapters_for_hidden_works()` in `supabase_io.py`.)

### 2. Stop / cap image inlining (root cause #2)
- Simplest: **don't inline at all** — leave remote `<img>` in place; the reader's
  `neutralizeRemoteImages` already shows the 📷 placeholder. Gate it behind an env
  flag (`INLINE_IMAGES=0`) in the worker, and a build flag / setting on-device.
- Or keep inlining but drop the per-work/per-image caps hard (e.g. only inline
  images < 40 KB). Worker caps live near `_inline_chapter_images`; on-device in
  `app/src/lib/sources/ao3.js`.

### 3. Lean discovery metadata (root cause #3)
- Lower `TAG_SEED_LIMIT` (worker `ao3.py`) from 300 back to ~150 — env-tunable.
- Optionally age out `tag_matches` that are unsaved + older than N days in the
  worker's What's-New retention pass (`age_out_saved_matches` already exists;
  extend it to prune stale unsaved suggestions, not just flip origins).

### 4. (Optional) periodic maintenance
- `VACUUM FULL` frees on-disk space, but Supabase's **dashboard figure lags** (can
  take hours to recompute) and the **provisioned disk doesn't auto-shrink**. So
  after a big reclaim, the billed number may look high for a while — that's normal.
- Autovacuum handles routine dead rows; you only need `VACUUM FULL` after a large
  one-off delete like this.

---

## Supabase gotchas learned here

- `VACUUM FULL` **cannot** run in a transaction → run each one as its own SQL-editor
  statement, not batched.
- `VACUUM FULL` takes an **exclusive lock** + needs temporary extra disk → run when
  no sync is writing that table.
- The dashboard "Database Size" **lags** the real `pg_database_size` — after cleanup
  it caught up from 0.51 GB → 0.149 GB on the next refresh.
- Free tier = **0.5 GB per project**, measured as current DB size (not a period
  peak). Getting under it clears the restriction once the metric refreshes.
