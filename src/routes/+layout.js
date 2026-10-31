// src/routes/+layout.js
// Client-only app (3D canvas + browser storage), and every route requires a signed-in user.
import { redirect } from '@sveltejs/kit';
import { supabase, safeRedirect } from '#lib/supabase.js';

export const ssr = false;
export const prerender = false;

export async function load({ url }) {
  const { data: { session } } = await supabase.auth.getSession();

  const exceptions = ['/admin', '/signin', '/onboarding']
  if (exceptions.some(e => url.pathname.includes(e)) ) return
  const onSignin = url.pathname === '/signin';

  /* Not signed in: everything except /signin sends you there, remembering where you were going. */
  if (!session) {
    if (!onSignin) {
      redirect(307, '/signin?redirect=' + encodeURIComponent(url.pathname + url.search));
    }
    return { session: null, profile: null };
  }

  /* Already signed in: no reason to see the sign-in page. */
  if (onSignin) redirect(307, safeRedirect(url.searchParams.get('redirect')));

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', session.user.id)
    .maybeSingle();

    
  console.log(profile)
  if (!profile?.mobile_number) redirect(307, '/onboarding')

  /* Admin area: UI guard only. Real protection comes from RLS and server-side checks on writes. */
  if (url.pathname.startsWith('/admin') && !profile?.is_admin) redirect(307, '/');

  return { session, profile };
}