import { supabase, hasSupabase } from './supabase.js';

// Ask the worker to run now (via the trigger-sync edge function → GitHub).
// Returns { ok, error? }. When Supabase isn't configured this is a no-op.
export async function triggerSync() {
  if (!hasSupabase) return { ok: false, error: 'Not connected' };
  const { data, error } = await supabase.functions.invoke('trigger-sync', { method: 'POST' });
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
