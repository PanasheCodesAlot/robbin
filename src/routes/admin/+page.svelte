<!-- src/routes/admin/+page.svelte -->
<script>
  import { onMount } from 'svelte';
  import { fly, fade } from 'svelte/transition';
  import {
    loadStore, saveStore, applyIdMap, uid, fmt, HEX_RE, svgPack, productImages
  } from '#lib/breathe.js';
  import { supabase } from '#lib/supabase.js';

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */
  let store = $state(null);
  let loading = $state(true);
  let saving = $state(false);
  let uploading = $state(false);
  let error = $state('');
  let success = $state('');
  let activeTab = $state('products');
  let session = $state(null);
  let isAdmin = $state(false);
  let snapshot = $state('');

  let productFilter = $state('');
  let categoryFilter = $state('');
  let productView = $state('all');
  let selectedProductId = $state(null);
  let selectedBannerId = $state(null);
  let newImageUrl = $state('');
  let dragging = $state(false);
  let confirmId = $state(null);

  // Orders
  let orders = $state([]);
  let ordersLoading = $state(false);
  let ordersError = $state('');
  let orderSearch = $state('');
  let orderStatusFilter = $state('all');
  let selectedOrderId = $state(null);
  let updatingOrderId = $state(null);

  const reduceMotion =
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const dur = (ms) => (reduceMotion ? 0 : ms);

  const groups = [
    { title: 'Catalogue', items: [
      { id: 'products', label: 'Products' },
      { id: 'categories', label: 'Categories' },
      { id: 'banners', label: 'Banners' }
    ]},
    { title: 'Sales', items: [{ id: 'orders', label: 'Orders' }] },
    { title: 'Store setup', items: [
      { id: 'layout', label: 'Floor plan' },
      { id: 'promo', label: 'Promo' },
      { id: 'settings', label: 'Settings' },
      { id: 'ai', label: 'AI shoppers' }
    ]}
  ];
  const tabLabel = (id) => groups.flatMap(g => g.items).find(t => t.id === id)?.label ?? '';

  const SHAPES = ['box', 'bottle', 'can', 'bag', 'bar', 'carton'];
  const STATUSES = ['pending', 'processing', 'completed', 'cancelled'];
  const NEXT_STATUS = { pending: 'processing', processing: 'completed' };
  const NEXT_LABEL = { pending: 'Start processing', processing: 'Mark as completed' };
  const CHECKOUT_SPOTS = ['back-left', 'back-right', 'front-left', 'front-right'];

  /* ------------------------------------------------------------------ */
  /* Load                                                                */
  /* ------------------------------------------------------------------ */
  onMount(async () => {
    const { data: { session: s } } = await supabase.auth.getSession();
    session = s;
    if (!s) {
      loading = false;
      return;
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('is_admin')
      .eq('id', s.user.id)
      .maybeSingle();

    isAdmin = !!profile?.is_admin;

    if (!isAdmin) {
      loading = false;
      return;
    }

    try {
      store = await loadStore();
      if (store.isSeed) delete store.isSeed;
      snapshot = JSON.stringify(store);
      await loadOrders();
      ensureSelection();
    } catch (e) {
      error = e.message || 'Failed to load store';
    } finally {
      loading = false;
    }
  });

  async function loadOrders() {
    ordersLoading = true;
    ordersError = '';

    try {
      const { data, error: queryError } = await supabase
        .from('orders')
        .select(`
          id,
          user_id,
          status,
          created_at,
          order_items (
            id,
            order_id,
            product_id,
            qty,
            products (*)
          )
        `)
        .order('created_at', { ascending: false });

      if (queryError) throw queryError;

      const loadedOrders = data || [];
      const userIds = [
        ...new Set(loadedOrders.map(order => order.user_id).filter(Boolean))
      ];

      let profiles = [];

      if (userIds.length) {
        const { data: profileData, error: profileError } = await supabase
          .from('profiles')
          .select('id, display_name, mobile_number')
          .in('id', userIds);

        if (profileError) throw profileError;
        profiles = profileData || [];
      }

      const profileMap = new Map(profiles.map(profile => [profile.id, profile]));

      orders = loadedOrders.map(order => ({
        ...order,
        customer: profileMap.get(order.user_id) || null,
        order_items: order.order_items || []
      }));

      if (selectedOrderId && !orders.some(order => order.id === selectedOrderId)) {
        selectedOrderId = null;
      }
    } catch (e) {
      ordersError = e.message || 'Failed to load orders';
    } finally {
      ordersLoading = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Derived                                                             */
  /* ------------------------------------------------------------------ */
  const dirty = $derived(!!store && JSON.stringify(store) !== snapshot);

  const selectedProduct = $derived(store?.products.find(p => p.id === selectedProductId) ?? null);
  const selectedBanner = $derived(store?.banners.find(b => b.id === selectedBannerId) ?? null);
  const selectedOrder = $derived(orders.find(order => order.id === selectedOrderId) || null);

  const productCountByCat = $derived.by(() => {
    const m = {};
    for (const p of store?.products ?? []) m[p.categoryId] = (m[p.categoryId] || 0) + 1;
    return m;
  });

  const productViews = $derived.by(() => {
    const ps = store?.products ?? [];
    return [
      { id: 'all', label: 'All', n: ps.length },
      { id: 'draft', label: 'Drafts', n: ps.filter(p => !p.published).length },
      { id: 'hidden', label: 'Off', n: ps.filter(p => !p.enabled).length },
      { id: 'nophoto', label: 'No photo', n: ps.filter(p => !hasPhoto(p)).length },
      { id: 'free', label: 'Price 0', n: ps.filter(p => !Number(p.price)).length }
    ];
  });

  const filteredProducts = $derived.by(() => {
    const q = productFilter.trim().toLowerCase();
    return (store?.products ?? []).filter(p => {
      if (q && !(p.name || '').toLowerCase().includes(q) && !(p.brand || '').toLowerCase().includes(q)) return false;
      if (categoryFilter && p.categoryId !== categoryFilter) return false;
      switch (productView) {
        case 'draft': return !p.published;
        case 'hidden': return !p.enabled;
        case 'nophoto': return !hasPhoto(p);
        case 'free': return !Number(p.price);
        default: return true;
      }
    });
  });

  const statusCounts = $derived.by(() => {
    const c = { all: orders.length, pending: 0, processing: 0, completed: 0, cancelled: 0 };
    for (const o of orders) {
      const s = (o.status || '').toLowerCase();
      if (s in c) c[s]++;
    }
    return c;
  });

  const filteredOrders = $derived(
    orders.filter(order => {
      const matchesStatus =
        orderStatusFilter === 'all' ||
        (order.status || '').toLowerCase() === orderStatusFilter;

      const search = orderSearch.trim().toLowerCase();

      const matchesSearch =
        !search ||
        String(order.id).toLowerCase().includes(search) ||
        String(order.customer?.display_name || '').toLowerCase().includes(search) ||
        String(order.customer?.mobile_number || '').toLowerCase().includes(search) ||
        String(order.user_id || '').toLowerCase().includes(search);

      return matchesStatus && matchesSearch;
    })
  );

  const floorPlan = $derived.by(() => {
    if (!store) return { aisles: [], orphans: [] };
    const n = Math.max(1, Number(store.layout.aisleCount) || 1);
    const aisles = Array.from({ length: n }, (_, i) => ({
      i,
      cats: store.categories.filter(c => (store.layout.assignments[c.id] ?? 0) === i)
    }));
    const orphans = store.categories.filter(c => (store.layout.assignments[c.id] ?? 0) >= n);
    return { aisles, orphans };
  });

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */
  const imgUrl = (img) => (img?.kind === 'url' && img.url ? img.url : '');
  const photoList = (p) => productImages(p).filter(i => imgUrl(i));
  const firstImage = (p) => imgUrl(photoList(p)[0]);
  function hasPhoto(p) {
    return photoList(p).some(i => !imgUrl(i).startsWith('data:'));
  }
  const categoryName = (id) => store?.categories.find(c => c.id === id)?.name || 'No category';

  function inkOn(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return '#ffffff';
    const n = parseInt(m[1], 16);
    const lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    return lum > 150 ? '#13231b' : '#ffffff';
  }

  function aisleOptions(current) {
    const count = Math.max(Number(store.layout.aisleCount) || 1, (current ?? 0) + 1);
    return Array.from({ length: count }, (_, i) => i);
  }

  function ensureSelection() {
    if (typeof window === 'undefined' || !window.matchMedia('(min-width: 1024px)').matches) return;
    if (activeTab === 'products' && !selectedProduct && store?.products.length) {
      selectProduct(store.products[0].id);
    }
    if (activeTab === 'banners' && !selectedBanner && store?.banners.length) {
      selectBanner(store.banners[0].id);
    }
  }

  function setTab(id) {
    activeTab = id;
    confirmId = null;
    if (id === 'orders' && !orders.length) loadOrders();
    ensureSelection();
  }

  function selectProduct(id) {
    const p = store.products.find(x => x.id === id);
    if (p && !p.placement) p.placement = { mode: 'auto' };
    selectedProductId = id;
    confirmId = null;
    newImageUrl = '';
  }

  function selectBanner(id) {
    const b = store.banners.find(x => x.id === id);
    if (b && !b.placements) b.placements = [];
    selectedBannerId = id;
    confirmId = null;
  }

  /* ------------------------------------------------------------------ */
  /* Orders                                                              */
  /* ------------------------------------------------------------------ */
  function orderItemName(item) {
    const product = item.products;
    return product?.name || product?.title || 'Product unavailable';
  }

  function orderItemPrice(item) {
    return Number(item.products?.price || 0);
  }

  function orderTotal(order) {
    return (order.order_items || []).reduce(
      (total, item) => total + orderItemPrice(item) * Number(item.qty || 0),
      0
    );
  }

  const orderUnits = (order) =>
    order.order_items.reduce((n, item) => n + Number(item.qty || 0), 0);

  function shortId(id) {
    const s = String(id);
    return s.length > 10 ? s.slice(0, 8) : s;
  }

  function formatDate(value) {
    if (!value) return '—';

    return new Intl.DateTimeFormat('en-MW', {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(new Date(value));
  }

  function timeAgo(value) {
    if (!value) return '';
    const secs = (Date.now() - new Date(value).getTime()) / 1000;
    if (secs < 60) return 'just now';
    const mins = secs / 60;
    if (mins < 60) return `${Math.floor(mins)} min ago`;
    const hrs = mins / 60;
    if (hrs < 24) return `${Math.floor(hrs)} h ago`;
    const days = hrs / 24;
    if (days < 7) return `${Math.floor(days)} d ago`;
    return new Intl.DateTimeFormat('en-MW', { dateStyle: 'medium' }).format(new Date(value));
  }

  const statusKey = (status) => {
    const s = (status || '').toLowerCase();
    return STATUSES.includes(s) ? s : 'default';
  };

  async function updateOrderStatus(order, newStatus) {
    if (!order || !newStatus || updatingOrderId) return;

    const previousStatus = order.status;
    if (previousStatus === newStatus) return;

    updatingOrderId = order.id;
    ordersError = '';

    try {
      const { error: updateError } = await supabase
        .from('orders')
        .update({ status: newStatus })
        .eq('id', order.id);

      if (updateError) throw updateError;

      orders = orders.map(item =>
        item.id === order.id ? { ...item, status: newStatus } : item
      );

      success = `Order ${shortId(order.id)} is now ${newStatus}`;
    } catch (e) {
      ordersError = e.message || 'Could not update order';
    } finally {
      updatingOrderId = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Images                                                              */
  /* ------------------------------------------------------------------ */
  /** Extract path inside the store-images bucket from a public URL */
  function getBucketPath(url) {
    if (!url || typeof url !== 'string') return null;
    const match = url.match(/\/storage\/v1\/object\/public\/store-images\/(.+?)(?:\?|$)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  /** Best-effort delete from the bucket (ignores non-bucket URLs) */
  async function removeFromBucket(url) {
    const path = getBucketPath(url);
    if (!path) return;

    try {
      await supabase.storage.from('store-images').remove([path]);
    } catch (e) {
      console.warn('Bucket delete failed:', e);
    }
  }

  /** How many products/banners still point at this image (so we never delete a shared file) */
  function urlRefCount(url) {
    let n = 0;
    for (const p of store.products) {
      if (new Set(productImages(p).map(imgUrl)).has(url)) n++;
    }
    for (const b of store.banners) {
      if (imgUrl(b.image) === url) n++;
    }
    return n;
  }

  async function uploadImage(file) {
    const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
    const path = `${crypto.randomUUID()}.${ext}`;

    const { error: upErr } = await supabase.storage
      .from('store-images')
      .upload(path, file, { cacheControl: '3600', upsert: false });

    if (upErr) throw upErr;

    const { data } = supabase.storage.from('store-images').getPublicUrl(path);
    return data.publicUrl;
  }

  async function uploadMany(files, apply) {
    const list = [...(files || [])].filter(f => f.type.startsWith('image/'));
    if (!list.length) return;

    uploading = true;
    error = '';

    try {
      for (const f of list) await apply(await uploadImage(f));
    } catch (err) {
      error = err.message || 'Upload failed';
    } finally {
      uploading = false;
    }
  }

  function addProductPhoto(url) {
    const p = selectedProduct;
    if (!p) return;
    // drop the generated placeholder once a real photo arrives
    const keep = photoList(p).filter(i => !imgUrl(i).startsWith('data:'));
    p.images = [...keep, { kind: 'url', url }];
    p.image = p.images[0];
  }

  async function onProductFiles(files) {
    dragging = false;
    await uploadMany(files, addProductPhoto);
  }

  function addPhotoByLink() {
    const url = newImageUrl.trim();
    if (!url) return;
    addProductPhoto(url);
    newImageUrl = '';
  }

  async function removeProductImage(index) {
    const p = selectedProduct;
    if (!p) return;

    const list = [...photoList(p)];
    const url = imgUrl(list[index]);
    list.splice(index, 1);
    p.images = list;
    p.image = list[0] || { kind: 'none' };

    if (url && urlRefCount(url) === 0) await removeFromBucket(url);
  }

  function makeMainPhoto(index) {
    const p = selectedProduct;
    if (!p) return;
    const list = [...photoList(p)];
    const [img] = list.splice(index, 1);
    p.images = [img, ...list];
    p.image = p.images[0];
  }

  async function onBannerFiles(files) {
    dragging = false;
    await uploadMany([[...(files || [])][0]].filter(Boolean), async (url) => {
      const old = imgUrl(selectedBanner?.image);
      if (selectedBanner) selectedBanner.image = { kind: 'url', url };
      if (old && urlRefCount(old) === 0) await removeFromBucket(old);
    });
  }

  async function clearBannerImage() {
    const url = imgUrl(selectedBanner?.image);
    selectedBanner.image = { kind: 'none' };
    if (url && urlRefCount(url) === 0) await removeFromBucket(url);
  }

  /* ------------------------------------------------------------------ */
  /* Save / add / remove                                                 */
  /* ------------------------------------------------------------------ */
  async function handleSave() {
    if (!store || saving) return;

    saving = true;
    error = '';
    success = '';

    try {
      const result = await saveStore(store);
      if (result.idMap) applyIdMap(store, result.idMap);

      success = result.skippedImages
        ? `Saved (skipped ${result.skippedImages} local uploads)`
        : 'Store saved';

      store = { ...store };
      snapshot = JSON.stringify(store);
    } catch (e) {
      error = e.message || 'Save failed';
    } finally {
      saving = false;
    }
  }

  function addCategory() {
    const id = uid('cat');
    store.categories = [...store.categories, { id, name: 'New Category' }];
    store.layout.assignments[id] = 0;
  }

  function removeCategory(id) {
    if (store.products.some(p => p.categoryId === id)) {
      error = 'Cannot delete a category that still has products';
      return;
    }

    store.categories = store.categories.filter(c => c.id !== id);
    delete store.layout.assignments[id];
  }

  function addProduct() {
    const id = uid('p');
    const catId = store.categories[0]?.id || '';
    const img = {
      kind: 'url',
      url: svgPack('NEW', '#94a3b8', '#0f172a')
    };

    store.products = [...store.products, {
      id,
      name: 'New Product',
      brand: '',
      price: 0,
      categoryId: catId,
      shape: 'box',
      color: '#94a3b8',
      imageType: 'wrap',
      enabled: true,
      published: false,
      placement: { mode: 'auto' },
      image: { ...img },
      images: [{ ...img }]
    }];

    productView = 'all';
    productFilter = '';
    categoryFilter = '';
    selectProduct(id);
  }

  function duplicateProduct() {
    const src = selectedProduct;
    if (!src) return;
    const copy = $state.snapshot(src);
    copy.id = uid('p');
    copy.name = `${src.name} copy`;
    copy.published = false;
    store.products = [...store.products, copy];
    selectProduct(copy.id);
  }

  function removeProduct(id) {
    store.products = store.products.filter(p => p.id !== id);
    if (selectedProductId === id) selectedProductId = null;
    confirmId = null;
  }

  function addBanner() {
    const id = uid('b');

    store.banners = [...store.banners, {
      id,
      name: 'New Banner',
      published: false,
      enabled: true,
      priority: 5,
      headline: '',
      sub: '',
      cta: '',
      url: '',
      bg: '#0f766e',
      image: { kind: 'none' },
      placements: ['ceiling']
    }];

    selectBanner(id);
  }

  function removeBanner(id) {
    store.banners = store.banners.filter(b => b.id !== id);
    if (selectedBannerId === id) selectedBannerId = null;
    confirmId = null;
  }

  function addAIProfile() {
    store.ai.profiles = [...store.ai.profiles, {
      id: uid('prof'),
      label: 'New profile',
      speed: 1,
      maxItems: 0,
      color: '',
      weight: 1
    }];
  }

  /* ------------------------------------------------------------------ */
  /* Toasts, shortcuts, unsaved-changes guard                             */
  /* ------------------------------------------------------------------ */
  $effect(() => {
    if (!success) return;
    const t = setTimeout(() => (success = ''), 3200);
    return () => clearTimeout(t);
  });

  $effect(() => {
    if (!error) return;
    const t = setTimeout(() => (error = ''), 8000);
    return () => clearTimeout(t);
  });

  function onKeydown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (store) handleSave();
    }
  }

  function onBeforeUnload(e) {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  }
</script>

<svelte:window onkeydown={onKeydown} onbeforeunload={onBeforeUnload} />

<svelte:head>
  <title>Breathe admin</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
  <link
    rel="stylesheet"
    href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,700&family=Instrument+Sans:wght@400;500;600&display=swap"
  />
</svelte:head>

<!-- ================================================================== -->
<!-- Reusable bits                                                        -->
<!-- ================================================================== -->
{#snippet shapeIcon(shape, color)}
  <svg viewBox="0 0 36 44" aria-hidden="true">
    <g fill={color || '#94a3b8'} stroke="rgba(0,0,0,.22)" stroke-width="1" stroke-linejoin="round">
      {#if shape === 'bottle'}
        <rect x="14" y="3" width="8" height="9" rx="2" />
        <rect x="9" y="11" width="18" height="31" rx="6" />
      {:else if shape === 'can'}
        <rect x="8" y="5" width="20" height="35" rx="4" />
        <path d="M8 11h20M8 34h20" fill="none" />
      {:else if shape === 'bag'}
        <path d="M7 10h22l2 31H5z" />
        <path d="M7 14h22" fill="none" />
      {:else if shape === 'bar'}
        <rect x="3" y="15" width="30" height="15" rx="3" />
      {:else if shape === 'carton'}
        <path d="M8 15 18 5l10 10v26H8z" />
        <path d="M8 15h20" fill="none" />
      {:else}
        <rect x="6" y="8" width="24" height="32" rx="3" />
      {/if}
    </g>
  </svg>
{/snippet}

{#snippet thumb(p)}
  {@const u = firstImage(p)}
  {#if u}
    <img src={u} alt="" />
  {:else}
    {@render shapeIcon(p.shape, p.color)}
  {/if}
{/snippet}

<!-- ================================================================== -->
<!-- Gate states                                                          -->
<!-- ================================================================== -->
{#if loading}
  <div class="gate">
    <span class="spinner" aria-hidden="true"></span>
    <p>Loading your store…</p>
  </div>

{:else if !session}
  <div class="gate">
    <div class="gate-card">
      <h1>Admin</h1>
      <p>Sign in to manage the store.</p>
      <a class="btn primary" href="/signin">Sign in</a>
    </div>
  </div>

{:else if !isAdmin}
  <div class="gate">
    <div class="gate-card">
      <h1>No admin access</h1>
      <p>You're signed in, but this account isn't an admin. Ask the store owner to enable it.</p>
      <a class="btn" href="/">Back to the store</a>
    </div>
  </div>

{:else if !store}
  <div class="gate">
    <div class="gate-card">
      <h1>Couldn't load the store</h1>
      <p>{error || 'Something went wrong while loading.'}</p>
      <button class="btn primary" onclick={() => location.reload()}>Try again</button>
    </div>
  </div>

{:else}
  <div class="admin">
    <div class="brand">
      <span class="logo">B</span>
      <span class="brand-name">Breathe admin</span>
    </div>

    <header class="topbar">
      <h1>{tabLabel(activeTab)}</h1>
      <div class="save">
        <span class="state" data-dirty={dirty || saving}>
          <i class="dot"></i>
          <span class="state-text">
            {#if saving}Saving…{:else if dirty}Unsaved changes{:else}All changes saved{/if}
          </span>
        </span>
        <button class="btn primary" onclick={handleSave} disabled={saving || uploading} title="Save (Ctrl/⌘ + S)">
          {#if saving}<span class="spinner sm" aria-hidden="true"></span>{/if}
          Save changes
        </button>
      </div>
    </header>

    <nav class="nav" aria-label="Admin sections">
      <div class="nav-inner">
        {#each groups as group}
          <div class="group">
            <p class="group-title">{group.title}</p>
            {#each group.items as tab}
              <button
                class="nav-item"
                class:active={activeTab === tab.id}
                aria-current={activeTab === tab.id ? 'page' : undefined}
                onclick={() => setTab(tab.id)}
              >
                {tab.label}
                {#if tab.id === 'orders'}
                  {#if statusCounts.pending}<span class="badge alert" title="Pending orders">{statusCounts.pending}</span>{/if}
                {:else if tab.id === 'products'}
                  <span class="badge">{store.products.length}</span>
                {:else if tab.id === 'categories'}
                  <span class="badge">{store.categories.length}</span>
                {:else if tab.id === 'banners'}
                  <span class="badge">{store.banners.length}</span>
                {/if}
              </button>
            {/each}
          </div>
        {/each}
        <a class="store-link" href="/" target="_blank" rel="noopener">Open the store</a>
      </div>
    </nav>

    <main class="content">
      {#key activeTab}
      <div in:fly={{ y: 8, duration: dur(180) }}>

      <!-- ============================ PRODUCTS ============================ -->
      {#if activeTab === 'products'}
        <div class="split" data-open={selectedProduct ? 'true' : 'false'}>
          <section class="panel list-pane">
            <div class="list-head">
              <input class="input" type="search" placeholder="Search products" aria-label="Search products" bind:value={productFilter} />
              <select class="input" aria-label="Filter by category" bind:value={categoryFilter}>
                <option value="">All categories</option>
                {#each store.categories as c (c.id)}
                  <option value={c.id}>{c.name}</option>
                {/each}
              </select>
              <div class="chips">
                {#each productViews as v}
                  {#if v.id === 'all' || v.n > 0 || productView === v.id}
                    <button class="chip" class:on={productView === v.id} onclick={() => (productView = v.id)}>
                      {v.label} <b>{v.n}</b>
                    </button>
                  {/if}
                {/each}
              </div>
              <button class="btn primary block" onclick={addProduct}>Add product</button>
            </div>

            <ul class="rows">
              {#each filteredProducts as p (p.id)}
                <li>
                  <button class="row" class:on={p.id === selectedProductId} onclick={() => selectProduct(p.id)}>
                    <span class="thumb">{@render thumb(p)}</span>
                    <span class="row-main">
                      <span class="row-title">{p.name || 'Untitled product'}</span>
                      <span class="row-sub">{p.brand ? `${p.brand} · ` : ''}{fmt(p.price)}</span>
                    </span>
                    {#if !p.published}<span class="pill" data-tone="amber">Draft</span>{/if}
                    {#if !p.enabled}<span class="pill" data-tone="red">Off</span>{/if}
                  </button>
                </li>
              {:else}
                <li class="empty-note">
                  {store.products.length ? 'No products match these filters.' : 'No products yet. Add your first one.'}
                </li>
              {/each}
            </ul>
          </section>

          <section class="panel detail-pane">
            {#if selectedProduct}
              {#key selectedProduct.id}
              <div class="detail" in:fly={{ x: 12, duration: dur(180) }}>
                <header class="detail-head">
                  <button class="btn ghost back" onclick={() => (selectedProductId = null)}>‹ Products</button>
                  <div class="head-id">
                    <span class="thumb lg">{@render thumb(selectedProduct)}</span>
                    <div class="min-w-0">
                      <h2>{selectedProduct.name || 'Untitled product'}</h2>
                      <p class="muted">{categoryName(selectedProduct.categoryId)} · {fmt(selectedProduct.price)}</p>
                    </div>
                  </div>
                  <div class="head-actions">
                    <button class="btn" onclick={duplicateProduct}>Duplicate</button>
                    {#if confirmId === `p:${selectedProduct.id}`}
                      <button class="btn danger solid" onclick={() => removeProduct(selectedProduct.id)}>Yes, delete</button>
                      <button class="btn ghost" onclick={() => (confirmId = null)}>Keep</button>
                    {:else}
                      <button class="btn ghost danger" onclick={() => (confirmId = `p:${selectedProduct.id}`)}>Delete</button>
                    {/if}
                  </div>
                </header>

                <div class="switch-group">
                  <label class="switch-row">
                    <span><b>Published</b><small>Drafts stay hidden from shoppers</small></span>
                    <input type="checkbox" class="switch" bind:checked={selectedProduct.published} />
                  </label>
                  <label class="switch-row">
                    <span><b>Enabled</b><small>Turn off to pull it from the shelves without deleting</small></span>
                    <input type="checkbox" class="switch" bind:checked={selectedProduct.enabled} />
                  </label>
                </div>

                <div class="section">
                  <h3>Details</h3>
                  <div class="grid2">
                    <label class="field">
                      <span>Name</span>
                      <input class="input" bind:value={selectedProduct.name} maxlength="120" />
                    </label>
                    <label class="field">
                      <span>Brand</span>
                      <input class="input" bind:value={selectedProduct.brand} maxlength="80" />
                    </label>
                    <label class="field">
                      <span>Price</span>
                      <div class="affix">
                        <em>MWK</em>
                        <input class="input" type="number" min="0" bind:value={selectedProduct.price} />
                      </div>
                    </label>
                    <label class="field">
                      <span>Category</span>
                      <select class="input" bind:value={selectedProduct.categoryId}>
                        {#each store.categories as c (c.id)}
                          <option value={c.id}>{c.name}</option>
                        {/each}
                      </select>
                    </label>
                  </div>
                </div>

                <div class="section">
                  <h3>Look</h3>
                  <div class="shape-grid" role="radiogroup" aria-label="Shape">
                    {#each SHAPES as s}
                      <label class="shape-tile">
                        <input type="radio" bind:group={selectedProduct.shape} value={s} />
                        <span class="tile">
                          <span class="shape-art">{@render shapeIcon(s, selectedProduct.color)}</span>
                          <span class="shape-name">{s}</span>
                        </span>
                      </label>
                    {/each}
                  </div>

                  <div class="grid2 mt">
                    <label class="field">
                      <span>Colour</span>
                      <div class="color-field">
                        <input type="color" bind:value={selectedProduct.color} />
                        <code>{selectedProduct.color}</code>
                      </div>
                    </label>
                    <div class="field">
                      <span>Image style</span>
                      <div class="seg">
                        {#each ['wrap', 'label', 'photo'] as t}
                          <label>
                            <input type="radio" bind:group={selectedProduct.imageType} value={t} />
                            <span>{t}</span>
                          </label>
                        {/each}
                      </div>
                    </div>
                  </div>
                </div>

                <div class="section">
                  <h3>Where it sits</h3>
                  <div class="seg">
                    <label>
                      <input type="radio" bind:group={selectedProduct.placement.mode} value="auto" />
                      <span>Auto</span>
                    </label>
                    <label>
                      <input type="radio" bind:group={selectedProduct.placement.mode} value="manual" />
                      <span>Manual</span>
                    </label>
                  </div>

                  {#if selectedProduct.placement.mode === 'manual'}
                    <div class="grid4 mt" in:fade={{ duration: dur(140) }}>
                      <label class="field">
                        <span>Aisle</span>
                        <input class="input" type="number" min="0" max="7" bind:value={selectedProduct.placement.aisle} />
                      </label>
                      <label class="field">
                        <span>Side</span>
                        <select class="input" bind:value={selectedProduct.placement.side}>
                          <option value="L">Left</option>
                          <option value="R">Right</option>
                        </select>
                      </label>
                      <label class="field">
                        <span>Level</span>
                        <input class="input" type="number" min="0" max="2" bind:value={selectedProduct.placement.level} />
                      </label>
                      <label class="field">
                        <span>Slot</span>
                        <input class="input" type="number" min="0" max="5" bind:value={selectedProduct.placement.slot} />
                      </label>
                    </div>
                  {:else}
                    <p class="hint">Placed automatically, using its category's aisle.</p>
                  {/if}
                </div>

                <div class="section">
                  <h3>Photos</h3>
                  <div class="photos">
                    {#each photoList(selectedProduct) as img, i}
                      <figure class="photo">
                        <img src={imgUrl(img)} alt="" />
                        {#if i === 0}<span class="badge-main">Main</span>{/if}
                        <figcaption>
                          {#if i > 0}<button onclick={() => makeMainPhoto(i)}>Make main</button>{/if}
                          <button class="x" aria-label="Remove photo" onclick={() => removeProductImage(i)}>Remove</button>
                        </figcaption>
                      </figure>
                    {/each}

                    <label
                      class="photo add"
                      class:drag={dragging}
                      ondragover={(e) => { e.preventDefault(); dragging = true; }}
                      ondragleave={() => (dragging = false)}
                      ondrop={(e) => { e.preventDefault(); onProductFiles(e.dataTransfer.files); }}
                    >
                      <span>{uploading ? 'Uploading…' : 'Add photos'}</span>
                      <small>Click or drop images</small>
                      <input type="file" accept="image/*" multiple hidden disabled={uploading}
                        onchange={(e) => { onProductFiles(e.target.files); e.target.value = ''; }} />
                    </label>
                  </div>

                  <div class="url-row">
                    <input class="input" placeholder="Or paste an image link" bind:value={newImageUrl}
                      onkeydown={(e) => e.key === 'Enter' && addPhotoByLink()} />
                    <button class="btn" onclick={addPhotoByLink} disabled={!newImageUrl.trim()}>Add link</button>
                  </div>
                </div>
              </div>
              {/key}
            {:else}
              <div class="empty">
                <h3>Pick a product to edit</h3>
                <p>Or start a new one. Changes show up here as you type.</p>
                <button class="btn primary" onclick={addProduct}>Add product</button>
              </div>
            {/if}
          </section>
        </div>

      <!-- =========================== CATEGORIES =========================== -->
      {:else if activeTab === 'categories'}
        <section class="panel">
          <div class="panel-head">
            <div>
              <h2>Categories</h2>
              <p class="muted">Each category sits in one aisle. Products follow their category unless placed manually.</p>
            </div>
            <button class="btn primary" onclick={addCategory}>Add category</button>
          </div>

          <ul class="cat-rows">
            {#each store.categories as c (c.id)}
              {@const n = productCountByCat[c.id] || 0}
              {@const aisle = store.layout.assignments[c.id] ?? 0}
              <li class="cat-row">
                <input class="input bare" bind:value={c.name} maxlength="60" aria-label="Category name" />
                <span class="muted count">{n} {n === 1 ? 'product' : 'products'}</span>
                <label class="inline-sel">
                  <span>Aisle</span>
                  <select class="input" value={aisle}
                    onchange={(e) => (store.layout.assignments[c.id] = +e.target.value)}>
                    {#each aisleOptions(aisle) as a}
                      <option value={a}>{a}</option>
                    {/each}
                  </select>
                </label>
                <button class="btn ghost danger" disabled={n > 0}
                  title={n > 0 ? 'Move or delete its products first' : 'Delete category'}
                  onclick={() => removeCategory(c.id)}>Delete</button>
              </li>
            {:else}
              <li class="empty-note">No categories yet.</li>
            {/each}
          </ul>
        </section>

      <!-- ============================= BANNERS ============================= -->
      {:else if activeTab === 'banners'}
        <div class="split narrow" data-open={selectedBanner ? 'true' : 'false'}>
          <section class="panel list-pane">
            <div class="list-head">
              <button class="btn primary block" onclick={addBanner}>Add banner</button>
            </div>
            <ul class="rows">
              {#each store.banners as b (b.id)}
                <li>
                  <button class="row" class:on={b.id === selectedBannerId} onclick={() => selectBanner(b.id)}>
                    <span class="swatch" style="background:{b.bg}"></span>
                    <span class="row-main">
                      <span class="row-title">{b.name || 'Untitled banner'}</span>
                      <span class="row-sub">Priority {b.priority}</span>
                    </span>
                    {#if !b.published}<span class="pill" data-tone="amber">Draft</span>{/if}
                    {#if !b.enabled}<span class="pill" data-tone="red">Off</span>{/if}
                  </button>
                </li>
              {:else}
                <li class="empty-note">No banners yet.</li>
              {/each}
            </ul>
          </section>

          <section class="panel detail-pane">
            {#if selectedBanner}
              {#key selectedBanner.id}
              <div class="detail" in:fly={{ x: 12, duration: dur(180) }}>
                <header class="detail-head">
                  <button class="btn ghost back" onclick={() => (selectedBannerId = null)}>‹ Banners</button>
                  <div class="head-id"><h2>{selectedBanner.name || 'Untitled banner'}</h2></div>
                  <div class="head-actions">
                    {#if confirmId === `b:${selectedBanner.id}`}
                      <button class="btn danger solid" onclick={() => removeBanner(selectedBanner.id)}>Yes, delete</button>
                      <button class="btn ghost" onclick={() => (confirmId = null)}>Keep</button>
                    {:else}
                      <button class="btn ghost danger" onclick={() => (confirmId = `b:${selectedBanner.id}`)}>Delete</button>
                    {/if}
                  </div>
                </header>

                <div class="banner-preview"
                  style="background:{selectedBanner.bg}; color:{inkOn(selectedBanner.bg)}">
                  <div class="bp-text">
                    <strong>{selectedBanner.headline || 'Your headline'}</strong>
                    {#if selectedBanner.sub}<p>{selectedBanner.sub}</p>{/if}
                    {#if selectedBanner.cta}
                      <span class="bp-cta" style="background:{inkOn(selectedBanner.bg)}; color:{selectedBanner.bg}">{selectedBanner.cta}</span>
                    {/if}
                  </div>
                  {#if imgUrl(selectedBanner.image)}
                    <img src={imgUrl(selectedBanner.image)} alt="" />
                  {/if}
                </div>

                <div class="switch-group">
                  <label class="switch-row">
                    <span><b>Published</b><small>Drafts stay hidden from shoppers</small></span>
                    <input type="checkbox" class="switch" bind:checked={selectedBanner.published} />
                  </label>
                  <label class="switch-row">
                    <span><b>Enabled</b><small>Turn off to pause it without deleting</small></span>
                    <input type="checkbox" class="switch" bind:checked={selectedBanner.enabled} />
                  </label>
                </div>

                <div class="section">
                  <h3>Message</h3>
                  <div class="stack">
                    <div class="grid2">
                      <label class="field">
                        <span>Name</span>
                        <input class="input" bind:value={selectedBanner.name} />
                      </label>
                      <label class="field">
                        <span>Priority (1–10)</span>
                        <input class="input" type="number" min="1" max="10" bind:value={selectedBanner.priority} />
                      </label>
                    </div>
                    <label class="field">
                      <span>Headline</span>
                      <input class="input" bind:value={selectedBanner.headline} maxlength="120" />
                    </label>
                    <label class="field">
                      <span>Sub-headline</span>
                      <textarea class="input" rows="2" bind:value={selectedBanner.sub} maxlength="240"></textarea>
                    </label>
                    <div class="grid2">
                      <label class="field">
                        <span>Button text</span>
                        <input class="input" bind:value={selectedBanner.cta} maxlength="40" />
                      </label>
                      <label class="field">
                        <span>Link</span>
                        <input class="input" bind:value={selectedBanner.url} maxlength="500" placeholder="https://…" />
                      </label>
                    </div>
                  </div>
                </div>

                <div class="section">
                  <h3>Look</h3>
                  <label class="field">
                    <span>Background</span>
                    <div class="color-field">
                      <input type="color" bind:value={selectedBanner.bg} />
                      <code>{selectedBanner.bg}</code>
                    </div>
                  </label>

                  <div class="field mt">
                    <span>Image</span>
                    {#if imgUrl(selectedBanner.image)}
                      <div class="banner-img">
                        <img src={imgUrl(selectedBanner.image)} alt="" />
                        <input class="input" value={imgUrl(selectedBanner.image)}
                          oninput={(e) => {
                            const url = e.target.value.trim();
                            selectedBanner.image = url ? { kind: 'url', url } : { kind: 'none' };
                          }} />
                        <button class="btn ghost danger" onclick={clearBannerImage}>Remove</button>
                      </div>
                    {:else}
                      <label
                        class="drop"
                        class:drag={dragging}
                        ondragover={(e) => { e.preventDefault(); dragging = true; }}
                        ondragleave={() => (dragging = false)}
                        ondrop={(e) => { e.preventDefault(); onBannerFiles(e.dataTransfer.files); }}
                      >
                        <span>{uploading ? 'Uploading…' : 'Add an image'}</span>
                        <small>Click or drop one here</small>
                        <input type="file" accept="image/*" hidden disabled={uploading}
                          onchange={(e) => { onBannerFiles(e.target.files); e.target.value = ''; }} />
                      </label>
                      <input class="input mt-sm" placeholder="Or paste an image link"
                        oninput={(e) => {
                          const url = e.target.value.trim();
                          selectedBanner.image = url ? { kind: 'url', url } : { kind: 'none' };
                        }} />
                    {/if}
                  </div>
                </div>

                <div class="section">
                  <h3>Where it shows</h3>
                  <div class="chips">
                    {#each ['ceiling', 'shelf', 'entrance'] as pl}
                      <label class="toggle-chip">
                        <input type="checkbox"
                          checked={selectedBanner.placements.includes(pl)}
                          onchange={(e) => {
                            if (e.target.checked) selectedBanner.placements = [...selectedBanner.placements, pl];
                            else selectedBanner.placements = selectedBanner.placements.filter(x => x !== pl);
                          }} />
                        <span>{pl}</span>
                      </label>
                    {/each}
                  </div>
                  {#if !selectedBanner.placements.length}
                    <p class="hint warn">Pick at least one spot or this banner won't appear.</p>
                  {/if}
                </div>
              </div>
              {/key}
            {:else}
              <div class="empty">
                <h3>Pick a banner to edit</h3>
                <p>You'll see a live preview as you type.</p>
                <button class="btn primary" onclick={addBanner}>Add banner</button>
              </div>
            {/if}
          </section>
        </div>

      <!-- ============================== ORDERS ============================== -->
      {:else if activeTab === 'orders'}
        <div class="stack-lg">
          <div class="panel-head plain">
            <p class="muted">Review customer purchases and move them through fulfilment.</p>
            <button class="btn" onclick={loadOrders} disabled={ordersLoading}>
              {#if ordersLoading}<span class="spinner sm" aria-hidden="true"></span>{/if}
              Refresh
            </button>
          </div>

          {#if ordersError}
            <div class="alert" role="alert">{ordersError}</div>
          {/if}

          <div class="split orders" data-open={selectedOrder ? 'true' : 'false'}>
            <section class="panel list-pane">
              <div class="list-head">
                <input class="input" type="search" bind:value={orderSearch}
                  placeholder="Search order, customer or phone" aria-label="Search orders" />
                <div class="chips">
                  {#each ['all', ...STATUSES] as s}
                    <button class="chip" class:on={orderStatusFilter === s} onclick={() => (orderStatusFilter = s)}>
                      {s === 'all' ? 'All' : s[0].toUpperCase() + s.slice(1)} <b>{statusCounts[s]}</b>
                    </button>
                  {/each}
                </div>
              </div>

              {#if ordersLoading && !orders.length}
                <p class="empty-note">Loading orders…</p>
              {:else if !filteredOrders.length}
                <div class="empty compact">
                  <h3>No orders found</h3>
                  <p>Try a different search or status.</p>
                </div>
              {:else}
                <ul class="rows">
                  {#each filteredOrders as order (order.id)}
                    <li>
                      <button class="row order" class:on={selectedOrderId === order.id} onclick={() => (selectedOrderId = order.id)}>
                        <span class="o-top">
                          <b>{order.customer?.display_name || 'Customer'}</b>
                          <span class="pill" data-status={statusKey(order.status)}>{order.status || 'Unknown'}</span>
                        </span>
                        <span class="o-sub">#{shortId(order.id)} · {order.customer?.mobile_number || 'No phone'}</span>
                        <span class="o-bottom">
                          <span>{orderUnits(order)} {orderUnits(order) === 1 ? 'unit' : 'units'} · {fmt(orderTotal(order))}</span>
                          <span title={formatDate(order.created_at)}>{timeAgo(order.created_at)}</span>
                        </span>
                      </button>
                    </li>
                  {/each}
                </ul>
              {/if}
            </section>

            <section class="panel detail-pane sticky">
              {#if selectedOrder}
                {#key selectedOrder.id}
                <div class="detail" in:fly={{ x: 12, duration: dur(180) }}>
                  <header class="detail-head">
                    <button class="btn ghost back" onclick={() => (selectedOrderId = null)}>‹ Orders</button>
                    <div class="head-id">
                      <div class="min-w-0">
                        <h2>{selectedOrder.customer?.display_name || 'Customer'}</h2>
                        <p class="muted" title={String(selectedOrder.id)}>Order #{shortId(selectedOrder.id)} · {formatDate(selectedOrder.created_at)}</p>
                      </div>
                    </div>
                    <span class="pill lg" data-status={statusKey(selectedOrder.status)}>{selectedOrder.status || 'Unknown'}</span>
                  </header>

                  <div class="section">
                    <h3>Customer</h3>
                    {#if selectedOrder.customer?.mobile_number}
                      <a class="phone" href={`tel:${selectedOrder.customer.mobile_number}`}>{selectedOrder.customer.mobile_number}</a>
                    {:else}
                      <p class="muted">No phone number provided</p>
                    {/if}
                    <p class="tiny">{selectedOrder.user_id || 'Guest order'}</p>
                  </div>

                  <div class="section">
                    <h3>Items</h3>
                    {#if selectedOrder.order_items.length}
                      <ul class="items">
                        {#each selectedOrder.order_items as item (item.id)}
                          <li>
                            <span class="min-w-0">
                              <b>{orderItemName(item)}</b>
                              <small>{item.qty} × {fmt(orderItemPrice(item))}</small>
                            </span>
                            <span>{fmt(orderItemPrice(item) * Number(item.qty || 0))}</span>
                          </li>
                        {/each}
                      </ul>
                      <div class="total">
                        <span>Estimated total</span>
                        <strong>{fmt(orderTotal(selectedOrder))}</strong>
                      </div>
                      <p class="tiny">Uses current product prices, so it may differ from the price at checkout.</p>
                    {:else}
                      <p class="muted">No items recorded for this order.</p>
                    {/if}
                  </div>

                  <div class="section">
                    <h3>Status</h3>
                    {#if NEXT_STATUS[statusKey(selectedOrder.status)]}
                      <button class="btn primary block"
                        disabled={updatingOrderId === selectedOrder.id}
                        onclick={() => updateOrderStatus(selectedOrder, NEXT_STATUS[statusKey(selectedOrder.status)])}>
                        {updatingOrderId === selectedOrder.id ? 'Updating…' : NEXT_LABEL[statusKey(selectedOrder.status)]}
                      </button>
                    {/if}
                    <div class="seg wide mt-sm" role="group" aria-label="Set status">
                      {#each STATUSES as s}
                        <button class:on={statusKey(selectedOrder.status) === s}
                          disabled={updatingOrderId === selectedOrder.id}
                          onclick={() => updateOrderStatus(selectedOrder, s)}>{s}</button>
                      {/each}
                    </div>
                  </div>
                </div>
                {/key}
              {:else}
                <div class="empty compact">
                  <h3>Select an order</h3>
                  <p>Choose one from the list to see what was bought.</p>
                </div>
              {/if}
            </section>
          </div>
        </div>

      <!-- ============================== LAYOUT ============================== -->
      {:else if activeTab === 'layout'}
        <section class="panel pad">
          <div class="layout-controls">
            <div class="field">
              <span>Aisles</span>
              <div class="stepper">
                <button aria-label="Fewer aisles" onclick={() => (store.layout.aisleCount = Math.max(1, (+store.layout.aisleCount || 1) - 1))}>−</button>
                <output>{store.layout.aisleCount}</output>
                <button aria-label="More aisles" onclick={() => (store.layout.aisleCount = Math.min(8, (+store.layout.aisleCount || 1) + 1))}>+</button>
              </div>
            </div>
            <p class="hint">Tap a corner to move the checkout. Assign categories to aisles on the Categories tab.</p>
          </div>

          <div class="plan" style="--n:{floorPlan.aisles.length}">
            {#each floorPlan.aisles as a}
              <div class="aisle">
                <b>Aisle {a.i}</b>
                {#each a.cats as c (c.id)}
                  <span class="cat-tag">{c.name}</span>
                {:else}
                  <span class="muted tiny">Empty</span>
                {/each}
              </div>
            {/each}

            {#each CHECKOUT_SPOTS as spot}
              <label class="spot {spot}" class:on={store.layout.checkout === spot}>
                <input type="radio" bind:group={store.layout.checkout} value={spot} />
                <span>{store.layout.checkout === spot ? 'Checkout' : ''}</span>
              </label>
            {/each}
          </div>
          <p class="tiny plan-note">Front of the store is at the bottom.</p>

          {#if floorPlan.orphans.length}
            <p class="hint warn">
              {floorPlan.orphans.map(c => c.name).join(', ')}
              {floorPlan.orphans.length === 1 ? 'is' : 'are'} assigned to an aisle that no longer exists.
            </p>
          {/if}
        </section>

      <!-- ============================== PROMO =============================== -->
      {:else if activeTab === 'promo'}
        <div class="two-col">
          <section class="panel pad stack">
            <label class="switch-row flat">
              <span><b>Show the promo</b><small>Appears after checkout</small></span>
              <input type="checkbox" class="switch" bind:checked={store.promo.enabled} />
            </label>

            <label class="field">
              <span>Message</span>
              <textarea class="input" rows="3" maxlength="300" bind:value={store.promo.message}></textarea>
            </label>
            <label class="field">
              <span>Button text</span>
              <input class="input" maxlength="40" bind:value={store.promo.label} />
            </label>
            <label class="field">
              <span>Link</span>
              <input class="input" maxlength="500" placeholder="https://…" bind:value={store.promo.url} />
            </label>
          </section>

          <aside class="preview-wrap" aria-label="Preview">
            <div class="promo-card" class:off={!store.promo.enabled}>
              <p>{store.promo.message || 'Your promo message appears here.'}</p>
              <span class="btn primary">{store.promo.label || 'Button'}</span>
            </div>
            {#if !store.promo.enabled}<p class="hint">The promo is switched off.</p>{/if}
          </aside>
        </div>

      <!-- ============================= SETTINGS ============================= -->
      {:else if activeTab === 'settings'}
        <section class="panel pad stack narrow-form">
          <label class="switch-row flat">
            <span><b>Muted by default</b><small>Shoppers can still turn sound on</small></span>
            <input type="checkbox" class="switch" bind:checked={store.settings.muted} />
          </label>

          <label class="field">
            <span>Volume</span>
            <div class="range-row">
              <input type="range" min="0" max="1" step="0.05" bind:value={store.settings.volume} />
              <output>{Math.round(store.settings.volume * 100)}%</output>
            </div>
          </label>
        </section>

      <!-- ================================ AI ================================ -->
      {:else if activeTab === 'ai'}
        <div class="stack-lg">
          <section class="panel pad stack">
            <div class="switch-group flat">
              <label class="switch-row">
                <span><b>AI shoppers</b><small>Bots wander the aisles to make the store feel busy</small></span>
                <input type="checkbox" class="switch" bind:checked={store.ai.enabled} />
              </label>
              <label class="switch-row">
                <span><b>Name tags</b><small>Show each shopper's name above their head</small></span>
                <input type="checkbox" class="switch" bind:checked={store.ai.showTags} />
              </label>
            </div>
          </section>

          <section class="panel pad">
            <h3>Crowd</h3>
            <div class="grid3 mt">
              <label class="field"><span>Max shoppers</span>
                <input class="input" type="number" min="1" max="8" bind:value={store.ai.maxShoppers} /></label>
              <label class="field"><span>Spawn min (s)</span>
                <input class="input" type="number" min="1" max="120" bind:value={store.ai.spawnMin} /></label>
              <label class="field"><span>Spawn max (s)</span>
                <input class="input" type="number" min="1" max="120" bind:value={store.ai.spawnMax} /></label>
            </div>

            <h3 class="mt-lg">Behaviour</h3>
            <div class="grid4 mt">
              <label class="field"><span>Walk speed</span>
                <input class="input" type="number" min="0.3" max="3" step="0.05" bind:value={store.ai.walkSpeed} /></label>
              <label class="field"><span>Max aisles</span>
                <input class="input" type="number" min="1" max="6" bind:value={store.ai.maxAisles} /></label>
              <label class="field"><span>Items / aisle</span>
                <input class="input" type="number" min="1" max="8" bind:value={store.ai.maxItemsPerAisle} /></label>
              <label class="field"><span>Max shop time (s)</span>
                <input class="input" type="number" min="20" max="900" bind:value={store.ai.maxShopTime} /></label>
            </div>
          </section>

          <section class="panel pad">
            <div class="grid2">
              <label class="field">
                <span>Names <small class="muted">one per line, up to {store.ai.names.length} added</small></span>
                <textarea class="input mono" rows="7"
                  value={store.ai.names.join('\n')}
                  oninput={(e) => (store.ai.names = e.target.value.split('\n').map(s => s.trim()))}></textarea>
              </label>

              <label class="field">
                <span>Cart colours <small class="muted">hex, one per line</small></span>
                <textarea class="input mono" rows="7"
                  value={store.ai.cartColors.join('\n')}
                  oninput={(e) => (store.ai.cartColors = e.target.value.split('\n').map(s => s.trim()).filter(c => HEX_RE.test(c)).slice(0, 30))}></textarea>
                <span class="dots">
                  {#each store.ai.cartColors as c}<i style="background:{c}" title={c}></i>{/each}
                </span>
              </label>
            </div>
          </section>

          <section class="panel pad">
            <div class="panel-head plain">
              <div>
                <h3>Shopper profiles</h3>
                <p class="muted">Higher weight means that profile is picked more often.</p>
              </div>
              <button class="btn" onclick={addAIProfile}>Add profile</button>
            </div>

            <div class="profiles">
              {#each store.ai.profiles as prof}
                <div class="profile">
                  <label class="field grow"><span>Label</span>
                    <input class="input" bind:value={prof.label} placeholder="Label" /></label>
                  <label class="field sm"><span>Speed</span>
                    <input class="input" type="number" min="0.3" max="3" step="0.1" bind:value={prof.speed} /></label>
                  <label class="field sm"><span>Max items</span>
                    <input class="input" type="number" min="0" max="8" bind:value={prof.maxItems} /></label>
                  <label class="field sm"><span>Weight</span>
                    <input class="input" type="number" min="1" max="10" bind:value={prof.weight} /></label>
                  <div class="field sm">
                    <span>Colour</span>
                    {#if prof.color}
                      <div class="color-field tight">
                        <input type="color" bind:value={prof.color} title="Override colour" />
                        <button class="btn ghost" onclick={() => (prof.color = '')}>Reset</button>
                      </div>
                    {:else}
                      <button class="btn" onclick={() => (prof.color = '#287653')}>Set colour</button>
                    {/if}
                  </div>
                  <button class="btn ghost danger remove" aria-label="Remove profile"
                    onclick={() => (store.ai.profiles = store.ai.profiles.filter(p => p !== prof))}>Remove</button>
                </div>
              {:else}
                <p class="empty-note">No profiles yet.</p>
              {/each}
            </div>
          </section>
        </div>
      {/if}

      </div>
      {/key}
    </main>

    <div class="toasts" aria-live="polite">
      {#if success}
        <div class="toast" transition:fly={{ y: 16, duration: dur(180) }}>{success}</div>
      {/if}
      {#if error}
        <div class="toast bad" role="alert" transition:fly={{ y: 16, duration: dur(180) }}>
          <span>{error}</span>
          <button aria-label="Dismiss" onclick={() => (error = '')}>×</button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* ---------------------------------------------------------------- */
  /* Tokens                                                            */
  /* ---------------------------------------------------------------- */
  .admin, .gate {
    --forest: #12372a;
    --leaf: #1f7a4d;
    --leaf-dark: #17613d;
    --mint: #e4f1e8;
    --canvas: #f3f5f0;
    --panel: #ffffff;
    --line: #e0e5dc;
    --ink: #18241d;
    --muted: #667369;
    --marigold: #e9a920;
    --amber-bg: #fdf1d2;
    --amber-ink: #85560a;
    --red: #b3402f;
    --red-bg: #fbe9e5;
    --blue-bg: #e5eefb;
    --blue-ink: #2c5596;
    --green-bg: #e0f2e6;
    --display: 'Bricolage Grotesque', 'Instrument Sans', ui-sans-serif, system-ui, sans-serif;
    font: 14px/1.45 'Instrument Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
    color: var(--ink);
  }

  h1, h2, h3 { font-family: var(--display); margin: 0; letter-spacing: -0.01em; }
  h3 { font-size: 15px; font-weight: 600; }
  p { margin: 0; }
  .muted { color: var(--muted); }
  .tiny { font-size: 12px; color: var(--muted); margin-top: 6px; word-break: break-all; }
  .min-w-0 { min-width: 0; }
  .mt { margin-top: 14px; }
  .mt-sm { margin-top: 8px; }
  .mt-lg { margin-top: 26px; }

  /* ---------------------------------------------------------------- */
  /* Gate (loading / sign in / no access)                              */
  /* ---------------------------------------------------------------- */
  .gate {
    min-height: 100vh;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 12px;
    background: var(--canvas);
    color: var(--muted);
    padding: 24px;
  }
  .gate-card {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 18px;
    padding: 28px;
    width: min(380px, 100%);
    display: grid;
    gap: 12px;
    justify-items: start;
  }
  .gate-card h1 { font-size: 22px; color: var(--ink); }

  .spinner {
    width: 20px; height: 20px;
    border: 2.5px solid var(--line);
    border-top-color: var(--leaf);
    border-radius: 50%;
    animation: spin .7s linear infinite;
    display: inline-block;
  }
  .spinner.sm { width: 14px; height: 14px; border-width: 2px; border-color: rgba(255,255,255,.4); border-top-color: #fff; }
  .btn:not(.primary) .spinner.sm { border-color: var(--line); border-top-color: var(--leaf); }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ---------------------------------------------------------------- */
  /* Shell                                                             */
  /* ---------------------------------------------------------------- */
  .admin {
    min-height: 100vh;
    background: var(--canvas);
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto 1fr;
    grid-template-areas: 'top' 'nav' 'content';
  }

  .brand { display: none; }
  .logo {
    width: 32px; height: 32px;
    display: grid; place-items: center;
    border-radius: 10px;
    background: var(--marigold);
    color: var(--forest);
    font: 700 17px var(--display);
  }
  .brand-name { font: 600 16px var(--display); }

  .topbar {
    grid-area: top;
    position: sticky; top: 0; z-index: 30;
    height: 56px;
    padding: 0 16px;
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    background: rgba(255,255,255,.92);
    backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--line);
  }
  .topbar h1 { font-size: 19px; font-weight: 600; }
  .save { display: flex; align-items: center; gap: 14px; }
  .state { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; }
  .state .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--leaf); }
  .state[data-dirty='true'] { color: var(--amber-ink); }
  .state[data-dirty='true'] .dot { background: var(--marigold); box-shadow: 0 0 0 4px rgba(233,169,32,.2); }
  .state-text { display: none; }

  .nav {
    grid-area: nav;
    position: sticky; top: 56px; z-index: 20;
    background: var(--forest);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .nav::-webkit-scrollbar { display: none; }
  .nav-inner { display: flex; gap: 4px; padding: 8px 12px; width: max-content; }
  .group { display: contents; }
  .group-title { display: none; }
  .store-link { display: none; }

  .nav-item {
    display: inline-flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 8px 12px;
    border: 0; border-radius: 10px;
    background: transparent;
    color: rgba(255,255,255,.72);
    font: 500 14px inherit;
    font-family: inherit;
    white-space: nowrap;
    cursor: pointer;
    transition: background-color .15s, color .15s;
  }
  .nav-item:hover { background: rgba(255,255,255,.08); color: #fff; }
  .nav-item.active { background: #fff; color: var(--forest); }
  .nav-item:focus-visible { outline: 2px solid var(--marigold); outline-offset: 2px; }

  .badge {
    min-width: 20px; padding: 1px 6px;
    border-radius: 99px;
    background: rgba(255,255,255,.14);
    font-size: 11px; font-weight: 600; text-align: center;
  }
  .nav-item.active .badge { background: var(--mint); color: var(--leaf-dark); }
  .badge.alert { background: var(--marigold); color: var(--forest); }

  .content { grid-area: content; padding: 16px; min-width: 0; }

  @media (min-width: 1024px) {
    .admin {
      grid-template-columns: 240px minmax(0, 1fr);
      grid-template-rows: 64px 1fr;
      grid-template-areas: 'brand top' 'nav content';
    }
    .brand {
      grid-area: brand;
      display: flex; align-items: center; gap: 10px;
      padding: 0 20px;
      background: var(--forest); color: #fff;
    }
    .topbar { height: 64px; padding: 0 32px; }
    .topbar h1 { font-size: 22px; }
    .state-text { display: inline; }
    .nav { position: static; overflow: visible; }
    .nav-inner {
      position: sticky; top: 0;
      flex-direction: column; gap: 2px;
      width: auto; height: calc(100vh - 64px);
      padding: 8px 12px 20px;
    }
    .group { display: block; margin-bottom: 14px; }
    .group-title { display: block; padding: 10px 12px 6px; font-size: 12px; font-weight: 500; color: rgba(255,255,255,.45); }
    .nav-item { width: 100%; }
    .store-link {
      display: block; margin-top: auto;
      padding: 10px 12px; border-radius: 10px;
      color: rgba(255,255,255,.7); text-decoration: none;
    }
    .store-link:hover { background: rgba(255,255,255,.08); color: #fff; }
    .content { padding: 28px 32px 48px; max-width: 1220px; width: 100%; }
  }

  /* ---------------------------------------------------------------- */
  /* Buttons, inputs                                                   */
  /* ---------------------------------------------------------------- */
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    height: 36px; padding: 0 14px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: #fff; color: var(--ink);
    font-weight: 500; font-size: 14px; font-family: inherit;
    text-decoration: none;
    cursor: pointer;
    transition: background-color .15s, border-color .15s, color .15s;
  }
  .btn:hover:not(:disabled) { background: #f4f7f3; border-color: #cfd8cc; }
  .btn:disabled { opacity: .5; cursor: not-allowed; }
  .btn:focus-visible, .nav-item:focus-visible, .row:focus-visible, .chip:focus-visible {
    outline: 2px solid var(--leaf); outline-offset: 2px;
  }
  .btn.primary { background: var(--leaf); border-color: var(--leaf); color: #fff; }
  .btn.primary:hover:not(:disabled) { background: var(--leaf-dark); border-color: var(--leaf-dark); }
  .btn.ghost { border-color: transparent; background: transparent; }
  .btn.ghost:hover:not(:disabled) { background: #eef2ec; border-color: transparent; }
  .btn.danger { color: var(--red); }
  .btn.ghost.danger:hover:not(:disabled) { background: var(--red-bg); }
  .btn.danger.solid { background: var(--red); border-color: var(--red); color: #fff; }
  .btn.danger.solid:hover { background: #983526; border-color: #983526; }
  .btn.block { width: 100%; }

  .input {
    width: 100%; min-height: 38px;
    padding: 8px 12px;
    border: 1px solid #d6ddd2;
    border-radius: 10px;
    background: #fff; color: var(--ink);
    font: inherit;
    transition: border-color .15s, box-shadow .15s;
  }
  textarea.input { resize: vertical; line-height: 1.45; }
  .input.mono { font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 13px; }
  .input::placeholder { color: #9aa59b; }
  .input:focus { outline: none; border-color: var(--leaf); box-shadow: 0 0 0 3px rgba(31,122,77,.15); }
  .input.bare { border-color: transparent; background: transparent; font-weight: 500; }
  .input.bare:hover { border-color: #d6ddd2; }
  .input.bare:focus { background: #fff; }

  .field { display: grid; gap: 6px; align-content: start; min-width: 0; }
  .field > span { font-size: 13px; font-weight: 500; color: #3c4a41; }
  .field > span small { font-weight: 400; margin-left: 4px; }

  .affix { display: flex; align-items: stretch; }
  .affix em {
    display: grid; place-items: center;
    padding: 0 12px; font-style: normal; font-size: 13px; color: var(--muted);
    background: #f2f5f0; border: 1px solid #d6ddd2; border-right: 0;
    border-radius: 10px 0 0 10px;
  }
  .affix .input { border-radius: 0 10px 10px 0; }

  .color-field { display: flex; align-items: center; gap: 10px; }
  .color-field input[type='color'] {
    width: 44px; height: 38px; padding: 3px;
    border: 1px solid #d6ddd2; border-radius: 10px; background: #fff; cursor: pointer;
  }
  .color-field code { font-size: 13px; color: var(--muted); }
  .color-field.tight { gap: 4px; }

  .switch {
    appearance: none; -webkit-appearance: none;
    flex: none; width: 40px; height: 24px;
    border-radius: 99px; background: #cdd6ca;
    position: relative; cursor: pointer;
    transition: background-color .18s;
  }
  .switch::after {
    content: ''; position: absolute; top: 3px; left: 3px;
    width: 18px; height: 18px; border-radius: 50%; background: #fff;
    box-shadow: 0 1px 2px rgba(0,0,0,.2);
    transition: transform .18s;
  }
  .switch:checked { background: var(--leaf); }
  .switch:checked::after { transform: translateX(16px); }
  .switch:focus-visible { outline: 2px solid var(--leaf); outline-offset: 2px; }

  .switch-group { display: grid; gap: 0; margin: 4px 0 8px; border: 1px solid var(--line); border-radius: 12px; }
  .switch-group.flat { border: 0; margin: 0; gap: 12px; }
  .switch-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 14px; cursor: pointer; }
  .switch-group:not(.flat) .switch-row + .switch-row { border-top: 1px solid var(--line); }
  .switch-row.flat { padding: 0; }
  .switch-row span { display: grid; gap: 2px; }
  .switch-row small { color: var(--muted); font-size: 12.5px; }

  .seg { display: inline-flex; gap: 2px; padding: 3px; border-radius: 11px; background: #eaefe7; }
  .seg.wide { display: flex; }
  .seg.wide button { flex: 1; }
  .seg label { position: relative; }
  .seg input { position: absolute; inset: 0; opacity: 0; cursor: pointer; margin: 0; }
  .seg label span, .seg button {
    display: block; padding: 6px 14px;
    border: 0; border-radius: 8px; background: transparent;
    color: var(--muted); font-weight: 500; font-size: 13.5px; font-family: inherit;
    text-transform: capitalize; text-align: center; cursor: pointer;
  }
  .seg input:checked + span, .seg button.on { background: #fff; color: var(--ink); box-shadow: 0 1px 2px rgba(0,0,0,.1); }
  .seg input:focus-visible + span, .seg button:focus-visible { outline: 2px solid var(--leaf); }
  .seg button:disabled { opacity: .55; cursor: wait; }

  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 5px 11px;
    border: 1px solid var(--line); border-radius: 99px;
    background: #fff; color: var(--muted);
    font-weight: 500; font-size: 13px; font-family: inherit; cursor: pointer;
    transition: background-color .15s, color .15s, border-color .15s;
  }
  .chip b { font-weight: 600; font-size: 12px; }
  .chip:hover { border-color: #c3cdc0; }
  .chip.on { background: var(--forest); border-color: var(--forest); color: #fff; }

  .toggle-chip input { position: absolute; opacity: 0; pointer-events: none; }
  .toggle-chip { position: relative; }
  .toggle-chip span {
    display: inline-block; padding: 6px 14px;
    border: 1px solid var(--line); border-radius: 99px;
    color: var(--muted); font-weight: 500; text-transform: capitalize; cursor: pointer;
    transition: all .15s;
  }
  .toggle-chip input:checked + span { background: var(--mint); border-color: #a9d3b8; color: var(--leaf-dark); }
  .toggle-chip input:focus-visible + span { outline: 2px solid var(--leaf); outline-offset: 2px; }

  .pill {
    display: inline-flex; align-items: center;
    padding: 2px 9px; border-radius: 99px;
    font-size: 12px; font-weight: 600; text-transform: capitalize; white-space: nowrap;
    background: #eef1ee; color: #5c675f;
  }
  .pill.lg { padding: 4px 12px; font-size: 13px; }
  .pill[data-tone='amber'], .pill[data-status='pending'] { background: var(--amber-bg); color: var(--amber-ink); }
  .pill[data-tone='red'], .pill[data-status='cancelled'] { background: var(--red-bg); color: var(--red); }
  .pill[data-status='processing'] { background: var(--blue-bg); color: var(--blue-ink); }
  .pill[data-status='completed'] { background: var(--green-bg); color: var(--leaf-dark); }

  /* ---------------------------------------------------------------- */
  /* Panels, split layout                                              */
  /* ---------------------------------------------------------------- */
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; min-width: 0; }
  .panel.pad { padding: 20px; }
  .panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 20px 20px 12px; }
  .panel-head.plain { padding: 0; align-items: center; }
  .panel-head h2 { font-size: 18px; }
  .panel-head p { margin-top: 2px; }

  .stack { display: grid; gap: 16px; }
  .stack-lg { display: grid; gap: 16px; }
  .narrow-form { max-width: 520px; }
  .two-col { display: grid; gap: 16px; grid-template-columns: 1fr; align-items: start; }
  @media (min-width: 900px) { .two-col { grid-template-columns: minmax(0, 520px) minmax(0, 1fr); } }

  .grid2, .grid3, .grid4 { display: grid; gap: 14px; grid-template-columns: 1fr; }
  @media (min-width: 560px) {
    .grid2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .grid3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .grid4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (min-width: 760px) { .grid4 { grid-template-columns: repeat(4, minmax(0, 1fr)); } }

  .split { display: grid; gap: 16px; grid-template-columns: 1fr; align-items: start; }
  @media (max-width: 1023px) {
    .split[data-open='true'] .list-pane { display: none; }
    .split[data-open='false'] .detail-pane { display: none; }
  }
  @media (min-width: 1024px) {
    .split { grid-template-columns: 310px minmax(0, 1fr); }
    .split.narrow { grid-template-columns: 270px minmax(0, 1fr); }
    .split.orders { grid-template-columns: minmax(0, 1fr) 400px; }
    .split.orders .list-pane { order: 1; }
    .split.orders .detail-pane { order: 2; }
    .list-pane { position: sticky; top: 80px; max-height: calc(100vh - 112px); display: flex; flex-direction: column; overflow: hidden; }
    .detail-pane.sticky { position: sticky; top: 80px; max-height: calc(100vh - 112px); overflow-y: auto; }
    .back { display: none; }
  }

  .list-head { padding: 12px; display: grid; gap: 8px; border-bottom: 1px solid var(--line); }
  .rows { list-style: none; margin: 0; padding: 6px; overflow-y: auto; flex: 1; display: grid; gap: 2px; align-content: start; }
  .row {
    width: 100%; display: flex; align-items: center; gap: 10px;
    padding: 8px 10px;
    border: 0; border-radius: 12px;
    background: transparent; color: inherit;
    font: inherit; text-align: left; cursor: pointer;
    transition: background-color .15s;
  }
  .row:hover { background: #f2f5f0; }
  .row.on { background: var(--mint); }
  .row-main { min-width: 0; flex: 1; display: grid; }
  .row-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-sub { font-size: 12.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .swatch { width: 28px; height: 28px; border-radius: 8px; flex: none; border: 1px solid rgba(0,0,0,.1); }
  .empty-note { padding: 28px 12px; text-align: center; color: var(--muted); }

  .row.order { display: grid; gap: 4px; padding: 12px; }
  .o-top, .o-bottom { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .o-sub { font-size: 12.5px; color: var(--muted); }
  .o-bottom { font-size: 12.5px; color: var(--muted); margin-top: 4px; }

  .thumb {
    flex: none; width: 40px; height: 40px;
    display: grid; place-items: center;
    border-radius: 11px; background: #eff3ed; overflow: hidden;
  }
  .thumb img { width: 100%; height: 100%; object-fit: cover; }
  .thumb :global(svg) { width: 26px; height: 32px; }
  .thumb.lg { width: 56px; height: 56px; border-radius: 14px; }
  .thumb.lg :global(svg) { width: 36px; height: 44px; }

  /* ---------------------------------------------------------------- */
  /* Detail                                                            */
  /* ---------------------------------------------------------------- */
  .detail { padding: 20px; max-width: 760px; }
  .detail-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
  .detail-head .back { margin-left: -8px; }
  .head-id { display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1; }
  .head-id h2 { font-size: 20px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .head-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

  .section { padding: 20px 0 4px; margin-top: 16px; border-top: 1px solid var(--line); }
  .section > h3 { margin-bottom: 12px; }
  .hint { margin-top: 10px; color: var(--muted); font-size: 13px; }
  .hint.warn { color: var(--amber-ink); }

  .shape-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  @media (min-width: 560px) { .shape-grid { grid-template-columns: repeat(6, 1fr); } }
  .shape-tile { position: relative; }
  .shape-tile input { position: absolute; inset: 0; opacity: 0; cursor: pointer; margin: 0; }
  .shape-tile .tile {
    display: grid; justify-items: center; gap: 4px;
    padding: 10px 4px 8px;
    border: 1px solid var(--line); border-radius: 12px;
    transition: border-color .15s, background-color .15s;
  }
  .shape-tile:hover .tile { border-color: #c3cdc0; }
  .shape-tile input:checked + .tile { border-color: var(--leaf); background: var(--mint); box-shadow: inset 0 0 0 1px var(--leaf); }
  .shape-tile input:focus-visible + .tile { outline: 2px solid var(--leaf); outline-offset: 2px; }
  .shape-art :global(svg) { width: 32px; height: 40px; display: block; }
  .shape-name { font-size: 12.5px; color: var(--muted); text-transform: capitalize; }

  .photos { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); }
  .photo {
    position: relative; margin: 0; aspect-ratio: 1;
    border: 1px solid var(--line); border-radius: 14px; overflow: hidden; background: #eff3ed;
  }
  .photo img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .badge-main {
    position: absolute; top: 8px; left: 8px;
    padding: 2px 9px; border-radius: 99px;
    background: var(--forest); color: #fff; font-size: 12px; font-weight: 600;
  }
  .photo figcaption {
    position: absolute; inset: auto 0 0 0;
    display: flex; gap: 4px; justify-content: flex-end; flex-wrap: wrap; padding: 6px;
    background: linear-gradient(transparent, rgba(0,0,0,.55));
  }
  .photo figcaption button {
    border: 0; border-radius: 8px; padding: 4px 9px;
    background: rgba(255,255,255,.92); color: var(--ink);
    font-weight: 500; font-size: 12px; font-family: inherit; cursor: pointer;
  }
  .photo figcaption button.x { color: var(--red); }
  .photo figcaption button:hover { background: #fff; }
  .photo.add, .drop {
    display: grid; place-content: center; justify-items: center; gap: 2px; text-align: center;
    border: 1.5px dashed #bcc8b9; background: #fafcf9; color: var(--leaf-dark);
    font-weight: 600; cursor: pointer;
    transition: background-color .15s, border-color .15s;
  }
  .photo.add small, .drop small { font-weight: 400; color: var(--muted); font-size: 12px; }
  .photo.add:hover, .drop:hover, .photo.add.drag, .drop.drag { background: var(--mint); border-color: var(--leaf); }
  .drop { padding: 22px; border-radius: 14px; }
  .url-row { display: flex; gap: 8px; margin-top: 12px; }

  .banner-preview {
    display: flex; align-items: stretch; justify-content: space-between; gap: 16px;
    min-height: 120px; padding: 20px 22px; margin-bottom: 8px;
    border-radius: 16px; overflow: hidden;
  }
  .bp-text { display: grid; gap: 6px; align-content: center; min-width: 0; }
  .bp-text strong { font: 600 22px/1.15 var(--display); }
  .bp-text p { opacity: .85; }
  .bp-cta { justify-self: start; margin-top: 6px; padding: 6px 14px; border-radius: 99px; font-weight: 600; font-size: 13px; }
  .banner-preview img { height: 100%; max-height: 140px; width: 38%; object-fit: cover; border-radius: 10px; }
  .banner-img { display: flex; align-items: center; gap: 10px; }
  .banner-img img { width: 56px; height: 56px; border-radius: 10px; object-fit: cover; flex: none; }

  /* categories */
  .cat-rows { list-style: none; margin: 0; padding: 4px 12px 12px; }
  .cat-row { display: flex; align-items: center; gap: 12px; padding: 6px 0; border-top: 1px solid var(--line); }
  .cat-row:first-child { border-top: 0; }
  .cat-row .input.bare { flex: 1; min-width: 0; }
  .count { white-space: nowrap; font-size: 13px; }
  .inline-sel { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; }
  .inline-sel .input { width: 72px; }
  @media (max-width: 640px) {
    .cat-row { flex-wrap: wrap; }
    .cat-row .count { order: 3; }
  }

  /* orders */
  .alert { padding: 10px 14px; border-radius: 12px; background: var(--red-bg); color: var(--red); border: 1px solid #f0cfc8; }
  .phone { font-weight: 600; color: var(--leaf-dark); text-decoration: none; }
  .phone:hover { text-decoration: underline; }
  .items { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
  .items li { display: flex; justify-content: space-between; gap: 12px; }
  .items b { display: block; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .items small { color: var(--muted); }
  .total { display: flex; justify-content: space-between; align-items: baseline; margin-top: 14px; padding-top: 12px; border-top: 1px dashed var(--line); }
  .total strong { font: 600 20px var(--display); }

  /* floor plan */
  .layout-controls { display: flex; align-items: flex-end; gap: 24px; flex-wrap: wrap; margin-bottom: 18px; }
  .stepper { display: inline-flex; align-items: center; border: 1px solid #d6ddd2; border-radius: 10px; overflow: hidden; }
  .stepper button { width: 38px; height: 36px; border: 0; background: #f4f7f3; font-size: 18px; cursor: pointer; }
  .stepper button:hover { background: var(--mint); }
  .stepper output { min-width: 40px; text-align: center; font-weight: 600; }
  .layout-controls .hint { margin: 0; flex: 1; min-width: 220px; }

  .plan {
    position: relative;
    display: grid; grid-template-columns: repeat(var(--n), minmax(0, 1fr)); gap: 8px;
    padding: 56px 12px; min-height: 280px;
    border: 2px solid #c9d4c6; border-radius: 18px;
    background: repeating-linear-gradient(0deg, transparent 0 39px, rgba(0,0,0,.025) 39px 40px), #f8faf6;
  }
  .aisle { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 12px 6px; border-radius: 12px; background: #fff; border: 1px solid var(--line); min-width: 0; }
  .aisle b { font: 600 13px var(--display); }
  .cat-tag { max-width: 100%; padding: 2px 8px; border-radius: 99px; background: var(--mint); color: var(--leaf-dark); font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .plan-note { margin-top: 8px; }

  .spot { position: absolute; width: 96px; height: 40px; display: grid; place-items: center; border-radius: 12px; border: 1.5px dashed #b4c2b0; color: var(--muted); font-size: 12.5px; font-weight: 600; cursor: pointer; transition: all .15s; }
  .spot input { position: absolute; inset: 0; opacity: 0; cursor: pointer; margin: 0; }
  .spot:hover { background: var(--mint); border-color: var(--leaf); }
  .spot.on { background: var(--marigold); border: 1.5px solid #c98f10; color: var(--forest); }
  .spot:focus-within { outline: 2px solid var(--leaf); outline-offset: 2px; }
  .spot.back-left { top: 8px; left: 8px; }
  .spot.back-right { top: 8px; right: 8px; }
  .spot.front-left { bottom: 8px; left: 8px; }
  .spot.front-right { bottom: 8px; right: 8px; }

  /* promo, settings, ai */
  .preview-wrap { display: grid; gap: 8px; }
  .promo-card {
    display: grid; gap: 14px; justify-items: start;
    padding: 22px; border-radius: 18px;
    background: var(--forest); color: #fff;
    font: 500 17px/1.35 var(--display);
    max-width: 380px; transition: opacity .2s;
  }
  .promo-card.off { opacity: .45; }
  .promo-card .btn { background: var(--marigold); border-color: var(--marigold); color: var(--forest); font-weight: 600; pointer-events: none; }

  .range-row { display: flex; align-items: center; gap: 14px; }
  .range-row input { flex: 1; accent-color: var(--leaf); }
  .range-row output { min-width: 44px; text-align: right; font-weight: 600; }

  .dots { display: flex; flex-wrap: wrap; gap: 5px; min-height: 18px; }
  .dots i { width: 18px; height: 18px; border-radius: 50%; border: 1px solid rgba(0,0,0,.12); }

  .profiles { display: grid; gap: 10px; margin-top: 14px; }
  .profile {
    display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px;
    padding: 12px; border: 1px solid var(--line); border-radius: 14px; background: #fafcf9;
  }
  .profile .field.grow { flex: 1 1 160px; }
  .profile .field.sm { flex: 0 0 84px; }
  .profile .remove { margin-left: auto; }

  /* empty states */
  .empty { display: grid; justify-items: center; align-content: center; gap: 8px; min-height: 340px; padding: 32px; text-align: center; color: var(--muted); }
  .empty.compact { min-height: 0; padding: 40px 20px; }
  .empty h3 { color: var(--ink); font-size: 17px; }
  .empty .btn { margin-top: 8px; }

  /* toasts */
  .toasts { position: fixed; inset: auto 0 20px 0; z-index: 60; display: grid; justify-items: center; gap: 8px; pointer-events: none; padding: 0 16px; }
  .toast {
    pointer-events: auto;
    display: flex; align-items: center; gap: 12px;
    padding: 10px 16px; border-radius: 12px;
    background: var(--forest); color: #fff; font-weight: 500;
    box-shadow: 0 8px 24px rgba(18,55,42,.25);
  }
  .toast.bad { background: var(--red); max-width: 520px; }
  .toast button { border: 0; background: transparent; color: inherit; font-size: 20px; line-height: 1; cursor: pointer; opacity: .8; }

  @media (max-width: 640px) {
    .detail { padding: 16px; }
    .panel.pad { padding: 16px; }
    .head-actions { width: 100%; }
    .url-row { flex-direction: column; }
  }

  @media (prefers-reduced-motion: reduce) {
    * { transition-duration: 0s !important; animation-duration: 0s !important; }
  }
</style>