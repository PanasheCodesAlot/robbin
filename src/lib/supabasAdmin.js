/* src/lib/server/supabaseAdmin.js
   SERVER ONLY. Uses the service-role key, which bypasses every database rule.
   Anything under src/lib/server cannot be imported by browser code (SvelteKit fails the build),
   and $env/static/private cannot be imported there either, so the key stays on the server. */
import { createClient } from '@supabase/supabase-js';

const PUBLIC_SUPABASE_URL = '...'
const SUPABASE_SERVICE_ROLE_KEY = '...'

export const supabaseAdmin = createClient(PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});