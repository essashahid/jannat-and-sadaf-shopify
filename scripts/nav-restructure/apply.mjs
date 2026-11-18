#!/usr/bin/env node
// Applies scripts/nav-restructure/config.json to the store through the Admin GraphQL API.
//
// Credentials come from the environment only (never from files in this repo):
//   SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET  Dev Dashboard app; exchanged for a 24-hour token
//                                              with the client credentials grant.
//   SHOPIFY_ADMIN_TOKEN                        Alternative: an existing Admin API access token.
//   SHOPIFY_SHOP (optional)                    Must match config.store; guards against the wrong store.
// Required scopes are listed in config.auth.required_scopes; the run stops if any is missing.
//
//   node scripts/nav-restructure/apply.mjs --dry-run            plan only, nothing written
//   node scripts/nav-restructure/apply.mjs                      live run (snapshot first)
//   node scripts/nav-restructure/apply.mjs --dry-run --state <file>        offline plan from captured state
//   node scripts/nav-restructure/apply.mjs --dry-run --state <file> --print-menu-json
//                                                               print the menu items payload only
//
// Idempotent: every step compares current state with config and only writes the difference.
// Hard rules: collection handles and product titles are never written; only collections created
// during this task (by id and createdAt) can be deleted; do_not_touch items stop the run.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const PRINT_MENU = args.includes('--print-menu-json');
const stateArg = args.includes('--state') ? args[args.indexOf('--state') + 1] : null;
if (stateArg && !DRY) die('--state is only allowed together with --dry-run.');
if (PRINT_MENU && !DRY) die('--print-menu-json is only allowed together with --dry-run.');

const config = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const STORE = config.store;
const ENDPOINT = `https://${STORE}/admin/api/${config.api_version}/graphql.json`;

function die(msg) {
  console.error(`\nSTOPPED: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------- Auth

const bare = (s) => String(s).replace(/^https?:\/\//, '').replace(/\.myshopify\.com\/?$/, '');
if (process.env.SHOPIFY_SHOP && bare(process.env.SHOPIFY_SHOP) !== bare(STORE)) {
  die(`SHOPIFY_SHOP is "${process.env.SHOPIFY_SHOP}" but config.store is "${STORE}".`);
}

let token = process.env.SHOPIFY_ADMIN_TOKEN || null;
let tokenExpiresAt = token ? Infinity : 0;

async function getToken() {
  if (token && Date.now() < tokenExpiresAt - 60_000) return token;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    die('No credentials. Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET (Dev Dashboard app), or SHOPIFY_ADMIN_TOKEN.');
  }
  const res = await fetch(`https://${STORE}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    const hint = JSON.stringify(body).includes('shop_not_permitted')
      ? ' The app is not in the same Shopify organization as the store: create it from the store admin (Settings > Apps > Develop apps).'
      : '';
    die(`Token request failed (${res.status}): ${body.error_description ?? body.error ?? 'no details'}.${hint}`);
  }
  token = body.access_token;
  tokenExpiresAt = Date.now() + (body.expires_in ?? 86399) * 1000;
  return token;
}

// ---------------------------------------------------------------- GraphQL

async function gql(query, variables = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await getToken() },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.json().catch(() => ({}));
    const throttled = res.status === 429 || body.errors?.some((e) => e.extensions?.code === 'THROTTLED');
    if (throttled && attempt < 6) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      continue;
    }
    if (!res.ok || body.errors) die(`GraphQL error (${res.status}): ${JSON.stringify(body.errors ?? body)}`);
    return body.data;
  }
}

function checkUserErrors(label, payload) {
  const errs = payload?.userErrors ?? [];
  if (errs.length) die(`${label} failed: ${JSON.stringify(errs)}`);
  return payload;
}

async function checkScopes() {
  const granted = new Set((await gql(`{ currentAppInstallation { accessScopes { handle } } }`)).currentAppInstallation.accessScopes.map((s) => s.handle));
  // A write scope includes the matching read scope.
  const has = (s) => granted.has(s) || (s.startsWith('read_') && granted.has(`write_${s.slice(5)}`));
  const missing = config.auth.required_scopes.filter((s) => !has(s));
  if (missing.length) die(`The app is missing scopes: ${missing.join(', ')}. Add them in a new app version and approve it on the store.`);
}

// ---------------------------------------------------------------- Read state

const PRODUCTS_Q = `query($after: String) { products(first: 100, after: $after) {
  pageInfo { hasNextPage endCursor }
  nodes { id title handle status collections(first: 50) { nodes { handle } } } } }`;

