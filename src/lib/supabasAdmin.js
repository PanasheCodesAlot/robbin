/* src/lib/server/supabaseAdmin.js
   SERVER ONLY. Uses the service-role key, which bypasses every database rule.
   Anything under src/lib/server cannot be imported by browser code (SvelteKit fails the build),
   and $env/static/private cannot be imported there either, so the key stays on the server. */
import { createClient } from '@supabase/supabase-js';

const PUBLIC_SUPABASE_URL = 'https://nxkqcretouzdiwammdzq.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im54a3FjcmV0b3V6ZGl3YW1tZHpxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MzMzODU3OCwiZXhwIjoyMTA4OTE0NTc4fQ.gcUxdpxN1O0joC6kvzA1HMkEeLIJhK0N6cVholhYzd8'

export const supabaseAdmin = createClient(PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});