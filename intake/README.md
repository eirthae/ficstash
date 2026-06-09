# FicStash Intake

A tiny dark, single-file web tool to **bulk add links + files** to your FicStash
library from any device (laptop, iPad, …). It writes to the *same* Supabase the
phone app reads, so anything you add here shows up in the app.

**Live (free GitHub Pages):** https://eirthae.github.io/ficstash-intake/
It auto-connects (URL + anon key baked in), then asks you to **sign in** with your
FicStash email + password — the library is private and locked to your account, so
the public anon key alone can't read or write anything. Bookmark it, or "Install" /
"Add to Home Screen" for an app icon.

## What it does
- **Links** — one box per link; paste a whole list and it splits into rows.
  "Fetch" queues them in `requested_urls`; the worker downloads on its next run.
- **Files** — pick/drag multiple **EPUB**/**TXT**; parsed in the browser (incl.
  series metadata) and inserted as offline works → appear in the app's Books
  shelf, auto-grouped.

## Hosting notes
- Source of truth is this `intake/index.html`. The live copy is mirrored to the
  public repo **eirthae/ficstash-intake**, which GitHub Pages serves.
- **Not** hosted from Supabase Storage: Supabase force-serves uploaded HTML as
  `text/plain` (anti-XSS), so a bucket can't render a page. GitHub Pages serves
  real `text/html`.
- To update: re-push `index.html` to the `ficstash-intake` repo (Pages
  redeploys automatically).
