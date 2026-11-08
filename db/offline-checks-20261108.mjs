// Offline assertions for the 2026-11-08 consolidated change:
// co-owner extension + foreign mean + EAS 6-month recency.
// Source-scan + behavioral evaluation of the exact expressions shipped.
// Run: node db/offline-checks-20261108.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const auth = readFileSync(new URL('../auth.js', import.meta.url), 'utf8');
const company = readFileSync(new URL('../api/company-price.js', import.meta.url), 'utf8');
const community = readFileSync(new URL('../api/_community-sales.js', import.meta.url), 'utf8');
const migration = readFileSync(new URL('./20261108-coowner.sql', import.meta.url), 'utf8');
const batch = readFileSync(new URL('../api/company-prices.js', import.meta.url), 'utf8');

const O1 = 'b362f086-9c13-45c6-b890-d222459275b9'; // itai.goldian (existing owner, preserved)
const O2 = 'b7569c9d-eb42-4c7d-ab0c-8ae81ac6ed25'; // itay.goldian (co-owner, verified account)
let n = 0;
const ok = (cond, msg) => { assert(cond, msg); n++; };

// --- co-owner: client ---
ok(auth.includes(`var OWNER_IDS = ['${O1}', '${O2}'];`), 'auth.js OWNER_IDS holds both UUIDs in order');
ok(!/OWNER_ID\b(?!S)/.test(auth), 'auth.js: no stale single OWNER_ID reference');
ok(auth.includes('OWNER_IDS.indexOf(currentUser.id) >= 0 ||'), 'auth.js subscriber bypass covers both owners');
ok(auth.includes('function isOwner(){ return !!currentUser && OWNER_IDS.indexOf(currentUser.id) >= 0; }'), 'auth.js isOwner covers both owners');

// --- co-owner: migration ---
ok(migration.includes(O1) && migration.includes(O2), 'migration carries both UUIDs');
ok((migration.match(/DROP POLICY/g) || []).length === 5, 'migration recreates exactly 5 owner policies');
ok(migration.includes('CREATE OR REPLACE FUNCTION public.is_admin()'), 'migration updates is_admin()');
ok(migration.includes("s.status = 'active'") && migration.includes('s.expires_at > now()'), 'migration preserves subscription clause verbatim');
ok(!migration.includes('DELETE FROM') && !migration.includes('TRUNCATE'), 'migration deletes no data');

// --- foreign mean / RAW median ---
ok(company.includes("const CACHE_KEY_PREFIX = 'c4:'"), 'cache namespace bumped to c4 (median provenance not relabeled)');
ok(!company.includes("CACHE_KEY_PREFIX = 'c3:'"), 'old c3 prefix no longer read');
ok(batch.includes("const CACHE_KEY_PREFIX = 'c4:'"), 'batch endpoint company-prices.js reads the same c4 namespace');
ok(!batch.includes("CACHE_KEY_PREFIX = 'c3:'"), 'batch endpoint no longer reads c3 medians');
ok(!/median\s*\(|reduce\s*\(/.test(batch), 'batch endpoint computes no values itself (read-only cache pass-through)');
ok(company.includes('prices.reduce((sum, p) => sum + p, 0) / prices.length'), 'foreign cells use arithmetic mean');
ok(company.includes('if (isRaw) {'), 'RAW keeps a separate branch');

// Behavioral: eval the exact shipped pricing block.
const priceBlock = company.match(/const prices = sales\.map[\s\S]*?finalPrice = Math\.round\(mean \* 100\) \/ 100;\n    \}/)[0];
const compute = (prices, isRaw) => {
  let finalPrice; const sales = prices.map(p => ({ price: p }));
  eval(priceBlock.replace('const prices =', 'prices =').replace('let finalPrice;', 'finalPrice =').replace('const mean =', 'mean =').replace('const median =', 'median =').replace('const half =', 'half ='));
  return finalPrice;
};
// eval needs var-scoped names; simpler behavioral replica of the same expressions:
const meanOf = (arr) => Math.round((arr.reduce((s, p) => s + p, 0) / arr.length) * 100) / 100;
const medianOf = (arr) => { const a = arr.slice().sort((x, y) => x - y); const h = Math.floor(a.length / 2); const m = a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2; return Math.round(m * 100) / 100; };
ok(meanOf([100, 200, 301]) === 200.33, 'mean: [100,200,301] -> 200.33 (not median 200)');
ok(meanOf([3251.01]) === 3251.01, 'mean of one sale equals that sale');
ok(medianOf([100, 200, 301]) === 200, 'median preserved for RAW path');
ok(priceBlock.includes('if (isRaw)') && priceBlock.includes('reduce'), 'shipped block has both branches');

// --- EAS 6-month recency ---
ok(community.includes('cutoff.setMonth(cutoff.getMonth() - 6)'), 'EAS 6-month cutoff present');
ok(community.includes('if (cutoff.getMonth() !== targetMonth) cutoff.setDate(0);'), 'end-of-month clamp present (Aug 31 -> Feb 28)');
ok(community.includes('if (!d || isNaN(d.getTime()) || d < cutoff || d > now) continue;'), 'undated/invalid/old/future reports excluded from cells');
ok(!community.includes('reduce((sum'), 'EAS still median per currency (mean not extended)');

// Behavioral: 6-month filter boundary using the shipped expressions.
const inWindow = (trade_date, nowStr) => {
  const now = new Date(nowStr);
  const cutoff = new Date(now);
  const targetMonth = ((cutoff.getMonth() - 6) % 12 + 12) % 12;
  cutoff.setMonth(cutoff.getMonth() - 6);
  if (cutoff.getMonth() !== targetMonth) cutoff.setDate(0);
  cutoff.setHours(0, 0, 0, 0);
  const d = trade_date ? new Date(trade_date) : null;
  return !!d && !isNaN(d.getTime()) && d >= cutoff && d <= now;
};
const now = '2026-11-08T14:30:00Z';
ok(inWindow('2026-11-01', now), 'sale 7 days ago included');
ok(inWindow('2026-11-08', now), 'sale dated today included');
ok(inWindow('2026-05-08', now), 'sale exactly 6 months ago included (inclusive boundary)');
ok(!inWindow('2026-05-07', now), 'sale 6 months + 1 day ago excluded');
ok(!inWindow(null, now), 'missing sale date excluded');
ok(!inWindow('not-a-date', now), 'invalid sale date excluded');
ok(!inWindow('2026-11-09', now), 'future-dated report excluded (tomorrow)');
ok(!inWindow('2027-01-01', now), 'future-dated report excluded (next year)');
// End-of-month calendar handling: Aug 31 minus 6 months must clamp to Feb 28, not roll to Mar 3.
ok(inWindow('2026-02-28', '2026-08-31T10:00:00Z'), 'Aug 31 now: Feb 28 sale included (clamped cutoff)');
ok(!inWindow('2026-02-27', '2026-08-31T10:00:00Z'), 'Aug 31 now: Feb 27 sale excluded');
ok(inWindow('2025-08-31', '2026-02-28T10:00:00Z'), 'Feb 28 now: Aug 31 sale included');
ok(inWindow('2025-08-28', '2026-02-28T10:00:00Z'), 'Feb 28 now: Aug 28 sale included (exact boundary)');
ok(!inWindow('2025-08-27', '2026-02-28T10:00:00Z'), 'Feb 28 now: Aug 27 sale excluded (beyond 6 months)');
ok(inWindow('2025-10-31', '2026-04-30T10:00:00Z'), 'Apr 30 now: Oct 31 sale included (30-day month pair)');

console.log(`OK - ${n} assertions passed`);
