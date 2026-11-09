// Cache rows are reusable only when both calculation age and source method
// are compatible. This floor is the successful pokevalue2 deployment status
// of 9f2c64d (sealed-product/reprint acceptance repair), not a refreshed TTL.
export const CACHE_SAFETY_FLOOR = Date.parse('2026-11-09T15:30:47Z');
export const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const FOREIGN = new Set(['PSA', 'BGS', 'CGC', 'SGC', 'TAG']);
export function companyCacheKeys(query, grader, variant, grade, provider) {
  const prefixes = grader === 'RAW' ? ['c5:', 'c8:']
    : (grade === 10 || grade > 100 ? ['c6:', 'c9:'] : ['c4:', 'c7:']);
  return prefixes.map(p => p + provider + ':' + query + '|' + grader.toLowerCase() + '|v:' + variant);
}
function positive(value) {
  return (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value)) && Number(value) > 0;
}
export function validCacheRow(row, { now, keys, language, grade, query, grader, variant, provider, aggregate = false }) {
  if (!row || !keys.includes(row.card_key) || row.language !== language || Number(row.grade) !== grade) return false;
  if (typeof row.updated_at !== 'string' || !row.updated_at.trim()) return false;
  const at = Date.parse(row.updated_at);
  if (!Number.isFinite(at) || at < CACHE_SAFETY_FLOOR || at > now || now - at > CACHE_TTL_MS) return false;
  if (!positive(row.price) || !positive(row.sample_count) || !Number.isInteger(Number(row.sample_count))) return false;
  const b = row.breakdown;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return false;
  const meta = b.cache_meta;
  for (const obj of [row, b, meta].filter(Boolean)) {
    if (obj.error || obj.partial === true || obj.complete === false || obj.failed === true || obj.formula_status === 'partial' || (Array.isArray(obj.omitted) && obj.omitted.length)) return false;
    if (obj.currency != null && obj.currency !== 'USD') return false;
    if (obj.status != null && !['complete', 'success', 'ok'].includes(obj.status)) return false;
  }
  if (aggregate) {
    // The gated legacy endpoint never recorded canonical printing/variant
    // identity. It cannot prove compatibility with a current exact cell.
    return false;
  }
  if (!(grader === 'RAW' && grade === 0) && !(FOREIGN.has(grader) && Number.isInteger(grade) && grade >= 1 && grade <= 10) && !(grader === 'CGC' && grade === 101) && !(grader === 'BGS' && grade === 102)) return false;
  if (meta) {
    if (meta.version !== 1 || meta.method !== 'arithmetic-mean' || meta.currency !== 'USD' || meta.status !== 'complete' || meta.query !== query || meta.grader !== grader || meta.variant !== variant || meta.grade !== grade || meta.provider !== provider) return false;
  } else {
    // Historical rows omit metadata. Only exact scoped company namespaces,
    // post-safety floor, from adapters with verified USD-only price contracts
    // qualify. Legacy mixed/error aggregates never share these keys.
    if (!['compsapi', 'scraperapi'].includes(provider) || Object.keys(b).length) return false;
  }
  return true;
}
export function newestValidCacheRow(rows, scope) {
  return (rows || []).filter(r => validCacheRow(r, scope)).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0] || null;
}
export function cacheMetadata(query, grader, variant, grade, provider) {
  return { cache_meta: { version: 1, method: 'arithmetic-mean', currency: 'USD', status: 'complete', query, grader, variant, grade, provider } };
}
