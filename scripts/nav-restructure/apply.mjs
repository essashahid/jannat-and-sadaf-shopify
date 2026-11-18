#!/usr/bin/env node
// Applies scripts/nav-restructure/config.json to the store through the Admin GraphQL API.
//
//   SHOPIFY_ADMIN_TOKEN=shpat_... node scripts/nav-restructure/apply.mjs --dry-run
//   SHOPIFY_ADMIN_TOKEN=shpat_... node scripts/nav-restructure/apply.mjs
//   node scripts/nav-restructure/apply.mjs --dry-run --state <captured-state.json>   (offline plan)
//
// Idempotent: every step compares current state with config and only writes the difference.
// A live run saves a snapshot of the current state to snapshots/<timestamp>.json before writing.
//
// Hard rules enforced here: collection handles and product titles are never written; only
// collections created during this task (by id and createdAt) can be deleted; anything under
// config.do_not_touch stops the run if a change would reach it.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const stateArg = args.includes('--state') ? args[args.indexOf('--state') + 1] : null;
if (stateArg && !DRY) die('--state is only allowed together with --dry-run.');

const config = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const ENDPOINT = `https://${config.store}/admin/api/${config.api_version}/graphql.json`;

function die(msg) {
  console.error(`\nSTOPPED: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------- GraphQL

async function gql(query, variables = {}) {
  if (!TOKEN) die('SHOPIFY_ADMIN_TOKEN is not set.');
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
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

// ---------------------------------------------------------------- Read state

const PRODUCTS_Q = `query($after: String) { products(first: 100, after: $after) {
  pageInfo { hasNextPage endCursor }
  nodes { id title handle status collections(first: 50) { nodes { handle } } } } }`;

const COLLECTIONS_Q = `query($after: String, $pub: ID!) { collections(first: 50, after: $after) {
  pageInfo { hasNextPage endCursor }
  nodes { id title handle createdAt publishedOnPublication(publicationId: $pub)
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
    return { id: c.id, title: c.title, handle: c.handle, createdAt: c.createdAt, published: c.publishedOnPublication, membership };
  });
  return { ...raw, products, collections };
}

// ---------------------------------------------------------------- Plan

const norm = (s) => String(s).trim().replace(/\s+/g, ' ').toLowerCase();

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

  // Collection lists -> product ids
  const desired = new Map();
  for (const spec of config.collections) {
    const ids = [];
    for (const t of spec.products) {
      const p = resolve(t);
      if (!p) continue;
      if (hidden.has(p.id)) errors.push(`${spec.title}: "${t}" is in the hide list.`);
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
    if (occupant && !deleting.has(occupant.id)) errors.push(`Redirect ${r.path}: collection ${occupant.handle} would still occupy the path, so the redirect could not fire.`);
    if (targetHandle && (!target || !target.published)) errors.push(`Redirect ${r.path}: target ${r.target} is missing or unpublished.`);
    if (existing && existing.target !== r.target) {
      errors.push(`Redirect ${r.path} exists with target ${existing.target}, expected ${r.target}; not changing it.`);
    } else if (existing) {
      notes.push(`Redirect ${r.path} -> ${r.target}: exists (${existing.id}).${occupant ? ` Takes effect once ${occupant.handle} is deleted.` : ''}`);
    } else {
      notes.push(`Redirect ${r.path} -> ${r.target}: does NOT exist now; planned to be created${occupant ? ` after ${occupant.handle} is deleted` : ''}.`);
      ops.push({ step: 0, kind: 'redirect.create', path: r.path, target: r.target, desc: `Create redirect ${r.path} -> ${r.target}` });
    }
  }

  // Step 2: collections (title and exact product list; handles never change)
  const target = new Map(config.collections.map((s) => [s.handle, byHandle(s.handle) ?? null]));
  for (const spec of config.collections) {
    const c = target.get(spec.handle);
    const want = desired.get(spec.handle);
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
    const remove = [...have].filter((id) => !want.includes(id));
    for (const id of add) ops.push({ step: 2, kind: 'note', desc: `  ${spec.handle} + ${label(byId.get(id))}` });
    for (const id of remove) {
      const p = byId.get(id);
      const why = !p ? '' : hidden.has(id) ? ' (being hidden)' : p.status !== 'ACTIVE' ? ` (${p.status})` : '';
      ops.push({ step: 2, kind: 'note', desc: `  ${spec.handle} - ${label(p)}${why}` });
    }
    if (add.length || remove.length) {
      ops.push({ step: 2, kind: 'collection.members', id: c.id, handle: spec.handle, sourceId: c.membership.sourceId, add, remove, desc: `${spec.handle} ("${spec.title}"): add ${add.length}, remove ${remove.length} (result ${want.length})` });
    }
    if (!c.published) ops.push({ step: 2, kind: 'collection.publish', handle: spec.handle, id: c.id, desc: `Publish ${spec.handle} to Online Store` });
  }

  // Step 3: menu
  const menu = state.menus.find((m) => m.handle === config.menu.handle);
  if (!menu) errors.push(`Menu ${config.menu.handle} not found.`);
  const shape = (items) => (items ?? []).map((i) => ({ title: i.title, type: i.type, url: i.url, items: shape(i.items) }));
  const targetShape = (items) => (items ?? []).map((i) => i.collection
    ? { title: i.title, type: 'COLLECTION', url: `/collections/${i.collection}`, items: shape([]) }
    : { title: i.title, type: i.type, url: i.type === 'CATALOG' ? '/collections/all' : i.url, items: targetShape(i.items) });
  const menuCollections = (items) => (items ?? []).flatMap((i) => (i.collection ? [i.collection] : menuCollections(i.items)));
  for (const h of menuCollections(config.menu.items)) {
    const c = byHandle(h);
    if (!targetHandles.has(h) && (!c || deleting.has(c.id))) errors.push(`Menu links to ${h}, which will not exist.`);
  }
  if (menu && JSON.stringify(shape(menu.items)) !== JSON.stringify(targetShape(config.menu.items))) {
    ops.push({ step: 3, kind: 'menu.update', id: menu.id, desc: `Replace ${config.menu.handle} items`, before: shape(menu.items), after: targetShape(config.menu.items) });
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
  for (const path of config.do_not_touch.redirect_paths) {
    const r = state.redirects.find((x) => x.path === path);
    notes.push(`do_not_touch redirect ${path}: no changes planned (${r ? `currently -> ${r.target}` : 'does not exist'}).`);
  }
  const deletes = ops.filter((o) => o.kind === 'collection.delete');
  notes.push(`Collection deletions: ${deletes.length}, all created on or after ${cutoff} and empty. Collection handle changes: none (the script cannot write handles). Product title changes: none (the script cannot write titles).`);

  // Projected visible counts per collection
  const projected = {};
  const statusAfter = (p) => (hidden.has(p.id) && p.status !== 'ARCHIVED' ? config.hide_products.status : p.status);
  for (const c of state.collections) {
    if (deleting.has(c.id)) continue;
    const spec = config.collections.find((s) => s.handle === c.handle);
    const members = spec ? desired.get(spec.handle).map((id) => byId.get(id)) : state.products.filter((p) => p.collections.includes(c.handle));
    projected[c.handle] = { title: spec?.title ?? c.title, n: members.filter((p) => statusAfter(p) === 'ACTIVE').length };
  }
  for (const spec of config.collections) if (!target.get(spec.handle)) projected[spec.handle] = { title: spec.title, n: desired.get(spec.handle).length };

  return { errors, ops, notes, projected, activeAfter: activeAfter.size };
}

// ---------------------------------------------------------------- Apply

const PUB = (state) => [{ publicationId: state.onlineStorePublicationId }];
const manualSource = (ids) => ({ source: { title: 'Manual selection', targetType: 'PRODUCTS', inclusion: { selections: ids.map((productId) => ({ productId })) } } });

async function collectionIdByHandle(handle) {
  const d = await gql(`query($h: String!) { collectionByIdentifier(identifier: { handle: $h }) { id } }`, { h: handle });
  if (!d.collectionByIdentifier) die(`Collection ${handle} not found while applying.`);
  return d.collectionByIdentifier.id;
}

async function menuItemsInput(items) {
  const out = [];
  for (const i of items) {
    if (i.collection) out.push({ title: i.title, type: 'COLLECTION', resourceId: await collectionIdByHandle(i.collection) });
    else out.push({ title: i.title, type: i.type, ...(i.url ? { url: i.url } : {}), items: await menuItemsInput(i.items ?? []) });
  }
  return out;
}

async function apply(op, state) {
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
      const items = await menuItemsInput(config.menu.items);
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

const raw = stateArg ? JSON.parse(readFileSync(stateArg, 'utf8')) : await fetchRawState();
const state = normalizeState(raw);
const result = plan(state);
const ORDER = [1, 0, 2, 3];
const STEPS = { 0: 'Cleanup and redirects', 1: 'Step 1: hide products', 2: 'Step 2: collections', 3: 'Step 3: main menu' };

console.log(`${DRY ? 'DRY RUN' : 'LIVE RUN'} against ${config.store} (state fetched ${raw.fetchedAt}${stateArg ? `, from ${stateArg}` : ''})`);
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
    await apply(op, state);
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