const COLLECTIONS_Q = `query($after: String, $pub: ID!) { collections(first: 50, after: $after) {
  pageInfo { hasNextPage endCursor }
  nodes { id title handle createdAt descriptionHtml seo { title description } publishedOnPublication(publicationId: $pub)
    sources { __typename id ... on CollectionConditionsSource { inclusion {
      conditions { __typename }
      selections(first: 250) { pageInfo { hasNextPage } nodes { product { id } } } } } } } } }`;

const MENUS_Q = `{ menus(first: 50) { nodes { id handle title
  items { id title type url resourceId
    items { id title type url resourceId
      items { id title type url resourceId } } } } } }`;

const REDIRECTS_Q = `query($q: String!) { urlRedirects(first: 50, query: $q) { nodes { id path target } } }`;

const redirectPaths = () => [...config.redirects.ensure.map((r) => r.path), ...config.do_not_touch.redirect_paths];

async function paginate(query, key, variables = {}) {
  const out = [];
  let after = null;
  do {
    const data = await gql(query, { ...variables, after });
    out.push(...data[key].nodes);
    after = data[key].pageInfo.hasNextPage ? data[key].pageInfo.endCursor : null;
  } while (after);
  return out;
}

async function fetchRawState() {
  const pubs = (await gql(`{ publications(first: 50) { nodes { id catalog { title } } } }`)).publications.nodes;
  const pub = pubs.find((p) => p.catalog?.title?.includes(config.online_store_publication_title_contains));
  if (!pub) die('Online Store publication not found.');
  const products = await paginate(PRODUCTS_Q, 'products');
  const collections = await paginate(COLLECTIONS_Q, 'collections', { pub: pub.id });
  const menus = (await gql(MENUS_Q)).menus.nodes;
  const redirects = [];
  for (const path of redirectPaths()) {
    // The search is fuzzy, so keep exact path matches only.
    const hits = (await gql(REDIRECTS_Q, { q: `path:${path}` })).urlRedirects.nodes.filter((r) => r.path === path);
    redirects.push(...hits);
  }
  return { fetchedAt: new Date().toISOString(), onlineStorePublicationId: pub.id, products, collections, menus, redirects };
}

function normalizeState(raw) {
  const products = raw.products.map((p) => ({
    id: p.id, title: p.title, handle: p.handle, status: p.status,
    collections: p.collections.nodes.map((c) => c.handle),
  }));
  const collections = raw.collections.map((c) => {
    let membership;
    const src = c.sources ?? [];
    if (src.length === 0) membership = { kind: 'empty', sourceId: null, productIds: [] };
    else if (src.length === 1 && src[0].__typename === 'CollectionConditionsSource' && src[0].inclusion.conditions.length === 0) {
      if (src[0].inclusion.selections.pageInfo?.hasNextPage) die(`Collection ${c.handle} has more than 250 selections; paging not implemented.`);
      membership = { kind: 'manual', sourceId: src[0].id, productIds: src[0].inclusion.selections.nodes.map((n) => n.product.id) };
    } else membership = { kind: 'rule-based', sourceId: null, productIds: null };
    return {
      id: c.id, title: c.title, handle: c.handle, createdAt: c.createdAt, published: c.publishedOnPublication, membership,
      descriptionHtml: c.descriptionHtml ?? '', seoTitle: c.seo?.title ?? null, seoDescription: c.seo?.description ?? null,
    };
  });
  return { ...raw, products, collections };
}

// ---------------------------------------------------------------- Menu helpers

const menuKey = (i) => i.collection ?? i.title;

// Returns config.menu.items with every child list ordered by config.menu.menu_order.
function orderedMenu(errors) {
  const order = config.menu.menu_order ?? {};
  const sortLevel = (items, parent) => {
    const list = order[parent];
    let out = items;
    if (list) {
      const keys = items.map(menuKey);
      const missing = keys.filter((k) => !list.includes(k));
      const extra = list.filter((k) => !keys.includes(k));
      if (missing.length || extra.length) errors.push(`menu_order["${parent}"] must list exactly ${JSON.stringify(keys)}; missing ${JSON.stringify(missing)}, unknown ${JSON.stringify(extra)}.`);
      else out = [...items].sort((a, b) => list.indexOf(menuKey(a)) - list.indexOf(menuKey(b)));
    }
    return out.map((i) => (i.items ? { ...i, items: sortLevel(i.items, i.title) } : i));
  };
  return sortLevel(config.menu.items, '(top)');
}

// ---------------------------------------------------------------- Plan

const norm = (s) => String(s).trim().replace(/\s+/g, ' ').toLowerCase();
const sameHtml = (a, b) => String(a ?? '').replace(/\s+/g, ' ').trim() === String(b ?? '').replace(/\s+/g, ' ').trim();

