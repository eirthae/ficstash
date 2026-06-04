# FicStash Intake

A tiny dark, single-file web tool to **bulk add links + files** to your FicStash
library from any device (laptop, iPad, …). It writes to the *same* Supabase the
phone app reads, so anything you add here shows up in the app.

It's one self-contained file — `index.html` — meant to live in a **public
Supabase Storage bucket** so you can open it anywhere. No build, no domain, no cost.

## What it does
- **Links** — one box per link; paste a whole list (newlines/commas) and it
  splits into rows. "Fetch" queues them in `requested_urls`; the worker downloads
  them on its next run (and the tool nudges a sync so it starts promptly).
- **Files** — pick/drag multiple **EPUB**/**TXT** files. They're parsed in the
  browser (incl. EPUB series metadata) and inserted as fully-offline works —
  they appear in the app's **Books** shelf, auto-grouped by series/author.

## Host it (one time, ~2 min, free)
1. Supabase dashboard → **Storage** → **New bucket** → name it `intake`, tick
   **Public bucket**.
2. **Upload** this `index.html` into that bucket.
3. Open the public URL:
   `https://<your-project>.supabase.co/storage/v1/object/public/intake/index.html`
4. First open asks for your **Project URL** + **anon (public) key** — both in
   Supabase → **Project Settings → API**. They're saved on that device and act as
   the gate (without them the tool does nothing). Repeat once per device.
5. Optional: **Install** it (desktop Chrome/Edge) or **Add to Home Screen**
   (iPad Safari) so it opens like an app with its own icon.

To update the tool later, re-upload `index.html` to the bucket (overwrite).

## Notes
- Links are fetched by the CI worker (a browser can't fetch arbitrary sites), so
  Cloudflare-blocked sites still won't work from here — same as the phone app.
- The anon key is public-safe (it only grants what your RLS allows), which is why
  it's fine to keep in a device's local storage.
- PDF isn't supported yet (would need a PDF text extractor); EPUB + TXT only.
