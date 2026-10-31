<!-- src/routes/+page.svelte  (the 3D store) -->
<script>
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import * as THREE from 'three';
  import { MagnifyingGlass, X, SpeakerSlash, SpeakerHigh, Plus, Minus, GameController, CaretLeft, CaretRight, CheckCircle } from 'phosphor-svelte';
  import {
    AI_DEFAULT_COLORS,
    AI_DEFAULT_NAMES,
    K_SESSION,
    K_TUT,
    LEVELS,
    LS,
    SLOTS,
    clamp,
    defaultState,
    fmt,
    imageKey,
    imageSrc,
    loadCart,
    loadStore,
    productImages,
    safeUrl,
    saveCartData,
    uid
  } from '#lib/breathe.js';
    import { div } from 'three/tsl';
    import { supabase } from '#lib/supabase.js';

  /* =========================================================
     CONSTANTS
     ========================================================= */
  const SHELF_LEN = 12;
  const SHELF_Z0 = -9;
  const SHELF_DEPTH = 0.55;
  const CORRIDOR_HALF = 1.5;
  const AISLE_SPACING = 4.6;
  const CAP_PER_AISLE = 2 * LEVELS.length * SLOTS;
  const PRODUCT_TEX_W = 640;
  const PRODUCT_TEX_H = 640;
  const CFG = { eyeHeight: 1.6, radius: 0.34, walkSpeed: 2.5, lookSens: 0.0032 };

  const TUT_STEPS = [
    { icon: '🕹️', title: 'Joystick = look + move', text: 'Push left/right to turn, up/down to walk forward or backward.' },
    { icon: '👆', title: 'Swipe to look', text: 'Swipe the view to look up and down. Swipes never trigger taps.' },
    { icon: '🛒', title: 'Tap products', text: 'Products face you on the shelves. Tap one to open its card.' },
    { icon: '➕', title: 'Add to cart', text: 'Choose quantity and add. Items drop into your basket.' },
    { icon: '💳', title: 'Check out', text: 'Tap the cart top-right when ready. Payment is simulated.' }
  ];

  /* =========================================================
     UTILITIES
     ========================================================= */
  /* Wait (briefly) for a texture's image to finish loading. */
  function whenTextureReady(image, cb) {
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      const t = getTexture(image);
      if (t?.image?.width) { clearInterval(iv); cb(); }
      else if (!t && tries > 2) { clearInterval(iv); }
      else if (tries > 80) { clearInterval(iv); }
    }, 150);
  }

  /* The catalogue normally arrives from +page.js. If it is missing or malformed, the page
     loads it itself in onMount, so the 3D scene never starts with an undefined store. */
  const validStore = (s) => !!(s && s.layout && Array.isArray(s.products) && Array.isArray(s.categories) && Array.isArray(s.banners));
  let { data } = $props();
  let loadError = $state('');
  // svelte-ignore state_referenced_locally
  let store = $state(validStore(data?.store) ? data.store : defaultState());
  let cart = $state(loadCart());
  let mode = $state('welcome');
  let activeSheet = $state(null);
  let toastText = $state('');
  let searchQuery = $state('');
  let searchCategory = $state('all');
  let cardProductId = $state(null);
  let cardQty = $state(1);
  let cardImageIndex = $state(0);
  let tutorialStep = $state(0);
  let threeReady = $state(false);
  let aimProductId = $state(null);
  let aimProductLabel = $state('');
  let pendingOrder = $state(null);
  let searchResults = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    return store.products
      .filter((p) => p.published && p.enabled !== false)
      .filter((p) => {
        if (searchCategory !== 'all' && p.categoryId !== searchCategory) return false;
        if (!q) return true;
        const cat = store.categories.find((c) => c.id === p.categoryId);
        return (p.name + ' ' + (p.brand || '') + ' ' + (cat?.name || '')).toLowerCase().includes(q);
      })
      .slice(0, 40);
  });
  let cartCount = $derived(cart.lines.reduce((s, l) => s + l.qty, 0));
  let cartTotal = $derived(cart.lines.reduce((s, l) => s + l.price * l.qty, 0));
  let publishedProducts = $derived(store.products.filter((p) => p.published && p.enabled !== false));
  let cardImages = $derived.by(() => {
    if (!cardProductId) return [];
    const p = store.products.find((x) => x.id === cardProductId);
    return p ? productImages(p) : [];
  });

  /* =========================================================
     NON-REACTIVE THREE.JS STATE
     ========================================================= */
  let canvasEl;
  let renderer, scene, camera;
  let worldGroup, fixtureGroup, productGroup, bannerGroup, npcGroup, cartGroup, basketItemsGroup;
  let raycaster = new THREE.Raycaster();
  let ndc = new THREE.Vector2();
  let geoCache = new Map();
  let matCache = new Map();
  let texCache = new Map();
  let roomHalfX = 9, roomHalfZ = 13;
  let placementMap = new Map();
  let productMeshes = [];
  let bannerMeshes = [];
  let shelfCarousels = [];
  let colliders = [];
  let bannerArrangement = [];
  let player = { pos: new THREE.Vector3(0, 0, 9.8), yaw: 0, pitch: 0, vx: 0, vz: 0, moving: 0 };
  let keys = {};
  let joyVec = { x: 0, y: 0 };
  let joyPointer = null;
  let lookId = null;
  let lookLast = { x: 0, y: 0 };
  let lookStart = { x: 0, y: 0, t: 0 };
  let lookMoved = 0;
  let walkPhase = 0, bumpCd = 0, stun = 0, camKick = 0, rumbleAmp = 0, lurch = 0;
  let blockedX = false, blockedZ = false;
  let basketPhysics = [];
  let prevFwdV = 0, prevSideV = 0;
  let cartOpen = false;
  let npcList = [], flights = [], wobbles = [];
  let npcSpawnTimer = 1.5;
  let _floorTex = null;
  let lastT = performance.now();
  let frameTimes = [];
  let aimTimer = 0;
  let rafId = null;
  let uiLock = $derived(activeSheet !== null);
  let currentDPR = 1, maxDPR = 1;

  let handleCursor = Math.floor(Math.random() * 64);

  const progress = $state({
    text: 'Starting off',
    perc: 0
  })

  /* The catalogue is saved by the admin only. Orders will move to their own tables later. */
  function saveStore() {}
  function saveCartState() { saveCartData($state.snapshot(cart)); }
  function saveSession() { if (player) LS.set(K_SESSION, { x: player.pos.x, z: player.pos.z, yaw: player.yaw, pitch: player.pitch }); }

  /* =========================================================
     SHARED THREE.JS HELPERS
     ========================================================= */
  function sharedMat(color, opts) {
    const key = 'sm|' + color + '|' + JSON.stringify(opts || {});
    if (matCache.has(key)) return matCache.get(key);
    const m = new THREE.MeshLambertMaterial(Object.assign({ color }, opts || {}));
    m.userData.shared = true;
    matCache.set(key, m);
    return m;
  }

  function getTexture(image) {
    if (!image || image.kind === 'none') return null;
    const key = imageKey(image);
    if (texCache.has(key)) return texCache.get(key);
    const src = image.url;
    if (!src) { texCache.set(key, null); return null; }
    let tex = null;
    try {
      const loader = new THREE.TextureLoader();
      loader.setCrossOrigin('anonymous');
      tex = loader.load(src, undefined, undefined, () => { texCache.set(key, null); });
      tex.encoding = THREE.sRGBEncoding;
    } catch { tex = null; }
    texCache.set(key, tex);
    return tex;
  }

  function drawImageCover(ctx, img, cw, ch) {
    const ir = img.width / Math.max(1, img.height);
    const cr = cw / ch;
    let dw, dh, dx, dy;
    if (ir > cr) { dh = ch; dw = ch * ir; dx = (cw - dw) / 2; dy = 0; }
    else { dw = cw; dh = cw / ir; dx = 0; dy = (ch - dh) / 2; }
    ctx.drawImage(img, dx, dy, dw, dh);
  }

  function makeProductLabelTexture(p) {
    const c = document.createElement('canvas');
    c.width = PRODUCT_TEX_W; c.height = PRODUCT_TEX_H;
    const x = c.getContext('2d');
    x.fillStyle = p.color || '#cfd6d2'; x.fillRect(0, 0, PRODUCT_TEX_W, PRODUCT_TEX_H);
    x.fillStyle = 'rgba(255,255,255,0.92)'; x.fillRect(28, 140, PRODUCT_TEX_W - 56, 320);
    x.fillStyle = '#14181a'; x.font = '700 42px Helvetica,Arial,sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    const words = (p.name || 'Product').split(' ');
    const lines = []; let line = '';
    words.forEach((w) => {
      const test = line ? line + ' ' + w : w;
      if (x.measureText(test).width > PRODUCT_TEX_W - 80 && line) { lines.push(line); line = w; }
      else line = test;
    });
    if (line) lines.push(line);
    lines.slice(0, 3).forEach((ln, i) => x.fillText(ln, PRODUCT_TEX_W / 2, 260 + i * 48));
    if (p.brand) {
      x.font = '500 28px Helvetica,Arial,sans-serif'; x.fillStyle = '#5a6662';
      x.fillText(String(p.brand).slice(0, 18), PRODUCT_TEX_W / 2, 430);
    }
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; return t;
  }

  function makeProductCoverTexture(p, image, sourceTex) {
    const key = 'cover|' + p.id + '|' + imageKey(image);
    if (texCache.has(key) && texCache.get(key)) return texCache.get(key);
    const c = document.createElement('canvas');
    c.width = PRODUCT_TEX_W; c.height = PRODUCT_TEX_H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = p.color || '#e8ebe6'; ctx.fillRect(0, 0, PRODUCT_TEX_W, PRODUCT_TEX_H);
    const img = sourceTex?.image;
    if (!img || !img.width) return makeProductLabelTexture(p);
    try { drawImageCover(ctx, img, PRODUCT_TEX_W, PRODUCT_TEX_H); } catch { /* cross-origin */ }
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding;
    texCache.set(key, t);
    return t;
  }

  /* Update one live sprite to reflect the carousel's current image.
     Called once when a not-yet-loaded secondary image finishes decoding. */
  function refreshProductSprites(pid) {
    for (const c of shelfCarousels) {
      if (c.product.id !== pid) continue;
      if (c.anim) continue;
      const tex = getProductBillboardTexture(c.product, c.images[c.index]);
      c.mat.map = tex;
      c.mat.needsUpdate = true;
    }
  }

  /* Get the billboard texture for a product (optionally for a specific image).
     Handles async image decode by returning a label fallback and hooking a
     refresh call that updates the sprite without a full rebuild. */
  function getProductBillboardTexture(p, overrideImage) {
    const image = overrideImage || p.image || productImages(p)[0];
    if (!image || image.kind === 'none') {
      const key = 'labelfb|' + p.id + '|' + (p.color || '') + '|' + (p.name || '');
      if (texCache.has(key)) return texCache.get(key);
      const fb = makeProductLabelTexture(p);
      texCache.set(key, fb);
      return fb;
    }
    const src = getTexture(image);
    if (src?.image?.width) return makeProductCoverTexture(p, image, src);
    if (src && !src.userData?._coverHooked) {
      src.userData = src.userData || {};
      src.userData._coverHooked = true;
      const tryRefresh = () => {
        try {
          if (!(src.image?.width)) return;
          const ikey = imageKey(image);
          for (const key of [...texCache.keys()]) {
            const s = String(key);
            if (!s.startsWith('cover|' + p.id + '|')) continue;
            if (s.endsWith('|' + ikey)) texCache.delete(key);
          }
          refreshProductSprites(p.id);
        } catch { /* ignore */ }
      };
      try {
        if (src.image?.decode) src.image.decode().then(tryRefresh).catch(() => setTimeout(tryRefresh, 300));
        else setTimeout(tryRefresh, 400);
      } catch { setTimeout(tryRefresh, 400); }
    }
    const key = 'labelfb|' + p.id + '|' + (p.color || '') + '|' + (p.name || '');
    if (texCache.has(key)) return texCache.get(key);
    const fb = makeProductLabelTexture(p);
    texCache.set(key, fb);
    return fb;
  }

  /* =========================================================
     THREE.JS SETUP
     ========================================================= */
  function initThree() {
    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: (window.devicePixelRatio || 1) < 2, powerPreference: 'high-performance' });
    } catch { threeReady = false; return; }
    maxDPR = Math.min(window.devicePixelRatio || 1, 2);
    currentDPR = maxDPR;
    renderer.setPixelRatio(currentDPR);
    renderer.setClearColor(0xc8d4ce, 1);
    renderer.outputEncoding = THREE.sRGBEncoding;

    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0xc8d4ce, 24, 52);

    camera = new THREE.PerspectiveCamera(72, 1, 0.05, 120);
    camera.rotation.order = 'YXZ';
    scene.add(camera);

    scene.add(new THREE.HemisphereLight(0xfff5e8, 0x8fa89a, 0.85));
    const d1 = new THREE.DirectionalLight(0xfff0d8, 0.55); d1.position.set(8, 16, 6); scene.add(d1);
    const d2 = new THREE.DirectionalLight(0xd0e8ff, 0.28); d2.position.set(-10, 12, -6); scene.add(d2);
    const d3 = new THREE.DirectionalLight(0xffffff, 0.18); d3.position.set(0, 8, 14); scene.add(d3);

    worldGroup = new THREE.Group(); scene.add(worldGroup);
    fixtureGroup = new THREE.Group(); worldGroup.add(fixtureGroup);
    productGroup = new THREE.Group(); worldGroup.add(productGroup);
    bannerGroup = new THREE.Group(); worldGroup.add(bannerGroup);
    npcGroup = new THREE.Group(); scene.add(npcGroup);

    cartGroup = new THREE.Group(); camera.add(cartGroup);
    basketItemsGroup = new THREE.Group(); cartGroup.add(basketItemsGroup);
    buildCartModel();
    cartGroup.visible = false;

    buildDust();
    buildGrains();

    resize();
    buildStore();
    bindEvents();
    threeReady = true;
    rafId = requestAnimationFrame(loop);
  }

  function buildCartModel() {
    const metal = new THREE.MeshLambertMaterial({ color: 0xd3d9d5 }); metal.userData.shared = true;
    const dark = new THREE.MeshLambertMaterial({ color: 0x8f9a95 }); dark.userData.shared = true;
    const bottom = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.02, 0.5), metal); bottom.position.y = -0.14; cartGroup.add(bottom);
    const far = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.26, 0.02), metal); far.position.set(0, -0.02, -0.25); cartGroup.add(far);
    const left = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.26, 0.5), metal); left.position.set(-0.22, -0.02, 0); cartGroup.add(left);
    const right = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.26, 0.5), metal); right.position.set(0.22, -0.02, 0); cartGroup.add(right);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.05, 0.02), dark); rail.position.set(0, 0.08, 0.25); cartGroup.add(rail);
    const handleBar = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.42, 8), dark);
    handleBar.rotation.z = Math.PI / 2; handleBar.position.set(0, 0.26, 0.32); cartGroup.add(handleBar);
    cartGroup.position.set(0.19, -0.52, -0.92);
    cartGroup.rotation.x = -0.06;
  }

  /* =========================================================
     STORE BUILDING
     ========================================================= */
  function clearGroup(g) {
    g.traverse((o) => {
      if (o.geometry && !o.geometry.userData.shared) { try { o.geometry.dispose(); } catch { /* */ } }
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => { if (m && !m.userData.shared && m.dispose) { try { m.dispose(); } catch { /* */ } } });
      }
    });
    while (g.children.length) g.remove(g.children[0]);
  }

  function makeFloorTexture() {
    if (_floorTex) return _floorTex;
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const x = c.getContext('2d');
    x.fillStyle = '#c9bea8'; x.fillRect(0, 0, 128, 128);
    x.strokeStyle = '#a99d85'; x.lineWidth = 3; x.strokeRect(2, 2, 124, 124);
    x.fillStyle = 'rgba(255,255,255,0.08)'; x.fillRect(8, 8, 40, 40);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.encoding = THREE.sRGBEncoding;
    try { t.anisotropy = renderer.capabilities.getMaxAnisotropy(); } catch { /* */ }
    _floorTex = t;
    return t;
  }

  function makeSignTexture(lines) {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 200;
    const x = c.getContext('2d');
    x.fillStyle = '#14181a'; x.fillRect(0, 0, 512, 200);
    x.strokeStyle = 'rgba(255,255,255,.16)'; x.lineWidth = 4; x.strokeRect(6, 6, 500, 188);
    x.fillStyle = '#ffffff'; x.textAlign = 'center'; x.textBaseline = 'middle';
    const n = lines.length; const fs = n > 2 ? 42 : 52;
    x.font = '700 ' + fs + 'px Helvetica,Arial,sans-serif';
    lines.forEach((ln, i) => { const y = 100 + (i - (n - 1) / 2) * (fs + 8); x.fillText(ln, 256, y); });
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; return t;
  }

  function buildRoom() {
    const floorTex = makeFloorTexture();
    floorTex.repeat.set(Math.max(4, Math.round(roomHalfX / 1.2)), Math.max(6, Math.round(roomHalfZ / 1.2)));
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(roomHalfX * 2, roomHalfZ * 2), new THREE.MeshLambertMaterial({ map: floorTex }));
    floor.rotation.x = -Math.PI / 2; fixtureGroup.add(floor);
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(roomHalfX * 2, roomHalfZ * 2), sharedMat('#f0ebe3'));
    ceil.rotation.x = Math.PI / 2; ceil.position.y = 3.8; fixtureGroup.add(ceil);
    const panelMat = new THREE.MeshBasicMaterial({ color: 0xfff8ee }); panelMat.userData.shared = true;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.5), panelMat);
      p.rotation.x = Math.PI / 2;
      p.position.set(-roomHalfX * 0.55 + i * (roomHalfX * 0.55), 3.78, -9 + j * 6);
      fixtureGroup.add(p);
    }
    const wallMat = sharedMat('#dce6df');
    const t = 0.2;
    const mkWall = (w, h, d, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat); m.position.set(x, y, z); fixtureGroup.add(m); };
    mkWall(roomHalfX * 2, 3.8, t, 0, 1.9, -roomHalfZ);
    mkWall(t, 3.8, roomHalfZ * 2, -roomHalfX, 1.9, 0);
    mkWall(t, 3.8, roomHalfZ * 2, roomHalfX, 1.9, 0);
    mkWall(roomHalfX * 2, 3.8, t, 0, 1.9, roomHalfZ);
    const stripeMat = sharedMat('#1f6b57'), baseMat = sharedMat('#aebfb5');
    const trim = (w, h, d, x, y, z, m) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); fixtureGroup.add(b); };
    const tx = roomHalfX - 0.12, tz = roomHalfZ - 0.12;
    [[stripeMat, 0.14, 1.15], [baseMat, 0.16, 0.08]].forEach(([m, h, y]) => {
      trim(roomHalfX * 2 - 0.3, h, 0.05, 0, y, -tz, m); trim(roomHalfX * 2 - 0.3, h, 0.05, 0, y, tz, m);
      trim(0.05, h, roomHalfZ * 2 - 0.3, -tx, y, 0, m); trim(0.05, h, roomHalfZ * 2 - 0.3, tx, y, 0, m);
    });
    const mat = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.6), sharedMat('#cfd6d2'));
    mat.rotation.x = -Math.PI / 2; mat.position.set(0, 0.01, roomHalfZ - 1.6); fixtureGroup.add(mat);
  }

  function buildCheckout() {
    const sign = store.layout.checkout === 'front-left' ? -1 : 1;
    const cx = sign * (roomHalfX - 3.4), cz = 8.6;
    const w = 3.0, d = 1.2, h = 1.02;
    const base = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), sharedMat('#c5d4cc'));
    base.position.set(cx, h / 2, cz); fixtureGroup.add(base);
    const top = new THREE.Mesh(new THREE.BoxGeometry(w + 0.14, 0.08, d + 0.14), sharedMat('#eef2ee'));
    top.position.set(cx, h + 0.04, cz); fixtureGroup.add(top);
    const scanner = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.18, 0.32), sharedMat('#1f6b57'));
    scanner.position.set(cx - w / 2 + 0.5, h + 0.17, cz); fixtureGroup.add(scanner);
    const tex = makeSignTexture(['CHECKOUT']);
    const smat = new THREE.MeshBasicMaterial({ map: tex }); smat.userData.shared = true;
    const s = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.0), smat);
    s.position.set(cx, 2.65, cz - 0.1); fixtureGroup.add(s);
    colliders.push({ minX: cx - w / 2 - 0.1, maxX: cx + w / 2 + 0.1, minZ: cz - d / 2 - 0.1, maxZ: cz + d / 2 + 0.1 });
  }

  function buildShelfRow(cx, dir) {
    const backMat = sharedMat('#c5d0c8'), boardMat = sharedMat('#e8ebe4');
    const backX = cx + dir * (CORRIDOR_HALF + SHELF_DEPTH - 0.03);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.06, 2.05, SHELF_LEN), backMat);
    back.position.set(backX, 1.02, SHELF_Z0 + SHELF_LEN / 2); fixtureGroup.add(back);
    const boardX = cx + dir * (CORRIDOR_HALF + SHELF_DEPTH / 2);
    LEVELS.forEach((y) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(SHELF_DEPTH, 0.05, SHELF_LEN), boardMat);
      b.position.set(boardX, y, SHELF_Z0 + SHELF_LEN / 2); fixtureGroup.add(b);
    });
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(SHELF_DEPTH, 0.2, SHELF_LEN), sharedMat('#b8c4bb'));
    plinth.position.set(boardX, 0.1, SHELF_Z0 + SHELF_LEN / 2); fixtureGroup.add(plinth);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(SHELF_DEPTH + 0.06, 0.08, SHELF_LEN), sharedMat('#a8b5ad'));
    rail.position.set(boardX, 2.02, SHELF_Z0 + SHELF_LEN / 2); fixtureGroup.add(rail);
    const x1 = cx + dir * CORRIDOR_HALF, x2 = cx + dir * (CORRIDOR_HALF + SHELF_DEPTH);
    colliders.push({ minX: Math.min(x1, x2), maxX: Math.max(x1, x2), minZ: SHELF_Z0, maxZ: SHELF_Z0 + SHELF_LEN });
  }

  function buildAisleSign(cx, aisleIndex) {
    const names = [];
    placementMap.forEach((pl, pid) => {
      if (pl.aisle !== aisleIndex) return;
      const p = store.products.find((x) => x.id === pid);
      if (!p) return;
      const c = store.categories.find((x) => x.id === p.categoryId);
      if (c && !names.includes(c.name)) names.push(c.name);
    });
    if (!names.length) return;
    const tex = makeSignTexture(names.slice(0, 3));
    const mat = new THREE.MeshBasicMaterial({ map: tex }); mat.userData.shared = true;
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.3), mat);
    plane.position.set(cx, 2.75, SHELF_Z0 + SHELF_LEN + 1.4); fixtureGroup.add(plane);
    const back = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.3), sharedMat('#14181a'));
    back.position.set(cx, 2.75, SHELF_Z0 + SHELF_LEN + 1.41); back.rotation.y = Math.PI; fixtureGroup.add(back);
  }

  function computePlacements() {
    const N = Math.max(1, store.layout.aisleCount | 0);
    const used = new Set(); const out = new Map();
    publishedProducts.forEach((p) => {
      const pl = p.placement;
      if (pl?.mode === 'manual' && Number.isInteger(pl.aisle)) {
        const a = clamp(pl.aisle, 0, N - 1);
        const l = clamp(pl.level | 0, 0, LEVELS.length - 1);
        const s = clamp(pl.slot | 0, 0, SLOTS - 1);
        const side = pl.side === 'R' ? 'R' : 'L';
        const k = a + '|' + side + '|' + l + '|' + s;
        if (!used.has(k)) { used.add(k); out.set(p.id, { aisle: a, side, level: l, slot: s }); }
      }
    });
    const groups = new Map();
    publishedProducts.forEach((p) => {
      if (out.has(p.id)) return;
      if (!groups.has(p.categoryId)) groups.set(p.categoryId, []);
      groups.get(p.categoryId).push(p);
    });
    store.categories.forEach((cat, ci) => {
      const list = groups.get(cat.id) || [];
      if (!list.length) return;
      let base = store.layout.assignments[cat.id];
      if (!Number.isInteger(base)) base = ci % N;
      base = clamp(base, 0, N - 1);
      for (const p of list) {
        let placed = false, tries = 0, ai = base;
        while (!placed && tries < N) {
          let found = null;
          for (let i = 0; i < CAP_PER_AISLE; i++) {
            const side = i % 2 === 0 ? 'L' : 'R';
            const rem = Math.floor(i / 2);
            const s = { side, level: Math.floor(rem / SLOTS), slot: rem % SLOTS };
            if (!used.has(ai + '|' + s.side + '|' + s.level + '|' + s.slot)) { found = s; break; }
          }
          if (found) {
            used.add(ai + '|' + found.side + '|' + found.level + '|' + found.slot);
            out.set(p.id, { aisle: ai, side: found.side, level: found.level, slot: found.slot });
            placed = true;
          } else { ai = (ai + 1) % N; tries++; }
        }
      }
    });
    return out;
  }

  function slotWorld(pl, N) {
    const cx = (pl.aisle - (N - 1) / 2) * AISLE_SPACING;
    const dir = pl.side === 'L' ? -1 : 1;
    return {
      x: cx + dir * (CORRIDOR_HALF + 0.13),
      y: LEVELS[pl.level] + 0.03 + 0.15,
      z: SHELF_Z0 + (pl.slot + 0.5) * (SHELF_LEN / SLOTS),
      rotY: pl.side === 'L' ? Math.PI / 2 : -Math.PI / 2
    };
  }

  function buildProducts() {
    shelfCarousels = [];
    const N = store.layout.aisleCount;
    placementMap.forEach((pl, pid) => {
      const p = store.products.find((x) => x.id === pid);
      if (!p) return;
      const w = slotWorld(pl, N);
      const images = productImages(p);
      const initialImage = images[0] || p.image;
      /* warm secondary images so the blur-in transitions never flash a placeholder */
      images.slice(1).forEach((im) => getProductBillboardTexture(p, im));
      const tex = getProductBillboardTexture(p, initialImage);
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: true, alphaTest: 0.08 });
      const sprite = new THREE.Sprite(mat);
      const shape = p.shape || 'box';
      let sx = 0.28, sy = 0.36;
      if (shape === 'bottle' || shape === 'carton') { sx = 0.22; sy = 0.40; }
      else if (shape === 'can') { sx = 0.22; sy = 0.28; }
      else if (shape === 'bag') { sx = 0.34; sy = 0.34; }
      else if (shape === 'bar') { sx = 0.20; sy = 0.32; }
      sprite.scale.set(sx, sy, 1);
      sprite.center.set(0.5, 0);
      sprite.position.set(w.x, LEVELS[pl.level] + 0.03, w.z);
      sprite.userData.productId = p.id;
      productGroup.add(sprite);
      productMeshes.push(sprite);
      shelfCarousels.push({
        sprite, mat, product: p,
        images: images.length ? images : [p.image || { kind: 'none' }],
        index: 0, timer: 0,
        interval: 3.5 + Math.random() * 2,
        anim: null, work: null
      });
    });
  }

  function rebuildProductsOnly() {
    clearGroup(productGroup);
    productMeshes.length = 0;
    shelfCarousels = [];
    buildProducts();
  }

  /* Shelf auto-carousel: rotate through each product's images over time,
     with a blur-in transition (new image starts blurry and resolves to sharp). */
  const BLUR_DUR = 1.0;
  function ensureWork(c) {
    if (c.work) return c.work;
    const canvas = document.createElement('canvas');
    canvas.width = PRODUCT_TEX_W; canvas.height = PRODUCT_TEX_H;
    const small = document.createElement('canvas');
    const tex = new THREE.CanvasTexture(canvas); tex.encoding = THREE.sRGBEncoding;
    c.work = { canvas, small, tex, ctx: canvas.getContext('2d'), sctx: small.getContext('2d') };
    return c.work;
  }
  function startShelfBlur(c, prevTex, nextTex) {
    const prevImg = prevTex?.image, nextImg = nextTex?.image;
    if (!prevImg || !nextImg || !nextImg.width) {
      c.mat.map = nextTex; c.mat.needsUpdate = true; return;
    }
    const w = ensureWork(c);
    c.anim = { t: 0, prev: prevImg, next: nextImg, target: nextTex };
    w.ctx.drawImage(prevImg, 0, 0, PRODUCT_TEX_W, PRODUCT_TEX_H);
    w.tex.needsUpdate = true;
    c.mat.map = w.tex; c.mat.needsUpdate = true;
  }
  function stepShelfBlur(c, dt) {
    const a = c.anim, w = c.work;
    a.t += dt;
    const k = Math.min(1, a.t / BLUR_DUR);
    if (k >= 1) {
      c.mat.map = a.target; c.mat.needsUpdate = true; c.anim = null; return;
    }
    const e = 1 - Math.pow(1 - k, 2);
    /* Blur by downscaling then upscaling: 10px (very soft) → full resolution. */
    const size = Math.max(8, Math.round(10 * Math.pow(PRODUCT_TEX_W / 10, e)));
    if (w.small.width !== size) { w.small.width = size; w.small.height = size; }
    w.sctx.imageSmoothingEnabled = true;
    w.sctx.drawImage(a.next, 0, 0, size, size);
    w.ctx.imageSmoothingEnabled = true;
    try { w.ctx.imageSmoothingQuality = 'high'; } catch { /* */ }
    w.ctx.globalAlpha = 1;
    w.ctx.drawImage(a.prev, 0, 0, PRODUCT_TEX_W, PRODUCT_TEX_H);
    w.ctx.globalAlpha = Math.min(1, k * 2.4);
    w.ctx.drawImage(w.small, 0, 0, PRODUCT_TEX_W, PRODUCT_TEX_H);
    w.ctx.globalAlpha = 1;
    w.tex.needsUpdate = true;
  }
  function updateShelfCarousels(dt) {
    for (const c of shelfCarousels) {
      if (c.anim) { stepShelfBlur(c, dt); continue; }
      if (c.images.length <= 1) continue;
      c.timer += dt;
      if (c.timer >= c.interval) {
        c.timer = 0;
        const prevTex = c.mat.map;
        c.index = (c.index + 1) % c.images.length;
        const tex = getProductBillboardTexture(c.product, c.images[c.index]);
        startShelfBlur(c, prevTex, tex);
      }
    }
  }

  /* ---------- banners ---------- */
  function wrapText(ctx, text, x, y, maxW, lineH, maxLines) {
    const words = String(text).split(/\s+/);
    let line = ''; const lines = [];
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; }
      else line = test;
      if (lines.length >= maxLines) break;
    }
    if (line && lines.length < maxLines) lines.push(line);
    lines.forEach((l, i) => ctx.fillText(l, x, y + i * lineH));
  }

  function bannerCanvasTexture(banner) {
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 320;
    const x = c.getContext('2d');
    x.fillStyle = banner.bg || '#1f6b57'; x.fillRect(0, 0, 1024, 320);
    x.fillStyle = 'rgba(255,255,255,.10)'; x.fillRect(0, 0, 1024, 8);
    x.fillStyle = '#ffffff'; x.textAlign = 'left'; x.textBaseline = 'top';
    x.font = '800 72px Helvetica,Arial,sans-serif';
    wrapText(x, banner.headline || banner.name || 'Breathe', 60, 70, 900, 80, 2);
    if (banner.sub) {
      x.font = '400 38px Helvetica,Arial,sans-serif';
      x.fillStyle = 'rgba(255,255,255,.86)';
      wrapText(x, banner.sub, 60, 190, 900, 46, 2);
    }
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; return t;
  }

  function bannerCoverTexture(banner, slotW, slotH) {
    const c = document.createElement('canvas');
    const aspect = slotW / Math.max(0.01, slotH);
    c.width = 1024; c.height = Math.max(128, Math.round(1024 / aspect));
    const ctx = c.getContext('2d');
    ctx.fillStyle = banner.bg || '#1f6b57'; ctx.fillRect(0, 0, c.width, c.height);
    const imgTex = getTexture(banner.image);
    if (imgTex?.image?.width) {
      const img = imgTex.image;
      const ir = img.width / img.height, cr = c.width / c.height;
      let dw, dh, dx, dy;
      if (ir > cr) { dh = c.height; dw = c.height * ir; dx = (c.width - dw) / 2; dy = 0; }
      else { dw = c.width; dh = c.width / ir; dx = 0; dy = (c.height - dh) / 2; }
      try { ctx.drawImage(img, dx, dy, dw, dh); } catch { /* */ }
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.fillRect(0, c.height * 0.55, c.width, c.height * 0.45);
      ctx.fillStyle = '#ffffff'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.font = '800 64px Helvetica,Arial,sans-serif';
      wrapText(ctx, banner.headline || banner.name || 'Breathe', 48, c.height * 0.58, c.width - 96, 70, 2);
      if (banner.sub) {
        ctx.font = '400 32px Helvetica,Arial,sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        wrapText(ctx, banner.sub, 48, c.height * 0.78, c.width - 96, 38, 2);
      }
    } else {
      return bannerCanvasTexture(banner);
    }
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; return t;
  }

  function bannerSlots(N) {
    const slots = [];
    for (let i = 0; i < N; i++) {
      const cx = (i - (N - 1) / 2) * AISLE_SPACING;
      slots.push({ id: 'ceil-' + i, type: 'ceiling', pos: [cx, 3.08, i % 2 === 0 ? -3.5 : 1.5], size: [3.2, 1.05] });
    }
    for (let i = 0; i < N; i++) {
      const cx = (i - (N - 1) / 2) * AISLE_SPACING;
      const side = i % 2 === 0 ? -1 : 1;
      slots.push({ id: 'shelf-' + i, type: 'shelf', pos: [cx + side * 1.48, 2.42, 6.3], size: [2.0, 0.75], rotY: side > 0 ? -Math.PI / 2 : Math.PI / 2 });
    }
    slots.push({ id: 'entrance', type: 'entrance', pos: [0, 2.85, 8.6], size: [4.0, 1.2] });
    return slots;
  }

  function weightedPick(pool, usage) {
    let total = 0;
    const weights = pool.map((b) => {
      const pr = clamp(Number(b.priority) || 1, 1, 10);
      const w = pr / (1 + (usage[b.id] || 0) * 1.6);
      total += w; return w;
    });
    if (total <= 0) return pool[0] || null;
    let r = Math.random() * total;
    for (let i = 0; i < pool.length; i++) { r -= weights[i]; if (r <= 0) return pool[i]; }
    return pool[pool.length - 1];
  }

  function pickBannerArrangement() {
    const N = store.layout.aisleCount;
    const slots = bannerSlots(N);
    const eligible = store.banners.filter((b) => b.enabled !== false && b.published !== false);
    const usage = {}; const out = [];
    const maxBanners = Math.min(slots.length, Math.max(2, Math.min(N + 1, 4)));
    const ordered = slots.slice().sort((a, b) => {
      const rank = (t) => t === 'entrance' ? 0 : t === 'ceiling' ? 1 : 2;
      return rank(a.type) - rank(b.type);
    });
    const usedAisleType = new Set();
    const halfOf = (s) => (s.rotY ? [0.06, s.size[1] / 2, s.size[0] / 2] : [s.size[0] / 2, s.size[1] / 2, 0.06]);
    const boxes = [];
    for (let i = 0; i < N; i++) boxes.push({ c: [(i - (N - 1) / 2) * AISLE_SPACING, 2.75, SHELF_Z0 + SHELF_LEN + 1.4], h: [1.7, 0.65, 0.06] });
    const clash = (s) => boxes.some((b) => { const h = halfOf(s); return [0, 1, 2].every((k) => Math.abs(b.c[k] - s.pos[k]) < b.h[k] + h[k] + 0.25); });
    for (const slot of ordered) {
      if (out.length >= maxBanners) break;
      if (slot.type === 'shelf' && Math.random() > 0.5) continue;
      if (slot.type === 'ceiling' && Math.random() > 0.7) continue;
      if (clash(slot)) continue;
      if (slot.type !== 'entrance' && usedAisleType.has(slot.id)) continue;
      const pool = eligible.filter((b) => {
        const pl = b.placements;
        if (!pl || !pl.length) return slot.type === 'ceiling' || slot.type === 'entrance';
        return pl.includes(slot.type);
      });
      if (!pool.length) continue;
      const b = weightedPick(pool, usage);
      if (!b) continue;
      usage[b.id] = (usage[b.id] || 0) + 1;
      usedAisleType.add(slot.id);
      boxes.push({ c: slot.pos.slice(), h: halfOf(slot) });
      out.push({ bannerId: b.id, slot: { ...slot } });
    }
    return out;
  }

  function buildBanners() {
    bannerMeshes.length = 0;
    bannerArrangement.forEach((item) => {
      const b = store.banners.find((x) => x.id === item.bannerId);
      if (!b) return;
      const slot = item.slot;
      const tex = bannerCoverTexture(b, slot.size[0], slot.size[1]);
      const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.FrontSide, transparent: false });
      /* If the banner image is still loading, swap in the real texture once ready. */
      if (b.image && b.image.kind !== 'none' && !(getTexture(b.image)?.image?.width)) {
        whenTextureReady(b.image, () => {
          try {
            const fresh = bannerCoverTexture(b, slot.size[0], slot.size[1]);
            mat.map = fresh; mat.needsUpdate = true;
          } catch { /* ignore */ }
        });
      }
      const geo = new THREE.PlaneGeometry(slot.size[0], slot.size[1]);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(slot.pos[0], slot.pos[1], slot.pos[2]);
      if (slot.rotY) mesh.rotation.y = slot.rotY;
      mesh.userData.bannerId = b.id;
      bannerGroup.add(mesh);
      bannerMeshes.push(mesh);
      const rb = slot.rotY || 0;
      const backMesh = new THREE.Mesh(geo, mat);
      backMesh.position.set(slot.pos[0] - 0.08 * Math.sin(rb), slot.pos[1], slot.pos[2] - 0.08 * Math.cos(rb));
      backMesh.rotation.y = rb + Math.PI;
      backMesh.userData.bannerId = b.id;
      bannerGroup.add(backMesh);
      bannerMeshes.push(backMesh);
      const frame = new THREE.Mesh(new THREE.BoxGeometry(slot.size[0] + 0.08, slot.size[1] + 0.08, 0.03), sharedMat('#2b2f36'));
      frame.position.copy(mesh.position);
      if (slot.rotY) { const s = Math.sign(Math.sin(slot.rotY)) || 1; frame.position.x -= 0.04 * s; frame.rotation.y = slot.rotY; }
      else frame.position.z -= 0.04;
      bannerGroup.add(frame);
    });
  }

  function buildStore() {
    clearGroup(fixtureGroup);
    clearGroup(productGroup);
    clearGroup(bannerGroup);
    colliders.length = 0;
    productMeshes.length = 0;
    bannerMeshes.length = 0;
    shelfCarousels = [];
    clearNPCs();
    const N = Math.max(1, store.layout.aisleCount | 0);
    roomHalfX = Math.max(8.5, (N - 1) * AISLE_SPACING / 2 + CORRIDOR_HALF + SHELF_DEPTH + 2.6);
    roomHalfZ = 11.5;
    buildRoom();
    for (let i = 0; i < N; i++) {
      const cx = (i - (N - 1) / 2) * AISLE_SPACING;
      buildShelfRow(cx, -1);
      buildShelfRow(cx, 1);
    }
    placementMap = computePlacements();
    buildProducts();
    for (let i = 0; i < N; i++) buildAisleSign((i - (N - 1) / 2) * AISLE_SPACING, i);
    if (!bannerArrangement.length) bannerArrangement = pickBannerArrangement();
    buildBanners();
    buildCheckout();
    updateBasket3D();
  }

  function rebuild() {
    const pubs = publishedProducts.length;
    const curN = Math.max(1, store.layout.aisleCount | 0);
    const needed = Math.ceil(pubs / CAP_PER_AISLE) || 1;
    const autoN = clamp(Math.max(curN, needed), 1, 6);
    if (autoN > curN && pubs > 0) { store.layout.aisleCount = autoN; saveStore(); }
    buildStore();
    clampPlayerInside();
  }

  function clampPlayerInside() {
    if (!player) return;
    const r = 0.4;
    player.pos.x = clamp(player.pos.x, -roomHalfX + r + 0.2, roomHalfX - r - 0.2);
    player.pos.z = clamp(player.pos.z, -roomHalfZ + r + 0.2, roomHalfZ - r - 0.2);
    for (const c of colliders) {
      if (player.pos.x > c.minX - r && player.pos.x < c.maxX + r && player.pos.z > c.minZ - r && player.pos.z < c.maxZ + r) {
        const dl = Math.abs(player.pos.x - (c.minX - r));
        const dr = Math.abs((c.maxX + r) - player.pos.x);
        const db = Math.abs(player.pos.z - (c.minZ - r));
        const df = Math.abs((c.maxZ + r) - player.pos.z);
        const m = Math.min(dl, dr, db, df);
        if (m === dl) player.pos.x = c.minX - r;
        else if (m === dr) player.pos.x = c.maxX + r;
        else if (m === db) player.pos.z = c.minZ - r;
        else player.pos.z = c.maxZ + r;
      }
    }
  }

  /* =========================================================
     INPUT
     ========================================================= */
  function collides(x, z) {
    const r = CFG.radius;
    if (x > roomHalfX - r - 0.12 || x < -roomHalfX + r + 0.12) return true;
    if (z > roomHalfZ - r - 0.12 || z < -roomHalfZ + r + 0.12) return true;
    for (const n of npcList) if (n.state !== 'vanish' && Math.hypot(x - n.x, z - n.z) < r + 0.46) return true;
    for (const c of colliders) if (x + r > c.minX && x - r < c.maxX && z + r > c.minZ && z - r < c.maxZ) return true;
    return false;
  }

  function bindEvents() {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onResize);
    canvasEl.addEventListener('pointerdown', onCanvasDown);
    canvasEl.addEventListener('pointermove', onCanvasMove);
    canvasEl.addEventListener('pointerup', onCanvasUp);
    canvasEl.addEventListener('pointercancel', onCanvasCancel);
  }
  function onKeyDown(e) {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    keys[e.code] = true;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  }
  function onKeyUp(e) { keys[e.code] = false; }
  function onBlur() { for (const k in keys) keys[k] = false; }
  function onResize() { resize(); }
  function onCanvasDown(e) {
    if (mode !== 'play' || uiLock) return;
    lookId = e.pointerId;
    lookLast = { x: e.clientX, y: e.clientY };
    lookStart = { x: e.clientX, y: e.clientY, t: performance.now() };
    lookMoved = 0;
    try { canvasEl.setPointerCapture(e.pointerId); } catch { /* */ }
  }
  function onCanvasMove(e) {
    if (e.pointerId !== lookId) return;
    const dx = e.clientX - lookLast.x;
    const dy = e.clientY - lookLast.y;
    lookLast = { x: e.clientX, y: e.clientY };
    lookMoved += Math.abs(dx) + Math.abs(dy);
    player.yaw -= dx * CFG.lookSens;
    player.pitch = clamp(player.pitch - dy * CFG.lookSens, -1.0, 1.0);
    e.preventDefault();
  }
  function onCanvasUp(e) {
    if (e.pointerId !== lookId) return;
    lookId = null;
    const dt = performance.now() - lookStart.t;
    if (lookMoved < 14 && dt < 450) handleTap(e.clientX, e.clientY);
  }
  function onCanvasCancel() { lookId = null; }

  function handleTap(cx, cy) {
    ndc.set((cx / window.innerWidth) * 2 - 1, -(cy / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const targets = productMeshes.concat(bannerMeshes);
    const hits = raycaster.intersectObjects(targets, true);
    if (!hits.length || hits[0].distance > 8) return;
    const hit = hits[0];
    const bid = hit.object.userData.bannerId || hit.object.parent?.userData.bannerId;
    if (bid) { openBanner(bid); return; }
    const pid = findProductId(hit.object);
    if (pid) openProductCard(pid);
  }
  function findProductId(obj) {
    let o = obj;
    while (o) { if (o.userData?.productId) return o.userData.productId; o = o.parent; }
    return null;
  }

  /* =========================================================
     PLAYER
     ========================================================= */
  function hitWall(speed) {
    if (speed < 0.8 || bumpCd > 0) return;
    bumpCd = 0.35; stun = 0.16;
    const s = Math.min(1, speed / 2.5);
    camKick = 0.035 * s + 0.01; rumbleAmp = Math.max(rumbleAmp, s); lurch = 0.07 * s;
    basketPhysics.forEach((it) => {
      it.vz -= s * (0.7 + Math.random() * 0.8);
      it.vx += (Math.random() - 0.5) * s;
      it.vy += s * (0.5 + Math.random() * 0.7);
    });
    Audio.beep(95, 0.16, 'square');
    try { if (navigator.vibrate) navigator.vibrate(22 + 30 * s); } catch { /* */ }
  }
  function decayBump(dt) {
    bumpCd -= dt; stun -= dt;
    camKick *= Math.exp(-dt * 8); rumbleAmp *= Math.exp(-dt * 4); lurch *= Math.exp(-dt * 9);
  }

  function updatePlayer(dt) {
    const turnInput = clamp(joyVec.x, -1, 1);
    const moveFwd = clamp(joyVec.y + (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0), -1, 1);
    const strafe = clamp((keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0), -1, 1);
    if (Math.abs(turnInput) > 0.08) player.yaw -= turnInput * 2.4 * dt;
    const sin = Math.sin(player.yaw), cos = Math.cos(player.yaw);
    const fwd = { x: -sin, z: -cos }, right = { x: cos, z: -sin };
    let wishX = fwd.x * moveFwd + right.x * strafe;
    let wishZ = fwd.z * moveFwd + right.z * strafe;
    const len = Math.hypot(wishX, wishZ);
    if (len > 1) { wishX /= len; wishZ /= len; }
    wishX *= CFG.walkSpeed; wishZ *= CFG.walkSpeed;
    if (stun > 0) { wishX = 0; wishZ = 0; }
    const t = Math.min(1, dt * (len > 0.05 ? 8.5 : 11));
    player.vx += (wishX - player.vx) * t;
    player.vz += (wishZ - player.vz) * t;
    if (Math.abs(player.vx) < 0.003) player.vx = 0;
    if (Math.abs(player.vz) < 0.003) player.vz = 0;
    const nx = player.pos.x + player.vx * dt;
    if (!collides(nx, player.pos.z)) { player.pos.x = nx; blockedX = false; }
    else { if (!blockedX) hitWall(Math.abs(player.vx)); blockedX = true; player.vx = 0; }
    const nz = player.pos.z + player.vz * dt;
    if (!collides(player.pos.x, nz)) { player.pos.z = nz; blockedZ = false; }
    else { if (!blockedZ) hitWall(Math.abs(player.vz)); blockedZ = true; player.vz = 0; }
    player.moving = Math.hypot(player.vx, player.vz);
    const k = Math.min(1, player.moving / 2);
    walkPhase += player.moving * dt * 3.4;
    const bob = Math.sin(walkPhase * 2) * 0.016 * k;
    camera.position.set(player.pos.x, CFG.eyeHeight + bob - camKick * 0.9, player.pos.z);
    camera.rotation.y = player.yaw;
    camera.rotation.x = player.pitch - camKick;
    const roll = -turnInput * 0.04 + Math.sin(walkPhase) * 0.004 * k;
    camera.rotation.z += (roll - camera.rotation.z) * Math.min(1, dt * 7);
    const fovT = 72 + Math.min(1, player.moving / CFG.walkSpeed) * 4;
    if (Math.abs(camera.fov - fovT) > 0.02) { camera.fov += (fovT - camera.fov) * Math.min(1, dt * 5); camera.updateProjectionMatrix(); }
  }

  /* =========================================================
     3D BASKET
     ========================================================= */
  function updateBasket3D() {
    while (basketItemsGroup.children.length) {
      const c = basketItemsGroup.children.pop();
      if (c.material && !c.material.userData.shared && c.material.dispose) { try { c.material.dispose(); } catch { /* */ } }
    }
    basketPhysics.length = 0;
    const totalUnits = cart.lines.reduce((s, l) => s + l.qty, 0);
    if (!totalUnits) return;
    const maxShow = Math.min(totalUnits, 14);
    for (let i = 0; i < maxShow; i++) {
      let line = null, acc = 0;
      for (const l of cart.lines) { if (i < acc + l.qty) { line = l; break; } acc += l.qty; }
      const prod = line ? store.products.find((p) => p.id === line.productId) : null;
      let sprite;
      if (prod) {
        const images = productImages(prod);
        const tex = getProductBillboardTexture(prod, images[0] || prod.image);
        const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, alphaTest: 0.1 });
        sprite = new THREE.Sprite(mat);
        sprite.scale.set(0.09, 0.11, 1);
      } else {
        sprite = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xcfd6d2 }));
        sprite.scale.set(0.08, 0.08, 1);
      }
      sprite.position.set((Math.random() - 0.5) * 0.32, -0.08 + Math.random() * 0.12, (Math.random() - 0.5) * 0.36);
      basketItemsGroup.add(sprite);
      basketPhysics.push({ mesh: sprite, vx: (Math.random() - 0.5) * 0.4, vy: 0, vz: (Math.random() - 0.5) * 0.4 });
    }
  }

  function stepBasketPhysics(dt) {
    const sn = Math.sin(player.yaw), cs = Math.cos(player.yaw);
    const fv = -(player.vx * sn + player.vz * cs), sv = player.vx * cs - player.vz * sn;
    const af = clamp((fv - prevFwdV) / Math.max(dt, 0.001), -10, 10);
    const as = clamp((sv - prevSideV) / Math.max(dt, 0.001), -10, 10);
    prevFwdV = fv; prevSideV = sv;
    if (!basketPhysics.length) return;
    const minX = -0.18, maxX = 0.18, minY = -0.12, maxY = 0.10, minZ = -0.22, maxZ = 0.20;
    const rum = Math.min(1, player.moving / 2.5);
    for (const it of basketPhysics) {
      const p = it.mesh.position;
      const floor = p.y <= minY + 0.004;
      it.vy -= 4.5 * dt;
      it.vz += af * 0.22 * dt; it.vx -= as * 0.22 * dt;
      if (floor) {
        const f = Math.max(0, 1 - 7 * dt); it.vx *= f; it.vz *= f;
        if (rum > 0.1 && Math.random() < dt * 9 * rum) it.vy += 0.12 + Math.random() * 0.28 * rum;
      } else { it.vx *= 1 - 0.8 * dt; it.vz *= 1 - 0.8 * dt; }
      p.x += it.vx * dt; p.y += it.vy * dt; p.z += it.vz * dt;
      if (p.x < minX) { p.x = minX; it.vx = Math.abs(it.vx) * 0.4; }
      if (p.x > maxX) { p.x = maxX; it.vx = -Math.abs(it.vx) * 0.4; }
      if (p.z < minZ) { p.z = minZ; it.vz = Math.abs(it.vz) * 0.4; }
      if (p.z > maxZ) { p.z = maxZ; it.vz = -Math.abs(it.vz) * 0.4; }
      if (p.y < minY) { p.y = minY; it.vy = Math.abs(it.vy) * 0.3; if (it.vy < 0.05) it.vy = 0; }
      if (p.y > maxY) { p.y = maxY; it.vy = -Math.abs(it.vy) * 0.25; }
    }
  }

  function updateCartPose() {
    if (!cartGroup) return;
    const lookDown = clamp((-player.pitch - 0.1) / 0.55, 0, 1);
    const openExtra = cartOpen ? 1 : 0;
    const t = Math.max(lookDown, openExtra);
    cartGroup.position.x = 0.19;
    cartGroup.position.y = -0.52 - t * 0.06;
    cartGroup.position.z = -0.92 + t * 0.10;
    cartGroup.rotation.x = -0.06 - t * 0.12;
    const sh = Math.min(1, player.moving / 2.5) * 0.0025 + rumbleAmp * 0.016;
    cartGroup.position.x += (Math.random() - 0.5) * sh * 2;
    cartGroup.position.y += (Math.random() - 0.5) * sh;
    cartGroup.position.z -= lurch;
    cartGroup.rotation.z = (Math.random() - 0.5) * sh * 5;
    cartGroup.rotation.x -= lurch * 1.5;
  }

  /* =========================================================
     CART
     ========================================================= */
  function addToCart(product, qty) {
    qty = Math.max(1, Math.min(99, qty | 0));
    const existing = cart.lines.find((l) => l.productId === product.id && l.price === product.price);
    if (existing) existing.qty += qty;
    else {
      const imgs = productImages(product);
      cart.lines.push({
        lineId: uid('line'), productId: product.id, name: product.name,
        brand: product.brand, price: product.price, qty,
        image: imgs[0] ? JSON.parse(JSON.stringify($state.snapshot(imgs[0]))) : { kind: 'none' }
      });
    }
    saveCartState();
    updateBasket3D();
    Audio.beep(660, 0.09, 'sine');
    toast('Added to cart');
    flyToCart(product);
  }

  function flyToCart(p) {
    if (mode !== 'play') return;
    const pill = document.getElementById('cartPill');
    if (!pill) return;
    const el = document.createElement('div');
    el.className = 'fixed z-[130] w-14 h-14 rounded-2xl bg-white flex items-center justify-center text-2xl pointer-events-none shadow-2xl';
    el.style.transition = 'transform .6s cubic-bezier(.55,0,.25,1), opacity .6s ease';
    const imgs = productImages(p);
    const src = imgs[0]?.url;
    if (src) el.style.backgroundImage = `url("${String(src).replace(/"/g, '%22')}")`, el.style.backgroundSize = '72%', el.style.backgroundRepeat = 'no-repeat', el.style.backgroundPosition = 'center';
    else el.textContent = '🛒';
    el.style.left = (window.innerWidth / 2 - 28) + 'px';
    el.style.top = (window.innerHeight / 2 - 28) + 'px';
    document.body.appendChild(el);
    const r = pill.getBoundingClientRect();
    requestAnimationFrame(() => {
      el.style.transform = `translate(${r.left + r.width / 2 - window.innerWidth / 2}px, ${r.top + r.height / 2 - window.innerHeight / 2}px) scale(.25)`;
      el.style.opacity = '.2';
    });
    setTimeout(() => el.remove(), 620);
  }

  function setLineQty(lineId, qty) {
    const l = cart.lines.find((x) => x.lineId === lineId);
    if (!l) return;
    if (qty <= 0) cart.lines = cart.lines.filter((x) => x.lineId !== lineId);
    else l.qty = Math.min(99, qty);
    saveCartState();
    updateBasket3D();
  }
  function removeLine(lineId) { cart.lines = cart.lines.filter((x) => x.lineId !== lineId); saveCartState(); updateBasket3D(); }
  function clearCart() { cart.lines = []; saveCartState(); updateBasket3D(); }

  /* =========================================================
     UI HELPERS
     ========================================================= */
  let toastTimer = null;
  function toast(msg) {
    toastText = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastText = ''; }, 1800);
  }
  function openSheet(name) { activeSheet = name; if (name === 'cartSheet') cartOpen = true; }
  function closeSheet(name) {
    if (name && activeSheet !== name) return;
    if (activeSheet === 'cartSheet') cartOpen = false;
    activeSheet = null;
  }

  /* =========================================================
     PRODUCT CARD
     ========================================================= */
  function openProductCard(productId) {
    cardProductId = productId;
    cardQty = 1;
    cardImageIndex = 0;
    openSheet('productCard');
  }

  /* =========================================================
     SEARCH
     ========================================================= */
  function openSearch() {
    searchCategory = 'all';
    searchQuery = '';
    openSheet('searchSheet');
    setTimeout(() => { document.getElementById('searchInput')?.focus(); }, 220);
  }
  function openAisleFromSearch(p) { closeSheet('searchSheet'); setTimeout(() => openProductCard(p.id), 120); }

  /* =========================================================
     BANNERS
     ========================================================= */
  function openBanner(bannerId) {
    const b = store.banners.find((x) => x.id === bannerId);
    if (!b) return;
    const href = safeUrl(b.url);
    if (!href) { toast('This banner has no destination yet'); return; }
    const w = window.open(href, '_blank', 'noopener,noreferrer');
    if (!w) toast('Popup blocked — allow popups');
  }

  /* =========================================================
     CHECKOUT
     ========================================================= */
  function validateCartForCheckout() {
    const problems = [];
    cart.lines.forEach((l) => {
      const p = store.products.find((x) => x.id === l.productId);
      if (!p || !p.published || p.enabled === false) problems.push({ lineId: l.lineId, name: l.name, reason: 'No longer available' });
    });
    return problems;
  }

  async function createOrder() {
    const order_items = cart.lines.map(c => {
      return {
        product_id: c.productId,
        qty: c.qty
      }
    })

    console.log(cart)

    const orderId = 'RBB-' + Date.now().toString(36).toUpperCase().slice(-6) + '-' + Math.floor(Math.random() * 900 + 100)

    const orderReq = await supabase.from('orders').insert({
      id: orderId,
      status: 'pending',
      user_id: data.profile.id
    }).select().single()

    if (orderReq.error) throw orderReq

  }

  async function startCheckout() {
    if (!cart.lines.length) { toast('Your cart is empty'); openSheet('cartSheet'); return; }
    
    await createOrder()
    clearCart()

    openSheet('receiptSheet')
  

  }
  function goToPayment() { 
    closeSheet('billSheet')
    console.log(cart)
  }
  function runPayment(success) {
    setTimeout(() => {
      if (!success) return;
      completeOrder();
    }, 1500);
  }
  function completeOrder() {
    const order = {
      id: 'BR-' + Date.now().toString(36).toUpperCase().slice(-6) + '-' + Math.floor(Math.random() * 900 + 100),
      at: new Date().toISOString(),
      items: cart.lines.map((l) => ({ name: l.name, brand: l.brand, qty: l.qty, price: l.price })),
      total: cartTotal
    };
    pendingOrder = order;
    store.orders.unshift(order);
    store.orders = store.orders.slice(0, 20);
    saveStore();
    closeSheet('paySheet');
    clearCart();
    openSheet('receiptSheet');
    Audio.beep(880, 0.12, 'sine');
    setTimeout(() => Audio.beep(1180, 0.14, 'sine'), 120);
  }
  function startNewTrip() {
    cart = { tripId: uid('trip'), lines: [] };
    saveCartState();
    updateBasket3D();
    bannerArrangement = pickBannerArrangement();
    buildBanners();
    player.pos.set(0, 0, 9.8);
    player.yaw = 0; player.pitch = 0;
    player.vx = player.vz = 0;
  }

  /* =========================================================
     AUDIO
     ========================================================= */
  const Audio = (() => {
    let ctx = null, master = null, ambient = null, on = false;
    function ensure() {
      if (ctx) return ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch { return null; }
      master = ctx.createGain();
      master.gain.value = (store.settings.volume || 0.6) * 0.4;
      master.connect(ctx.destination);
      return ctx;
    }
    function beep(freq, dur, type) {
      if (!on) return;
      const c = ensure(); if (!c) return;
      try {
        const o = c.createOscillator(), g = c.createGain();
        o.type = type || 'sine'; o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, c.currentTime);
        g.gain.exponentialRampToValueAtTime(0.22, c.currentTime + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
        o.connect(g); g.connect(master);
        o.start(); o.stop(c.currentTime + dur + 0.03);
      } catch { /* */ }
    }
    function startAmbient() {
      if (!on || ambient) return;
      const c = ensure(); if (!c) return;
      try {
        const len = Math.floor(c.sampleRate * 2);
        const buf = c.createBuffer(1, len, c.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * 0.025;
        const src = c.createBufferSource(); src.buffer = buf; src.loop = true;
        const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 380;
        const g = c.createGain(); g.gain.value = 0.55;
        src.connect(f); f.connect(g); g.connect(master);
        src.start(); ambient = src;
      } catch { /* */ }
    }
    function stopAmbient() { if (ambient) { try { ambient.stop(); } catch { /* */ } ambient = null; } }
    return {
      beep,
      setEnabled(v) { on = !!v; if (on) { const c = ensure(); if (c && c.state === 'suspended') c.resume(); startAmbient(); } else stopAmbient(); },
      isOn() { return on; }
    };
  })();

  /* =========================================================
     NPCs
     ========================================================= */
  function poof(x, z, count, spread) {
    for (let i = 0; i < count; i++) {
      grains.emit(x + (Math.random() - 0.5) * 0.6, 0.1 + Math.random() * 0.95, z + (Math.random() - 0.5) * 0.8,
        (Math.random() - 0.5) * spread, 0.5 + Math.random() * 1.1, (Math.random() - 0.5) * spread,
        1.2 + Math.random() * 1.0, 0.045 + Math.random() * 0.05);
    }
  }
  let grains, dust;
  function buildGrains() {
    const GR_N = 700;
    const pos = new Float32Array(GR_N * 3), vel = new Float32Array(GR_N * 3);
    const size = new Float32Array(GR_N), alpha = new Float32Array(GR_N);
    const life = new Float32Array(GR_N), maxL = new Float32Array(GR_N), base = new Float32Array(GR_N);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, uniforms: { uScale: { value: 600 } },
      vertexShader: 'attribute float aSize;attribute float aAlpha;uniform float uScale;varying float vA;void main(){vA=aAlpha;vec4 mv=modelViewMatrix*vec4(position,1.0);gl_PointSize=max(1.0,aSize*uScale/max(0.1,-mv.z));gl_Position=projectionMatrix*mv;}',
      fragmentShader: 'varying float vA;void main(){gl_FragColor=vec4(1.0,1.0,1.0,vA);}'
    });
    const pts = new THREE.Points(g, mat); pts.frustumCulled = false; pts.renderOrder = 10; scene.add(pts);
    let cur = 0, any = false;
    grains = {
      mat,
      emit(x, y, z, vx, vy, vz, l, s) {
        const i = cur; cur = (cur + 1) % GR_N;
        pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
        vel[i * 3] = vx; vel[i * 3 + 1] = vy; vel[i * 3 + 2] = vz;
        life[i] = maxL[i] = l; base[i] = s; any = true;
      },
      update(dt) {
        if (!any) return;
        let live = false;
        for (let i = 0; i < GR_N; i++) {
          if (life[i] <= 0) continue;
          life[i] -= dt;
          if (life[i] <= 0) { size[i] = 0; alpha[i] = 0; continue; }
          live = true;
          const k = life[i] / maxL[i], d = Math.max(0, 1 - 0.9 * dt);
          vel[i * 3] *= d; vel[i * 3 + 2] *= d; vel[i * 3 + 1] += 0.35 * dt;
          pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
          alpha[i] = Math.min(1, k * 1.7); size[i] = base[i] * (0.45 + 0.55 * k);
        }
        g.attributes.position.needsUpdate = true;
        g.attributes.aSize.needsUpdate = true;
        g.attributes.aAlpha.needsUpdate = true;
        any = live;
      }
    };
  }
  function buildDust() {
    const n = 140, pos = new Float32Array(n * 3), seed = [];
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() * 2 - 1) * 8;
      pos[i * 3 + 1] = 0.3 + Math.random() * 3.2;
      pos[i * 3 + 2] = (Math.random() * 2 - 1) * 12;
      seed.push(Math.random() * 6.28);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({ color: 0xfff3d6, size: 0.04, transparent: true, opacity: 0.5, depthWrite: false });
    const pts = new THREE.Points(g, m); pts.frustumCulled = false; scene.add(pts);
    dust = { update(t) {
      const a = g.attributes.position.array;
      for (let i = 0; i < n; i++) {
        a[i * 3 + 1] += Math.sin(t * 0.4 + seed[i]) * 0.0016;
        a[i * 3] += Math.cos(t * 0.3 + seed[i]) * 0.0012;
      }
      g.attributes.position.needsUpdate = true;
    }};
  }

  const NPC_BOX = new THREE.BoxGeometry(1, 1, 1);
  const NPC_CYL = new THREE.CylinderGeometry(1, 1, 1, 8);

  function makeNPCCart(color) {
    const g = new THREE.Group();
    const metal = sharedMat('#c9d1cc'), dark = sharedMat('#4a5450'), bas = sharedMat(color);
    const part = (geo, m, sx, sy, sz, x, y, z, rz) => {
      const o = new THREE.Mesh(geo, m); o.scale.set(sx, sy, sz); o.position.set(x, y, z);
      if (rz) o.rotation.z = rz; g.add(o); return o;
    };
    part(NPC_BOX, metal, 0.54, 0.03, 0.84, 0, 0.38, 0);
    part(NPC_BOX, bas, 0.03, 0.22, 0.84, -0.255, 0.49, 0);
    part(NPC_BOX, bas, 0.03, 0.22, 0.84, 0.255, 0.49, 0);
    part(NPC_BOX, bas, 0.54, 0.22, 0.03, 0, 0.49, -0.405);
    part(NPC_BOX, dark, 0.40, 0.03, 0.70, 0, 0.2, 0);
    [[-0.2, -0.3], [0.2, -0.3], [-0.2, 0.3], [0.2, 0.3]].forEach((a) => part(NPC_CYL, dark, 0.06, 0.04, 0.06, a[0], 0.06, a[1], Math.PI / 2));
    [[-0.2, -0.3], [0.2, -0.3], [-0.2, 0.3], [0.2, 0.3]].forEach((a) => part(NPC_BOX, dark, 0.025, 0.16, 0.025, a[0], 0.29, a[1]));
    part(NPC_CYL, dark, 0.018, 0.54, 0.018, 0, 0.98, 0.47, Math.PI / 2);
    return g;
  }

  function npcPlanTrip(itemsCap) {
    const N = Math.max(1, store.layout.aisleCount | 0);
    const by = new Map();
    placementMap.forEach((pl, pid) => { if (!by.has(pl.aisle)) by.set(pl.aisle, []); by.get(pl.aisle).push({ pid, pl }); });
    if (!by.size) return null;
    const shuffle = (a) => a.slice().sort(() => Math.random() - 0.5);
    const aisles = shuffle(Array.from(by.keys())).slice(0, 1 + Math.floor(Math.random() * Math.min(Math.max(1, store.ai.maxAisles), by.size)));
    const lane = (Math.random() < 0.5 ? -1 : 1) * (roomHalfX - 1.3), FRONT = 4.9, BACK = -10.2;
    const wp = []; let atFront = true;
    aisles.forEach((a) => {
      const cx = (a - (N - 1) / 2) * AISLE_SPACING;
      const list = shuffle(by.get(a)).slice(0, 1 + Math.floor(Math.random() * Math.max(1, itemsCap || 3)));
      list.sort((p, q) => (atFront ? 1 : -1) * (slotWorld(p.pl, N).z - slotWorld(q.pl, N).z));
      wp.push({ x: cx, z: atFront ? FRONT : BACK });
      list.forEach((it) => {
        const w = slotWorld(it.pl, N);
        const side = w.x > cx ? 1 : -1;
        wp.push({ x: cx + side * 0.72, z: w.z, side, cx, pick: { pid: it.pid, wx: w.x, wy: w.y, wz: w.z } });
      });
      wp.push({ x: cx, z: atFront ? BACK : FRONT });
      atFront = !atFront;
    });
    wp.push({ x: lane, z: atFront ? FRONT : BACK });
    if (!atFront) wp.push({ x: lane, z: FRONT });
    wp.push({ x: lane, z: 9.3, checkout: true });
    return wp;
  }

  function pickProfile(ai) {
    const list = ai.profiles || [];
    if (!list.length) return { speed: 1, maxItems: 0, color: '' };
    const total = list.reduce((a, p) => a + (p.weight || 1), 0);
    let r = Math.random() * total;
    for (const p of list) { r -= (p.weight || 1); if (r <= 0) return p; }
    return list[list.length - 1];
  }

  function spawnNPC() {
    const ai = store.ai;
    if (!ai.enabled) return;
    if (npcList.length >= Math.min(ai.maxShoppers, currentDPR < 1 ? 2 : ai.maxShoppers)) return;
    const prof = pickProfile(ai);
    const wp = npcPlanTrip(prof.maxItems > 0 ? prof.maxItems : ai.maxItemsPerAisle); if (!wp) return;
    const sx = (Math.random() - 0.5) * 4;
    if (mode === 'play' && Math.hypot(sx - player.pos.x, 10.8 - player.pos.z) < 2.4) { npcSpawnTimer = 1; return; }
    let handle = null;
    const names = ai.names.length ? ai.names : AI_DEFAULT_NAMES;
    for (let k = 0; k < names.length && !handle; k++) {
      const h = names[(handleCursor++) % names.length];
      if (!npcList.some((o) => o.handle === h)) handle = h;
    }
    if (!handle) return;
    const palette = ai.cartColors.length ? ai.cartColors : AI_DEFAULT_COLORS;
    const color = prof.color || palette[Math.floor(Math.random() * palette.length)];
    const group = makeNPCCart(color);
    const tagCanvas = document.createElement('canvas'); tagCanvas.width = 360; tagCanvas.height = 90;
    const tagTex = new THREE.CanvasTexture(tagCanvas); tagTex.encoding = THREE.sRGBEncoding;
    const tagMat = new THREE.SpriteMaterial({ map: tagTex, transparent: true });
    const tag = new THREE.Sprite(tagMat); tag.scale.set(1.15, 0.2875, 1); tag.position.set(0, 1.5, 0);
    tag.visible = ai.showTags !== false;
    group.add(tag);
    const n = { group, tag, tagMat, tagTex, tagCanvas, handle, color, x: sx, z: 10.8, yaw: 0, speed: 0, wp, speedMul: prof.speed || 1, i: 0, state: 'walk', age: 0, life: 0, timer: 0, bt: 0, rumble: 0, items: [], stuck: 0 };
    drawTag(n, false);
    group.position.set(n.x, 0, n.z);
    group.scale.setScalar(0.01);
    npcGroup.add(group);
    npcList.push(n);
    poof(n.x, n.z, 36, 0.5);
  }

  function drawTag(n, paid) {
    const x = n.tagCanvas.getContext('2d');
    x.clearRect(0, 0, 360, 90);
    const rr = (ctx, a, b, w, h, r) => {
      ctx.beginPath(); ctx.moveTo(a + r, b);
      ctx.arcTo(a + w, b, a + w, b + h, r);
      ctx.arcTo(a + w, b + h, a, b + h, r);
      ctx.arcTo(a, b + h, a, b, r);
      ctx.arcTo(a, b, a + w, b, r);
      ctx.closePath();
    };
    rr(x, 4, 10, 352, 70, 35);
    x.fillStyle = 'rgba(12,24,20,.9)'; x.fill();
    x.strokeStyle = paid ? '#3ddc97' : 'rgba(126,224,184,.45)';
    x.lineWidth = 3; x.stroke();
    x.fillStyle = n.color; x.beginPath(); x.arc(45, 45, 22, 0, 6.283); x.fill();
    x.fillStyle = '#fff'; x.font = '700 26px Helvetica,Arial,sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText((n.handle.replace(/^[^A-Za-z0-9]+/, '').charAt(0) || '?').toUpperCase(), 45, 46);
    x.textAlign = 'left';
    let fs = 29; x.font = '700 ' + fs + 'px Helvetica,Arial,sans-serif';
    while (x.measureText(n.handle).width > 170 && fs > 14) { fs--; x.font = '700 ' + fs + 'px Helvetica,Arial,sans-serif'; }
    x.fillText(n.handle, 80, 46);
    x.textAlign = 'right'; x.fillStyle = paid ? '#7ee0b8' : '#cfe3da';
    x.font = '700 25px Helvetica,Arial,sans-serif';
    x.fillText(paid ? 'paid ✓' : '🛒 ' + n.items.length, 340, 47);
    n.tagTex.needsUpdate = true;
  }

  function addCartItem(n, pid) {
    const p = store.products.find((x) => x.id === pid); if (!p) return;
    const imgs = productImages(p);
    const mat = new THREE.SpriteMaterial({ map: getProductBillboardTexture(p, imgs[0] || p.image), transparent: true, alphaTest: 0.1 });
    const sp = new THREE.Sprite(mat); sp.center.set(0.5, 0); sp.scale.set(0.2, 0.25, 1);
    const idx = n.items.length;
    sp.position.set(((idx % 3) - 1) * 0.15, 0.4 + Math.floor(idx / 9) * 0.1, (Math.floor(idx / 3) % 3 - 1) * 0.24);
    n.group.add(sp);
    n.items.push({ sp, y0: sp.position.y, ph: Math.random() * 6 });
    drawTag(n, false);
  }
  function nextSlot(n) {
    const idx = n.items.length;
    return new THREE.Vector3(((idx % 3) - 1) * 0.15, 0.55 + Math.floor(idx / 9) * 0.1, (Math.floor(idx / 3) % 3 - 1) * 0.24);
  }
  function doPick(n, pk) {
    const p = store.products.find((x) => x.id === pk.pid); if (!p) return;
    const imgs = productImages(p);
    const mat = new THREE.SpriteMaterial({ map: getProductBillboardTexture(p, imgs[0] || p.image), transparent: true, alphaTest: 0.1 });
    const sp = new THREE.Sprite(mat); sp.scale.set(0.2, 0.25, 1);
    sp.position.set(pk.wx, pk.wy + 0.15, pk.wz); npcGroup.add(sp);
    flights.push({ sp, n, pid: pk.pid, t: 0, from: sp.position.clone(), slot: nextSlot(n) });
  }
  function stepNPC(n, dt, t) {
    const g = n.group;
    n.age += dt; n.life += dt;
    const sc = Math.min(1, n.age / 0.6);
    if (n.state !== 'vanish') g.scale.setScalar(Math.max(0.01, 1 + 2.7 * Math.pow(sc - 1, 3) + 1.7 * Math.pow(sc - 1, 2)));
    if (n.life > store.ai.maxShopTime && n.state === 'walk') { n.state = 'checkout'; n.timer = 0.01; }
    const fx = -Math.sin(n.yaw), fz = -Math.cos(n.yaw);
    let moving = false;
    if (n.state === 'walk') {
      const w = n.wp[n.i], dx = w.x - n.x, dz = w.z - n.z, d = Math.hypot(dx, dz);
      let diff = Math.atan2(-dx, -dz) - n.yaw;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      n.yaw += clamp(diff, -2.8 * dt, 2.8 * dt);
      let target = store.ai.walkSpeed * (n.speedMul || 1);
      if (Math.abs(diff) > 0.7) target *= 0.3;
      if (w.pick || w.checkout) target *= clamp(d / 0.9, 0.2, 1);
      if (n.age < 0.5) target = 0;
      n.speed += (target - n.speed) * Math.min(1, dt * 4);
      n.x += fx * n.speed * dt; n.z += fz * n.speed * dt;
      moving = true;
      n.stuck = n.speed < 0.08 && n.age > 0.6 ? n.stuck + dt : 0;
      if (d < 0.22 || n.stuck > 5) {
        n.stuck = 0;
        if (w.pick && d < 0.4) { n.state = 'pick'; n.timer = 0.6 + Math.random() * 0.7; }
        else if (w.checkout && d < 0.5) { n.state = 'checkout'; n.timer = 1.9; drawTag(n, true); }
        else n.i = Math.min(n.i + 1, n.wp.length - 1);
      }
    } else if (n.state === 'pick') {
      n.speed *= Math.max(0, 1 - dt * 8);
      n.timer -= dt;
      if (n.timer <= 0) {
        const w = n.wp[n.i]; doPick(n, w.pick); n.i++; n.state = 'walk';
      }
    } else if (n.state === 'checkout') {
      n.speed *= Math.max(0, 1 - dt * 8);
      n.timer -= dt;
      if (n.timer <= 0) { n.state = 'vanish'; n.vt = 0; poof(n.x, n.z, 90, 0.9); }
    } else if (n.state === 'vanish') {
      n.vt += dt;
      const k = Math.max(0, 1 - n.vt / 0.3);
      g.scale.set(k, Math.max(0.01, k), k);
      if (n.vt >= 0.3) n.dead = true;
    }
    n.rumble *= Math.exp(-dt * 5);
    const sh = (moving ? n.speed * 0.0035 : 0) + n.rumble * 0.018;
    g.position.set(n.x + (Math.random() - 0.5) * sh * 2, (Math.random() - 0.5) * sh, n.z + (Math.random() - 0.5) * sh * 2);
    g.rotation.y = n.yaw;
    n.items.forEach((it) => { it.sp.position.y = it.y0 + Math.abs(Math.sin(t * 25 + it.ph)) * 0.05 * n.rumble; });
  }
  function removeNPC(n) {
    npcGroup.remove(n.group);
    try { n.tagTex.dispose(); n.tagMat.dispose(); } catch { /* */ }
    n.items.forEach((it) => { try { it.sp.material.dispose(); } catch { /* */ } });
    for (let i = flights.length - 1; i >= 0; i--) if (flights[i].n === n) {
      npcGroup.remove(flights[i].sp);
      try { flights[i].sp.material.dispose(); } catch { /* */ }
      flights.splice(i, 1);
    }
  }
  function clearNPCs() { npcList.forEach(removeNPC); npcList.length = 0; wobbles.length = 0; }
  function updateNPCs(dt, t) {
    if (!grains) return;
    grains.mat.uniforms.uScale.value = renderer.domElement.height / (2 * Math.tan(camera.fov * Math.PI / 360));
    const ai = store.ai;
    if (!ai.enabled && npcList.length) clearNPCs();
    npcSpawnTimer -= dt;
    if (npcSpawnTimer <= 0) {
      npcSpawnTimer = ai.spawnMin + Math.random() * Math.max(0, ai.spawnMax - ai.spawnMin);
      if (ai.enabled) spawnNPC();
    }
    for (let i = npcList.length - 1; i >= 0; i--) {
      const n = npcList[i];
      stepNPC(n, dt, t);
      if (n.dead) { removeNPC(n); npcList.splice(i, 1); }
    }
    for (let i = flights.length - 1; i >= 0; i--) {
      const f = flights[i];
      f.t += dt / 0.55;
      const k = Math.min(1, f.t), e = k * k * (3 - 2 * k);
      f.n.group.updateMatrixWorld(true);
      const to = f.n.group.localToWorld(f.slot.clone());
      f.sp.position.set(
        f.from.x + (to.x - f.from.x) * e,
        f.from.y + (to.y - f.from.y) * e + Math.sin(Math.PI * k) * 0.35,
        f.from.z + (to.z - f.from.z) * e
      );
      if (f.t >= 1) {
        npcGroup.remove(f.sp);
        try { f.sp.material.dispose(); } catch { /* */ }
        flights.splice(i, 1);
        if (f.n.state !== 'vanish') addCartItem(f.n, f.pid);
      }
    }
    grains.update(dt);
  }

  /* =========================================================
     RENDER LOOP
     ========================================================= */
  function resize() {
    if (!renderer || !camera) return;
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  function updateAim() {
    let aid = null;
    if (mode === 'play' && !uiLock) {
      ndc.set(0, 0);
      raycaster.setFromCamera(ndc, camera);
      const h = raycaster.intersectObjects(productMeshes, true)[0];
      if (h && h.distance < 5.5) aid = findProductId(h.object);
    }
    if (aid !== aimProductId) {
      aimProductId = aid;
      const p = aid && store.products.find((x) => x.id === aid);
      aimProductLabel = p ? `${p.name} · ${fmt(p.price)}` : '';
    }
  }
  function loop(now) {
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    if (mode === 'welcome') {
      const t = now * 0.001;
      camera.position.set(Math.sin(t * 0.16) * 3.2, 2.05, 9.6 + Math.cos(t * 0.1) * 0.6);
      camera.lookAt(0, 1.15, -4);
      if (cartGroup) cartGroup.visible = false;
    } else {
      if (cartGroup) cartGroup.visible = true;
      if (!uiLock) updatePlayer(dt);
      else {
        camera.position.set(player.pos.x, CFG.eyeHeight, player.pos.z);
        camera.rotation.z *= 0.8;
        camera.rotation.y = player.yaw;
        camera.rotation.x = player.pitch;
      }
      updateCartPose();
      decayBump(dt);
      stepBasketPhysics(dt);
    }
    updateShelfCarousels(dt);
    aimTimer += dt;
    if (aimTimer > 0.12) { aimTimer = 0; updateAim(); }
    updateNPCs(dt, now * 0.001);
    dust?.update(now * 0.001);
    try { renderer.render(scene, camera); } catch { /* */ }
    frameTimes.push(dt * 1000);
    if (frameTimes.length >= 90) {
      const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
      frameTimes = [];
      if (avg > 34 && currentDPR > 0.75) {
        currentDPR = Math.max(0.75, currentDPR - 0.25);
        renderer.setPixelRatio(currentDPR); resize();
      } else if (avg < 19 && currentDPR < maxDPR) {
        currentDPR = Math.min(maxDPR, currentDPR + 0.25);
        renderer.setPixelRatio(currentDPR); resize();
      }
    }
    rafId = requestAnimationFrame(loop);
  }

  /* =========================================================
     MODE / ADMIN
     ========================================================= */
  function enterStore(resume) {
    Audio.setEnabled(!store.settings.muted);
    mode = 'play';
    if (!resume) startNewTrip();
    else {
      const session = LS.get(K_SESSION, null);
      if (session) {
        player.pos.set(session.x || 0, 0, session.z || 9.8);
        player.yaw = session.yaw || 0;
        player.pitch = clamp(session.pitch || 0, -1, 1);
      } else {
        player.pos.set(0, 0, 9.8);
        player.yaw = 0; player.pitch = 0;
      }
      clampPlayerInside();
    }
    if (!LS.get(K_TUT, false)) setTimeout(() => { tutorialStep = 0; openSheet('tutorial'); }, 420);
  }
  function backToWelcome() {
    mode = 'welcome';
    activeSheet = null;
    saveSession();
  }

  /* =========================================================
     LIFECYCLE
     ========================================================= */

    const increaseProgress = (limit = 100, speed = 0.1) => {
        progress.perc = (progress.perc || 0) + (limit - (progress.perc || 0)) * speed;
        if (!threeReady) setTimeout(increaseProgress, 50);
        console.log(progress.perc)
    };

  onMount(() => {
    let cancelled = false;
    (async () => {
      if (!validStore(data?.store)) {
        try {
          progress.text = 'Getting store ready'
        
          increaseProgress()
          const s = await loadStore();
          if (!validStore(s)) throw new Error('The store data from the server is incomplete.');
          store = s;
            progress.text = 'All set'
        } catch (e) {
          loadError = e?.message || 'Could not load the store.';
          progress.text = 'Something went wrong'
          return;
        }
      }
      if (!cancelled) initThree();
    })();
    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onResize);
      if (canvasEl) {
        canvasEl.removeEventListener('pointerdown', onCanvasDown);
        canvasEl.removeEventListener('pointermove', onCanvasMove);
        canvasEl.removeEventListener('pointerup', onCanvasUp);
        canvasEl.removeEventListener('pointercancel', onCanvasCancel);
      }
      try { renderer?.dispose(); } catch { /* */ }
    };
  });

  /* =========================================================
     JOYSTICK
     ========================================================= */
  function joyHandle(e) {
    if (mode !== 'play' || uiLock) return;
    const el = document.getElementById('joyEl');
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = e.clientX - cx, dy = e.clientY - cy;
    const max = rect.width / 2 - 12;
    const d = Math.hypot(dx, dy);
    if (d > max) { dx = dx / d * max; dy = dy / d * max; }
    el.classList.add('on');
    const knob = document.getElementById('knob');
    if (knob) knob.style.transform = `translate(${dx}px,${dy}px)`;
    joyVec.x = dx / max; joyVec.y = -dy / max;
  }
  function joyReset() {
    joyVec.x = joyVec.y = 0;
    const knob = document.getElementById('knob');
    if (knob) knob.style.transform = 'translate(0,0)';
    document.getElementById('joyEl')?.classList.remove('on');
    joyPointer = null;
  }
  function joyDown(e) {
    if (mode !== 'play' || uiLock) return;
    joyPointer = e.pointerId;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* */ }
    joyHandle(e);
    e.preventDefault();
  }
  function joyMove(e) { if (e.pointerId === joyPointer) { joyHandle(e); e.preventDefault(); } }
  function joyUp(e) { if (e.pointerId === joyPointer) joyReset(); }
