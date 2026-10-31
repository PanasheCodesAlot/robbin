import { createClient } from '@supabase/supabase-js';

const PUBLIC_SUPABASE_URL = '...'
const PUBLIC_SUPABASE_PUBLISHABLE_KEY = '...'

if (!PUBLIC_SUPABASE_URL || !PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
  throw new Error('Missing PUBLIC_SUPABASE_URL or PUBLIC_SUPABASE_PUBLISHABLE_KEY');
}

export const supabase = createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY);

/* Only allow redirects to paths inside this app (blocks //evil.com and loops back to /signin). */
export function safeRedirect(path) {
  if (typeof path !== 'string') return '/';
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/signin')) return '/';
  return path;
}

export async function signOut() {
  await supabase.auth.signOut();
}