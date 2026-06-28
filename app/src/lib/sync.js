import { supabase, hasSupabase } from './supabase.js';
import { runSync } from './ondevice.js';

// The PRIMARY sync now: run AO3 discovery + downloads ON-DEVICE (residential IP,
// which AO3 answers), writing straight to Supabase. This is what pull-to-refresh
// calls instead of the old worker round-trip — no GitHub Actions dispatch, no 525.
// The worker still runs on its schedule for non-AO3 sources + ongoing refresh.
// Never throws (runSync catches); returns { ok, newMatches, saved }.
export async function syncNow({ onProgress } = {}) {
  return runSync({ onProgress });
}

// Ask the worker to run now (via the trigger-sync edge function → GitHub).
// Returns { ok, error? }. When Supabase isn't configured this is a no-op.
export async function triggerSync(opts = {}) {
  if (!hasSupabase) return { ok: false, error: 'Not connected' };
  // savesOnly → a fast, real-time run that fetches just the requested links/saves
  // in its own workflow lane, so a tapped Save downloads now instead of waiting
  // behind the full sweep.
  const body = opts.savesOnly ? { savesOnly: true } : {};
  const { data, error } = await supabase.functions.invoke('trigger-sync', { method: 'POST', body });
  if (error) return { ok: false, error: error.message || String(error) };
  return data || { ok: true };
}

// Latest sync run status, for showing "last synced / running".
export async function syncStatus() {
  if (!hasSupabase) return null;
  const { data, error } = await supabase.functions.invoke('trigger-sync', { method: 'GET' });
  if (error) return null;
  return data?.run || null;
}

// Fire a sync run, but skip it when one is already queued or in progress.
// Tapping Save kicks this so a download starts right away; the guard keeps
// several quick saves from stacking redundant full AO3 sweeps (the next run
// already picks up every wanted work). Fire-and-forget — never throws.
export async function kickSync() {
  if (!hasSupabase) return { ok: false, error: 'Not connected' };
  try {
    const run = await syncStatus();
    if (run && (run.status === 'queued' || run.status === 'in_progress')) {
      return { ok: true, alreadyRunning: true };
    }
    return await triggerSync();
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Fire a real-time SAVE run: fetch just the requested links/saves now, in their
// own workflow lane, so a tapped Save downloads immediately instead of waiting
// behind (or being blocked by) a full sweep. Fire-and-forget.
export async function kickSave() {
  if (!hasSupabase) return { ok: false, error: 'Not connected' };
  try { return await triggerSync({ savesOnly: true }); }
  catch (e) { return { ok: false, error: String(e) }; }
}

// Trigger a sync and WATCH it through to completion, so the UI can hold a live
// "Syncing…" state until the worker run actually finishes — instead of the old
// fire-and-forget that said "started" and stopped (so a run that later failed
// looked identical to one that worked).
//
// Defaults to the fast saves-only lane: it downloads your pending links + tapped
// Saves in its own workflow lane and finishes in a minute or two. The heavy
// tag-discovery / offline-backfill sweep runs on the nightly schedule, so the
// interactive button never kicks (or waits behind) that slow, failure-prone run.
//
// Polls the latest run's status via the trigger-sync edge function. Resolves with
// { ok, conclusion?, timedOut?, error? }. `onPhase('starting'|'queued'|
// 'fetching'|'done'|'failed'|'timeout')` is an optional progress hook. Never
// throws — a watch failure just resolves ok:true,timedOut so the run keeps going
// server-side and the next pull picks it up.
export async function watchSync({ savesOnly = true, onPhase, timeoutMs = 240000, pollMs = 4000 } = {}) {
  if (!hasSupabase) return { ok: false, error: 'Not connected' };
  const phase = (p) => { try { onPhase && onPhase(p); } catch (e) {} };
  // Remember the run that's "latest" right now, so we can tell when OURS appears
  // rather than mistaking a previously-finished run for this one.
  let prevUrl = null;
  try { const r0 = await syncStatus(); prevUrl = r0?.url || null; } catch (e) {}

  phase('starting');
  const disp = await triggerSync(savesOnly ? { savesOnly: true } : {});
  if (!disp.ok) return { ok: false, error: disp.error || 'Could not start sync.' };

  const t0 = Date.now();
  let sawActive = false;
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollMs));
    let run = null;
    try { run = await syncStatus(); } catch (e) { continue; }
    if (!run) continue;
    const isOurs = sawActive || (run.url && run.url !== prevUrl);
    if (run.status === 'queued') { phase('queued'); continue; }
    if (run.status === 'in_progress') { sawActive = true; phase('fetching'); continue; }
    if (run.status === 'completed') {
      if (!isOurs) { phase('starting'); continue; } // still the previous run — wait for ours
      const ok = run.conclusion === 'success';
      phase(ok ? 'done' : 'failed');
      return { ok, conclusion: run.conclusion || 'unknown' };
    }
    // status 'none'/unknown — keep waiting for the run to register.
  }
  phase('timeout');
  return { ok: true, timedOut: true };
}
