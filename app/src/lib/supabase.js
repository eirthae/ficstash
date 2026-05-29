import { createClient } from '@supabase/supabase-js';

// The app uses the ANON key only, behind Row Level Security.
// The service_role key is NEVER shipped in the app — worker-side only.
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = url && anonKey ? createClient(url, anonKey) : null;
export const hasSupabase = Boolean(supabase);
