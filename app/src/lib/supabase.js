import { createClient } from '@supabase/supabase-js';
import { Preferences } from '@capacitor/preferences';

// The app uses the ANON key only, behind Row Level Security. After migration
// 0015 the anon key reads/writes NOTHING on its own — every table requires a
// logged-in owner session (see is_owner() in the DB). So the library is private
// even though this key is public. The service_role key is NEVER shipped in the
// app — worker-side only.
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Persist the auth session in Capacitor Preferences (SharedPreferences), not the
// WebView's localStorage: on Android the WebView can drop localStorage between
// cold starts, which would silently log the user out every launch. Preferences
// survives. supabase-js awaits async storage, so returning Promises is fine.
const capacitorAuthStorage = {
  getItem: (key) => Preferences.get({ key }).then(({ value }) => value ?? null),
  setItem: (key, value) => Preferences.set({ key, value }).then(() => undefined),
  removeItem: (key) => Preferences.remove({ key }).then(() => undefined),
};

export const supabase = url && anonKey
  ? createClient(url, anonKey, {
      auth: {
        storage: capacitorAuthStorage,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false, // no OAuth/magic-link redirects in the app
      },
    })
  : null;
export const hasSupabase = Boolean(supabase);
