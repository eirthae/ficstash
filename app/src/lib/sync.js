import { supabase, hasSupabase } from './supabase.js';

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
