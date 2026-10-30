/* src/lib/breathe.js
   ------------------------------------------------------------------
   Shared data layer for the store page (/) and the admin page (/admin).
   Everything that reads or writes catalogue, cart or image data lives here,
   so the server migration only has to replace the internals of these
   functions (loadStore, saveStoreData, ImgDB / imageSrc) with API calls.
   ------------------------------------------------------------------ */

export const K_STORE = 'breathe.store.v1';
export const K_CART = 'breathe.cart.v1';
export const K_TUT = 'breathe.tutorial.v1';
export const K_SESSION = 'breathe.session.v1';

export const DEFAULT_CATEGORIES = [
  { id: 'cat_drinks',    name: 'Drinks' },
  { id: 'cat_snacks',    name: 'Snacks' },
  { id: 'cat_dairy',     name: 'Dairy' },
  { id: 'cat_household', name: 'Household' },
  { id: 'cat_bakery',    name: 'Bakery' },
  { id: 'cat_produce',   name: 'Produce' }
];

export const AI_DEFAULT_NAMES = ['@thandi_m','@chikondi','@mwayi.k','@tadala_','@kondwani','@limbani','@yami.k','@temwa.b','@lusungu','@mphatso','@zione_','@nthenda','@chisomo','@tiyamike','@mercy_l','@patrick.c'];
export const AI_DEFAULT_COLORS = ['#e4572e','#2e86de','#f2a900','#8e5bd9','#1f6b57','#d6336c','#0ca678'];
export const HEX_RE = /^#[0-9a-fA-F]{6}$/;


export const LEVELS = [0.45, 1.05, 1.65];
export const SLOTS = 6;

export function svgPack(label, bg, fg) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="${bg}"/><rect x="14" y="86" width="228" height="84" rx="12" fill="rgba(255,255,255,.92)"/><text x="128" y="138" font-family="Helvetica,Arial,sans-serif" font-size="30" font-weight="700" fill="${fg}" text-anchor="middle">${label}</text></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const uid = (p) => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ---------- AI shopper settings ---------- */
export function defaultAI() {
  return {
    enabled: true, showTags: true,
    maxShoppers: 3, spawnMin: 6, spawnMax: 14,
    walkSpeed: 1.25, maxAisles: 3, maxItemsPerAisle: 3, maxShopTime: 150,
    names: AI_DEFAULT_NAMES.slice(),
    cartColors: AI_DEFAULT_COLORS.slice(),
    profiles: [{ id: 'prof_default', label: 'Casual shopper', speed: 1, maxItems: 0, color: '', weight: 1 }]
  };
}
export function normalizeAI(a) {
  const d = defaultAI();
  a = (a && typeof a === 'object') ? a : {};
  const num = (v, def, lo, hi, int) => {
    let n = Number(v); if (!isFinite(n)) n = def;
    n = Math.min(hi, Math.max(lo, n)); return int ? Math.round(n) : n;
  };
  const out = {
    enabled: a.enabled !== false,
    showTags: a.showTags !== false,
    maxShoppers: num(a.maxShoppers, d.maxShoppers, 1, 8, true),
    spawnMin: num(a.spawnMin, d.spawnMin, 1, 120),
    spawnMax: num(a.spawnMax, d.spawnMax, 1, 120),
    walkSpeed: num(a.walkSpeed, d.walkSpeed, 0.3, 3),
    maxAisles: num(a.maxAisles, d.maxAisles, 1, 6, true),
    maxItemsPerAisle: num(a.maxItemsPerAisle, d.maxItemsPerAisle, 1, 8, true),
    maxShopTime: num(a.maxShopTime, d.maxShopTime, 20, 900, true)
  };
  out.spawnMax = Math.max(out.spawnMax, out.spawnMin);
  out.names = Array.isArray(a.names)
    ? a.names.map((x) => String(x).trim().slice(0, 20)).filter(Boolean).slice(0, 60) : d.names;
  out.cartColors = Array.isArray(a.cartColors)
    ? a.cartColors.map((x) => String(x)).filter((x) => HEX_RE.test(x)).slice(0, 30) : d.cartColors;
  const profs = Array.isArray(a.profiles) ? a.profiles.map((p) => ({
    id: p?.id || uid('prof'),
    label: String(p?.label || 'Shopper').slice(0, 30),
    speed: num(p?.speed, 1, 0.3, 3),
    maxItems: num(p?.maxItems, 0, 0, 8, true),
    color: HEX_RE.test(p?.color || '') ? p.color : '',
    weight: num(p?.weight, 1, 1, 10, true)
  })) : [];
  out.profiles = profs.length ? profs.slice(0, 12) : d.profiles;
  return out;
}
export const fmt = (n) => 'MWK ' + Math.round(Number(n) || 0).toLocaleString('en-US');

