<!-- src/routes/admin/+page.svelte  (the admin platform) -->
<script>
  import { goto } from '$app/navigation';
  import { X, Plus, ArrowUp, ImageSquare, CaretLeft, CaretRight, House, Package, List, Storefront, Robot, Tag, Download } from 'phosphor-svelte';
  import {
    AI_DEFAULT_COLORS,
    AI_DEFAULT_NAMES,
    HEX_RE,
    ImgDB,
    LEVELS,
    SLOTS,
    base64ToBlob,
    blobToBase64,
    clamp,
    defaultAI,
    defaultState,
    fmt,
    imageSrc,
    imageURLs,
    loadCart,
    loadStore,
    normalizeAI,
    productImages,
    safeUrl,
    saveCartData,
    saveStoreData,
    svgPack,
    uid
  } from '#lib/breathe.js';

  /* =========================================================
     STATE
     ========================================================= */
  const CAP_PER_AISLE = 2 * LEVELS.length * SLOTS;
  let store = $state(loadStore());
  let adminTab = $state('overview');
  let toastText = $state('');
  let dialogState = $state(null);
  let editorOpen = $state(false);
  let editor = $state({ mode: 'product', isNew: false, productId: null, data: null });
  let bannerEditor = $state({ existing: false, data: null });
  let publishedProducts = $derived(store.products.filter((p) => p.published && p.enabled !== false));

  function saveStore() { saveStoreData($state.snapshot(store)); }

  let toastTimer = null;
  function toast(msg) {
    toastText = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastText = ''; }, 1800);
  }
  function uiAsk(opts) { return new Promise((resolve) => { dialogState = { ...opts, resolve }; }); }
  function closeDialog(result) { if (dialogState) dialogState.resolve(result); dialogState = null; }

  function openProductEditor(productId) {
    let data;
    if (productId) {
      const p = store.products.find((x) => x.id === productId);
      if (!p) return;
      data = JSON.parse(JSON.stringify($state.snapshot(p.draft || p)));
      if (!Array.isArray(data.images)) {
        data.images = (data.image && data.image.kind !== 'none') ? [JSON.parse(JSON.stringify(data.image))] : [];
      }
      editor = { mode: 'product', isNew: false, productId, data };
    } else {
      data = {
        name: '', brand: '', price: 1000,
        categoryId: store.categories[0]?.id || '',
        shape: 'box', color: '#cfd6d2',
        image: { kind: 'none' }, images: [],
        imageType: 'wrap',
        enabled: true, published: false, placement: { mode: 'auto' }
      };
      editor = { mode: 'product', isNew: true, productId: null, data };
    }
    editorOpen = true;
  }

  function collectEditor() {
    const d = editor.data;
    if (!d) return;
    d.name = (document.getElementById('edName')?.value || '').trim() || 'Untitled product';
    d.brand = (document.getElementById('edBrand')?.value || '').trim();
    d.price = Math.max(0, Math.round(Number(document.getElementById('edPrice')?.value) || 0));
    d.categoryId = document.getElementById('edCat')?.value;
    d.shape = document.getElementById('edShape')?.value;
    d.color = (document.getElementById('edColor')?.value || '#cfd6d2').trim();
    d.enabled = document.getElementById('edEnabled')?.value === '1';
    const mode = document.getElementById('edPlaceMode')?.value;
    if (mode === 'manual') {
      d.placement = {
        mode: 'manual',
        aisle: clamp((Number(document.getElementById('edAisle')?.value) || 1) - 1, 0, 7),
        side: document.getElementById('edSide')?.value === 'R' ? 'R' : 'L',
        level: clamp((Number(document.getElementById('edLevel')?.value) || 1) - 1, 0, LEVELS.length - 1),
        slot: clamp((Number(document.getElementById('edSlot')?.value) || 1) - 1, 0, SLOTS - 1)
      };
    } else d.placement = { mode: 'auto' };
    /* sync image[] → primary */
    const snap = $state.snapshot(d.images || []);
    d.images = snap;
    d.image = d.images.length ? JSON.parse(JSON.stringify(d.images[0])) : { kind: 'none' };
  }

  function saveEditorDraft() {
    if (editor.isNew) {
      const rec = JSON.parse(JSON.stringify($state.snapshot(editor.data)));
      rec.id = uid('p'); rec.published = false;
      store.products.push(rec);
      editor = { mode: 'product', isNew: false, productId: rec.id, data: rec };
      toast('Draft saved');
    } else {
      const p = store.products.find((x) => x.id === editor.productId);
      if (!p) return;
      if (p.published) { p.draft = JSON.parse(JSON.stringify($state.snapshot(editor.data))); toast('Draft saved'); }
      else { Object.assign(p, $state.snapshot(editor.data)); toast('Draft saved'); }
    }
    saveStore();
  }

  function publishEditor() {
    if (editor.isNew) {
      const rec = JSON.parse(JSON.stringify($state.snapshot(editor.data)));
      rec.id = uid('p'); rec.published = true;
      store.products.push(rec);
      editor = { mode: 'product', isNew: false, productId: rec.id, data: rec };
    } else {
      const p = store.products.find((x) => x.id === editor.productId);
      if (!p) return;
      if (p.draft) { Object.assign(p, $state.snapshot(p.draft)); delete p.draft; }
      else Object.assign(p, $state.snapshot(editor.data));
      p.published = true;
    }
    saveStore();
    
    editorOpen = false;
    toast('Published');
  }

  async function uploadImage(file, cb) {
    if (!file || !/^image\//.test(file.type)) { toast('Not an image'); return false; }
    if (file.size > 4 * 1024 * 1024) { toast('Image too large (max 4 MB)'); return false; }
    const id = uid('img');
    try {
      await ImgDB.put(id, file);
      imageURLs.set(id, URL.createObjectURL(file));
      cb({ kind: 'upload', id });
      return true;
    } catch { toast('Could not store image'); return false; }
  }

  /* Append multiple uploaded files to editor product */
  function addEditorImages() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.multiple = true;
    inp.onchange = async () => {
      const files = Array.from(inp.files || []);
      if (!files.length) return;
      if (!Array.isArray(editor.data.images)) editor.data.images = [];
      for (const f of files) {
        if (!/^image\//.test(f.type)) continue;
        if (f.size > 4 * 1024 * 1024) { toast(`${f.name}: too large (max 4 MB)`); continue; }
        const id = uid('img');
        try {
          await ImgDB.put(id, f);
          imageURLs.set(id, URL.createObjectURL(f));
          editor.data.images.push({ kind: 'upload', id });
        } catch { toast(`${f.name}: could not store`); }
      }
      toast(files.length > 1 ? `${files.length} images added` : 'Image added');
    };
    inp.click();
  }

  function addEditorImageFromUrl() {
    uiAsk({ title: 'Image URL', msg: 'Paste a link to the image.', ok: 'Add image', input: 'https://…' }).then((u) => {
      if (!u) return;
      const href = safeUrl(u);
      if (!href) { toast('Only http(s) URLs are allowed'); return; }
      if (!Array.isArray(editor.data.images)) editor.data.images = [];
      editor.data.images.push({ kind: 'url', url: href });
    });
  }

  function addEditorImageFromSample() {
    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 z-[130] flex items-center justify-center bg-[#090c0c]/45 backdrop-blur-sm p-4';
    const panel = document.createElement('div');
    panel.className = 'w-full max-w-[420px] bg-white rounded-[20px] p-[18px]';
    panel.innerHTML = `
      <div class="flex items-center gap-2.5 mb-3.5">
        <h2 class="text-[17px] m-0 font-bold" style="font-family:'Bricolage Grotesque',sans-serif">Sample images</h2>
        <div class="flex-1"></div>
        <button class="w-8 h-8 rounded-full border border-[#e3e7e4] bg-white flex items-center justify-center text-[#5a6662]">✕</button>
      </div>
      <div class="flex flex-wrap gap-2"></div>
    `;
    const wrap = panel.querySelector('.flex.flex-wrap');
    // Recreate the sample list used in the original
    const samples = [
      { name: 'Aqua',    url: svgPack('AQUA', '#8ecae6', '#0b3d4d') },
      { name: 'Fresh',   url: svgPack('FRESH', '#1f6b57', '#ffffff') },
      { name: 'Classic', url: svgPack('CLASSIC', '#c05a4a', '#ffffff') },
      { name: 'Golden',  url: svgPack('GOLD', '#d8a13a', '#3a2a06') },
      { name: 'Cocoa',   url: svgPack('COCOA', '#6b4a35', '#fff5e6') },
      { name: 'Pure',    url: svgPack('PURE', '#7c6bb0', '#ffffff') },
      { name: 'Daily',   url: svgPack('DAILY', '#7fb3c8', '#0a2a33') },
      { name: 'Bake',    url: svgPack('BAKE', '#e3d4b5', '#5a4527') }
    ];
    samples.forEach((s) => {
      const b = document.createElement('button');
      b.className = 'w-14 h-14 rounded-[10px] overflow-hidden border-2 border-transparent hover:border-[#1f6b57]';
      b.innerHTML = `<img src="${s.url}" alt="${s.name}" class="w-full h-full object-cover" />`;
      b.onclick = () => {
        if (!Array.isArray(editor.data.images)) editor.data.images = [];
        editor.data.images.push({ kind: 'url', url: s.url });
        modal.remove();
      };
      wrap.appendChild(b);
    });
    panel.querySelector('button').onclick = () => modal.remove();
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    modal.appendChild(panel);
    document.body.appendChild(modal);
  }

  function removeEditorImage(i) {
    if (!editor.data.images) return;
    editor.data.images.splice(i, 1);
  }
  function moveEditorImage(i, dir) {
    if (!editor.data.images) return;
    const j = i + dir;
    if (j < 0 || j >= editor.data.images.length) return;
    const arr = editor.data.images;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    editor.data.images = arr.slice();
  }

  function openBannerEditor(bannerId) {
    const existing = bannerId ? store.banners.find((b) => b.id === bannerId) : null;
    const b = existing ? JSON.parse(JSON.stringify($state.snapshot(existing))) : {
      id: uid('b'), name: '', headline: '', sub: '', cta: '', url: '', bg: '#1f6b57',
      image: { kind: 'none' }, enabled: true, published: true, priority: 5, placements: ['ceiling']
    };
    bannerEditor = { existing: !!existing, data: b };
    editor = { mode: 'banner', isNew: !existing, productId: null, data: null };
    editorOpen = true;
  }

  function collectBanner() {
    const d = bannerEditor.data;
    if (!d) return;
    d.name = (document.getElementById('bnName')?.value || '').trim() || 'Banner';
    d.headline = (document.getElementById('bnHead')?.value || '').trim();
    d.sub = (document.getElementById('bnSub')?.value || '').trim();
    d.cta = (document.getElementById('bnCta')?.value || '').trim();
    d.bg = (document.getElementById('bnBg')?.value || '#1f6b57').trim();
    d.url = (document.getElementById('bnUrl')?.value || '').trim();
    d.priority = clamp(Number(document.getElementById('bnPriority')?.value) || 5, 1, 10);
    d.placements = Array.from(document.querySelectorAll('[data-bn-place]')).filter((c) => c.checked).map((c) => c.getAttribute('data-bn-place'));
  }
  function saveBanner() {
    collectBanner();
    const d = $state.snapshot(bannerEditor.data);
    if (d.url && !safeUrl(d.url)) { toast('URL must be http(s)'); return; }
    const idx = store.banners.findIndex((b) => b.id === d.id);
    if (idx >= 0) store.banners[idx] = d;
    else store.banners.push(d);
    saveStore();
    
    
    editorOpen = false;
    toast('Banner saved');
  }

  function deleteProduct(id) {
    const p = store.products.find((x) => x.id === id);
    if (!p) return;
    uiAsk({ title: `Delete "${p.name}"?`, msg: 'This removes the product and its images.', ok: 'Delete', danger: true })
      .then((ok) => { if (!ok) return; doPurgeProducts([id]); });
  }
  function doPurgeProducts(ids) {
    const set = new Set(ids);
    store.products = store.products.filter((p) => !set.has(p.id));
    const c = loadCart();
    c.lines = c.lines.filter((l) => !set.has(l.productId));
    saveCartData(c);
    saveStore(); 
    
    
    toast(ids.length > 1 ? `${ids.length} products deleted` : 'Product deleted');
  }
  function deleteBanner(id) {
    uiAsk({ title: 'Delete banner?', msg: 'This removes the banner.', ok: 'Delete', danger: true }).then((ok) => {
      if (!ok) return;
      store.banners = store.banners.filter((b) => b.id !== id);
      saveStore();  
      toast('Banner deleted');
    });
  }
  function toggleProduct(id) {
    const p = store.products.find((x) => x.id === id);
    if (!p) return;
    p.enabled = p.enabled === false;
    saveStore(); 
  }
  function toggleBanner(id) {
    const b = store.banners.find((x) => x.id === id);
    if (!b) return;
    b.enabled = b.enabled === false;
    saveStore();  
  }

  function exportBackup() {
    try {
      ImgDB.all().then(async (records) => {
        const images = [];
        for (const r of records) {
          if (!r.blob) continue;
          images.push({ id: r.id, mime: r.mime || r.blob.type, data: await blobToBase64(r.blob) });
        }
        const payload = { app: 'breathe', version: 1, exportedAt: new Date().toISOString(), state: $state.snapshot(store), images };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `breathe-backup-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        toast('Backup exported');
      });
    } catch { toast('Export failed'); }
  }
  function importBackup() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'application/json,.json';
    inp.onchange = async () => {
      const f = inp.files?.[0]; if (!f) return;
      let payload;
      try { payload = JSON.parse(await f.text()); }
      catch { toast('Not valid JSON'); return; }
      if (!payload || payload.app !== 'breathe' || !payload.state) { toast('Not a Breathe backup'); return; }
      if (!Array.isArray(payload.state.products)) { toast('Invalid backup'); return; }
      if (Array.isArray(payload.images)) {
        for (const img of payload.images) {
          try { const blob = base64ToBlob(img.data, img.mime); await ImgDB.put(img.id, blob); imageURLs.set(img.id, URL.createObjectURL(blob)); }
          catch { /* */ }
        }
      }
      store = payload.state;
      if (!store.orders) store.orders = [];
      if (!store.promo) store.promo = defaultState().promo;
      if (!store.settings) store.settings = defaultState().settings;
      store.ai = normalizeAI(store.ai);
      /* migrate */
      store.products.forEach((p) => {
        if (!Array.isArray(p.images)) p.images = (p.image && p.image.kind !== 'none') ? [p.image] : [];
        if (!p.image) p.image = p.images[0] || { kind: 'none' };
      });
      saveStore();
      
      
      toast('Backup imported');
    };
    inp.click();
  }


  /* ---- AI settings ---- */
  function aiSetNum(key, raw, lo, hi, int, el) {
    let v = Number(raw);
    if (!isFinite(v)) v = defaultAI()[key];
    v = clamp(v, lo, hi); if (int) v = Math.round(v);
    store.ai[key] = v;
    if (key === 'spawnMin' && store.ai.spawnMax < v) store.ai.spawnMax = v;
    if (key === 'spawnMax' && store.ai.spawnMin > v) store.ai.spawnMin = v;
    if (el) el.value = v;
    saveStore();
  }
  function aiAddName(inputEl) {
    let v = (inputEl?.value || '').trim().slice(0, 20);
    if (!v) return;
    if (store.ai.names.some((x) => x.toLowerCase() === v.toLowerCase())) { toast('Name already added'); return; }
    if (store.ai.names.length >= 60) { toast('Name list is full'); return; }
    store.ai.names.push(v); inputEl.value = '';
    saveStore();
  }
  function aiRemoveName(i) { store.ai.names.splice(i, 1); saveStore(); }
  function aiAddColor(hex) {
    if (!HEX_RE.test(hex || '')) return;
    if (store.ai.cartColors.some((c) => c.toLowerCase() === hex.toLowerCase())) { toast('Colour already added'); return; }
    if (store.ai.cartColors.length >= 30) { toast('Colour list is full'); return; }
    store.ai.cartColors.push(hex); saveStore();
  }
  function aiSetColor(i, hex) { if (HEX_RE.test(hex || '')) { store.ai.cartColors[i] = hex; saveStore(); } }
  function aiRemoveColor(i) { store.ai.cartColors.splice(i, 1); saveStore(); }
  function aiAddProfile() {
    if (store.ai.profiles.length >= 12) { toast('Profile list is full'); return; }
    store.ai.profiles.push({ id: uid('prof'), label: 'New shopper', speed: 1, maxItems: 0, color: '', weight: 1 });
    saveStore();
  }
  function aiSetProfile(p, key, raw, lo, hi, int, el) {
    let v = Number(raw); if (!isFinite(v)) v = key === 'maxItems' ? 0 : 1;
    v = clamp(v, lo, hi); if (int) v = Math.round(v);
    p[key] = v; if (el) el.value = v; saveStore();
  }
  function aiRemoveProfile(i) {
    if (store.ai.profiles.length <= 1) { toast('Keep at least one profile'); return; }
    store.ai.profiles.splice(i, 1); saveStore();
  }
  function aiResetAll() {
    uiAsk({ title: 'Reset AI settings?', msg: 'This restores the default AI settings, names, cart colours and profiles.', ok: 'Reset', danger: true }).then((ok) => {
      if (!ok) return;
      store.ai = defaultAI(); saveStore(); toast('AI settings reset');
    });
  }

</script>

<svelte:head>
  <title>Breathe — Admin</title>
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@600;700;800&family=Figtree:wght@400;500;600;700&display=swap" rel="stylesheet" />
</svelte:head>

<!-- ============ EDITOR (product / banner) ============ -->
{#if editorOpen}
  {#if editor.mode === 'banner' && bannerEditor.data}
    <div class="fixed inset-0 z-[120] flex items-end md:items-center justify-center bg-[#090c0c]/42 backdrop-blur-sm">
      <div class="w-full max-w-[520px] max-h-[90vh] overflow-auto bg-white rounded-t-[20px] md:rounded-[20px] p-[18px] pb-[calc(18px+env(safe-area-inset-bottom,0px))] md:pb-[18px]">
        <div class="flex items-center gap-2.5 mb-3.5">
          <h2 class="text-[17px] m-0 font-bold" style="font-family:'Bricolage Grotesque',sans-serif">{bannerEditor.existing ? 'Edit banner' : 'New banner'}</h2>
          <div class="flex-1"></div>
          <button onclick={() => editorOpen = false} class="w-8 h-8 rounded-full border border-[#e3e7e4] bg-white flex items-center justify-center text-[#5a6662]"><X size={16} /></button>
        </div>
        <div class="mb-3">
          <label class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">Banner name</label>
          <input id="bnName" type="text" value={bannerEditor.data.name} class="w-full px-3 py-2.5 border border-[#e3e7e4] rounded-[11px] text-[14.5px] outline-none focus:border-[#1f6b57]" />
        </div>
        <div class="mb-3">
          <label class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">Headline</label>
          <input id="bnHead" type="text" value={bannerEditor.data.headline} class="w-full px-3 py-2.5 border border-[#e3e7e4] rounded-[11px] text-[14.5px] outline-none focus:border-[#1f6b57]" />
        </div>
        <div class="mb-3">
          <label class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">Supporting text</label>
          <input id="bnSub" type="text" value={bannerEditor.data.sub} class="w-full px-3 py-2.5 border border-[#e3e7e4] rounded-[11px] text-[14.5px] outline-none focus:border-[#1f6b57]" />
        </div>
        <div class="grid grid-cols-2 gap-2.5 mb-3">
          <div>
            <label class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">CTA label</label>
            <input id="bnCta" type="text" value={bannerEditor.data.cta} class="w-full px-3 py-2.5 border border-[#e3e7e4] rounded-[11px] text-[14.5px] outline-none focus:border-[#1f6b57]" />
          </div>
          <div>
            <label class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">Background</label>
            <input id="bnBg" type="text" value={bannerEditor.data.bg} class="w-full px-3 py-2.5 border border-[#e3e7e4] rounded-[11px] text-[14.5px] outline-none focus:border-[#1f6b57]" />
          </div>
        </div>
        <div class="mb-3">
          <label class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">Destination URL</label>
          <input id="bnUrl" type="text" placeholder="https://…" value={bannerEditor.data.url} class="w-full px-3 py-2.5 border border-[#e3e7e4] rounded-[11px] text-[14.5px] outline-none focus:border-[#1f6b57]" />
        </div>
        <div class="mb-3">
          <label class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">Priority (1–10)</label>
          <input id="bnPriority" type="number" min="1" max="10" value={bannerEditor.data.priority || 5} class="w-full px-3 py-2.5 border border-[#e3e7e4] rounded-[11px] text-[14.5px] outline-none focus:border-[#1f6b57]" />
        </div>
        <div class="mb-3">
          <label class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">Placements</label>
          <div class="flex flex-wrap gap-2.5">
            {#each ['ceiling','shelf','entrance'] as pl}
              <label class="flex items-center gap-1.5 text-[11.5px] text-[#5a6662]">
                <input type="checkbox" data-bn-place={pl} checked={bannerEditor.data.placements?.includes(pl)} />
                {pl}
              </label>
            {/each}
          </div>
        </div>
        <div class="mb-3">
          <label class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">Image</label>
          <div class="flex flex-wrap gap-1.5">
            <button onclick={() => {
              const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
              inp.onchange = async () => { const ok = await uploadImage(inp.files?.[0], () => {}); if (ok && inp.files?.[0]) {
                const id = uid('img2'); // NB: uploadImage already stored under a fresh id; fetch it back via the last URL
                /* simpler: just re-use uploadImage's stored blob via its side effect */
              } };
              /* use a wrapper so we get the id */
              const input2 = document.createElement('input'); input2.type = 'file'; input2.accept = 'image/*';
              input2.onchange = async () => {
                const f = input2.files?.[0]; if (!f) return;
                const ok = await uploadImage(f, (img) => { bannerEditor.data.image = img; });
                if (ok) toast('Banner image updated');
              };
              input2.click();
            }} class="px-2.5 py-1.5 text-[12.5px] font-bold border border-[#e3e7e4] rounded-[10px] bg-white">Upload</button>
            <button onclick={() => uiAsk({ title: 'Banner image URL', ok: 'Use image', input: 'https://…' }).then((u) => {
              if (!u) return; const h = safeUrl(u); if (!h) { toast('Must be http(s)'); return; }
              bannerEditor.data.image = { kind: 'url', url: h };
            })} class="px-2.5 py-1.5 text-[12.5px] font-bold border border-[#e3e7e4] rounded-[10px] bg-white">From URL</button>
            <button onclick={() => bannerEditor.data.image = { kind: 'none' }} class="px-2.5 py-1.5 text-[12.5px] font-bold border border-[#e3e7e4] rounded-[10px] bg-white">None</button>
          </div>
        </div>
        <div class="flex flex-col gap-2.5 mt-3.5">
          <button onclick={saveBanner} class="w-full rounded-xl px-4 py-3 text-[14.5px] font-bold text-white" style="background:linear-gradient(180deg,#27806a,#1b5e4d)">Publish banner</button>
          <button onclick={() => editorOpen = false} class="w-full rounded-xl border border-[#e3e7e4] bg-white px-4 py-2.5 text-[14px] font-semibold text-[#14181a]">Cancel</button>
        </div>
      </div>
    </div>
  {:else if editor.data}
    <!-- product editor -->
    <div class="fixed inset-0 z-[120] flex items-end md:items-center justify-center bg-[#090c0c]/42 backdrop-blur-sm">
      <div class="w-full max-w-[520px] max-h-[90vh] overflow-auto bg-white rounded-t-[20px] md:rounded-[20px] p-[18px] pb-[calc(18px+env(safe-area-inset-bottom,0px))] md:pb-[18px]">
        <div class="flex items-center gap-2.5 mb-3.5">
          <h2 class="text-[17px] m-0 font-bold" style="font-family:'Bricolage Grotesque',sans-serif">{editor.isNew ? 'New product' : 'Edit product'}</h2>
          <div class="flex-1"></div>
          <button onclick={() => editorOpen = false} class="w-8 h-8 rounded-full border border-[#e3e7e4] bg-white flex items-center justify-center text-[#5a6662]"><X size={16} /></button>
        </div>

        <div class="mb-3">
          <label class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">Name</label>
          <input id="edName" type="text" value={editor.data.name} class="w-full px-3 py-2.5 border border-[#e3e7e4] rounded-[11px] text-[14.5px] outline-none focus:border-[#1f6b57]" />
        </div>
        <div class="grid grid-cols-2 gap-2.5 mb-3">
          <div>
            <label class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">Brand</label>
            <input id="edBrand" type="text" value={editor.data.brand || ''} class="w-full px-3 py-2.5 border border-[#e3e7e4] rounded-[11px] text-[14.5px] outline-none focus:border-[#1f6b57]" />
          </div>
          <div>
            <label class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">Price (MWK)</label>
            <input id="edPrice" type="number" min="0" value={editor.data.price | 0} class="w-full px-3 py-2.5 border border-[#e3e7e4] rounded-[11px] text-[14.5px] outline-none focus:border-[#1f6b57]" />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2.5 mb-3">
          <div>
            <label class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">Category</label>
            <select id="edCat" class="w-full px-3 py-2.5 border border-[#e3e7e4] rounded-[11px] text-[14.5px] outline-none">
              {#each store.categories as c (c.id)}
                <option value={c.id} selected={c.id === editor.data.categoryId}>{c.name}</option>
              {/each}
            </select>
          </div>
          <div>
            <label class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">Style</label>
            <select id="edShape" class="w-full px-3 py-2.5 border border-[#e3e7e4] rounded-[11px] text-[14.5px] outline-none">
              {#each ['bottle','can','carton','box','bar','bag'] as s}
                <option value={s} selected={s === editor.data.shape}>{s}</option>
              {/each}
            </select>
          </div>
        </div>
        <div class="mb-3">
          <label class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">Package colour</label>
          <input id="edColor" type="text" value={editor.data.color || '#cfd6d2'} class="w-full px-3 py-2.5 border border-[#e3e7e4] rounded-[11px] text-[14.5px] outline-none focus:border-[#1f6b57]" />
        </div>

        <!-- multi-image carousel -->
        <div class="mb-3">
          <div class="flex items-center justify-between mb-1.5">
            <label class="block text-[11.5px] font-bold text-[#5a6662] uppercase tracking-wider">Images</label>
            <span class="text-[11px] text-[#5a6662]">{(editor.data.images || []).length} image{(editor.data.images || []).length === 1 ? '' : 's'}</span>
          </div>
          <p class="text-[11px] text-[#5a6662] mb-2">Add one or more images. The first is used as the primary thumbnail; shelves auto-cycle through all of them.</p>
          <div class="flex flex-wrap gap-2">
            {#each (editor.data.images || []) as img, i (i)}
              <div class="relative w-[76px] h-[76px] rounded-xl overflow-hidden border-2 {i === 0 ? 'border-[#1f6b57]' : 'border-[#e3e7e4]'} bg-[#f2f4f2] flex-none">
                {#await imageSrc(img) then src}
                  {#if src}
                    <img src={src} alt="" class="w-full h-full object-cover" />
                  {:else}
                    <div class="w-full h-full grid place-items-center text-[#5a6662] text-lg">·</div>
                  {/if}
                {:catch}
                  <div class="w-full h-full grid place-items-center text-[#5a6662] text-lg">·</div>
                {/await}
                {#if i === 0}
                  <span class="absolute top-0.5 left-0.5 text-[8.5px] font-extrabold bg-[#1f6b57] text-white px-1 py-px rounded tracking-wider">MAIN</span>
                {/if}
                <button onclick={() => removeEditorImage(i)} aria-label="Remove"
                        class="absolute top-0.5 right-0.5 w-[18px] h-[18px] rounded-full bg-white/95 text-[#b23a2f] text-[11px] font-bold grid place-items-center border border-[#e3e7e4]">
                  <X size={10} weight="bold" />
                </button>
                <div class="absolute bottom-0.5 inset-x-0.5 flex justify-between">
                  {#if i > 0}
                    <button onclick={() => moveEditorImage(i, -1)} aria-label="Move left"
                            class="w-[18px] h-[18px] rounded-full bg-white/95 border border-[#e3e7e4] grid place-items-center text-[#14181a]">
                      <CaretLeft size={10} weight="bold" />
                    </button>
                  {:else}<span></span>{/if}
                  {#if i < (editor.data.images || []).length - 1}
                    <button onclick={() => moveEditorImage(i, 1)} aria-label="Move right"
                            class="w-[18px] h-[18px] rounded-full bg-white/95 border border-[#e3e7e4] grid place-items-center text-[#14181a]">
                      <CaretRight size={10} weight="bold" />
                    </button>
                  {:else}<span></span>{/if}
                </div>
              </div>
            {/each}
            <button onclick={addEditorImages}
                    class="w-[76px] h-[76px] rounded-xl border border-dashed border-[#cfd6d2] bg-white flex flex-col items-center justify-center gap-0.5 text-[#5a6662] hover:border-[#1f6b57] hover:text-[#1f6b57]">
              <Plus size={18} />
              <span class="text-[10px] font-bold">Add</span>
            </button>
          </div>
          <div class="flex gap-1.5 mt-2">
            <button onclick={addEditorImageFromUrl} class="px-2 py-1 text-[11px] font-bold border border-[#e3e7e4] rounded-[8px] bg-white">From URL</button>
            <button onclick={addEditorImageFromSample} class="px-2 py-1 text-[11px] font-bold border border-[#e3e7e4] rounded-[8px] bg-white">Sample</button>
          </div>
        </div>

        <div class="mb-3">
          <label class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">Placement</label>
          <select id="edPlaceMode" class="w-full px-3 py-2.5 border border-[#e3e7e4] rounded-[11px] text-[14.5px] outline-none">
            <option value="auto" selected={(!editor.data.placement || editor.data.placement.mode === 'auto')}>Automatic</option>
            <option value="manual" selected={(editor.data.placement?.mode === 'manual')}>Manual</option>
          </select>
        </div>
        <div class="mb-3">
          <label class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">Status</label>
          <select id="edEnabled" class="w-full px-3 py-2.5 border border-[#e3e7e4] rounded-[11px] text-[14.5px] outline-none">
            <option value="1" selected={editor.data.enabled !== false}>Enabled</option>
            <option value="0" selected={editor.data.enabled === false}>Disabled</option>
          </select>
        </div>

        <div class="flex flex-col gap-2.5 mt-3.5">
          <button onclick={() => { collectEditor(); publishEditor(); }} class="w-full rounded-xl px-4 py-3 text-[14.5px] font-bold text-white" style="background:linear-gradient(180deg,#27806a,#1b5e4d)">Publish</button>
          <button onclick={() => { collectEditor(); saveEditorDraft(); editorOpen = false; }} class="w-full rounded-xl border border-[#e3e7e4] bg-white px-4 py-2.5 text-[14px] font-semibold text-[#14181a]">Save draft</button>
          <button onclick={() => editorOpen = false} class="w-full rounded-xl border border-[#f0d6d2] bg-white px-4 py-2.5 text-[14px] font-semibold text-[#b23a2f]">Discard</button>
        </div>
      </div>
    </div>
  {/if}
{/if}

<!-- ============ ADMIN ============ -->
  <div class="fixed inset-0 z-[70] bg-[#eef2f0] flex">
    <div class="w-full h-full min-h-0 max-w-[1180px] mx-auto flex flex-col md:flex-row">
      <aside class="w-full md:w-[232px] flex-none md:flex md:flex-col bg-gradient-to-b from-[#0d1b17] to-[#12261f] text-[#cfe3da] p-3 md:p-5 gap-2 md:gap-[18px] overflow-x-auto md:overflow-visible flex flex-row items-center">
        <div class="hidden md:flex gap-3 items-center px-2">
          <div class="w-9 h-9 rounded-[11px] bg-gradient-to-br from-[#3ddc97] to-[#1f6b57] grid place-items-center font-extrabold text-[18px] text-[#06231a]">B</div>
          <div><b class="block text-[16px] text-white" style="font-family:'Bricolage Grotesque',sans-serif">Breathe</b><small class="text-[11.5px] text-[#7fa597]">Admin</small></div>
        </div>
        <nav class="flex flex-row md:flex-col gap-1 md:gap-[3px]">
          {#each [
            { id: 'overview', label: 'Overview', icon: House },
            { id: 'products', label: 'Products', icon: Package },
            { id: 'categories', label: 'Categories', icon: List },
            { id: 'layout', label: 'Layout', icon: Storefront },
            { id: 'banners', label: 'Banners', icon: ImageSquare },
            { id: 'ai', label: 'AI Settings', icon: Robot },
            { id: 'promo', label: 'Promotion', icon: Tag },
            { id: 'backup', label: 'Backup', icon: Download }
          ] as tab}
            <button onclick={() => adminTab = tab.id}
                    class="flex items-center gap-2.5 px-3 py-2.5 rounded-[11px] text-[13.5px] font-semibold whitespace-nowrap
                           {adminTab === tab.id ? 'bg-[#3ddc97]/15 text-[#7ee0b8] md:shadow-[inset_3px_0_0_#3ddc97]' : 'text-[#9bbbad] hover:bg-white/5 hover:text-white'}">
              <svelte:component this={tab.icon} size={16} />
              <span>{tab.label}</span>
            </button>
          {/each}
        </nav>
      </aside>
      <main class="flex-1 flex flex-col min-w-0 min-h-0">
        <header class="flex items-center gap-3 px-4 md:px-6 pt-3 md:pt-5 pb-1.5">
          <div>
            <h1 class="m-0 text-[22px] md:text-[24px] font-extrabold tracking-tight text-[#10201a]" style="font-family:'Bricolage Grotesque',sans-serif">
              {#if adminTab === 'overview'}Overview{:else if adminTab === 'products'}Products{:else if adminTab === 'categories'}Categories{:else if adminTab === 'layout'}Layout{:else if adminTab === 'banners'}Banners{:else if adminTab === 'ai'}AI Settings{:else if adminTab === 'promo'}Promotion{:else}Backup{/if}
            </h1>
          </div>
          <div class="flex-1"></div>
          <button onclick={() => goto('/')} class="px-2.5 py-1.5 text-[12.5px] font-bold text-white rounded-[10px]" style="background:linear-gradient(180deg,#27806a,#1b5e4d)">Back to store</button>
        </header>
        <div class="flex-1 overflow-y-auto min-h-0 overscroll-contain px-4 md:px-6 pt-3.5 pb-16">
          {#if adminTab === 'overview'}
            {@const live = publishedProducts.length}
            {@const drafts = store.products.filter((p) => !p.published || p.draft).length}
            {@const liveBanners = store.banners.filter((b) => b.enabled !== false && b.published !== false).length}
            {@const N = Math.max(1, store.layout.aisleCount | 0)}
            {@const cap = N * CAP_PER_AISLE}
            {@const fill = Math.min(100, Math.round(live / cap * 100))}
            <div class="bg-white border border-[#e0e7e3] rounded-2xl p-4 mb-3 shadow-sm">
              <div class="grid grid-cols-2 md:grid-cols-4 gap-2.5">
                {#each [[live, 'Live products'], [drafts, 'Drafts'], [store.categories.length, 'Categories'], [liveBanners, 'Live banners']] as [n, l]}
                  <div class="bg-gradient-to-b from-[#f7faf8] to-[#eef4f1] rounded-[14px] px-3 py-3.5">
                    <div class="text-[30px] font-extrabold tracking-tight text-[#12302a]" style="font-family:'Bricolage Grotesque',sans-serif">{n}</div>
                    <div class="text-[12px] text-[#5a6a63] mt-0.5">{l}</div>
                  </div>
                {/each}
              </div>
              <div class="mt-3.5">
                <div class="flex items-center gap-2">
                  <span class="text-[11.5px] text-[#5a6662]">Shelf capacity</span>
                  <div class="flex-1"></div>
                  <span class="text-[11.5px] text-[#5a6662]"><b>{live}</b> of {cap} slots · {N} aisle{N > 1 ? 's' : ''}</span>
                </div>
                <div class="h-2 rounded-full bg-[#e4ece8] mt-2 overflow-hidden">
                  <div class="h-full rounded-full" style="width:{fill}%;background:linear-gradient(90deg,#3ddc97,#1f6b57)"></div>
                </div>
              </div>
            </div>
            <div class="text-[13px] font-bold text-[#41524b] mx-0.5 mt-4 mb-2.5">Quick actions</div>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-2.5">
              <button onclick={() => openProductEditor(null)} class="flex gap-3 items-center text-left bg-white border border-[#e0e7e3] rounded-[14px] p-3">
                <span class="w-10 h-10 rounded-[11px] bg-[#e3f4ec] text-[#1f6b57] grid place-items-center flex-none"><Plus size={18} weight="bold" /></span>
                <span><b class="block text-[13.5px]">New product</b><small class="text-[11.5px] text-[#68786f]">Add to catalogue</small></span>
              </button>
              <button onclick={() => openBannerEditor(null)} class="flex gap-3 items-center text-left bg-white border border-[#e0e7e3] rounded-[14px] p-3">
                <span class="w-10 h-10 rounded-[11px] bg-[#e3f4ec] text-[#1f6b57] grid place-items-center flex-none"><ImageSquare size={18} /></span>
                <span><b class="block text-[13.5px]">New banner</b><small class="text-[11.5px] text-[#68786f]">Promote a deal</small></span>
              </button>
              <button onclick={() => { store.products.forEach((p) => { if (p.draft) { Object.assign(p, p.draft); delete p.draft; } p.published = true; }); saveStore();  toast('All drafts published'); }}
                      class="flex gap-3 items-center text-left bg-white border border-[#e0e7e3] rounded-[14px] p-3">
                <span class="w-10 h-10 rounded-[11px] bg-[#e3f4ec] text-[#1f6b57] grid place-items-center flex-none"><ArrowUp size={18} /></span>
                <span><b class="block text-[13.5px]">Publish drafts</b><small class="text-[11.5px] text-[#68786f]">{drafts} waiting</small></span>
              </button>
            </div>
          {:else if adminTab === 'products'}
            <div class="bg-white border border-[#e0e7e3] rounded-2xl p-3.5 mb-3">
              <div class="flex items-center gap-2 mb-2.5">
                <div class="flex-1">
                  <strong class="text-[14px]">Catalogue</strong>
                  <div class="text-[11.5px] text-[#5a6662]">Draft changes stay hidden until published.</div>
                </div>
                <button onclick={() => { uiAsk({ title: 'Delete all products?', msg: 'This permanently removes all products and their images.', ok: 'Delete all', danger: true }).then((ok) => { if (ok) doPurgeProducts(store.products.map((p) => p.id)); }); }}
                        class="px-2.5 py-1.5 text-[12.5px] font-bold text-[#b23a2f] border border-[#f0d6d2] rounded-[10px] bg-white">Delete all</button>
                <button onclick={() => openProductEditor(null)} class="px-2.5 py-1.5 text-[12.5px] font-bold text-white rounded-[10px]" style="background:linear-gradient(180deg,#27806a,#1b5e4d)">New product</button>
              </div>
              <input type="text" placeholder="Search products…" class="w-full px-3 py-2 border border-[#e3e7e4] rounded-[10px] text-[13.5px] outline-none" />
            </div>
            {#each store.categories as c (c.id)}
              {@const list = store.products.filter((p) => p.categoryId === c.id)}
              <div class="bg-white border border-[#e0e7e3] rounded-2xl mb-3 overflow-hidden">
                <div class="flex items-center gap-2 px-3.5 py-2.5 bg-[#f8f9f8]">
                  <strong class="flex-1 text-[13.5px]">{c.name}</strong>
                  <span class="text-[11.5px] text-[#5a6662]">{list.length} product{list.length === 1 ? '' : 's'}</span>
                </div>
                <div class="px-3.5 py-1">
                  {#if !list.length}
                    <div class="text-[#5a6662] text-[12.5px] py-3">No products in this category.</div>
                  {:else}
                    {#each list as p (p.id)}
                      {@const isLive = p.published === true}
                      {@const hasDraft = !!p.draft}
                      {@const imgs = productImages(p.draft ? p.draft : p)}
                      <div class="flex items-center gap-3 py-2.5 border-b border-[#e3e7e4] last:border-0">
                        <div class="w-11 h-11 rounded-[10px] bg-[#f2f4f2] grid place-items-center overflow-hidden flex-none relative">
                          {#await imageSrc(imgs[0]) then src}
                            {#if src}<img src={src} alt={p.name} class="max-w-[80%] max-h-[80%] object-contain" />{:else}<span class="opacity-40">·</span>{/if}
                          {/await}
                          {#if imgs.length > 1}
                            <span class="absolute bottom-0 right-0 text-[9px] font-bold bg-[#1f6b57] text-white rounded-full px-1">{imgs.length}</span>
                          {/if}
                        </div>
                        <div class="flex-1 min-w-0">
                          <div class="text-[13px] font-semibold leading-tight truncate">{p.name}{#if hasDraft} <span class="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-[#fdf1dc] text-[#a5731a]">edited</span>{/if}</div>
                          <div class="text-[11.5px] text-[#5a6662] mt-0.5">{p.brand || ''} · {fmt(p.price)}</div>
                        </div>
                        <div class="flex flex-col gap-1 items-end flex-none">
                          <span class="text-[10.5px] font-extrabold px-1.5 py-0.5 rounded uppercase {isLive ? (p.enabled === false ? 'bg-[#f2f4f2] text-[#77817d]' : 'bg-[#e3f2ec] text-[#1f6b57]') : 'bg-[#fdf1dc] text-[#a5731a]'}">{isLive ? (p.enabled === false ? 'Disabled' : 'Live') : 'Draft'}</span>
                          <div class="flex items-center gap-1">
                            <button onclick={() => openProductEditor(p.id)} class="px-2 py-1 text-[11.5px] font-bold border border-[#e3e7e4] rounded-[8px] bg-white">Edit</button>
                            {#if isLive}
                              <button onclick={() => toggleProduct(p.id)} class="px-2 py-1 text-[11.5px] font-bold border border-[#e3e7e4] rounded-[8px] bg-white">{p.enabled === false ? 'Enable' : 'Disable'}</button>
                            {/if}
                            <button onclick={() => deleteProduct(p.id)} class="px-2 py-1 text-[11.5px] font-bold border border-[#f0d6d2] rounded-[8px] bg-white text-[#b23a2f]">Delete</button>
                          </div>
                        </div>
                      </div>
                    {/each}
                  {/if}
                </div>
              </div>
            {/each}
          {:else if adminTab === 'categories'}
            <div class="bg-white border border-[#e0e7e3] rounded-2xl p-3.5 mb-3">
              <strong class="text-[14px]">Categories</strong>
              <div class="text-[11.5px] text-[#5a6662]">Changes propagate to search and shelf allocation.</div>
            </div>
            <div class="bg-white border border-[#e0e7e3] rounded-2xl p-3.5 mb-3">
              {#each store.categories as c, i (c.id)}
                <div class="flex items-center gap-2 py-2 border-b border-[#e3e7e4] last:border-0">
                  <input type="text" value={c.name} class="flex-1 px-3 py-1.5 border border-[#e3e7e4] rounded-[8px] text-[13px]"
                         onchange={(e) => { c.name = e.target.value.trim() || c.name; saveStore();  }} />
                  <button onclick={() => { if (i === 0) return; const arr = store.categories; [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; saveStore();  }} disabled={i === 0} class="px-2 py-1.5 text-[12px] font-bold border border-[#e3e7e4] rounded-[8px] bg-white disabled:opacity-40">↑</button>
                  <button onclick={() => { if (i === store.categories.length - 1) return; const arr = store.categories; [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]]; saveStore();  }} disabled={i === store.categories.length - 1} class="px-2 py-1.5 text-[12px] font-bold border border-[#e3e7e4] rounded-[8px] bg-white disabled:opacity-40">↓</button>
                  <button onclick={() => { uiAsk({ title: `Delete "${c.name}"?`, msg: 'Products in this category must be reassigned first.', ok: 'Delete category', danger: true }).then((ok) => { if (!ok) return; const affected = store.products.filter((p) => p.categoryId === c.id); if (affected.length) { toast('Reassign products first'); return; } store.categories = store.categories.filter((x) => x.id !== c.id); delete store.layout.assignments[c.id]; saveStore();  }); }} class="px-2 py-1.5 text-[12px] font-bold border border-[#f0d6d2] rounded-[8px] bg-white text-[#b23a2f]">Delete</button>
                </div>
              {/each}
            </div>
            <div class="bg-white border border-[#e0e7e3] rounded-2xl p-3.5">
              <div class="flex gap-2">
                <input id="newCatName" type="text" placeholder="New category name" class="flex-1 px-3 py-2 border border-[#e3e7e4] rounded-[10px] text-[13.5px] outline-none" />
                <button onclick={() => { const inp = document.getElementById('newCatName'); const name = (inp?.value || '').trim(); if (!name) return; store.categories.push({ id: uid('cat'), name }); inp.value = ''; saveStore();  }} class="px-3 py-1.5 text-[12.5px] font-bold text-white rounded-[10px]" style="background:linear-gradient(180deg,#27806a,#1b5e4d)">Add</button>
              </div>
            </div>
          {:else if adminTab === 'layout'}
            {@const N = store.layout.aisleCount}
            <div class="bg-white border border-[#e0e7e3] rounded-2xl p-3.5 mb-3">
              <strong class="text-[14px]">Store layout</strong>
              <div class="text-[11.5px] text-[#5a6662]">The layout adapts to the published catalogue.</div>
            </div>
            <div class="bg-white border border-[#e0e7e3] rounded-2xl p-3.5 mb-3">
              <label class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">Number of aisles</label>
              <input id="layAisles" type="number" min="1" max="6" value={N} class="w-full px-3 py-2.5 border border-[#e3e7e4] rounded-[11px] text-[14.5px] outline-none" />
              <div class="mt-3">
                <label class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">Category → aisle</label>
                {#each store.categories as c, i (c.id)}
                  {@const cur = Number.isInteger(store.layout.assignments[c.id]) ? store.layout.assignments[c.id] : (i % N)}
                  <div class="flex items-center gap-2 mb-1.5">
                    <span class="text-[11.5px] text-[#5a6662] w-24">{c.name}</span>
                    <select class="flex-1 px-2 py-1.5 border border-[#e3e7e4] rounded-[8px] text-[13px]" onchange={(e) => { store.layout.assignments[c.id] = Number(e.target.value); saveStore();  }}>
                      {#each Array.from({ length: Math.max(N, 6) }, (_, i) => i) as a}
                        <option value={a} selected={a === cur}>Aisle {a + 1}</option>
                      {/each}
                    </select>
                  </div>
                {/each}
              </div>
              <div class="flex gap-2 mt-3">
                <button onclick={() => { const inp = document.getElementById('layAisles'); const nn = clamp(Number(inp?.value) || 3, 1, 6); store.layout.aisleCount = nn; saveStore();  toast('Layout applied'); }} class="px-3 py-1.5 text-[12.5px] font-bold text-white rounded-[10px]" style="background:linear-gradient(180deg,#27806a,#1b5e4d)">Apply layout</button>
                <button onclick={() => { store.layout = defaultState().layout; saveStore();  toast('Default layout restored'); }} class="px-3 py-1.5 text-[12.5px] font-bold border border-[#e3e7e4] rounded-[10px] bg-white">Restore default</button>
              </div>
            </div>
          {:else if adminTab === 'banners'}
            <div class="bg-white border border-[#e0e7e3] rounded-2xl p-3.5 mb-3">
              <div class="flex items-center gap-2 mb-2.5">
                <div class="flex-1"><strong class="text-[14px]">In-store banners</strong><div class="text-[11.5px] text-[#5a6662]">A new weighted arrangement is generated each trip.</div></div>
                <button onclick={() => { uiAsk({ title: 'Delete all banners?', msg: 'This removes all banners.', ok: 'Delete all', danger: true }).then((ok) => { if (!ok) return; store.banners = []; saveStore();   }); }} class="px-2.5 py-1.5 text-[12.5px] font-bold text-[#b23a2f] border border-[#f0d6d2] rounded-[10px] bg-white">Delete all</button>
                <button onclick={() => openBannerEditor(null)} class="px-2.5 py-1.5 text-[12.5px] font-bold text-white rounded-[10px]" style="background:linear-gradient(180deg,#27806a,#1b5e4d)">New banner</button>
              </div>
            </div>
            <div class="bg-white border border-[#e0e7e3] rounded-2xl p-3.5">
              {#if !store.banners.length}
                <div class="text-[#5a6662] text-[13.5px] text-center py-7">No banners yet.</div>
              {:else}
                {#each store.banners as b (b.id)}
                  {@const live = b.published !== false && b.enabled !== false}
                  <div class="flex items-center gap-3 py-2.5 border-b border-[#e3e7e4] last:border-0">
                    <div class="w-11 h-11 rounded-[10px] bg-[#f2f4f2] grid place-items-center overflow-hidden flex-none">
                      {#await imageSrc(b.image) then src}
                        {#if src}<img src={src} alt={b.name} class="max-w-full max-h-full object-cover" />{:else}<ImageSquare size={20} class="opacity-50" />{/if}
                      {/await}
                    </div>
                    <div class="flex-1 min-w-0">
                      <div class="text-[13px] font-semibold leading-tight truncate">{b.name}</div>
                      <div class="text-[11.5px] text-[#5a6662] mt-0.5">{b.headline || ''} · priority {b.priority || 1}</div>
                    </div>
                    <div class="flex flex-col gap-1 items-end flex-none">
                      <span class="text-[10.5px] font-extrabold px-1.5 py-0.5 rounded uppercase {live ? 'bg-[#e3f2ec] text-[#1f6b57]' : 'bg-[#f2f4f2] text-[#77817d]'}">{live ? 'Live' : 'Off'}</span>
                      <div class="flex items-center gap-1">
                        <button onclick={() => openBannerEditor(b.id)} class="px-2 py-1 text-[11.5px] font-bold border border-[#e3e7e4] rounded-[8px] bg-white">Edit</button>
                        <button onclick={() => toggleBanner(b.id)} class="px-2 py-1 text-[11.5px] font-bold border border-[#e3e7e4] rounded-[8px] bg-white">{b.enabled === false ? 'Enable' : 'Disable'}</button>
                        <button onclick={() => deleteBanner(b.id)} class="px-2 py-1 text-[11.5px] font-bold border border-[#f0d6d2] rounded-[8px] bg-white text-[#b23a2f]">Delete</button>
                      </div>
                    </div>
                  </div>
                {/each}
              {/if}
            </div>
          {:else if adminTab === 'ai'}
            <div class="bg-white border border-[#e0e7e3] rounded-2xl p-3.5 mb-3">
              <div class="flex items-center gap-2 flex-wrap">
                <div class="flex-1 min-w-[180px]"><strong class="text-[14px]">AI shoppers</strong><div class="text-[11.5px] text-[#5a6662]">The simulated customers who walk the aisles, pick products and check out. Changes apply the next time someone enters the store.</div></div>
              </div>
              <div class="flex flex-col gap-2.5 mt-3.5">
                <label class="flex items-center gap-2.5 text-[13.5px] font-semibold">
                  <input type="checkbox" checked={store.ai.enabled} onchange={(e) => { store.ai.enabled = e.target.checked; saveStore(); }} />
                  Enable AI shoppers
                </label>
                <label class="flex items-center gap-2.5 text-[13.5px] font-semibold">
                  <input type="checkbox" checked={store.ai.showTags} onchange={(e) => { store.ai.showTags = e.target.checked; saveStore(); }} />
                  Show name tags above carts
                </label>
              </div>
            </div>

            <div class="bg-white border border-[#e0e7e3] rounded-2xl p-3.5 mb-3">
              <strong class="text-[14px]">Behaviour</strong>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3 mt-3">
                {#each [
                  { k: 'maxShoppers', label: 'Max shoppers at once', lo: 1, hi: 8, step: 1, int: true, hint: 'Phones that run slowly are capped at 2 automatically.' },
                  { k: 'walkSpeed', label: 'Walk speed', lo: 0.3, hi: 3, step: 0.05, int: false, hint: 'Metres per second. Default 1.25.' },
                  { k: 'spawnMin', label: 'Shortest wait between shoppers (s)', lo: 1, hi: 120, step: 1, int: false, hint: 'Default 6.' },
                  { k: 'spawnMax', label: 'Longest wait between shoppers (s)', lo: 1, hi: 120, step: 1, int: false, hint: 'Default 14.' },
                  { k: 'maxAisles', label: 'Max aisles per trip', lo: 1, hi: 6, step: 1, int: true, hint: 'Each shopper visits 1 to this many aisles.' },
                  { k: 'maxItemsPerAisle', label: 'Max items per aisle', lo: 1, hi: 8, step: 1, int: true, hint: 'Each shopper picks 1 to this many items per aisle.' },
                  { k: 'maxShopTime', label: 'Max time in store (s)', lo: 20, hi: 900, step: 5, int: true, hint: 'After this a shopper heads to checkout.' }
                ] as f}
                  <div>
                    <label class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">{f.label}</label>
                    <input type="number" min={f.lo} max={f.hi} step={f.step} value={store.ai[f.k]}
                           onchange={(e) => aiSetNum(f.k, e.target.value, f.lo, f.hi, f.int, e.target)}
                           class="w-full px-3 py-2 border border-[#e3e7e4] rounded-[10px] text-[13.5px] outline-none focus:border-[#1f6b57]" />
                    <div class="text-[11px] text-[#5a6662] mt-1">{f.hint}</div>
                  </div>
                {/each}
              </div>
            </div>

            <div class="bg-white border border-[#e0e7e3] rounded-2xl p-3.5 mb-3">
              <div class="flex items-center gap-2">
                <div class="flex-1"><strong class="text-[14px]">Shopper names</strong><div class="text-[11.5px] text-[#5a6662]">Shown on the tag above each cart. {store.ai.names.length} name{store.ai.names.length === 1 ? '' : 's'}. Use up to 20 characters. Add as many as you like, and each active shopper gets a different one.</div></div>
                <button onclick={() => { store.ai.names = AI_DEFAULT_NAMES.slice(); saveStore(); }} class="px-2.5 py-1.5 text-[12.5px] font-bold border border-[#e3e7e4] rounded-[10px] bg-white">Defaults</button>
              </div>
              <div class="flex flex-wrap gap-1.5 mt-3">
                {#each store.ai.names as nm, i (nm + '|' + i)}
                  <span class="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full bg-[#eef6f2] border border-[#d5e6dd] text-[12.5px] font-semibold">
                    {nm}
                    <button onclick={() => aiRemoveName(i)} aria-label="Remove name" class="w-5 h-5 rounded-full grid place-items-center text-[#5a6662] hover:bg-white"><X size={11} /></button>
                  </span>
                {/each}
                {#if !store.ai.names.length}<span class="text-[12.5px] text-[#5a6662]">No names yet, so the default names are used.</span>{/if}
              </div>
              <div class="flex gap-2 mt-3">
                <input id="aiNewName" type="text" maxlength="20" placeholder="@new_name" class="w-full px-3 py-2 border border-[#e3e7e4] rounded-[10px] text-[13.5px] outline-none focus:border-[#1f6b57]"
                       onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); aiAddName(e.target); } }} />
                <button onclick={() => aiAddName(document.getElementById('aiNewName'))} class="px-2.5 py-1.5 text-[12.5px] font-bold text-white rounded-[10px]" style="background:linear-gradient(180deg,#27806a,#1b5e4d)">Add</button>
              </div>
            </div>

            <div class="bg-white border border-[#e0e7e3] rounded-2xl p-3.5 mb-3">
              <div class="flex items-center gap-2">
                <div class="flex-1"><strong class="text-[14px]">Cart colours</strong><div class="text-[11.5px] text-[#5a6662]">Each shopper gets a random colour from this list. Tap a swatch to change it.</div></div>
                <button onclick={() => { store.ai.cartColors = AI_DEFAULT_COLORS.slice(); saveStore(); }} class="px-2.5 py-1.5 text-[12.5px] font-bold border border-[#e3e7e4] rounded-[10px] bg-white">Defaults</button>
              </div>
              <div class="flex flex-wrap gap-2 mt-3">
                {#each store.ai.cartColors as col, i (col + '|' + i)}
                  <div class="relative">
                    <input type="color" value={col} onchange={(e) => aiSetColor(i, e.target.value)} class="w-10 h-10 p-0 border border-[#e3e7e4] rounded-[10px] bg-white cursor-pointer" />
                    <button onclick={() => aiRemoveColor(i)} aria-label="Remove colour" class="absolute -top-1.5 -right-1.5 w-[18px] h-[18px] rounded-full bg-[#14181a] text-white grid place-items-center"><X size={10} /></button>
                  </div>
                {/each}
                {#if !store.ai.cartColors.length}<span class="text-[12.5px] text-[#5a6662]">No colours yet, so the default colours are used.</span>{/if}
              </div>
              <div class="flex gap-2 mt-3 items-center">
                <input id="aiNewColor" type="color" value="#e4572e" class="w-10 h-10 p-0 border border-[#e3e7e4] rounded-[10px] bg-white cursor-pointer" />
                <button onclick={() => aiAddColor(document.getElementById('aiNewColor')?.value)} class="px-2.5 py-1.5 text-[12.5px] font-bold text-white rounded-[10px]" style="background:linear-gradient(180deg,#27806a,#1b5e4d)">Add colour</button>
              </div>
            </div>

            <div class="bg-white border border-[#e0e7e3] rounded-2xl p-3.5 mb-3">
              <div class="flex items-center gap-2">
                <div class="flex-1"><strong class="text-[14px]">Shopper profiles</strong><div class="text-[11.5px] text-[#5a6662]">Make your own shopper types. Each new shopper picks a profile. A higher weight means that profile appears more often.</div></div>
                <button onclick={aiAddProfile} class="px-2.5 py-1.5 text-[12.5px] font-bold text-white rounded-[10px]" style="background:linear-gradient(180deg,#27806a,#1b5e4d)">Add profile</button>
              </div>
              {#each store.ai.profiles as p, i (p.id)}
                <div class="border border-[#e3e7e4] rounded-[12px] p-3 mt-3">
                  <div class="flex gap-2 items-center">
                    <input type="text" value={p.label} maxlength="30" class="w-full px-3 py-2 border border-[#e3e7e4] rounded-[10px] text-[13.5px] outline-none focus:border-[#1f6b57]" onchange={(e) => { p.label = e.target.value.trim() || 'Shopper'; saveStore(); }} />
                    <button onclick={() => aiRemoveProfile(i)} class="px-2 py-1.5 text-[12px] font-bold border border-[#f0d6d2] rounded-[8px] bg-white text-[#b23a2f]">Delete</button>
                  </div>
                  <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
                    <div>
                      <label class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">Speed ×</label>
                      <input type="number" min="0.3" max="3" step="0.1" value={p.speed} onchange={(e) => aiSetProfile(p, 'speed', e.target.value, 0.3, 3, false, e.target)} class="w-full px-3 py-2 border border-[#e3e7e4] rounded-[10px] text-[13.5px] outline-none focus:border-[#1f6b57]" />
                    </div>
                    <div>
                      <label class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">Items / aisle</label>
                      <input type="number" min="0" max="8" step="1" value={p.maxItems} onchange={(e) => aiSetProfile(p, 'maxItems', e.target.value, 0, 8, true, e.target)} class="w-full px-3 py-2 border border-[#e3e7e4] rounded-[10px] text-[13.5px] outline-none focus:border-[#1f6b57]" />
                      <div class="text-[11px] text-[#5a6662] mt-1">0 = use the global value</div>
                    </div>
                    <div>
                      <label class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">Weight</label>
                      <input type="number" min="1" max="10" step="1" value={p.weight} onchange={(e) => aiSetProfile(p, 'weight', e.target.value, 1, 10, true, e.target)} class="w-full px-3 py-2 border border-[#e3e7e4] rounded-[10px] text-[13.5px] outline-none focus:border-[#1f6b57]" />
                    </div>
                    <div>
                      <label class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">Cart colour</label>
                      <div class="flex items-center gap-2">
                        {#if p.color}
                          <input type="color" value={p.color} onchange={(e) => { p.color = e.target.value; saveStore(); }} class="w-10 h-10 p-0 border border-[#e3e7e4] rounded-[10px] bg-white cursor-pointer" />
                          <button onclick={() => { p.color = ''; saveStore(); }} class="px-2.5 py-1.5 text-[12.5px] font-bold border border-[#e3e7e4] rounded-[10px] bg-white">Random</button>
                        {:else}
                          <button onclick={() => { p.color = store.ai.cartColors[0] || '#1f6b57'; saveStore(); }} class="px-2.5 py-1.5 text-[12.5px] font-bold border border-[#e3e7e4] rounded-[10px] bg-white">Set colour</button>
                          <span class="text-[11.5px] text-[#5a6662]">Random</span>
                        {/if}
                      </div>
                    </div>
                  </div>
                </div>
              {/each}
            </div>

            <div class="bg-white border border-[#e0e7e3] rounded-2xl p-3.5">
              <strong class="text-[14px]">Reset</strong>
              <div class="text-[11.5px] text-[#5a6662] mb-3">Restore every AI setting, name, colour and profile to the defaults.</div>
              <button onclick={aiResetAll} class="px-2.5 py-1.5 text-[12.5px] font-bold text-[#b23a2f] border border-[#f0d6d2] rounded-[10px] bg-white">Reset AI settings</button>
            </div>
          {:else if adminTab === 'promo'}
            <div class="bg-white border border-[#e0e7e3] rounded-2xl p-3.5 mb-3">
              <strong class="text-[14px]">Post-checkout promotion</strong>
              <div class="text-[11.5px] text-[#5a6662]">Shown beneath the receipt. Opens in a new tab.</div>
            </div>
            <div class="bg-white border border-[#e0e7e3] rounded-2xl p-3.5">
              <div class="mb-3"><label class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">Message</label><textarea id="promoMsg" class="w-full px-3 py-2.5 border border-[#e3e7e4] rounded-[11px] text-[14.5px] outline-none min-h-[70px]">{store.promo.message || ''}</textarea></div>
              <div class="mb-3"><label class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">Button label</label><input id="promoLabel" type="text" value={store.promo.label || 'Play Game'} class="w-full px-3 py-2.5 border border-[#e3e7e4] rounded-[11px] text-[14.5px] outline-none" /></div>
              <div class="mb-3"><label class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">Destination URL</label><input id="promoUrl" type="text" placeholder="https://…" value={store.promo.url || ''} class="w-full px-3 py-2.5 border border-[#e3e7e4] rounded-[11px] text-[14.5px] outline-none" /></div>
              <div class="mb-3"><label class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">Visible</label><select id="promoEnabled" class="w-full px-3 py-2.5 border border-[#e3e7e4] rounded-[11px] text-[14.5px] outline-none"><option value="1" selected={store.promo.enabled !== false}>Enabled</option><option value="0" selected={store.promo.enabled === false}>Disabled</option></select></div>
              <button onclick={() => { const url = (document.getElementById('promoUrl')?.value || '').trim(); if (url && !safeUrl(url)) { toast('URL must be http(s)'); return; } store.promo = { enabled: document.getElementById('promoEnabled')?.value === '1', message: (document.getElementById('promoMsg')?.value || '').trim(), label: (document.getElementById('promoLabel')?.value || 'Play Game').trim(), url }; saveStore(); toast('Promotion saved'); }} class="w-full rounded-xl px-4 py-3 text-[14.5px] font-bold text-white" style="background:linear-gradient(180deg,#27806a,#1b5e4d)">Save promotion</button>
            </div>
          {:else if adminTab === 'backup'}
            <div class="bg-white border border-[#e0e7e3] rounded-2xl p-3.5 mb-3">
              <strong class="text-[14px]">Backup</strong>
              <div class="text-[11.5px] text-[#5a6662]">Export everything (catalogue, layout, banners, uploaded images) to a JSON file.</div>
              <div class="flex flex-col gap-2.5 mt-3">
                <button onclick={exportBackup} class="w-full rounded-xl px-4 py-3 text-[14.5px] font-bold text-white" style="background:linear-gradient(180deg,#27806a,#1b5e4d)">Export backup</button>
                <button onclick={importBackup} class="w-full rounded-xl border border-[#e3e7e4] bg-white px-4 py-2.5 text-[14px] font-semibold text-[#14181a]">Import backup</button>
              </div>
            </div>
            <div class="bg-white border border-[#e0e7e3] rounded-2xl p-3.5">
              <strong class="text-[14px]">Prototype limitations</strong>
              <div class="text-[11.5px] text-[#5a6662] mt-1.5">This admin panel is not protected by real authentication. Browser storage is local to this device and is not a shared database. Client-side prices and checkout are not authoritative for real transactions — a production build needs a backend, server-side validation and a real payment provider.</div>
            </div>
          {/if}
        </div>
      </main>
    </div>
  </div>


<!-- ============ TOAST ============ -->
{#if toastText}
  <div class="fixed left-1/2 bottom-[calc(env(safe-area-inset-bottom,0px)+160px)] -translate-x-1/2 z-[80] border border-[#7ee0b8]/35 bg-[#0e1c18]/95 text-white text-[13px] font-semibold px-4 py-2.5 rounded-full backdrop-blur-md max-w-[82vw] text-center flex items-center gap-2">
    <span class="w-2 h-2 rounded-full bg-[#7ee0b8] flex-none"></span>
    <span>{toastText}</span>
  </div>
{/if}

<!-- ============ DIALOG ============ -->
{#if dialogState}
  <div class="fixed inset-0 z-[220] flex items-center justify-center bg-[#090c0c]/45 backdrop-blur-sm p-4" onclick={() => closeDialog(dialogState.input != null ? null : false)}>
    <div class="w-full max-w-[420px] bg-white rounded-[20px] p-[18px]" onclick={(e) => e.stopPropagation()}>
      <h2 class="text-[18px] m-0 font-bold" style="font-family:'Bricolage Grotesque',sans-serif">{dialogState.title}</h2>
      {#if dialogState.msg}<p class="text-[13.5px] text-[#5a6662] mt-1.5 mb-3.5 leading-relaxed">{dialogState.msg}</p>{/if}
      {#if dialogState.input != null}<input id="dlgIn" type="text" placeholder={dialogState.input} class="w-full px-3 py-2.5 border border-[#e3e7e4] rounded-[11px] text-[14.5px] outline-none focus:border-[#1f6b57]" />{/if}
      <div class="flex justify-end gap-2 mt-3.5">
        <button onclick={() => closeDialog(dialogState.input != null ? null : false)} class="px-3 py-1.5 text-[12.5px] font-bold border border-[#e3e7e4] rounded-[10px] bg-white">Cancel</button>
        <button onclick={() => { const v = dialogState.input != null ? (document.getElementById('dlgIn')?.value || '').trim() : true; closeDialog(v); }} class="px-3 py-1.5 text-[12.5px] font-bold text-white rounded-[10px]" style="background:{dialogState.danger ? '#b23a2f' : 'linear-gradient(180deg,#27806a,#1b5e4d)'}">{dialogState.ok || 'Confirm'}</button>
      </div>
    </div>
  </div>
{/if}