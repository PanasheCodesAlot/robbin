// src/routes/api/store/+server.js
// Admin-only write endpoint. POST the whole store object; it is validated and synced to the tables.
import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '#lib/supabasAdmin.js';

const PUBLIC_SUPABASE_URL = 'https://grjulfjflluweshgjgjg.supabase.co'
const CONFIG_KEY = 'singleton';   // singleton column in store_config / ai_config (rename if yours differs)
const BUCKET = 'store-images';    // storage bucket that holds uploaded images (rename if yours differs)
const PLACEMENTS = ['ceiling', 'shelf', 'entrance'];

class Bad extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

/* ---------- auth: signed in AND is_admin, checked on every request ---------- */
async function requireAdmin(request) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) throw new Bad('Not signed in', 401);
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) throw new Bad('Not signed in', 401);
  const { data: profile } = await supabaseAdmin.from('profiles').select('is_admin').eq('id', data.user.id).maybeSingle();
  if (!profile?.is_admin) throw new Bad('Admins only', 403);
}

/* ---------- small validators ---------- */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v, lo, hi, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
const int = (v, lo, hi, def) => Math.round(num(v, lo, hi, def));
const hex = (v, def) => (HEX_RE.test(v || '') ? v : def);
const chunk = (a, n = 100) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

function placementOf(p) {
  if (p?.mode === 'manual') {
    return { mode: 'manual', aisle: int(p.aisle, 0, 7, 0), side: p.side === 'R' ? 'R' : 'L', level: int(p.level, 0, 2, 0), slot: int(p.slot, 0, 5, 0) };
  }
  return { mode: 'auto' };
}

