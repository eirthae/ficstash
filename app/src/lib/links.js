import { supabase, hasSupabase } from './supabase.js';
import { triggerSync } from './sync.js';
import { parseWorkRef } from './urlref.js';

// Add a work by pasting its URL. The app can't fetch a site directly (it only
// talks to Supabase), so this queues the URL and kicks the worker, which
// downloads a full offline copy with FanFicFare on its run. Returns { ok, error? }.
export async function requestUrl(url) {
  if (!hasSupabase) return { ok: false, error: 'Connect your account first to enable downloads.' };
  const clean = (url || '').trim();
  if (!/^https?:\/\/\S+\.\S+/i.test(clean)) {
    return { ok: false, error: 'Paste a full link starting with http(s)://' };
  }
  const { error } = await supabase.from('requested_urls').insert({ url: clean });
  if (error) return { ok: false, error: error.message || String(error) };
  // Fire the worker so the download starts now. Fire-and-forget: a failure here
  // just means it waits for the next scheduled sync, so don't surface it.
  triggerSync().catch(() => {});
  return { ok: true };
}

// Does this URL already correspond to a work in the library? Returns the
// existing work ({ title, status, offline, hidden }) or null. Used to flag a
// duplicate add before queueing it. Only checks sources with a parseable id.
export async function findExistingWork(url) {
  if (!hasSupabase) return null;
  const ref = parseWorkRef(url);
  if (!ref) return null;
  const { data, error } = await supabase
    .from('works')
    .select('id,title,custom_title,status,offline,hidden')
    .eq('source', ref.source)
    .eq('source_work_id', ref.id)
    .limit(1);
  if (error || !data || !data.length) return null;
  const w = data[0];
  return { id: w.id, title: w.custom_title || w.title || 'this work', status: w.status, offline: w.offline, hidden: w.hidden };
}

// Remove a link request the user no longer wants — e.g. a failed download
// cluttering the "Other" tab. Returns { ok, error? }.
export async function removeRequest(id) {
  if (!hasSupabase) return { ok: false, error: 'Connect your account first.' };
  const { error } = await supabase.from('requested_urls').delete().eq('id', id);
  if (error) return { ok: false, error: error.message || String(error) };
  return { ok: true };
}

// In-flight / failed link requests, newest first. Completed requests are dropped
// here because the finished work shows up in the library's "Added by link"
// section instead.
export async function fetchPendingLinks() {
  if (!hasSupabase) return [];
  const { data, error } = await supabase
    .from('requested_urls')
    .select('id,url,status,title,error,created_at')
    .neq('status', 'done')
    .order('created_at', { ascending: false });
  if (error) return [];
  return data || [];
}