function plan(state) {
  const errors = [];
  const ops = [];
  const notes = [];
  const byId = new Map(state.products.map((p) => [p.id, p]));
  const byHandle = (h) => state.collections.find((c) => c.handle === h);
  const aliases = Object.fromEntries(Object.entries(config.matching.title_aliases).map(([k, v]) => [norm(k), v]));
  const pins = Object.fromEntries(Object.entries(config.matching.handle_pins).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [norm(k), v]));
  const label = (p) => (p ? `${p.title} [${p.handle}]` : '?');
  const cutoff = config.hard_rules.collections_created_during_task_on_or_after;

  // Title -> product
  const resolved = new Map();
  function resolve(title) {
    const key = norm(title);
    if (resolved.has(key)) return resolved.get(key);
    const wanted = norm(aliases[key] ?? title);
    let hit = null;
    if (pins[key]) {
      const p = state.products.find((x) => x.handle === pins[key]);
      if (!p) errors.push(`"${title}": pinned handle "${pins[key]}" not found.`);
      else if (norm(p.title) !== wanted) errors.push(`"${title}": pinned handle "${pins[key]}" has title "${p.title}".`);
      else hit = p;
    } else {
      const c = state.products.filter((p) => norm(p.title) === wanted);
      if (c.length === 0) errors.push(`"${title}": no product with this title.`);
      else if (c.length > 1) errors.push(`"${title}": ${c.length} products match (${c.map((p) => `${p.handle}/${p.status}`).join(', ')}). Add a handle pin.`);
      else hit = c[0];
    }
    resolved.set(key, hit);
    return hit;
  }

  // Step 1: hide products
  const hidden = new Set();
  for (const t of config.hide_products.titles) {
    const p = resolve(t);
    if (!p) continue;
    hidden.add(p.id);
    if (p.status === 'ARCHIVED') notes.push(`${label(p)} is ARCHIVED; left as is.`);
    else if (p.status !== config.hide_products.status) ops.push({ step: 1, kind: 'product.status', id: p.id, desc: `${label(p)}: ${p.status} -> ${config.hide_products.status}`, status: config.hide_products.status });
  }
  const activeAfter = new Set(state.products.filter((p) => p.status === 'ACTIVE' && !hidden.has(p.id)).map((p) => p.id));
  if (activeAfter.size !== config.hide_products.expected_active_after) {
    errors.push(`Active products after hiding would be ${activeAfter.size}, expected ${config.hide_products.expected_active_after}.`);
  }
  const statusAfter = (p) => (hidden.has(p.id) && p.status !== 'ARCHIVED' ? config.hide_products.status : p.status);

  // Collection lists -> product ids
  const desired = new Map();
  for (const spec of config.collections) {
    const ids = [];
    for (const t of spec.products) {
      const p = resolve(t);
      if (!p) continue;
      if (hidden.has(p.id)) {
        if (spec.membership === 'add_only') notes.push(`${spec.title}: "${t}" is added but also hidden in Step 1, so it will not show until un-hidden.`);
        else errors.push(`${spec.title}: "${t}" is in the hide list.`);
      }
      if (ids.includes(p.id)) errors.push(`${spec.title}: "${t}" listed twice.`);
      ids.push(p.id);
    }
    desired.set(spec.handle, ids);
  }

  // Coverage assertions
  function coverage(name, lists) {
    const count = new Map();
    for (const ids of lists) for (const id of ids) count.set(id, (count.get(id) ?? 0) + 1);
    const missing = [...activeAfter].filter((id) => !count.has(id)).map((id) => label(byId.get(id)));
    const extra = [...count.keys()].filter((id) => !activeAfter.has(id)).map((id) => label(byId.get(id)));
    const dupes = [...count].filter(([, n]) => n > 1).map(([id]) => label(byId.get(id)));
    if (missing.length || extra.length || dupes.length) {
      errors.push(`${name}: missing ${JSON.stringify(missing)}, not active ${JSON.stringify(extra)}, listed more than once ${JSON.stringify(dupes)}.`);
    } else notes.push(`${name}: OK (${count.size} products, each once).`);
  }
  const group = (g) => config.collections.filter((c) => c.group === g).map((c) => desired.get(c.handle));
  if (config.assertions.by_collection_covers_active_exactly_once) coverage('By Collection covers active products', group('by_collection'));
  if (config.assertions.by_season_plus_unassigned_covers_active_exactly_once) {
    coverage('By Season + unassigned covers active products', [...group('by_season'), config.unassigned_season.map(resolve).filter(Boolean).map((p) => p.id)]);
  }

  const targetHandles = new Set(config.collections.map((c) => c.handle));

  // Cleanup: leftover menus, then leftover collections (by id, created during this task, empty)
  for (const h of config.cleanup.delete_menus_by_handle) {
    if (h === config.menu.handle) { errors.push(`Refusing to delete ${h}.`); continue; }
    const m = state.menus.find((x) => x.handle === h);
    if (m) ops.push({ step: 0, kind: 'menu.delete', id: m.id, desc: `Delete leftover menu "${m.title}" (${h})` });
    else notes.push(`Menu ${h}: already gone.`);
  }
  const deleting = new Set();
  for (const { handle, id } of config.cleanup.delete_collections) {
    const c = state.collections.find((x) => x.id === id);
    const sameHandle = byHandle(handle);
    if (!c) {
      if (sameHandle) errors.push(`Cleanup ${handle}: handle now belongs to ${sameHandle.id}, not ${id}; not deleting.`);
      else notes.push(`Collection ${handle} (${id}): already gone.`);
      continue;
    }
    const members = state.products.filter((p) => p.collections.includes(c.handle)).length + (c.membership.productIds?.length ?? 0);
    if (c.handle !== handle) errors.push(`Cleanup ${id}: handle is "${c.handle}", expected "${handle}".`);
    else if (!(c.createdAt >= cutoff)) errors.push(`Cleanup ${handle}: created ${c.createdAt}, before ${cutoff}. Pre-existing collections are never deleted.`);
    else if (members > 0 || c.membership.kind !== 'empty') errors.push(`Cleanup ${handle}: not empty; not deleting.`);
    else if (targetHandles.has(handle)) errors.push(`Cleanup ${handle}: it is also a target collection.`);
    else {
      deleting.add(c.id);
      ops.push({ step: 0, kind: 'collection.delete', id: c.id, handle, desc: `Delete empty collection "${c.title}" (${handle}, ${c.id}, created ${c.createdAt})` });
    }
  }

  // Redirects that must exist after the run
  for (const r of config.redirects.ensure) {
    const existing = state.redirects.find((x) => x.path === r.path);
    const pathHandle = r.path.startsWith('/collections/') ? r.path.slice('/collections/'.length) : null;
    const occupant = pathHandle ? byHandle(pathHandle) : null;
    const targetHandle = r.target.startsWith('/collections/') ? r.target.slice('/collections/'.length) : null;
    const target = targetHandle ? byHandle(targetHandle) : null;
    let pathNote = '';
    if (occupant && deleting.has(occupant.id)) pathNote = ` Takes effect once ${occupant.handle} is deleted.`;
    else if (occupant && !occupant.published) pathNote = ` ${occupant.handle} is unpublished, so the path returns 404 and the redirect applies.`;
    else if (occupant) errors.push(`Redirect ${r.path}: published collection ${occupant.handle} occupies the path, so the redirect could not fire.`);
    if (targetHandle && (!target || !target.published)) errors.push(`Redirect ${r.path}: target ${r.target} is missing or unpublished.`);
    if (existing && existing.target === r.target) {
      notes.push(`Redirect ${r.path} -> ${r.target}: exists (${existing.id}).${pathNote}`);
    } else if (existing && r.replace_target && existing.target === r.replace_target) {
      notes.push(`Redirect ${r.path}: currently -> ${existing.target}; planned to point at ${r.target}.${pathNote}`);
      ops.push({ step: 0, kind: 'redirect.update', id: existing.id, path: r.path, target: r.target, desc: `Repoint redirect ${r.path}: ${existing.target} -> ${r.target}` });
    } else if (existing) {
      errors.push(`Redirect ${r.path} exists with target ${existing.target}, expected ${r.target}${r.replace_target ? ` or ${r.replace_target}` : ''}; not changing it.`);
    } else {
      notes.push(`Redirect ${r.path} -> ${r.target}: does NOT exist now; planned to be created.${pathNote}`);
      ops.push({ step: 0, kind: 'redirect.create', path: r.path, target: r.target, desc: `Create redirect ${r.path} -> ${r.target}` });
    }
  }

  // Step 2: collections (title, products, copy; handles never change)
  const target = new Map(config.collections.map((s) => [s.handle, byHandle(s.handle) ?? null]));
  const copyChecks = [];
  for (const spec of config.collections) {
    const c = target.get(spec.handle);
    const want = desired.get(spec.handle);
    const mode = spec.membership ?? 'exact';
    if (c && deleting.has(c.id)) { errors.push(`${spec.handle} is both a target and scheduled for deletion.`); continue; }
    if (!c) {
      ops.push({ step: 2, kind: 'collection.create', handle: spec.handle, title: spec.title, add: want, desc: `Create "${spec.title}" (${spec.handle}) with ${want.length} products` });
      ops.push({ step: 2, kind: 'collection.publish', handle: spec.handle, desc: `Publish ${spec.handle} to Online Store` });
      continue;
    }
    if (c.title !== spec.title) {
      ops.push({ step: 2, kind: 'collection.title', id: c.id, title: spec.title, desc: `Rename "${c.title}" -> "${spec.title}" (handle ${c.handle} unchanged)` });
    }
    if (c.membership.kind === 'rule-based') { errors.push(`${spec.title}: existing collection ${c.handle} is rule-based, not manual.`); continue; }
    const have = new Set(c.membership.productIds);
    const add = want.filter((id) => !have.has(id));
    const remove = mode === 'add_only' ? [] : [...have].filter((id) => !want.includes(id));
    for (const id of add) {
      const p = byId.get(id);
      ops.push({ step: 2, kind: 'note', desc: `  ${spec.handle} + ${label(p)}${statusAfter(p) !== 'ACTIVE' ? ` (${statusAfter(p)} after Step 1)` : ''}` });
    }
    for (const id of remove) {
      const p = byId.get(id);
      const why = !p ? '' : hidden.has(id) ? ' (being hidden)' : p.status !== 'ACTIVE' ? ` (${p.status})` : '';
      ops.push({ step: 2, kind: 'note', desc: `  ${spec.handle} - ${label(p)}${why}` });
    }
    const result = mode === 'add_only' ? new Set([...have, ...add]) : new Set(want);
    const visible = [...result].filter((id) => byId.get(id) && statusAfter(byId.get(id)) === 'ACTIVE').length;
    if (add.length || remove.length) {
      ops.push({ step: 2, kind: 'collection.members', id: c.id, handle: spec.handle, sourceId: c.membership.sourceId, add, remove, desc: `${spec.handle} ("${spec.title}", ${mode}): add ${add.length}, remove ${remove.length} (result ${result.size}, ${visible} visible)` });
    }
    if (!c.published) ops.push({ step: 2, kind: 'collection.publish', handle: spec.handle, id: c.id, desc: `Publish ${spec.handle} to Online Store` });

    if (spec.copy) {
      const next = { descriptionHtml: spec.copy.description_html, seoTitle: spec.copy.seo_title, seoDescription: spec.copy.seo_description };
      copyChecks.push({ handle: spec.handle, ...next });
      const changed = !sameHtml(c.descriptionHtml, next.descriptionHtml) || c.seoTitle !== next.seoTitle || c.seoDescription !== next.seoDescription;
      if (changed) ops.push({ step: 2, kind: 'collection.copy', id: c.id, handle: spec.handle, ...next, before: { descriptionHtml: c.descriptionHtml, seoTitle: c.seoTitle, seoDescription: c.seoDescription }, desc: `${spec.handle} ("${spec.title}"): set intro and SEO` });
    }
  }

  // Exact text edits in existing collection copy
  const fieldKey = { description_html: 'descriptionHtml', seo_description: 'seoDescription', seo_title: 'seoTitle' };
  const editsByHandle = new Map();
  for (const e of config.copy_edits.edits) {
    if (!editsByHandle.has(e.handle)) editsByHandle.set(e.handle, []);
    editsByHandle.get(e.handle).push(e);
  }
  for (const [handle, edits] of editsByHandle) {
    const c = byHandle(handle);
    if (!c) { errors.push(`copy_edits: collection ${handle} not found.`); continue; }
    if (config.collections.some((s) => s.handle === handle && s.copy)) { errors.push(`copy_edits: ${handle} also has full copy in collections; use one or the other.`); continue; }
    const before = { descriptionHtml: c.descriptionHtml, seoTitle: c.seoTitle, seoDescription: c.seoDescription };
    const next = { ...before };
    for (const e of edits) {
      const k = fieldKey[e.field];
      if (!k) { errors.push(`copy_edits: unknown field ${e.field}.`); continue; }
      const cur = String(next[k] ?? '');
      const n = cur.split(e.from).length - 1;
      if (n > 0) {
        next[k] = cur.split(e.from).join(e.to);
        ops.push({ step: 2, kind: 'note', desc: `  ${handle}.${e.field}: "${e.from}" -> "${e.to}" (${n}x)` });
      } else if (cur.includes(e.to)) notes.push(`copy_edits ${handle}.${e.field}: already done.`);
      else errors.push(`copy_edits ${handle}.${e.field}: neither "${e.from}" nor "${e.to}" found; the copy changed, so not editing.`);
    }
    if (next.descriptionHtml !== before.descriptionHtml || next.seoTitle !== before.seoTitle || next.seoDescription !== before.seoDescription) {
      ops.push({ step: 2, kind: 'collection.copy', id: c.id, handle, ...next, before, desc: `${handle} ("${c.title}"): edit existing copy` });
    }
  }
  for (const c of copyChecks) {
    if (c.seoTitle.length > 70) notes.push(`SEO title for ${c.handle} is ${c.seoTitle.length} chars (over 70).`);
    if (c.seoDescription.length > 160) notes.push(`SEO description for ${c.handle} is ${c.seoDescription.length} chars (over 160).`);
  }

  // Step 3: menu (ordered by menu_order)
  const menuItems = orderedMenu(errors);
  const menu = state.menus.find((m) => m.handle === config.menu.handle);
  if (!menu) errors.push(`Menu ${config.menu.handle} not found.`);
  const shape = (items) => (items ?? []).map((i) => ({ title: i.title, type: i.type, url: i.url, items: shape(i.items) }));
  const targetShape = (items) => (items ?? []).map((i) => i.collection
    ? { title: i.title, type: 'COLLECTION', url: `/collections/${i.collection}`, items: shape([]) }
    : { title: i.title, type: i.type, url: i.type === 'CATALOG' ? '/collections/all' : i.url, items: targetShape(i.items) });
  const menuCollections = (items) => (items ?? []).flatMap((i) => (i.collection ? [i.collection] : menuCollections(i.items)));
  for (const h of menuCollections(menuItems)) {
    const c = byHandle(h);
    if (!targetHandles.has(h) && (!c || deleting.has(c.id))) errors.push(`Menu links to ${h}, which will not exist.`);
  }
  if (menu && JSON.stringify(shape(menu.items)) !== JSON.stringify(targetShape(menuItems))) {
    ops.push({ step: 3, kind: 'menu.update', id: menu.id, desc: `Replace ${config.menu.handle} items`, before: shape(menu.items), after: targetShape(menuItems) });
  }

  // Hard rules and do_not_touch
  const guarded = new Set(config.do_not_touch.collections);
  const guardedIds = new Set(state.collections.filter((c) => guarded.has(c.handle)).map((c) => c.id));
  for (const o of ops) {
    if (o.kind === 'note') continue;
    if ((o.id && guardedIds.has(o.id)) || (o.handle && guarded.has(o.handle))) errors.push(`Planned change touches a do_not_touch collection: ${o.desc}`);
    if (o.path && config.do_not_touch.redirect_paths.includes(o.path)) errors.push(`Planned change touches a do_not_touch redirect: ${o.desc}`);
  }
  for (const h of guarded) {
    const c = byHandle(h);
    notes.push(c ? `do_not_touch ${h}: no changes planned ("${c.title}", ${c.membership.productIds?.length ?? '?'} products, ${c.published ? 'published' : 'unpublished'}).` : `do_not_touch ${h}: not found.`);
  }
  const deletes = ops.filter((o) => o.kind === 'collection.delete');
  notes.push(`Collection deletions: ${deletes.length}, all created on or after ${cutoff} and empty. Collection handle changes: none (the script cannot write handles). Product title changes: none (the script cannot write titles).`);

  // Projected visible counts per collection
  const projected = {};
  for (const c of state.collections) {
    if (deleting.has(c.id)) continue;
    const spec = config.collections.find((s) => s.handle === c.handle);
    let ids;
    if (!spec) ids = state.products.filter((p) => p.collections.includes(c.handle)).map((p) => p.id);
    else if ((spec.membership ?? 'exact') === 'add_only') ids = [...new Set([...(c.membership.productIds ?? []), ...desired.get(spec.handle)])];
    else ids = desired.get(spec.handle);
    projected[c.handle] = { title: spec?.title ?? c.title, n: ids.map((id) => byId.get(id)).filter((p) => p && statusAfter(p) === 'ACTIVE').length };
  }
  for (const spec of config.collections) if (!target.get(spec.handle)) projected[spec.handle] = { title: spec.title, n: desired.get(spec.handle).length };

  return { errors, ops, notes, projected, activeAfter: activeAfter.size, menuItems };
}

