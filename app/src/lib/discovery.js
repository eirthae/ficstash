import { supabase, hasSupabase } from './supabase.js';

// Global discovery filters (the single discovery_prefs row, id = 1):
//   languages     — only surface tag-discovery matches in these languages
//                   (empty = all). Stored as [{code, native, english}].
//                   AO3-only; a single list.
//   excludedTags  — never surface a work carrying any of these tags. Now scoped
//                   per Discovery shelf: { ao3:[], sites:[], books:[] }, so you
//                   can exclude "litrpg" from Stories without touching AO3. On
//                   AO3 ratings are tags, so this still powers "exclude Explicit".
const newExcluded = () => ({ ao3: [], sites: [], books: [] });
const DEFAULT_PREFS = { languages: [], excludedTags: newExcluded() };
const SHELVES = ['ao3', 'sites', 'books'];

// Coerce any stored shape into { ao3:[], sites:[], books:[] } of {name,id,kind}.
// A legacy flat array is treated as the AO3 shelf (the old filter was AO3-only).
function normExcluded(e) {
  const clean = (arr) => (arr || [])
    .map((t) => ({ name: t.name, id: t.id ?? '', kind: t.kind || 'freeform' }))
    .filter((t) => t.name);
  const out = newExcluded();
  if (Array.isArray(e)) { out.ao3 = clean(e); return out; }
  if (e && typeof e === 'object') for (const s of SHELVES) out[s] = clean(e[s]);
  return out;
}

export async function fetchDiscoveryPrefs() {
  if (!hasSupabase) return { languages: [], excludedTags: newExcluded() };
  const { data, error } = await supabase
    .from('discovery_prefs')
    .select('languages,excluded_tags')
    .eq('id', 1)
    .maybeSingle();
  if (error || !data) return { languages: [], excludedTags: newExcluded() };
  return {
    languages: Array.isArray(data.languages) ? data.languages : [],
    excludedTags: normExcluded(data.excluded_tags),
  };
}

export async function updateDiscoveryPrefs({ languages, excludedTags }) {
  if (!hasSupabase) return;
  const langs = (languages || [])
    .map((l) => ({ code: l.code, native: l.native, english: l.english }))
    .filter((l) => l.code);
  const excluded = normExcluded(excludedTags); // { ao3:[], sites:[], books:[] }
  // Singleton row: upsert so it works whether or not the seed row exists.
  const { error } = await supabase
    .from('discovery_prefs')
    .upsert({ id: 1, languages: langs, excluded_tags: excluded }, { onConflict: 'id' });
  if (error) throw error;
}
