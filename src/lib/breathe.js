/* src/lib/breathe.js
   ------------------------------------------------------------------
   Shared data layer for the store page (/) and the admin page (/admin).
   READS  : loadStore() reads the tables straight from Supabase (public key, protected by RLS).
   WRITES : saveStore() posts to /api/store, which checks the admin token and uses the service role.
   IMAGES : an image is just a url string stored in the `attachments` table.
   ------------------------------------------------------------------ */
import { supabase } from '#lib/supabase.js';

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

/* ---------- images ---------- */
/* Images are { kind: 'url', url } or { kind: 'none' }. Kept async so existing {#await imageSrc(...)} markup still works. */
export async function imageSrc(image) {
  if (!image || image.kind !== 'url') return null;
  return image.url || null;
}

/* Image key used for texture / cache lookups. Stable per image identity. */
export function imageKey(image) {
  if (!image || image.kind === 'none') return 'none';
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
/* Rebuilds the store object the pages use from the database tables. */
const asImages = (urls) => (urls || []).map((url) => ({ kind: 'url', url }));
const firstImage = (imgs) => imgs[0] ? { ...imgs[0] } : { kind: 'none' };

export async function loadStore() {
  const q = (t, sel = '*') => supabase.from(t).select(sel);
  const [cats, prods, bans, atts, sc, ac] = await Promise.all([
    q('categories').order('sort_order'),
    q('products').order('created_at'),
    q('banners').order('created_at'),
    q('attachments').order('position'),
    q('store_config').maybeSingle(),
    q('ai_config').maybeSingle()
  ]);
  for (const r of [cats, prods, bans, atts, sc, ac]) if (r.error) throw new Error(r.error.message);

  console.log(cats, prods, bans, atts, sc, ac)

  const byProduct = new Map(), byBanner = new Map();
  for (const a of atts.data) {
    const m = a.product_id ? byProduct : byBanner, k = a.product_id || a.banner_id;
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(a.url);
  }

  const assignments = {};
  cats.data.forEach((c) => { if (c.aisle !== null && c.aisle !== undefined) assignments[c.id] = c.aisle; });

  const products = prods.data.map((p) => {
    const images = asImages(byProduct.get(p.id));
    const out = {
      id: p.id, name: p.name, brand: p.brand || '', price: p.price, categoryId: p.category_id,
      shape: p.shape, color: p.color, imageType: p.image_type, enabled: p.enabled, published: p.published,
      placement: p.placement || { mode: 'auto' }, images, image: firstImage(images)
    };
    if (p.draft) {
      const dImages = asImages(p.draft.images);
      out.draft = { ...p.draft, id: p.id, published: p.published, images: dImages, image: firstImage(dImages) };
    }
    return out;
  });

  const banners = bans.data.map((b) => {
    const imgs = asImages(byBanner.get(b.id));
    return {
      id: b.id, name: b.name, headline: b.headline || '', sub: b.sub || '', cta: b.cta || '', url: b.url || '',
      bg: b.bg, priority: b.priority, placements: b.placements || [], enabled: b.enabled, published: b.published,
      image: firstImage(imgs)
    };
  });

  const d = defaultState();
  const c = sc.data, a = ac.data;
  return {
    version: 1,
    categories: cats.data.map((x) => ({ id: x.id, name: x.name })),
    products,
    banners,
    layout: { aisleCount: c?.aisle_count ?? d.layout.aisleCount, checkout: c?.checkout ?? d.layout.checkout, assignments },
    promo: c ? { enabled: c.promo_enabled, message: c.promo_message || '', label: c.promo_label || '', url: c.promo_url || '' } : d.promo,
    settings: c ? { muted: c.muted, volume: Number(c.volume) } : d.settings,
    ai: normalizeAI(a ? {
      enabled: a.enabled, showTags: a.show_tags, maxShoppers: a.max_shoppers, spawnMin: Number(a.spawn_min), spawnMax: Number(a.spawn_max),
      walkSpeed: Number(a.walk_speed), maxAisles: a.max_aisles, maxItemsPerAisle: a.max_items_per_aisle, maxShopTime: a.max_shop_time,
      names: a.names, cartColors: a.cart_colors, profiles: a.profiles
    } : undefined),
    orders: []
  };
}

/* Admin only. Posts the store to /api/store; the server verifies the token and is_admin. Returns { ok, idMap, skippedImages }. */
export async function saveStore(store) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not signed in');
  const res = await fetch('/api/store', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + session.access_token },
    body: JSON.stringify(store)
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.message || 'Save failed (' + res.status + ')');
  return out;
}

/* After a save, swap the temporary ids the admin created for the real UUIDs the server assigned. */
export function applyIdMap(store, idMap) {
  if (!idMap || !Object.keys(idMap).length) return store;
  const m = (id) => idMap[id] || id;
  store.categories.forEach((c) => { c.id = m(c.id); });
  store.products.forEach((p) => {
    p.id = m(p.id); p.categoryId = m(p.categoryId);
    if (p.draft) { p.draft.id = p.id; p.draft.categoryId = m(p.draft.categoryId); }
  });
  store.banners.forEach((b) => { b.id = m(b.id); });
  const next = {};
  for (const [k, v] of Object.entries(store.layout?.assignments || {})) next[m(k)] = v;
  if (store.layout) store.layout.assignments = next;
  return store;
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

/* ---------- cart persistence (stays on the device) ---------- */
export function saveCartData(snapshot) { return LS.set(K_CART, snapshot); }