export const LS = {
  get(k, fb) { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : fb; } catch { return fb; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }
};

/* ---------- IndexedDB image store ---------- */
export const ImgDB = (() => {
  let ready = null; const mem = new Map();
  function open() {
    if (ready) return ready;
    ready = new Promise((resolve) => {
      let req;
      try { req = indexedDB.open('breathe-db', 1); } catch { return resolve(null); }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    return ready;
  }
  async function put(id, blob) {
    const db = await open();
    if (!db) { mem.set(id, { id, blob, mime: blob.type }); return; }
    return new Promise((res, rej) => {
      const tx = db.transaction('images', 'readwrite');
      tx.objectStore('images').put({ id, blob, mime: blob.type, at: Date.now() });
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    });
  }
  async function get(id) {
    const db = await open();
    if (!db) return mem.get(id) || null;
    return new Promise((res) => {
      const tx = db.transaction('images', 'readonly');
      const rq = tx.objectStore('images').get(id);
      rq.onsuccess = () => res(rq.result || null); rq.onerror = () => res(null);
    });
  }
  async function all() {
    const db = await open();
    if (!db) return Array.from(mem.values());
    return new Promise((res) => {
      const tx = db.transaction('images', 'readonly');
      const rq = tx.objectStore('images').getAll();
      rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]);
    });
  }
  async function del(id) {
    const db = await open();
    if (!db) { mem.delete(id); return; }
    return new Promise((res) => {
      const tx = db.transaction('images', 'readwrite');
      tx.objectStore('images').delete(id);
      tx.oncomplete = () => res(); tx.onerror = () => res();
    });
  }
  return { put, get, all, del };
})();

export const imageURLs = new Map();
export async function imageSrc(image) {
  if (!image || image.kind === 'none') return null;
  if (image.kind === 'url') return image.url || null;
  if (image.kind === 'upload') {
    if (imageURLs.has(image.id)) return imageURLs.get(image.id);
    try {
      const rec = await ImgDB.get(image.id);
      if (rec?.blob) { const u = URL.createObjectURL(rec.blob); imageURLs.set(image.id, u); return u; }
    } catch { /* ignore */ }
  }
  return null;
}

/* Image key used for texture / cache lookups. Stable per image identity. */
export function imageKey(image) {
  if (!image || image.kind === 'none') return 'none';
  if (image.kind === 'upload') return 'u:' + image.id;
  return image.url || '';
}

/* Normalise a product to a non-empty array of images. */
export function productImages(p) {
  if (!p) return [];
  if (Array.isArray(p.images) && p.images.length) return p.images;
  if (p.image && p.image.kind !== 'none') return [p.image];
  return [];
}

/* =========================================================
   DEFAULTS
   ========================================================= */
export function defaultProducts() {
  const mk = (id, name, brand, price, categoryId, shape, color, label, bg, fg) => {
    const img = { kind: 'url', url: svgPack(label, bg, fg) };
    return {
      id, name, brand, price, categoryId, shape, color,
      image: { ...img }, images: [{ ...img }],
      imageType: 'wrap', enabled: true, published: true, placement: { mode: 'auto' }
    };
  };
  return [
    mk('p_water','Still Water 500ml','Aqua',850,'cat_drinks','bottle','#bfe3f0','AQUA','#8ecae6','#0b3d4d'),
    mk('p_juice','Mango Juice 1L','Sunleaf',2200,'cat_drinks','carton','#f3c67a','MANGO','#f0b03c','#4a3005'),
    mk('p_cola','Cola 330ml','Fizzo',900,'cat_drinks','can','#c05a4a','COLA','#c05a4a','#ffffff'),
    mk('p_tea','Green Tea 500ml','TeaCo',1500,'cat_drinks','bottle','#b6d4b0','TEA','#6f9e63','#ffffff'),
    mk('p_crisps','Salted Crisps 120g','Crispo',1800,'cat_snacks','bag','#e8d16a','CRISPO','#d8bb3a','#3a2a06'),
    mk('p_choc','Chocolate Bar 90g','Cocoa',2500,'cat_snacks','bar','#6b4a35','COCOA','#6b4a35','#fff5e6'),
    mk('p_peanuts','Roasted Peanuts 150g','Nutty',1400,'cat_snacks','bag','#d9b98a','NUTTY','#c9a06a','#3a2a06'),
    mk('p_milk','Fresh Milk 1L','DairyFresh',2100,'cat_dairy','carton','#eef2f5','MILK','#dbe6ee','#26414f'),
    mk('p_yoghurt','Natural Yoghurt 500ml','DairyFresh',1700,'cat_dairy','can','#f2f4f0','YOGHURT','#e8ece6','#3d5343'),
    mk('p_cheese','Cheddar Cheese 250g','Alpine',4500,'cat_dairy','box','#f0d98a','CHEESE','#e6c75c','#4a3a05'),
    mk('p_dish','Dish Soap 750ml','PureClean',3200,'cat_household','bottle','#9fd3c7','PURE','#7fc0b1','#0c3a33'),
    mk('p_tissue','Tissues 200 sheets','Softly',1900,'cat_household','box','#e8eef0','SOFTLY','#d5e2e7','#2c4750'),
    mk('p_powder','Laundry Powder 1kg','PureClean',5500,'cat_household','bag','#a8c4e0','WASH','#7fa3c9','#0d2942'),
    mk('p_bread','White Bread 700g','Bakehouse',1600,'cat_bakery','box','#e3d4b5','BAKE','#e3d4b5','#5a4527'),
    mk('p_brown','Brown Bread 700g','Bakehouse',1800,'cat_bakery','box','#c9a678','BROWN','#c9a678','#402c12'),
    mk('p_banana','Bananas 1kg','Farm Fresh',2400,'cat_produce','bag','#f2e07a','BANANA','#e8d24a','#3f350a'),
    mk('p_tomato','Tomatoes 1kg','Farm Fresh',2800,'cat_produce','bag','#e08a7a','TOMATO','#d96a56','#ffffff'),
    mk('p_apple','Apples 1kg','Farm Fresh',3500,'cat_produce','bag','#c9d97a','APPLE','#a8bf4f','#25300a')
  ];
}

