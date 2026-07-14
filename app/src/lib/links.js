import { supabase, hasSupabase } from './supabase.js';
import { triggerSync } from './sync.js';
import { parseWorkRef } from './urlref.js';
import { processAo3Links } from './ondevice.js';
import { isAo3Url } from './sources/ao3.js';

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
  // AO3 link → fetch it NOW on-device (residential IP, which AO3 answers), so the
  // download lands without a worker round-trip. Non-AO3 (Royal Road, FFN, …) still
  // needs FanFicFare, so also kick the worker's fast lane. Both fire-and-forget.
  // AO3 → fetch on-device (residential IP). Non-AO3 (Royal Road, FFN, …) needs
  // FanFicFare, so those go to the worker. Only ONE path fires, so we stop spamming
  // the worker on every AO3 add (which was churning its runs into cancellations).
  if (isAo3Url(clean)) processAo3Links().catch(() => {});
  else triggerSync({ savesOnly: true }).catch(() => {});
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

// In-flight link requests (queued / fetching), newest first. Completed ones drop
// off (the finished work shows in the library's "Added by link" section); FAILED
// ones (error / restricted) move to the Discover → Failed stash, so they're not
// listed here anymore.
export async function fetchPendingLinks() {
  if (!hasSupabase) return [];
  const { data, error } = await supabase
    .from('requested_urls')
    .select('id,url,status,title,error,created_at')
    .in('status', ['queued', 'fetching'])
    .order('created_at', { ascending: false });
  if (error) return [];
  return data || [];
}

// Retry a failed link import. Re-queues it and kicks the WORKER's fast lane — the
// worker logs in with the AO3 account, so a work that was 'restricted' to a
// logged-out fetch (registered-users-only) downloads on the authenticated retry.
export async function retryLinkRequest(id) {
  if (!hasSupabase) return { ok: false, error: 'Connect your account first.' };
  const { error } = await supabase
    .from('requested_urls')
    .update({ status: 'queued', error: null })
    .eq('id', id);
  if (error) return { ok: false, error: error.message || String(error) };
  triggerSync({ savesOnly: true }).catch(() => {}); // worker (logged in) re-fetches
  return { ok: true };
}

// Retry ALL failed link imports at once (re-queue every error/restricted request),
// then one worker kick. For when a batch of members-only links needs the account.
export async function retryAllFailedLinks() {
  if (!hasSupabase) return { ok: false, count: 0 };
  const { data, error } = await supabase
    .from('requested_urls')
    .update({ status: 'queued', error: null })
    .in('status', ['error', 'restricted'])
    .select('id');
  if (error) return { ok: false, error: error.message || String(error), count: 0 };
  if ((data || []).length) triggerSync({ savesOnly: true }).catch(() => {});
  return { ok: true, count: (data || []).length };
}

// Failed link imports for the Discover → Failed stash: requests that errored or hit
// AO3's members-only gate. Shaped like a discovery match so the Failed screen can
// render them with the same card (isLink flags the link-specific retry/remove).
export async function fetchFailedLinks() {
  if (!hasSupabase) return [];
  const { data, error } = await supabase
    .from('requested_urls')
    .select('id,url,status,title,error,source,source_work_id,created_at')
    .in('status', ['error', 'restricted'])
    .order('created_at', { ascending: false });
  if (error) return [];
  return (data || []).map((r) => ({
    id: `link-${r.id}`,
    requestId: r.id,
    isLink: true,
    source: r.source || 'ao3',
    sourceWorkId: r.source_work_id || '',
    sourceUrl: r.url,
    title: r.title || r.url,
    author: '',
    fandom: '',
    summary: '',
    tags: [],
    status: 'ongoing',
    palette: 0,
    failReason: r.status === 'restricted'
      ? 'Restricted — members-only; retry uses your AO3 account'
      : (r.error || 'Import failed'),
  }));
}
