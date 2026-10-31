
<script>
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Eye, EyeSlash } from 'phosphor-svelte';
  import { supabase, safeRedirect } from '#lib/supabase.js';

  let mode = $state('signin');
  let displayName = $state('');
  let email = $state('');
  let password = $state('');
  let showPw = $state(false);
  let busy = $state(false);
  let error = $state('');
  let notice = $state('');

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function setMode(m) {
    mode = m;
    error = '';
    notice = '';
  }

  function friendly(err) {
    const m = (err?.message || '').toLowerCase();

    if (m.includes('invalid login')) return 'Wrong email or password.';
    if (m.includes('email not confirmed')) return 'Please confirm your email first. Check your inbox for the link.';
    if (m.includes('already registered') || m.includes('already been registered')) return 'An account with this email already exists. Try signing in.';
    if (m.includes('rate limit') || m.includes('too many')) return 'Too many attempts. Please wait a minute and try again.';
    if (m.includes('password') && m.includes('characters')) return 'Password must be at least 6 characters.';
    if (m.includes('failed to fetch') || m.includes('network')) return 'Could not reach the server. Check your connection.';

    return err?.message || 'Something went wrong. Please try again.';
  }

  async function continueUserToOnBoarding(user) {
    location.href = '/onboarding'
  }

  async function continueUserToMain(user) {
    location.href = '/'
  }

  async function submit(e) {
    e.preventDefault();

    if (busy) return;

    error = '';
    notice = '';

    const mail = email.trim();
    const name = displayName.trim();

    if (!EMAIL_RE.test(mail)) {
      error = 'Enter a valid email address.';
      return;
    }

    if (password.length < 6) {
      error = 'Password must be at least 6 characters.';
      return;
    }

    if (mode === 'signup' && (name.length < 2 || name.length > 24)) {
      error = 'Display name must be 2 to 24 characters.';
      return;
    }

    busy = true;

    try {
      if (mode === 'signin') {
        const { data, error: err } = await supabase.auth.signInWithPassword({
          email: mail,
          password
        });

        if (err) throw err;

        await continueUserToMain(data.user);

      } else {
        const { data, error: err } = await supabase.auth.signUp({
          email: mail,
          password,
          options: {
            data: { display_name: name }
          }
        });

        if (err) throw err;

        if (data.session && data.user) {
          await continueUserToOnBoarding(data.user);
        } else {
          // Email confirmation required.
          mode = 'signin';
          password = '';
          notice = 'Account created. Check your email to confirm it, then sign in.';
        }
      }

    } catch (err) {
      error = friendly(err);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head>
  <title>{mode === 'signin' ? 'Sign in' : 'Create account'} — Robbin'</title>
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@600;700;800&family=Figtree:wght@400;500;600;700&display=swap" rel="stylesheet" />
</svelte:head>

<div class="min-h-[100dvh] w-full grid px-4 py-8" style="font-family:'Figtree',system-ui,sans-serif;color:#14181a">
  <span class="text-[26px] font-extrabold tracking-tight ml-2">Robbin'</span>

  <div class="w-full max-w-[400px]">
    <div class="bg-white border border-[#e0e7e3] rounded-[20px] p-5 shadow-[0_10px_30px_-18px_rgba(20,24,26,.35)]">

      <div id="tablist-nav" class="grid grid-cols-2 gap-1 p-1 rounded-[12px] bg-black/15 mb-5" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'signin'}
          onclick={() => setMode('signin')}
          class="py-2 rounded-[9px] text-[13.5px] font-bold transition {mode === 'signin' ? 'bg-white shadow-sm text-[#14181a]' : 'text-[#5a6662]'}"
        >
          Sign in
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={mode === 'signup'}
          onclick={() => setMode('signup')}
          class="py-2 rounded-[9px] text-[13.5px] font-bold transition {mode === 'signup' ? 'bg-white shadow-sm text-[#14181a]' : 'text-[#5a6662]'}"
        >
          Create account
        </button>
      </div>

      <h1 class="text-[20px] font-extrabold mb-1" style="font-family:'Bricolage Grotesque',sans-serif">
        {mode === 'signin' ? 'Welcome back' : 'Join the store'}
      </h1>

      <p class="text-[13px] text-[#5a6662] mb-4">
        {mode === 'signin' ? 'Sign in to walk the aisles.' : 'Pick a name. Other shoppers will see it above your cart.'}
      </p>

      <form onsubmit={submit} class="flex flex-col gap-3.5" novalidate>

        {#if mode === 'signup'}
          <div>
            <label for="name" class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">
              @ Name
            </label>

            <input
              id="name"
              type="text"
              bind:value={displayName}
              maxlength="24"
              autocomplete="nickname"
              placeholder="e.g. Thandi"
              class="w-full px-3 py-2.5 border border-[#e3e7e4] rounded-[10px] text-[14px] outline-none focus:border-[#1f6b57]"
            />
          </div>
        {/if}

        <div>
          <label for="email" class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">
            Email
          </label>

          <input
            id="email"
            type="email"
            bind:value={email}
            autocomplete="email"
            inputmode="email"
            placeholder="you@example.com"
            class="w-full px-3 py-2.5 border border-[#e3e7e4] rounded-[10px] text-[14px] outline-none focus:border-[#1f6b57]"
          />
        </div>

        <div>
          <label for="password" class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">
            Password
          </label>

          <div class="relative">
            <input
              id="password"
              type={showPw ? 'text' : 'password'}
              bind:value={password}
              autocomplete={mode === 'signin' ? 'current-password' : 'new-password'}
              placeholder="At least 6 characters"
              class="w-full pl-3 pr-11 py-2.5 border border-[#e3e7e4] rounded-[10px] text-[14px] outline-none focus:border-[#1f6b57]"
            />

            <button
              type="button"
              onclick={() => showPw = !showPw}
              aria-label={showPw ? 'Hide password' : 'Show password'}
              class="absolute right-1.5 top-1/2 -translate-y-1/2 w-8 h-8 grid place-items-center rounded-[8px] text-[#5a6662] hover:bg-[#eef2f0]"
            >
              {#if showPw}
                <EyeSlash size={18} />
              {:else}
                <Eye size={18} />
              {/if}
            </button>
          </div>
        </div>

        {#if error}
          <div role="alert" class="text-[13px] font-semibold text-[#b23a2f] bg-[#fdf1ef] border border-[#f0d6d2] rounded-[10px] px-3 py-2">
            {error}
          </div>
        {/if}

        {#if notice}
          <div role="status" class="text-[13px] font-semibold text-[#1b5e4d] bg-[#eef6f2] border border-[#d5e6dd] rounded-[10px] px-3 py-2">
            {notice}
          </div>
        {/if}

        <button
          type="submit"
          disabled={busy}
          class="w-full bg-black py-3 rounded-[12px] text-[14.5px] font-bold text-white disabled:opacity-60"
        >
          {#if busy}
            Please wait…
          {:else if mode === 'signin'}
            Sign in
          {:else}
            Create account
          {/if}
        </button>

      </form>
    </div>
  </div>
</div>