export function defaultBanners() {
  return [
    { id: 'b_welcome', name: 'Welcome Banner', published: true, enabled: true, priority: 8, headline: 'Welcome to Breathe', sub: 'Everything you need, calmly arranged.', cta: 'Start shopping', url: '', bg: '#1f6b57', image: { kind: 'none' }, placements: ['ceiling','entrance'] },
    { id: 'b_fresh', name: 'Fresh Produce', published: true, enabled: true, priority: 6, headline: 'Fresh from the farm', sub: 'Produce delivered every morning.', cta: 'See produce', url: '', bg: '#3f7a4a', image: { kind: 'none' }, placements: ['ceiling','shelf'] },
    { id: 'b_gaming', name: 'Partner Arcade', published: true, enabled: true, priority: 4, headline: 'Take a break', sub: 'Play a quick round at our partner arcade.', cta: 'Play now', url: '', bg: '#2b2f36', image: { kind: 'none' }, placements: ['shelf','entrance'] }
  ];
}

export function defaultState() {
  const assignments = {};
  DEFAULT_CATEGORIES.forEach((c, i) => { assignments[c.id] = i % 3; });
  return {
    version: 1,
    categories: JSON.parse(JSON.stringify(DEFAULT_CATEGORIES)),
    products: defaultProducts(),
    layout: { aisleCount: 3, checkout: 'front-right', assignments },
    banners: defaultBanners(),
    promo: { enabled: true, message: 'Take a break and play a round at our partner arcade.', label: 'Play Game', url: '' },
    settings: { muted: true, volume: 0.6 },
    ai: defaultAI(),
    orders: []
  };
}

/* =========================================================
   REACTIVE STATE
   ========================================================= */
export function loadStore() {
  let s = LS.get(K_STORE, null);
  if (!s || !s.products) s = defaultState();
  if (!s.layout) s.layout = defaultState().layout;
  if (!s.banners) s.banners = [];
  if (!s.promo) s.promo = defaultState().promo;
  if (!s.settings) s.settings = defaultState().settings;
  s.ai = normalizeAI(s.ai);
  if (!s.orders) s.orders = [];
  if (!s.layout.assignments) s.layout.assignments = {};
  s.categories.forEach((c) => { delete c.icon; });
  /* migrate single-image products → images[] */
  s.products.forEach((p) => {
    if (!Array.isArray(p.images)) {
      p.images = (p.image && p.image.kind !== 'none') ? [JSON.parse(JSON.stringify(p.image))] : [];
    }
    if (!p.image) p.image = p.images[0] || { kind: 'none' };
  });
  return s;
}

export function loadCart() {
  let c = LS.get(K_CART, { tripId: null, lines: [] });
  if (!c.lines) c = { tripId: null, lines: [] };
  if (!c.tripId) c.tripId = uid('trip');
  return c;
}


export function safeUrl(u) {
  if (!u) return null;
  try { const url = new URL(u, window.location.href); if (url.protocol === 'https:' || url.protocol === 'http:') return url.href; } catch { /* */ }
  return null;
}

export function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}
export function base64ToBlob(b64, mime) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime || 'image/png' });
}

/* ---------- persistence (swap these for API calls when moving to the server) ---------- */
export function saveStoreData(snapshot) { return LS.set(K_STORE, snapshot); }
export function saveCartData(snapshot) { return LS.set(K_CART, snapshot); }