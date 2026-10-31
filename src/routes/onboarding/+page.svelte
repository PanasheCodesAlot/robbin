
<script>
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { supabase, safeRedirect } from '#lib/supabase.js';
    import { ArrowsDownUp, DeviceMobile, Handshake } from 'phosphor-svelte';

  let phone = $state('');
  let busy = $state(false);
  let loading = $state(true);
  let error = $state('');

  onMount(async () => {
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      goto('/signin?redirect=/onboarding');
      return;
    }

    // Load existing number if available
    const { data } = await supabase
      .from('profiles')
      .select('mobile_number')
      .eq('id', user.id)
      .maybeSingle();

    phone = data?.mobile_number || '';
    loading = false;
  });

  async function submit(e) {
    e.preventDefault();
    if (busy) return;

    error = '';

    const mobile = phone.trim();

    if (!/^\+?[\d\s()-]{7,20}$/.test(mobile)) {
      error = 'Enter a valid mobile number.';
      return;
    }

    busy = true;

    try {
      const { data: { user }, error: authError } =
        await supabase.auth.getUser();

      if (authError || !user) throw new Error('Please sign in again.');

      const { error: updateError } = await supabase
        .from('profiles')
        .update({ mobile_number: mobile })
        .eq('id', user.id);

      if (updateError) throw updateError;

      await goto(
        safeRedirect(page.url.searchParams.get('redirect')),
        { invalidateAll: true }
      );

    } catch (err) {
      error = err.message || 'Could not save your number. Try again.';
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head>
  <title>Almost there — Robbin'</title>
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@600;700;800&family=Figtree:wght@400;500;600;700&display=swap" rel="stylesheet" />
</svelte:head>

<div
  class="min-h-[100dvh] w-full grid place-items-center px-4 py-8"
  style="font-family:'Figtree',system-ui,sans-serif;color:#14181a"
>
  <span class="text-[26px] font-extrabold tracking-tight fixed top-5 left-7.5">
    Robbin'
  </span>

  <div class="w-full max-w-[400px]">
    <div class="bg-white border border-[#e0e7e3] rounded-[20px] p-6 shadow-[0_10px_30px_-18px_rgba(20,24,26,.35)]">

      {#if loading}
        <div class="py-10 text-center text-sm text-[#5a6662]">
          Getting things ready...
        </div>
      {:else}
        <div class="mb-6">
          <div class="w-11 h-11 rounded-[13px] grid place-items-center mb-5">
            <span class="text-xl">
                <ArrowsDownUp size={40} />
            </span>
          </div>

          <h1
            class="text-[23px] font-extrabold mb-2"
            style="font-family:'Bricolage Grotesque',sans-serif"
          >
            One last thing.
          </h1>
        </div>

        <form onsubmit={submit} class="flex flex-col gap-4" novalidate>
          <div>
            <label
              for="phone"
              class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider"
            >
              Mobile number
            </label>

            <input
              id="phone"
              type="tel"
              bind:value={phone}
              autocomplete="tel"
              inputmode="tel"
              placeholder="0 991 234 567"
              class="w-full px-3 py-3 border border-[#e3e7e4] rounded-[10px] text-[14px] outline-none focus:border-[#1f6b57]"
            />

            <p class="text-[11px] text-[#8a9690] mt-2">
              Better experience when number is linked to Whatsapp.
            </p>
          </div>

          {#if error}
            <div
              role="alert"
              class="text-[13px] font-semibold text-[#b23a2f] bg-[#fdf1ef] border border-[#f0d6d2] rounded-[10px] px-3 py-2"
            >
              {error}
            </div>
          {/if}

          <button
            type="submit"
            disabled={busy}
            class="w-full bg-black py-3 rounded-[12px] text-[14.5px] font-bold text-white disabled:opacity-60"
          >
            {#if busy}
              Saving...
            {:else}
              Continue →
            {/if}
          </button>
        </form>
      {/if}
    </div>

    <p class="text-center text-[11px] text-[#89938e] mt-4">
      Your number is only used for order-related communication.
    </p>
  </div>
</div>