/* Only url images can be stored. Local 'upload' images must be uploaded to the bucket first. */
let skippedImages = 0;
function urlsOf(images) {
  const out = [];
  for (const im of Array.isArray(images) ? images : []) {
    if (im?.kind === 'upload') { skippedImages++; continue; }
    const u = im?.kind === 'url' ? im.url : null;
    const ok = typeof u === 'string' && ((/^https?:\/\//i.test(u) && u.length <= 2000) || (/^data:image\//i.test(u) && u.length <= 50000));
    if (ok && !out.includes(u)) out.push(u);
  }
  return out;
}

function bucketPath(url) {
  const prefix = `${PUBLIC_SUPABASE_URL}/storage/v1/object/public/${BUCKET}/`;
  return typeof url === 'string' && url.startsWith(prefix) ? decodeURIComponent(url.slice(prefix.length).split('?')[0]) : null;
}

async function run(q) { const { data, error } = await q; if (error) throw new Error(error.message); return data; }

/* ---------- saveStore ---------- */
async function saveStore(store) {
  skippedImages = 0;
  if (!store || !Array.isArray(store.categories) || !Array.isArray(store.products) || !Array.isArray(store.banners)) {
    throw new Bad('Invalid store payload');
  }
  if (!store.categories.length) throw new Bad('A store needs at least one category');
  const layout = store.layout || {}, promo = store.promo || {}, settings = store.settings || {}, ai = store.ai || {};

  /* ids: keep real UUIDs, give every other id a new UUID, and report the mapping back */
  const ids = new Map();
  const idOf = (old) => {
    if (!ids.has(old)) ids.set(old, UUID_RE.test(String(old)) ? old : crypto.randomUUID());
    return ids.get(old);
  };
  const seen = new Set();
  for (const x of [...store.categories, ...store.products, ...store.banners]) {
    if (!x?.id || seen.has(x.id)) throw new Bad('Missing or duplicate id in payload');
    seen.add(x.id); idOf(x.id);
  }
  const catIds = new Set(store.categories.map((c) => c.id));

  const categories = store.categories.map((c, i) => {
    const aisle = layout.assignments?.[c.id];
    return { id: idOf(c.id), name: str(c.name, 60) || 'Category', sort_order: i, aisle: Number.isInteger(aisle) ? Math.max(0, aisle) : null };
  });

  const wanted = [];   // desired attachments
  const products = store.products.map((p) => {
    if (!catIds.has(p.categoryId)) throw new Bad(`Product "${str(p.name, 40)}" has an unknown category`);
    const id = idOf(p.id);
    urlsOf(p.images?.length ? p.images : [p.image]).forEach((url, position) => wanted.push({ product_id: id, banner_id: null, url, position }));
    let draft = null;
    if (p.draft) {
      const d = p.draft;
      draft = {
        name: str(d.name, 120), brand: str(d.brand, 80), price: int(d.price, 0, 100000000, 0),
        categoryId: catIds.has(d.categoryId) ? idOf(d.categoryId) : null, shape: str(d.shape, 20), color: hex(d.color, '#cccccc'),
        imageType: str(d.imageType, 20), enabled: d.enabled !== false, placement: placementOf(d.placement),
        images: urlsOf(d.images?.length ? d.images : [d.image])
      };
    }
    return {
      id, category_id: idOf(p.categoryId), name: str(p.name, 120) || 'Untitled', brand: str(p.brand, 80),
      price: int(p.price, 0, 100000000, 0), shape: str(p.shape, 20) || 'box', color: hex(p.color, '#cccccc'),
      image_type: str(p.imageType, 20) || 'wrap', enabled: p.enabled !== false, published: !!p.published,
      placement: placementOf(p.placement), draft
    };
  });

  const banners = store.banners.map((b) => {
    const id = idOf(b.id);
    urlsOf([b.image]).slice(0, 1).forEach((url) => wanted.push({ product_id: null, banner_id: id, url, position: 0 }));
    return {
      id, name: str(b.name, 80) || 'Banner', headline: str(b.headline, 120), sub: str(b.sub, 240), cta: str(b.cta, 40),
      url: str(b.url, 500), bg: hex(b.bg, '#1f6b57'), priority: int(b.priority, 1, 10, 5),
      placements: (Array.isArray(b.placements) ? b.placements : []).filter((x, i, a) => PLACEMENTS.includes(x) && a.indexOf(x) === i),
      enabled: b.enabled !== false, published: !!b.published
    };
  });

  const storeConfig = {
    [CONFIG_KEY]: true, aisle_count: int(layout.aisleCount, 1, 8, 3), checkout: str(layout.checkout, 30) || 'front-right',
    promo_enabled: !!promo.enabled, promo_message: str(promo.message, 300), promo_label: str(promo.label, 40), promo_url: str(promo.url, 500),
    muted: !!settings.muted, volume: num(settings.volume, 0, 1, 0.6)
  };
  const aiConfig = {
    [CONFIG_KEY]: true, enabled: ai.enabled !== false, show_tags: ai.showTags !== false,
    max_shoppers: int(ai.maxShoppers, 1, 8, 3), spawn_min: num(ai.spawnMin, 1, 120, 6), spawn_max: Math.max(num(ai.spawnMax, 1, 120, 14), num(ai.spawnMin, 1, 120, 6)),
    walk_speed: num(ai.walkSpeed, 0.3, 3, 1.25), max_aisles: int(ai.maxAisles, 1, 6, 3), max_items_per_aisle: int(ai.maxItemsPerAisle, 1, 8, 3),
    max_shop_time: int(ai.maxShopTime, 20, 900, 150),
    names: (Array.isArray(ai.names) ? ai.names : []).map((n) => str(n, 20)).filter(Boolean).slice(0, 60),
    cart_colors: (Array.isArray(ai.cartColors) ? ai.cartColors : []).filter((c) => HEX_RE.test(c || '')).slice(0, 30),
    profiles: (Array.isArray(ai.profiles) ? ai.profiles : []).slice(0, 12).map((p) => ({
      id: str(p?.id, 60) || crypto.randomUUID(), label: str(p?.label, 30) || 'Shopper', speed: num(p?.speed, 0.3, 3, 1),
      maxItems: int(p?.maxItems, 0, 8, 0), color: hex(p?.color, ''), weight: int(p?.weight, 1, 10, 1)
    }))
  };

  /* what exists now */
  const [exCats, exProds, exBans, exAtt] = await Promise.all([
    run(supabaseAdmin.from('categories').select('id')),
    run(supabaseAdmin.from('products').select('id')),
    run(supabaseAdmin.from('banners').select('id')),
    run(supabaseAdmin.from('attachments').select('id, product_id, banner_id, url, position'))
  ]);

  /* 1. upserts, parents first */
  await run(supabaseAdmin.from('categories').upsert(categories));
  await run(supabaseAdmin.from('products').upsert(products));
  await run(supabaseAdmin.from('banners').upsert(banners));
  await run(supabaseAdmin.from('store_config').upsert(storeConfig, { onConflict: CONFIG_KEY }));
  await run(supabaseAdmin.from('ai_config').upsert(aiConfig, { onConflict: CONFIG_KEY }));

  /* 2. attachments: drop stale, add new, fix order */
  const key = (a) => `${a.product_id || ''}|${a.banner_id || ''}|${a.url}`;
  const wantedMap = new Map(wanted.map((a) => [key(a), a]));
  const haveMap = new Map(exAtt.map((a) => [key(a), a]));
  const stale = exAtt.filter((a) => !wantedMap.has(key(a)));
  for (const part of chunk(stale.map((a) => a.id))) await run(supabaseAdmin.from('attachments').delete().in('id', part));
  const fresh = wanted.filter((a) => !haveMap.has(key(a)));
  if (fresh.length) for (const part of chunk(fresh)) await run(supabaseAdmin.from('attachments').insert(part));
  await Promise.all(wanted.filter((a) => haveMap.has(key(a)) && haveMap.get(key(a)).position !== a.position)
    .map((a) => run(supabaseAdmin.from('attachments').update({ position: a.position }).eq('id', haveMap.get(key(a)).id))));

  /* 3. deletes (children before parents) */
  const keepOf = (list) => new Set(list.map((r) => r.id));
  const drop = (existing, rows) => existing.map((r) => r.id).filter((id) => !keepOf(rows).has(id));
  for (const part of chunk(drop(exProds, products))) await run(supabaseAdmin.from('products').delete().in('id', part));
  for (const part of chunk(drop(exBans, banners))) await run(supabaseAdmin.from('banners').delete().in('id', part));
  for (const part of chunk(drop(exCats, categories))) await run(supabaseAdmin.from('categories').delete().in('id', part));

  /* 4. remove bucket files that nothing references any more (the database can't do this itself) */
  const stillUsed = new Set(wanted.map((a) => a.url));
  const files = [...new Set(stale.map((a) => a.url).filter((u) => !stillUsed.has(u)).map(bucketPath).filter(Boolean))];
  for (const part of chunk(files, 50)) await supabaseAdmin.storage.from(BUCKET).remove(part);

  const idMap = {};
  ids.forEach((neu, old) => { if (neu !== old) idMap[old] = neu; });
  return { ok: true, idMap, skippedImages };
}

export async function POST({ request }) {
  try {
    await requireAdmin(request);
    const body = await request.json().catch(() => null);
    return json(await saveStore(body));
  } catch (e) {
    if (e instanceof Bad) return json({ ok: false, message: e.message }, { status: e.status });
    console.error('saveStore failed:', e);
    return json({ ok: false, message: 'Save failed: ' + (e?.message || 'unknown error') }, { status: 500 });
  }
}