</script>

<svelte:head>
  <title>Breathe — Virtual Supermarket</title>
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover" />
  <meta name="theme-color" content="#0f1112" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@600;700;800&family=Figtree:wght@400;500;600;700&display=swap" rel="stylesheet" />
</svelte:head>

<canvas bind:this={canvasEl} class="fixed inset-0 w-full h-full block touch-none bg-[#0f1112]" />

<!-- ============ HUD ============ -->
{#if threeReady && mode === 'play'}
  <div class="fixed inset-0 pointer-events-none z-20">
    <div class="absolute top-0 left-0 right-0 flex items-center gap-2 pt-[calc(env(safe-area-inset-top,0px)+10px)] px-3 pb-2.5 pointer-events-auto">
      <div class="flex-1"></div>
      <button onclick={openSearch} class="w-10 h-10 rounded-full bg-[#14181a]/60 border border-white/15 text-white flex items-center justify-center backdrop-blur-md" aria-label="Search"><MagnifyingGlass size={18} /></button>
      <button onclick={() => { const on = !Audio.isOn(); Audio.setEnabled(on); store.settings.muted = !on; saveStore(); }} class="w-10 h-10 rounded-full bg-[#14181a]/60 border border-white/15 text-white flex items-center justify-center backdrop-blur-md" aria-label="Sound">
        {#if Audio.isOn()}<SpeakerHigh size={18} />{:else}<SpeakerSlash size={18} />{/if}
      </button>
      <button id="cartPill" onclick={() => openSheet('cartSheet')} class="flex items-center gap-2 rounded-full px-3.5 py-2 text-[12.5px] font-bold text-white border border-white/20 bg-[#14181a]/75 backdrop-blur-md">
        <span class="bg-black rounded-full px-1.5 py-px text-[11.5px]">{cartCount}</span>
        <span>{cartTotal > 0? 'Checkout' : 'Empty Cart'}</span>
      </button>
    </div>
    <div class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-2 rounded-full border-2 border-white/75 shadow pointer-events-none transition-all duration-200"
         class:w-9={!!aimProductId} class:h-9={!!aimProductId}
         class:bg-[#7ee0b8]={!!aimProductId} class:border-[#7ee0b8]={!!aimProductId}></div>
    {#if aimProductId && aimProductLabel}
      <button onclick={() => openProductCard(aimProductId)}
              class="absolute left-1/2 top-[calc(50%+34px)] -translate-x-1/2 max-w-[80vw] truncate border border-[#7ee0b8]/50 bg-[#0e2820]/80 text-white font-bold text-[13px] px-3.5 py-2 rounded-full backdrop-blur-md pointer-events-auto">
        {aimProductLabel}
      </button>
    {/if}
    <div id="joyEl"
         onpointerdown={joyDown} onpointermove={joyMove}
         onpointerup={joyUp} onpointercancel={joyUp} onpointerleave={joyUp}
         class="absolute left-4 bottom-[calc(env(safe-area-inset-bottom,0px)+26px)] w-[116px] h-[116px] rounded-full touch-none pointer-events-auto"
         style="background:radial-gradient(circle,rgba(255,255,255,.06),rgba(255,255,255,.2));border:1px solid rgba(255,255,255,.3);box-shadow:inset 0 0 24px rgba(255,255,255,.12),0 8px 30px rgba(0,0,0,.25)">
      <div id="knob" class="absolute left-1/2 top-1/2 w-[50px] h-[50px] -mt-[25px] -ml-[25px] rounded-full"
           style="background:radial-gradient(circle at 35% 30%,#fff,#d4f1e4);box-shadow:0 3px 12px rgba(0,0,0,.28)"></div>
    </div>
  </div>
{/if}

<!-- ============ WELCOME ============ -->
{#if mode === 'welcome'}
  <div class="fixed inset-0 z-[60] flex flex-col justify-end px-[22px] pb-[calc(30px+env(safe-area-inset-bottom,0px))] pt-[26px]"
       style="background:radial-gradient(120% 70% at 50% 100%,rgba(10,40,32,.92) 0%,rgba(8,12,12,.55) 55%,rgba(8,10,10,.08) 100%)">
    <div class="text-[36px] tracking-[-.04em] text-white leading-none font-medium">Robbin'</div>
    <p class="text-white/78 text-[14.5px] mt-2 mb-[22px] max-w-[340px]">
      A pit stop to your next steal - Everything is legal. Relax...
    </p>
    <div class="flex flex-col gap-2.5 max-w-[420px]">
      {#if cart.lines.length > 0}
        <button onclick={() => enterStore(true)} class="rounded-[14px] px-3 py-2 text-[15.5px] font-bold text-white border border-white/35 bg-black/20 backdrop-blur-md">Resume Shopping</button>
        <button onclick={() => enterStore(false)} class="rounded-[14px] px-3 py-2 text-[15.5px] font-bold text-white border border-white/35 bg-white/10 backdrop-blur-md">Start New Trip</button>
      {:else}
        <button onclick={() => enterStore(false)} class="rounded-[14px] px-3 py-2 text-[15.5px] font-bold text-white border border-white/35 bg-black/20 backdrop-blur-md">Enter Store</button>
      {/if}
    </div>
    <p class="text-[11px] text-white/45 mt-4"></p>
  </div>
{/if}

<!-- ============ PRODUCT CARD (with carousel) ============ -->
{#if activeSheet === 'productCard' && cardProductId}
  {@const p = store.products.find((x) => x.id === cardProductId)}
  {@const cat = p && store.categories.find((x) => x.id === p.categoryId)}
  {@const safeIdx = Math.min(cardImageIndex, Math.max(0, cardImages.length - 1))}
  {#if p}
    <div class="fixed inset-0 z-[120] flex items-end md:items-center justify-center bg-[#090c0c]/42 backdrop-blur-sm" onclick={() => closeSheet('productCard')}>
      <div class="w-full max-w-[520px] max-h-[90vh] overflow-auto bg-white rounded-t-[20px] md:rounded-[20px] p-[18px] pb-[calc(18px+env(safe-area-inset-bottom,0px))] md:pb-[18px]" onclick={(e) => e.stopPropagation()}>
        <div class="flex items-center gap-2.5 mb-3.5">
          <h2 class="text-[17px] m-0 font-bold tracking-tight" style="">Product</h2>
          <div class="flex-1"></div>
          <button onclick={() => closeSheet('productCard')} class="w-8 h-8 rounded-full border border-[#e3e7e4] bg-white flex items-center justify-center text-[#5a6662]"><X size={16} /></button>
        </div>

        <!-- image carousel -->
        <div class="relative w-full h-[150px] rounded-[14px] overflow-hidden mb-3.5">
          {#if cardImages.length}
            {#await imageSrc(cardImages[safeIdx]) then src}
              {#if src}
                <img src={src} alt={p.name} class="absolute inset-0 w-full h-full object-contain p-3 rounded-[28px]" />
              {:else}
                <span class="absolute inset-0 grid place-items-center text-3xl opacity-35">🛍️</span>
              {/if}
            {:catch}
              <span class="absolute inset-0 grid place-items-center text-3xl opacity-35">🛍️</span>
            {/await}
          {:else}
            <span class="absolute inset-0 grid place-items-center text-3xl opacity-35">🛍️</span>
          {/if}

          {#if cardImages.length > 1}
            <button onclick={() => cardImageIndex = (safeIdx - 1 + cardImages.length) % cardImages.length}
                    aria-label="Previous image"
                    class="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/95 border border-[#e3e7e4] grid place-items-center text-[#14181a] shadow">
              <CaretLeft size={16} weight="bold" />
            </button>
            <button onclick={() => cardImageIndex = (safeIdx + 1) % cardImages.length}
                    aria-label="Next image"
                    class="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/95 border border-[#e3e7e4] grid place-items-center text-[#14181a] shadow">
              <CaretRight size={16} weight="bold" />
            </button>
            <div class="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1 items-center">
              {#each cardImages as _, i}
                <button onclick={() => cardImageIndex = i}
                        class="h-1.5 rounded-full transition-all {i === safeIdx ? 'w-4 bg-[#1f6b57]' : 'w-1.5 bg-[#14181a]/30'}"></button>
              {/each}
            </div>
            <div class="absolute top-2 right-2 text-[10.5px] font-bold text-[#14181a] bg-white/85 border border-[#e3e7e4] rounded-full px-1.5 py-0.5">
              {safeIdx + 1}/{cardImages.length}
            </div>
          {/if}
        </div>

        <h3 class="text-[19px] font-bold tracking-tight m-0 mb-[3px]" style="">{p.name}</h3>
        <p class="text-[12.5px] text-[#5a6662] m-0 mb-3.5">{p.brand || '—'} · {cat?.name || 'Uncategorised'}</p>
        <p class="text-[23px] font-extrabold tracking-tight m-0 mb-4 text-green-600" style="">{fmt(p.price)}</p>
        <div class="flex items-stretch border border-[#e3e7e4] rounded-xl overflow-hidden mb-3.5">
          <button onclick={() => cardQty = Math.max(1, cardQty - 1)} class="w-11 h-11 bg-white text-[19px] font-semibold text-[#14181a] active:bg-[#f2f4f2]"><Minus size={16} class="inline" /></button>
          <div class="flex-1 text-center font-bold text-[15px] flex items-center justify-center">{cardQty}</div>
          <button onclick={() => cardQty = Math.min(99, cardQty + 1)} class="w-11 h-11 bg-white text-[19px] font-semibold text-[#14181a] active:bg-[#f2f4f2]"><Plus size={16} class="inline" /></button>
        </div>
        <button onclick={() => { addToCart(p, cardQty); closeSheet('productCard'); }}
                class="w-full rounded-xl px-4 py-3 text-[14.5px] bg-black font-bold text-white">
          Add to Cart
        </button>
      </div>
    </div>
  {/if}
{/if}

<!-- ============ CART ============ -->
{#if activeSheet === 'cartSheet'}
  <div class="fixed inset-0 z-[120] flex items-end md:items-center justify-center bg-[#090c0c]/42 backdrop-blur-sm" onclick={() => closeSheet('cartSheet')}>
    <div class="w-full max-w-[520px] max-h-[90vh] overflow-auto bg-white rounded-t-[20px] md:rounded-[20px] p-[18px] pb-[calc(18px+env(safe-area-inset-bottom,0px))] md:pb-[18px]" onclick={(e) => e.stopPropagation()}>
      <div class="flex items-center gap-2.5 mb-3.5">
        <h2 class="text-[17px] m-0 font-bold" style="">Your cart</h2>
        <div class="flex-1"></div>
        <button onclick={() => closeSheet('cartSheet')} class="w-8 h-8 rounded-full border border-[#e3e7e4] bg-white flex items-center justify-center text-[#5a6662]"><X size={16} /></button>
      </div>
      {#if !cart.lines.length}
        <div class="text-center text-[#5a6662] py-7 text-[13.5px]">Your cart is empty.<br><span class="text-[11.5px]">Walk the aisles or use search to find something.</span></div>
        <button onclick={() => closeSheet('cartSheet')} class="w-full rounded-xl border border-[#e3e7e4] bg-white px-4 py-2.5 text-[14px] font-semibold text-[#14181a]">Continue Shopping</button>
      {:else}
        {#each cart.lines as l (l.lineId)}
          <div class="flex gap-3 items-center py-2.5 border-b border-[#e3e7e4] last:border-0">
            <div class="w-12 h-12 rounded-[10px] bg-[#f2f4f2] grid place-items-center overflow-hidden flex-none">
              {#await imageSrc(l.image) then src}
                {#if src}<img src={src} alt={l.name} class="max-w-[80%] max-h-[80%] object-contain" />{:else}<span class="opacity-40">·</span>{/if}
              {/await}
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-[13.5px] font-semibold leading-tight truncate">{l.name}</div>
              <div class="text-[11.5px] text-[#5a6662] mt-0.5">{l.brand || ''} · {fmt(l.price)}</div>
            </div>
            <div class="flex items-stretch border border-[#e3e7e4] rounded-xl overflow-hidden w-[104px] flex-none">
              <button onclick={() => setLineQty(l.lineId, l.qty - 1)} class="w-8 h-9 bg-white flex items-center justify-center"><Minus size={12} /></button>
              <div class="flex-1 text-center font-bold text-[13px] flex items-center justify-center">{l.qty}</div>
              <button onclick={() => setLineQty(l.lineId, l.qty + 1)} class="w-8 h-9 bg-white flex items-center justify-center"><Plus size={12} /></button>
            </div>
          </div>
        {/each}
        <div class="flex justify-between py-1.5 text-[14px] mt-3"><span>Subtotal</span><span>{fmt(cartTotal)}</span></div>
        <div class="flex justify-between py-3 text-[17px] font-extrabold border-t border-[#e3e7e4] mt-2" style=""><span>Total</span><span class="text-green-600">{fmt(cartTotal)}</span></div>
        <div class="flex flex-col gap-2.5 mt-4">
          <button onclick={() => { closeSheet('cartSheet'); startCheckout(); }} class="w-full rounded-xl px-4 py-3 text-[14.5px] font-bold text-white bg-black" >Checkout</button>
          <button onclick={() => closeSheet('cartSheet')} class="w-full rounded-xl border border-[#e3e7e4] bg-white px-4 py-2.5 text-[14px] font-semibold text-[#14181a]">Continue Shopping</button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<!-- ============ SEARCH ============ -->
{#if activeSheet === 'searchSheet'}
  <div class="fixed inset-0 z-[120] flex items-end md:items-center justify-center bg-[#090c0c]/42 backdrop-blur-sm" onclick={() => closeSheet('searchSheet')}>
    <div class="w-full max-w-[520px] max-h-[90vh] overflow-auto bg-white rounded-t-[20px] md:rounded-[20px] p-[18px] pb-[calc(18px+env(safe-area-inset-bottom,0px))] md:pb-[18px]" onclick={(e) => e.stopPropagation()}>
      <div class="flex items-center gap-2.5 mb-3.5">
        <h2 class="text-[17px] m-0 font-bold" style="">Find a product</h2>
        <div class="flex-1"></div>
        <button onclick={() => closeSheet('searchSheet')} class="w-8 h-8 rounded-full border border-[#e3e7e4] bg-white flex items-center justify-center text-[#5a6662]"><X size={16} /></button>
      </div>
      <input id="searchInput" type="text" placeholder="Search by name, brand or category…" autocomplete="off" bind:value={searchQuery}
             class="w-full px-3 py-2.5 border border-[#e3e7e4] rounded-[11px] text-[14.5px] outline-none focus:border-[#1f6b57] focus:ring-2 focus:ring-[#1f6b57]/10" />
      <div class="flex flex-wrap gap-1.5 my-3">
        <button onclick={() => searchCategory = 'all'} class="rounded-full px-3 py-1.5 text-[12px] font-bold text-white {searchCategory === 'all' ? 'bg-[#1f6b57]' : 'bg-[#14181a]/75'}">All</button>
        {#each store.categories as c (c.id)}
          <button onclick={() => searchCategory = c.id} class="rounded-full px-3 py-1.5 text-[12px] font-bold text-white {searchCategory === c.id ? 'bg-[#1f6b57]' : 'bg-[#14181a]/75'}">{c.name}</button>
        {/each}
      </div>
      {#if !searchResults.length}
        <div class="text-center text-[#5a6662] py-7 text-[13.5px]">No products match.</div>
      {:else}
        {#each searchResults as p (p.id)}
          {@const pl = placementMap.get(p.id)}
          {@const pImgs = productImages(p)}
          <button onclick={() => openAisleFromSearch(p)} class="w-full flex gap-3 items-center py-2.5 border-b border-[#e3e7e4] last:border-0 text-left">
            <div class="w-12 h-12 rounded-[10px] bg-[#f2f4f2] grid place-items-center overflow-hidden flex-none relative">
              {#await imageSrc(pImgs[0]) then src}
                {#if src}<img src={src} alt={p.name} class="max-w-[80%] max-h-[80%] object-contain" />{:else}<span class="opacity-40">·</span>{/if}
              {/await}
              {#if pImgs.length > 1}
                <span class="absolute bottom-0.5 right-0.5 text-[9px] font-bold bg-[#1f6b57] text-white rounded-full px-1">{pImgs.length}</span>
              {/if}
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-[13.5px] font-semibold leading-tight truncate">{p.name}</div>
              <div class="text-[11.5px] text-[#5a6662] mt-0.5">{p.brand || ''} · {pl ? `Aisle ${pl.aisle + 1} · Shelf ${pl.level + 1}` : 'In store'}</div>
            </div>
            <div class="text-[13px] font-bold whitespace-nowrap">{fmt(p.price)}</div>
          </button>
        {/each}
      {/if}
    </div>
  </div>
{/if}

<!-- ============ CHECKOUT: BILL ============ -->
{#if activeSheet === 'billSheet'}
  {@const problems = validateCartForCheckout()}
  <div class="fixed inset-0 z-[120] flex items-end md:items-center justify-center bg-[#090c0c]/42 backdrop-blur-sm" onclick={() => closeSheet('billSheet')}>
    <div class="w-full max-w-[520px] max-h-[90vh] overflow-auto bg-white rounded-t-[20px] md:rounded-[20px] p-[18px] pb-[calc(18px+env(safe-area-inset-bottom,0px))] md:pb-[18px]" onclick={(e) => e.stopPropagation()}>
      <div class="flex items-center gap-2.5 mb-3.5">
        <h2 class="text-[17px] m-0 font-bold" style="">Checkout</h2>
        <div class="flex-1"></div>
        <button onclick={() => closeSheet('billSheet')} class="w-8 h-8 rounded-full border border-[#e3e7e4] bg-white flex items-center justify-center text-[#5a6662]"><X size={16} /></button>
      </div>
      {#if problems.length}
        <p class="text-[11.5px] text-[#b23a2f] mb-3">Some items are no longer available. Remove them to continue.</p>
        {#each problems as p (p.lineId)}
          <div class="flex items-center gap-3 py-2.5 border-b border-[#e3e7e4] last:border-0">
            <div class="flex-1"><div class="text-[13.5px] font-semibold">{p.name}</div><div class="text-[11.5px] text-[#5a6662]">{p.reason}</div></div>
            <button onclick={() => removeLine(p.lineId)} class="px-2.5 py-1.5 text-[12.5px] font-bold text-[#b23a2f] border border-[#f0d6d2] rounded-[10px]">Remove</button>
          </div>
        {/each}
        <button onclick={() => closeSheet('billSheet')} class="w-full mt-3 rounded-xl border border-[#e3e7e4] bg-white px-4 py-2.5 text-[14px] font-semibold text-[#14181a]">Back</button>
      {:else}
        {#each cart.lines as l (l.lineId)}
          <div class="flex items-center gap-3 py-2.5 border-b border-[#e3e7e4] last:border-0">
            <div class="flex-1"><div class="text-[13.5px] font-semibold">{l.name}</div><div class="text-[11.5px] text-[#5a6662]">{l.qty} × {fmt(l.price)}</div></div>
            <div class="text-[13px] font-bold">{fmt(l.price * l.qty)}</div>
          </div>
        {/each}
        <div class="flex justify-between py-1.5 text-[14px]"><span>Subtotal</span><span>{fmt(cartTotal)}</span></div>
        <div class="flex justify-between py-3 text-[17px] font-extrabold border-t border-[#e3e7e4] mt-2" style=""><span>Total payable</span><span>{fmt(cartTotal)}</span></div>
        <div class="flex flex-col gap-2.5 mt-4">
          <button onclick={goToPayment} class="w-full rounded-xl px-4 py-3 text-[14.5px] font-bold text-white" style="background:linear-gradient(180deg,#27806a,#1b5e4d);box-shadow:0 6px 18px rgba(31,107,87,.35)">Continue</button>
          <button onclick={() => closeSheet('billSheet')} class="w-full rounded-xl border border-[#e3e7e4] bg-white px-4 py-2.5 text-[14px] font-semibold text-[#14181a]">Back</button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<!-- ============ CHECKOUT: PAY ============ -->
{#if activeSheet === 'paySheet'}
  <div class="fixed inset-0 z-[120] flex items-end md:items-center justify-center bg-[#090c0c]/42 backdrop-blur-sm" onclick={() => closeSheet('paySheet')}>
    <div class="w-full max-w-[520px] max-h-[90vh] overflow-auto bg-white rounded-t-[20px] md:rounded-[20px] p-[18px] pb-[calc(18px+env(safe-area-inset-bottom,0px))] md:pb-[18px]" onclick={(e) => e.stopPropagation()}>
      <div class="flex items-center gap-2.5 mb-3.5">
        <h2 class="text-[17px] m-0 font-bold" style="">Payment</h2>
        <div class="flex-1"></div>
        <button onclick={() => closeSheet('paySheet')} class="w-8 h-8 rounded-full border border-[#e3e7e4] bg-white flex items-center justify-center text-[#5a6662]"><X size={16} /></button>
      </div>
      <div class="bg-[#fdf7e8] border border-[#f0e2bf] rounded-xl p-3 mb-4">
        <div class="text-[11.5px] text-[#7a5a12] font-bold">DEMONSTRATION ONLY</div>
        <div class="text-[11.5px] text-[#7a5a12]">This is a simulated payment. No real card details are collected and no money is charged.</div>
      </div>
      <div class="flex justify-between py-3 text-[17px] font-extrabold border-t border-b border-[#e3e7e4]" style=""><span>Amount</span><span>{fmt(cartTotal)}</span></div>
      <div class="mt-4 mb-3">
        <label class="block text-[11.5px] font-bold text-[#5a6662] mb-1.5 uppercase tracking-wider">Payment method</label>
        <select class="w-full px-3 py-2.5 border border-[#e3e7e4] rounded-[11px] text-[14.5px] outline-none focus:border-[#1f6b57]">
          <option>Demo Card</option><option>Demo Mobile Money</option><option>Demo Cash at counter</option>
        </select>
      </div>
      <button onclick={() => { closeSheet('paySheet'); runPayment(true); }} class="w-full rounded-xl px-4 py-3 text-[14.5px] font-bold text-white" style="background:linear-gradient(180deg,#27806a,#1b5e4d);box-shadow:0 6px 18px rgba(31,107,87,.35)">Pay {fmt(cartTotal)}</button>
      <button onclick={() => toast('Payment declined — simulated')} class="w-full mt-2 rounded-xl border border-[#f0d6d2] bg-white px-4 py-2.5 text-[13.5px] font-semibold text-[#b23a2f]">Simulate declined payment</button>
    </div>
  </div>
{/if}

<!-- ============ RECEIPT ============ -->
{#if activeSheet === 'receiptSheet'}
  {@const promoUrl = safeUrl(store.promo.url)}
  <div class="fixed inset-0 z-[120] flex items-end md:items-center justify-center bg-[#090c0c]/42 backdrop-blur-sm" onclick={() => closeSheet('receiptSheet')}>
    <div class="w-full max-w-[520px] max-h-[90vh] overflow-auto bg-white rounded-t-[20px] md:rounded-[20px] p-[18px] pb-[calc(18px+env(safe-area-inset-bottom,0px))] md:pb-[18px]" onclick={(e) => e.stopPropagation()}>
      <div class="flex items-center gap-2.5 mb-3.5">
        <div class="flex-1"></div>
        <button onclick={() => closeSheet('receiptSheet')} class="w-8 h-8 rounded-full border border-[#e3e7e4] bg-white flex items-center justify-center text-[#5a6662]"><X size={16} /></button>
      </div>
      <div class="flex justify-center w-full">
        <div>
          <div class="flex justify-center"><CheckCircle size={150} weight='duotone' class='text-green-600' /></div>
          <div class="text-[22px] text-center tracking-tight">Ready in less than 24 hours</div>
          <div class="mb-5 text-[14px] text-center tracking-tight text-black/60">We're processing your order. We'll notify you when it's ready. Fees may apply.</div>
        </div>
      </div>
      {#if store.promo.enabled !== false}
        <div class="border border-[#e3e7e4] rounded-[14px] p-3.5 flex gap-3 items-center bg-[#fafbfa] mb-3.5">
          <div class="w-[42px] h-[42px] rounded-[11px] bg-[#14181a] text-white grid place-items-center flex-none"><GameController size={20} /></div>
          <div class="flex-1 min-w-0">
            <div class="text-[13.5px] font-semibold leading-tight">{store.promo.message || 'Take a break and play.'}</div>
            <div class="text-[11.5px] text-[#5a6662] mt-0.5">Opens in a new tab</div>
          </div>
          <button onclick={() => { if (!promoUrl) { toast('No game link configured'); return; } window.open(promoUrl, '_blank', 'noopener,noreferrer'); }}
                  disabled={!promoUrl} class="px-3 py-1.5 rounded-[10px] bg-black text-[12.5px] font-bold text-white disabled:opacity-40"
                  >{store.promo.label || 'Play Game'}</button>
        </div>
      {/if}
      <div class="flex flex-col gap-2.5">
        <button onclick={() => closeSheet('receiptSheet')} class="w-full rounded-xl px-4 py-3 text-[14.5px] font-bold text-white bg-black">Continue Shopping</button>
        <button onclick={() => { closeSheet('receiptSheet'); startNewTrip(); toast('New trip started'); }} class="w-full rounded-xl border border-[#e3e7e4] bg-white px-4 py-2.5 text-[14px] font-semibold text-[#14181a]">Start Fresh</button>
      </div>
    </div>
  </div>
{/if}

<!-- ============ TUTORIAL ============ -->
{#if activeSheet === 'tutorial'}
  {@const step = TUT_STEPS[tutorialStep]}
  <div class="fixed inset-0 z-[120] flex items-end md:items-center justify-center bg-[#090c0c]/42 backdrop-blur-sm">
    <div class="w-full max-w-[520px] max-h-[90vh] overflow-auto bg-white rounded-t-[20px] md:rounded-[20px] p-[18px] pb-[calc(18px+env(safe-area-inset-bottom,0px))] md:pb-[18px]">
      <div class="flex items-center gap-2.5 mb-3.5">
        <h2 class="text-[17px] m-0 font-bold" style="">Quick tour</h2>
        <div class="flex-1"></div>
        <button onclick={() => { LS.set(K_TUT, true); closeSheet('tutorial'); }} class="w-8 h-8 rounded-full border border-[#e3e7e4] bg-white flex items-center justify-center text-[#5a6662]"><X size={16} /></button>
      </div>
      <div class="text-[38px] mb-1.5">{step.icon}</div>
      <h3 class="text-[17px] m-0 mb-1.5">{step.title}</h3>
      <p class="text-[13px] leading-relaxed text-[#5a6662]">{step.text}</p>
      <div class="text-[11.5px] text-[#5a6662] mt-2.5">{tutorialStep + 1} of {TUT_STEPS.length}</div>
      <div class="flex items-center gap-2 mt-4">
        <button onclick={() => { LS.set(K_TUT, true); closeSheet('tutorial'); }} class="px-3 py-1.5 text-[12.5px] font-bold border border-[#e3e7e4] rounded-[10px] bg-white">Skip</button>
        <div class="flex-1"></div>
        <button onclick={() => { if (tutorialStep < TUT_STEPS.length - 1) tutorialStep += 1; else { LS.set(K_TUT, true); closeSheet('tutorial'); } }} class="px-3 py-1.5 text-[12.5px] font-bold text-white rounded-[10px]" style="background:linear-gradient(180deg,#27806a,#1b5e4d)">
          {tutorialStep === TUT_STEPS.length - 1 ? 'Start shopping' : 'Next'}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- ============ TOAST ============ -->
{#if toastText}
  <div class="fixed left-1/2 bottom-[calc(env(safe-area-inset-bottom,0px)+160px)] -translate-x-1/2 z-[80] border border-[#7ee0b8]/35 bg-[#0e1c18]/95 text-white text-[13px] font-semibold px-4 py-2.5 rounded-full backdrop-blur-md max-w-[82vw] text-center flex items-center gap-2">
    <span class="w-2 h-2 rounded-full bg-[#7ee0b8] flex-none"></span>
    <span>{toastText}</span>
  </div>
{/if}

{#if !threeReady}
  <div class="fixed inset-0 z-[150] bg-[#fff] text-black flex flex-col items-center justify-center gap-4 text-[14px] ">
    {#if loadError}
      <div class="max-w-[320px] text-center normal-case tracking-normal leading-snug px-4">
        <div class="font-bold mb-1">Could not load the store</div>
        <div class="text-white/70 text-[13px] mb-4">{loadError}</div>
        <button onclick={() => location.reload()} class="px-4 py-2 rounded-[10px] bg-white text-[#14181a] text-[13px] font-bold">Try again</button>
      </div>
    {:else}
      <div class="w-[250px] overflow-hidden bg-black/10 mb-5" style="border-radius: 30px;">
        <div class={`bg-black h-2 transition-all`} style={`width: ${progress.perc}%`}></div>
      </div>
      <span class="text-[26px] tracking-tight text-center px-4">Preparing your Robbin' experience</span>
      <span class="text-[14px] tracking-tight text-center px-4">{progress.text}</span>
    {/if}
  </div>
{/if}