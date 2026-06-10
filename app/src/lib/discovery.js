import { supabase, hasSupabase } from './supabase.js';

// Global discovery filters (the single discovery_prefs row, id = 1):
//   languages     — only surface tag-discovery matches in these languages
//                   (empty = all). Stored as [{code, native, english}].
//   excludedTags  — never surface a work carrying any of these tags. On AO3
//                   ratings are tags, so this also powers "exclude Explicit".
const DEFAULT_PREFS = { languages: [], excludedTags: [] };

export async function fetchDiscoveryPrefs() {
  if (!hasSupabase) return { ...DEFAULT_PREFS };
  const { data, error } = await supabase
    .from('discovery_prefs')
    .select('languages,excluded_tags')
    .eq('id', 1)
    .maybeSingle();
  if (error || !data) return { ...DEFAULT_PREFS };
  return {
    languages: Array.isArray(data.languages) ? data.languages : [],
    excludedTags: Array.isArray(data.excluded_tags) ? data.excluded_tags : [],
  };
}

export async function updateDiscoveryPrefs({ languages, excludedTags }) {
  if (!hasSupabase) return;
  const langs = (languages || [])
    .map((l) => ({ code: l.code, native: l.native, english: l.english }))
    .filter((l) => l.code);
  const excluded = (excludedTags || [])
    .map((t) => ({ name: t.name, id: t.id ?? '', kind: t.kind || 'freeform' }))
    .filter((t) => t.name);
  // Singleton row: upsert so it works whether or not the seed row exists.
  const { error } = await supabase
    .from('discovery_prefs')
    .upsert({ id: 1, languages: langs, excluded_tags: excluded }, { onConflict: 'id' });
  if (error) throw error;
}
