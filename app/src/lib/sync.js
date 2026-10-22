import { supabase, hasSupabase } from './supabase.js';
import { runSync } from './ondevice.js';

// Pull-to-refresh: finish pending downloads ON-DEVICE (residential IP, which AO3
// answers) — the links you pasted and the works you tapped Save on. That's what
// a pull is actually for: "I saved this a few minutes ago and it still isn't
// here." It no longer re-runs discovery, series follows or new-chapter checks;
// those are the scheduled worker's job, where the time budget and AO3 login are.
// Never throws (runSync catches); returns { ok, saved, savesFailed }.
export async function syncNow({ onProgress } = {}) {
  const r = await runSync({ onProgress });
  // Anything the device couldn't download (members-only / adult works a logged-out
  // fetch returns empty for) → hand off to the logged-in worker ONCE (guarded), so
  // saves don't sit "pending" forever when on-device simply can't read them.
  if (r && r.ok && r.savesFailed > 0) kickSaveGuarded().catch(() => {});
  return r;
}

// Ask the worker to run now (via the trigger-sync edge function → GitHub).
// Returns { ok, error? }. When Supabase isn't configured this is a no-op.
export async function triggerSync(opts = {}) {
  if (!hasSupabase) return { ok: false, error: 'Not connected' };
  // savesOnly → a fast, real-time run that fetches just the requested links/saves
  // in its own workflow lane, so a tapped Save downloads now instead of waiting
  // behind the full sweep.
  // savesOnly → a fast, real-time run that fetches just the requested links/saves
  // in its own workflow lane, so a tapped Save downloads now instead of waiting
  // behind the full sweep.
  // groupId → discovery for ONE group, skipping every other pass (allTime adds
  // the back-catalogue walk). See syncGroupViaWorker below for why this goes to
  // the worker rather than being fetched here.
  const body = opts.savesOnly ? { savesOnly: true }
    : opts.groupId ? { groupId: opts.groupId, allTime: !!opts.allTime }
      : {};
  const { data, error } = await supabase.functions.invoke('trigger-sync', { method: 'POST', body });
  if (error) return { ok: false, error: error.message || String(error) };
  return data || { ok: true };
}

// Sync ONE tracked group by asking the worker to do it, and wait for the answer.
//
// Why the worker and not this device: on-device AO3 search is logged out, and it
// has never once succeeded. Every match in the database — across every group,
// for the four months since on-device discovery shipped — was written by a
// worker run hours after the group was created, never by the app at creation.
// AO3 refuses the logged-out phone and answers the logged-in worker, from the
// datacenter IP we'd long blamed for the opposite. So the phone asks.
//
// The cost is honesty about time: GitHub has to start a runner, so this is a
// minute or two, not a moment. `onPhase` is called with 'dispatching' |
// 'queued' | 'running' so the button can say which.
//
// Returns { ok, conclusion, alreadyRunning?, timedOut?, error? }.
export async function syncGroupViaWorker(groupId, { allTime = false, onPhase, timeoutMs = 420000 } = {}) {
  if (!hasSupabase) return { ok: false, error: 'Not connected' };
  onPhase && onPhase('dispatching');
  const started = Date.now();
  const r = await triggerSync({ groupId, allTime });
  if (!r.ok) return { ok: false, error: r.error || 'Could not reach the worker' };
  // Someone else's run holds the lane; ours wasn't dispatched. Say so rather
  // than spinning for seven minutes on a run that isn't ours.
  if (r.alreadyRunning) return { ok: false, alreadyRunning: true };

  // Poll the workflow's latest run. It settles into queued → in_progress →
  // completed. Note this reads the newest run of the whole workflow, not ours by
  // id, so a run someone starts alongside this one can be what we end up
  // watching — acceptable for a progress spinner, not something to trust for
  // correctness. The list refresh afterwards is what actually tells the truth.
  let sawRunning = false;
  while (Date.now() - started < timeoutMs) {
    await new Promise((res) => setTimeout(res, 5000));
    const run = await syncStatus();
    if (!run) continue;
    if (run.status === 'queued') onPhase && onPhase('queued');
    if (run.status === 'in_progress') { sawRunning = true; onPhase && onPhase('running'); }
    // Only trust a 'completed' we reached THROUGH a running state; the first
    // poll can still be showing the previous run, already finished.
    if (run.status === 'completed' && sawRunning) {
      return { ok: run.conclusion === 'success', conclusion: run.conclusion };
    }
  }
  return { ok: false, timedOut: true };
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

// Like kickSave, but SKIP if a run is already queued/in-progress — so a burst of
// callers (e.g. several AO3 link imports that the on-device pass couldn't finish)
// results in ONE worker run, not a stack of them. The fast lane (logged in) then
// mops up whatever the device left 'queued'.
export async function kickSaveGuarded() {
  if (!hasSupabase) return { ok: false, error: 'Not connected' };
  try {
    const run = await syncStatus();
    if (run && (run.status === 'queued' || run.status === 'in_progress')) {
      return { ok: true, alreadyRunning: true };
    }
    return await triggerSync({ savesOnly: true });
  } catch (e) {
    return { ok: false, error: String(e) };
  }
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
