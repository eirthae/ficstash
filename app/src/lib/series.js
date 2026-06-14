import { supabase, hasSupabase } from './supabase.js';
import { triggerSync } from './sync.js';

// AO3 series actions. Both "download all works in this series" and "follow
// series" write to the same `followed_series` queue; the worker enumerates the
// series from AO3 and downloads each work. A one-shot download is follow=false
// (the worker drops the row once everything's pulled); a follow is follow=true
// (kept, re-checked each sync for newly-added works).

// The followed_series row for a series id, or null. Tells the detail screen
// whether the series is already queued / being followed.
export async function getSeriesFollow(seriesId) {
  if (!hasSupabase || !seriesId) return null;
  const { data, error } = await supabase
    .from('followed_series')
    .select('id,series_id,series_name,follow,last_checked')
    .eq('series_id', String(seriesId))
    .limit(1);
  if (error || !data || !data.length) return null;
  const r = data[0];
  return { id: r.id, seriesId: r.series_id, seriesName: r.series_name, follow: !!r.follow, lastChecked: r.last_checked };
}

// "Download all works in this series" — also follows it (follow=true), so new
// works added to the series later keep arriving automatically. Kicks the worker.
export async function requestSeriesDownload(seriesId, seriesName = '') {
  if (!hasSupabase) return { ok: false, error: 'Connect your account first.' };
  if (!seriesId) return { ok: false, error: 'No series id' };
  const { error } = await supabase
    .from('followed_series')
    .upsert({ series_id: String(seriesId), series_name: seriesName, follow: true }, { onConflict: 'series_id' });
  if (error) return { ok: false, error: error.message || String(error) };
  triggerSync().catch(() => {});
  return { ok: true, follow: true };
}

// Turn "follow this series" on/off. Following also pulls the whole series (the
// worker downloads any work it doesn't have yet, then watches for new ones).
export async function setSeriesFollow(seriesId, seriesName, follow) {
  if (!hasSupabase) return { ok: false, error: 'Connect your account first.' };
  if (!seriesId) return { ok: false, error: 'No series id' };
  if (follow) {
    const { error } = await supabase
      .from('followed_series')
      .upsert({ series_id: String(seriesId), series_name: seriesName, follow: true }, { onConflict: 'series_id' });
    if (error) return { ok: false, error: error.message || String(error) };
    triggerSync().catch(() => {});
    return { ok: true, follow: true };
  }
  // Unfollow: keep a one-shot download in flight if works are still pending, but
  // stop watching. Simplest + predictable: drop the row entirely.
  const { error } = await supabase.from('followed_series').delete().eq('series_id', String(seriesId));
  if (error) return { ok: false, error: error.message || String(error) };
  return { ok: true, follow: false };
}
