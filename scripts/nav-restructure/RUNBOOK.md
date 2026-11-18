# Nav restructure: go-live runbook

Approved 2026-11-18. Run top to bottom without waiting for sign-off, **except** at the two
STOP checks (steps 1 and 2). Nothing outward-facing happens before both checks pass.

Scope approved: everything in `dryrun-v4-approved.txt` (hiding 22 products, cleanup, the
occasion-wear and summer-collection redirects, 22 product redirects, Block Print, renames,
new collections, menu). Collection copy stays **held** (`copy_on_hold.hold: true`): go live
without it.

Paths below are relative to the theme repo root (`horizon-live/`). `$TMP` is any scratch folder.

## 0. Preconditions

- `SHOPIFY_SHOP`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` are set. Check names only,
  never print values:
  `for v in SHOPIFY_SHOP SHOPIFY_CLIENT_ID SHOPIFY_CLIENT_SECRET; do eval "x=\${$v:-}"; [ -n "$x" ] && echo "$v set" || echo "$v MISSING"; done`
- Branch `nav-restructure` is checked out and clean; `git fetch` shows `origin/main` is
  still its base (`git merge-base --is-ancestor origin/main nav-restructure`).

## 1. STOP check: live theme vs main

1. Confirm theme `192069992759` is still the live (MAIN) theme:
   `shopify theme list --store x1hna4-kw.myshopify.com`. If another theme is live, STOP.
2. Pull it and diff against `origin/main`:
   ```
   shopify theme pull --store x1hna4-kw.myshopify.com --theme 192069992759 --path $TMP/live
   git worktree add --detach $TMP/main origin/main
   diff -rq $TMP/live $TMP/main -x .git -x .github -x scripts -x .gitignore
   ```
   Allowed difference: `AGENTS.md` only on live, and identical to the branch copy
   (`cmp AGENTS.md $TMP/live/AGENTS.md`). **Any other difference: STOP and report it.**
   Do not merge; it would overwrite live changes.

## 2. STOP check: real-credentials dry run

```
node scripts/nav-restructure/apply.mjs --dry-run > $TMP/dryrun-real.txt
diff <(tail -n +3 scripts/nav-restructure/dryrun-v4-approved.txt) <(tail -n +2 $TMP/dryrun-real.txt)
```
The approved file has one extra comment line at the top, hence `+3` vs `+2`; the
`DRY RUN against ...` header line (timestamp) is excluded from both. **Any output from
`diff` means the store changed: STOP and report the diff.** A missing scope or a token
error (`shop_not_permitted`) also stops here.

## 3. Merge (deploys the theme)

```
git checkout main
git merge --ff-only nav-restructure
git push origin main
```
This brings in the nav fix, the homepage tile and hero names, `AGENTS.md` and the script.
The push triggers `.github/workflows/deploy.yml` (`shopify theme push --theme 192069992759
--allow-live --nodelete`). Wait for it: `gh run watch` on the newest run. It must succeed,
and its log must say "pushed successfully" and not "pushed with errors". If it fails, STOP
and report before running the script.

## 4. Live run

```
node scripts/nav-restructure/apply.mjs 2>&1 | tee $TMP/live-run.txt
```
- It saves a snapshot to `scripts/nav-restructure/snapshots/<timestamp>.json` before
  writing. Snapshots are git-ignored: the repo is public and a snapshot is a full store dump.
- Expected ending: `46 active products; 0 changes still pending; 8 held.`
- Skipped product redirects are listed as `skipped redirect:`. Report them; do not force.
- If it ends with pending changes and no `problem:` lines (for example throttling), run it
  once more: it is idempotent. Otherwise STOP and report.

## 5. Verify redirects

```
for p in /collections/occasion-wear /collections/summer-collection /products/elara /products/aura /products/muted-iris /products/diamond-lattice /products/lace-jacket /products/black-leopard; do
  printf "%s -> " $p; curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" "https://jannatandsadaf.com$p"; done
```
Expect 301s to `/collections/formals`, `/collections/summer`, `/collections/pret`,
`/collections/festive-wear`, `/collections/dinner-wear`, `/collections/co-ord-sets`,
`/collections/formals`, `/collections/pret`.

## 6. Screenshots (desktop + mobile: menu, homepage, every collection page)

```
npm i --prefix $TMP/pw playwright@1.48.2
cp scripts/nav-restructure/screenshots.mjs $TMP/pw/
node $TMP/pw/screenshots.mjs ../screenshots/nav-golive-$(date +%Y-%m-%d)
```
Uses the system Chrome. Shoots the live site by default. Look at every image, and check
the printed `tiles:` line: the Everyday Wear and Occasion Wear tiles should now use the
stored `collection-pret.jpg` and `collection-formals.jpg` (Serenade Beige and Muted Iris are
drafts). Check each collection's `products linked` count against the live-run output.

## 7. Delete the preview theme

```
shopify theme delete --store x1hna4-kw.myshopify.com --theme 192109216055 --force
```
("ZZ nav preview (safe to delete)". Its menu, `main-menu-new`, is deleted by step 4.)

## 8. Report

Screenshots folder, snapshot path, active product count, visible products per collection,
redirect checks, deploy run, anything skipped. Still open (not blocking): seasons for the
10 unassigned products, releasing the held copy, and the thin collections (Wedding, Hue,
Special Prices, New In).

## Later: release the held copy

When the family confirms the facts, set `copy_on_hold.hold` to `false`, run the dry run
(only the 8 copy changes should show), then the live run.