// ---------------------------------------------------------------- Apply

const PUB = (state) => [{ publicationId: state.onlineStorePublicationId }];
const manualSource = (ids) => ({ source: { title: 'Manual selection', targetType: 'PRODUCTS', inclusion: { selections: ids.map((productId) => ({ productId })) } } });

function menuItemsInput(items, idByHandle) {
  return items.map((i) => {
    if (i.collection) {
      const id = idByHandle(i.collection);
      if (!id) die(`Collection ${i.collection} not found for the menu.`);
      return { title: i.title, type: 'COLLECTION', resourceId: id };
    }
    return { title: i.title, type: i.type, ...(i.url ? { url: i.url } : {}), items: menuItemsInput(i.items ?? [], idByHandle) };
  });
}

async function collectionIdByHandle(handle) {
  const d = await gql(`query($h: String!) { collectionByIdentifier(identifier: { handle: $h }) { id } }`, { h: handle });
  return d.collectionByIdentifier?.id ?? null;
}

async function apply(op, state, menuItems) {
  switch (op.kind) {
    case 'product.status': {
      const d = await gql(`mutation($p: ProductUpdateInput!) { productUpdate(product: $p) { product { id status } userErrors { field message } } }`, { p: { id: op.id, status: op.status } });
      return checkUserErrors(op.desc, d.productUpdate);
    }
    case 'menu.delete': {
      const d = await gql(`mutation($id: ID!) { menuDelete(id: $id) { deletedMenuId userErrors { field message } } }`, { id: op.id });
      return checkUserErrors(op.desc, d.menuDelete);
    }
    case 'collection.delete': {
      const d = await gql(`mutation($id: ID!) { collectionDelete(input: { id: $id }) { deletedCollectionId userErrors { field message } } }`, { id: op.id });
      return checkUserErrors(op.desc, d.collectionDelete);
    }
    case 'redirect.create': {
      const d = await gql(`mutation($r: UrlRedirectInput!) { urlRedirectCreate(urlRedirect: $r) { urlRedirect { id } userErrors { field message } } }`, { r: { path: op.path, target: op.target } });
      return checkUserErrors(op.desc, d.urlRedirectCreate);
    }
    case 'redirect.update': {
      const d = await gql(`mutation($id: ID!, $r: UrlRedirectInput!) { urlRedirectUpdate(id: $id, urlRedirect: $r) { urlRedirect { id } userErrors { field message } } }`, { id: op.id, r: { path: op.path, target: op.target } });
      return checkUserErrors(op.desc, d.urlRedirectUpdate);
    }
    case 'collection.create': {
      const input = { title: op.title, handle: op.handle, ...(op.add.length ? { sources: [manualSource(op.add)] } : {}) };
      const d = await gql(`mutation($c: CollectionCreateInput!) { collectionCreate(collection: $c) { collection { id handle } userErrors { field message } } }`, { c: input });
      return checkUserErrors(op.desc, d.collectionCreate);
    }
    case 'collection.title': {
      // Title only. The handle is deliberately not part of the input.
      const d = await gql(`mutation($c: CollectionUpdateInput!) { collectionUpdate(collection: $c) { collection { id handle title } userErrors { field message } } }`, { c: { id: op.id, title: op.title } });
      return checkUserErrors(op.desc, d.collectionUpdate);
    }
    case 'collection.copy': {
      // SEO title and description are always sent together so neither is cleared.
      const c = { id: op.id, descriptionHtml: op.descriptionHtml, seo: { title: op.seoTitle, description: op.seoDescription } };
      const d = await gql(`mutation($c: CollectionUpdateInput!) { collectionUpdate(collection: $c) { collection { id } userErrors { field message } } }`, { c });
      return checkUserErrors(op.desc, d.collectionUpdate);
    }
    case 'collection.members': {
      const sel = (ids) => ids.map((productId) => ({ productId }));
      const c = op.sourceId
        ? { id: op.id, sourcesToUpdate: [{ condition: { id: op.sourceId, inclusion: { ...(op.add.length ? { selectionsToAdd: sel(op.add) } : {}), ...(op.remove.length ? { selectionsToRemove: sel(op.remove) } : {}) } } }] }
        : { id: op.id, sourcesToCreate: [manualSource(op.add)] };
      const d = await gql(`mutation($c: CollectionUpdateInput!) { collectionUpdate(collection: $c) { collection { id } job { id done } userErrors { field message } } }`, { c });
      return checkUserErrors(op.desc, d.collectionUpdate);
    }
    case 'collection.publish': {
      const id = op.id ?? (await collectionIdByHandle(op.handle));
      const d = await gql(`mutation($id: ID!, $p: [PublicationInput!]!) { publishablePublish(id: $id, input: $p) { userErrors { field message } } }`, { id, p: PUB(state) });
      return checkUserErrors(op.desc, d.publishablePublish);
    }
    case 'menu.update': {
      const ids = new Map();
      for (const h of new Set(JSON.stringify(menuItems).match(/"collection":"[^"]+"/g).map((s) => s.slice(14, -1)))) ids.set(h, await collectionIdByHandle(h));
      const items = menuItemsInput(menuItems, (h) => ids.get(h));
      const d = await gql(`mutation($id: ID!, $t: String!, $items: [MenuItemUpdateInput!]!) { menuUpdate(id: $id, title: $t, items: $items) { menu { id } userErrors { field message } } }`, { id: op.id, t: config.menu.title, items });
      return checkUserErrors(op.desc, d.menuUpdate);
    }
    case 'note':
      return null;
    default:
      die(`Unknown op ${op.kind}`);
  }
}

// ---------------------------------------------------------------- Main

function printTree(items, depth = 0) {
  for (const i of items) {
    console.log(`${'  '.repeat(depth + 2)}${i.title}  ->  ${i.url} (${i.type})`);
    printTree(i.items ?? [], depth + 1);
  }
}

function printCopy(o) {
  const show = (label, before, after) => {
    if ((before ?? '') === (after ?? '')) return;
    console.log(`      ${label} (${(after ?? '').length} chars)`);
    console.log(`        before: ${before || '(empty)'}`);
    console.log(`        after:  ${after}`);
  };
  show('intro (descriptionHtml)', o.before.descriptionHtml, o.descriptionHtml);
  show('SEO title', o.before.seoTitle, o.seoTitle);
  show('SEO description', o.before.seoDescription, o.seoDescription);
}

if (!stateArg) await checkScopes();
const raw = stateArg ? JSON.parse(readFileSync(stateArg, 'utf8')) : await fetchRawState();
const state = normalizeState(raw);
const result = plan(state);

if (PRINT_MENU) {
  if (result.errors.length) die(result.errors.join('\n'));
  const idByHandle = (h) => state.collections.find((c) => c.handle === h)?.id;
  console.log(JSON.stringify(menuItemsInput(result.menuItems, idByHandle), null, 2));
  process.exit(0);
}

const ORDER = [1, 0, 2, 3];
const STEPS = { 0: 'Cleanup and redirects', 1: 'Step 1: hide products', 2: 'Step 2: collections and copy', 3: 'Step 3: main menu' };

console.log(`${DRY ? 'DRY RUN' : 'LIVE RUN'} against ${STORE} (state fetched ${raw.fetchedAt}${stateArg ? `, from ${stateArg}` : ''})`);
console.log(`Products: ${state.products.length} total, ${state.products.filter((p) => p.status === 'ACTIVE').length} active now`);

if (result.errors.length) {
  console.log('\nProblems found. Nothing was written:');
  for (const e of result.errors) console.log(`  - ${e}`);
  process.exit(1);
}

for (const step of ORDER) {
  const ops = result.ops.filter((o) => o.step === step);
  console.log(`\n${STEPS[step]} (${ops.filter((o) => o.kind !== 'note').length} changes)`);
  if (!ops.length) console.log('  nothing to do');
  for (const o of ops) {
    console.log(o.kind === 'note' ? `  ${o.desc}` : `  [${o.kind}] ${o.desc}`);
    if (o.kind === 'collection.copy') printCopy(o);
    if (o.kind === 'menu.update') {
      console.log('    before:'); printTree(o.before);
      console.log('    after:'); printTree(o.after);
    }
  }
}

console.log('\nChecks:');
for (const n of result.notes) console.log(`  ${n}`);
console.log(`  Active products after run: ${result.activeAfter}`);
console.log('\nVisible (ACTIVE) products per collection after run:');
for (const [h, { title, n }] of Object.entries(result.projected).sort()) console.log(`  ${h.padEnd(24)} ${String(n).padStart(3)}  ${title}`);
console.log(`\nUnassigned season (${config.unassigned_season.length}): ${config.unassigned_season.join(', ')}`);

const writes = result.ops.filter((o) => o.kind !== 'note');
if (DRY) {
  console.log(`\nDry run: ${writes.length} changes planned, none written.`);
  process.exit(0);
}
if (!writes.length) {
  console.log('\nAlready in the target state. Nothing written.');
  process.exit(0);
}

mkdirSync(join(HERE, 'snapshots'), { recursive: true });
const snap = join(HERE, 'snapshots', `${raw.fetchedAt.replace(/[:.]/g, '-')}.json`);
writeFileSync(snap, JSON.stringify(raw, null, 2));
console.log(`\nSnapshot saved: ${snap}`);

for (const step of ORDER) {
  for (const op of result.ops.filter((o) => o.step === step && o.kind !== 'note')) {
    await apply(op, state, result.menuItems);
    console.log(`  done: ${op.desc}`);
  }
}

// Verify by re-reading and re-planning: a correct run leaves nothing to do.
const after = normalizeState(await fetchRawState());
const recheck = plan(after);
const left = recheck.ops.filter((o) => o.kind !== 'note');
console.log(`\nAfter run: ${after.products.filter((p) => p.status === 'ACTIVE').length} active products; ${left.length} changes still pending.`);
for (const e of recheck.errors) console.log(`  problem: ${e}`);
for (const o of left) console.log(`  pending: ${o.desc}`);
if (left.length || recheck.errors.length) process.exit(1);
