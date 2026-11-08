// Community EAS sales: the ONLY source of recorded EAS sales (owner decision
// Nov7 17:36, verified wamid ...QUM3NkU3NDVBMjM1MjYyQjMwMDE4QjNENjE4QzI2NzcA:
// EAS sales are never searched externally; they come only from this site's
// approved deal reports, and user Nov7 11:00:16: existing EAS sales are to be
// included). Owner moderation still gates every report (status 'approved'
// only), and the user's Nov7 14:06 steering feeds approved reports into
// valuation without removing that moderation.
//
// Variant safety (Main review Nov7 22:36): a report enters a valuation cell
// only when its tcg id, language, grade AND variant all match the cell
// exactly. Legacy reports whose variant is NULL never match a variant key, so
// they stay display-only in the deals list. Foreign-graded reports are never
// converted into EAS-equivalent values (durable grade-equivalence blocker):
// this module only ever reads grader='EAS' rows.
//
// No price_cache rows are written: community data changes the moment the
// owner approves a report, and a Supabase read is free, so cells are always
// computed live instead of served from a 14-day cache.
//
// Currencies are never converted (no approved FX source): each cell reports a
// median per currency; the primary display currency is the one with more
// reports, ties going to ILS (the local market).

function median(nums) {
  const a = nums.slice().sort((x, y) => x - y);
  const h = Math.floor(a.length / 2);
  return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2;
}

function buildCell(grade, sales) {
  const byCur = {};
  for (const s of sales) (byCur[s.currency] = byCur[s.currency] || []).push(s.price);
  const per = {};
  for (const c of Object.keys(byCur)) {
    per[c] = { price: Math.round(median(byCur[c]) * 100) / 100, count: byCur[c].length };
  }
  const primary = Object.keys(per).sort((a, b) => per[b].count - per[a].count || (a === 'ILS' ? -1 : 1))[0];
  const latest = sales.map(s => s.trade_date).filter(Boolean).sort().pop() || null;
  return {
    grader: 'EAS',
    grade,
    price: per[primary].price,
    currency: primary,
    per_currency: per,
    total_sales: sales.length,
    source: 'community',
    cached: false,
    updated_at: latest,
  };
}

// Returns { cells } with one cell per integer grade that has at least one
// usable approved report, or { error } on a Supabase failure. Reports with a
// non-integer grade ('9.5') or a non-positive price never mix into a cell.
export async function fetchEasCommunityCells(supabase, tcgId, language, variantKey) {
  const { data, error } = await supabase
    .from('community_trades')
    .select('grade,price,currency,trade_date')
    .eq('status', 'approved')
    .eq('tcg_id', tcgId)
    .eq('language', language)
    .eq('grader', 'EAS')
    .eq('variant', variantKey);
  if (error) return { error };
  // Recency (owner instruction Nov8 16:17): an approved report enters an EAS
  // cell only when its actual sale date is within the last 6 months. A report
  // without a verifiable sale date can never prove recency, so it stays
  // display-only in the deals list and never enters a cell.
  const now = new Date();
  const cutoff = new Date(now);
  const targetMonth = ((cutoff.getMonth() - 6) % 12 + 12) % 12;
  cutoff.setMonth(cutoff.getMonth() - 6);
  if (cutoff.getMonth() !== targetMonth) cutoff.setDate(0); // e.g. Aug 31 -> Feb 28, never Mar 3
  cutoff.setHours(0, 0, 0, 0); // date granularity: the boundary date counts for the whole day
  const byGrade = new Map();
  for (const r of data || []) {
    const g = Number(r.grade);
    if (!Number.isInteger(g) || g < 1 || g > 10) continue;
    const p = Number(r.price);
    if (!isFinite(p) || p <= 0) continue;
    const d = r.trade_date ? new Date(r.trade_date) : null;
    if (!d || isNaN(d.getTime()) || d < cutoff || d > now) continue;
    const cur = r.currency === 'USD' ? 'USD' : 'ILS';
    if (!byGrade.has(g)) byGrade.set(g, []);
    byGrade.get(g).push({ price: p, currency: cur, trade_date: r.trade_date });
  }
  const cells = [];
  for (const [grade, sales] of byGrade) cells.push(buildCell(grade, sales));
  return { cells };
}
