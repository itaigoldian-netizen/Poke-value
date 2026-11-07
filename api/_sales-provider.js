// Sales-data provider dispatch (owner request Nov7 18:40, confirmed 18:40:40):
// the site's sales source is selected by SALES_PROVIDER.
//
//   SALES_PROVIDER=scraperapi (default, original integration):
//     ScraperAPI structured eBay search, key in SCRAPER_API_KEY.
//   SALES_PROVIDER=compsapi:
//     CompsAPI (https://compsapi.com/docs), key in COMPS_API_KEY sent in the
//     X-API-Key header (never in a URL). Free plan: 100 requests/month, key
//     pauses at quota with a 429 until the UTC month resets - no overage
//     charge, no card required.
//
// Reverting is an env change back to scraperapi; no code edit needed.
// Both paths return the same shape: [{ price, date, title }] (up to 10 sales,
// newest first) already filtered for the requested company+grade (or raw) and
// language. EAS is never looked up externally: callers never pass EAS.
//
// The pause gate (SALES_PROVIDER_ENABLED) lives in the calling endpoints and
// applies to every provider.

const JUNK_KEYWORDS = /\b(lot|bundle|set of|proxy|custom|reprint|replica|orica|empty slab|slab only|fake)\b/i;
const LANG_PATTERNS = {
  Japanese: /\b(japanese|japan|jpn|jp)\b/i,
  Korean: /\b(korean|korea|kor)\b/i,
  Chinese: /\b(chinese|china|chn|simplified|traditional)\b/i,
};
// EAS stays in this filter: an 'EAS 9' title is still a graded card and must
// never count toward the raw value, even though EAS is not a lookup column.
const GRADED_TITLE = /\b(PSA|BGS|CGC|EAS|TAG|SGC|ACE)\s*-?\s*\d/i;

// --- Finish/edition variant separation (owner approval Nov7 22:15:22,
// wamid...QUMwQjNGRTc0MEVDN0Y3NzIyMzM2MUUwRDg0QUM5QjAA; semantics hardened
// per Main review Nov7 22:25) ---
// Sales of different variants of the SAME printing are never merged into one
// value. The authoritative source for which variants a printing really has is
// the TCGdex card record's variants_detailed list (type/subtype/stamp per real
// combo) - flat boolean flags and Cartesian guesses are NOT used.
//
// Matching rules (applied to every candidate sale title, both providers):
// - STRICT mode (the printing has more than one detailed entry, supported or
//   not): every token of the variant must be POSITIVELY stated in the title.
//   Absence of "1st edition"/"shadowless" never proves unlimited, and silence
//   about finish never proves non-holo - an ambiguous title counts toward NO
//   variant and the cell shows 'no data' instead of a mixed value.
// - EXHAUSTION mode (exactly one detailed entry exists): an unmarked title
//   can only be that variant, so it matches; a title positively naming a
//   different variant token is excluded.
// - 'shadowless' and any other unsupported subtype are explicit no-data
//   variants: they are never selectable, never silently mapped to unlimited,
//   and their titles never match any supported variant.
const VARIANT_TOKENS = new Set(['first-edition', 'unlimited', 'holo', 'non-holo', 'reverse', 'w-promo']);
const RE_1ST_ED = /\b1st[\s-]*(ed|edition)\b/i;
const RE_UNLIMITED = /\bunlimited\b/i;
const RE_SHADOWLESS = /\bshadowless\b/i;
const RE_REVERSE = /\breverse[\s-]*(holo|holographic|foil)?/i;
const RE_HOLO = /\b(holo|holographic|foil)\b/i;
const RE_NONHOLO = /\bnon[\s-]*holo(graphic)?\b/i;
const RE_WPROMO = /\bw[\s-]*(promo|stamp(ed)?)\b|\bwotc\s+promo\b/i;

// Validates the variant param: '+'-joined known tokens, at most one edition
// and one finish token. Returns the normalized key or null when invalid.
export function normalizeVariant(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const tokens = String(raw).toLowerCase().split('+').filter(Boolean);
  if (!tokens.length || tokens.length > 2) return null;
  for (const t of tokens) if (!VARIANT_TOKENS.has(t)) return null;
  const editions = tokens.filter(t => t === 'first-edition' || t === 'unlimited');
  if (editions.length > 1) return null;
  const finishes = tokens.filter(t => t !== 'first-edition' && t !== 'unlimited');
  return editions.concat(finishes).join('+'); // edition-first, matches variantOptionsFromDetail keys
}

// Builds the printing's real variant list from TCGdex variants_detailed.
// Returns { options: [key...], unsupported: [label...], strict: bool }.
// options holds only variants this site can price; unsupported holds labels
// of variants that exist but get an explicit no-data display (shadowless and
// other unmodelled subtypes). strict is true whenever more than one detailed
// entry exists - supported or not - because ambiguity is then possible.
const TYPE_TO_FINISH = { holo: 'holo', normal: 'non-holo', reverse: 'reverse', 'w-promo': 'w-promo', wpromo: 'w-promo' };
export function variantOptionsFromDetail(detailed) {
  if (!Array.isArray(detailed) || !detailed.length) return null; // unknown -> fail closed
  const options = [];
  const unsupported = [];
  for (const e of detailed) {
    if (!e || typeof e !== 'object') continue;
    const finish = TYPE_TO_FINISH[String(e.type || '').toLowerCase()] || null;
    const stamps = Array.isArray(e.stamp) ? e.stamp.map(x => String(x).toLowerCase()) : [];
    const subtype = e.subtype ? String(e.subtype).toLowerCase() : null;
    const firstEd = stamps.includes('1st-edition');
    let edition = null;
    if (subtype && subtype !== 'unlimited') {
      // shadowless / 1999-2000-copyright / any unmodelled subtype: explicit no-data
      unsupported.push(firstEd ? subtype + ' 1st-edition' : subtype);
      continue;
    }
    if (firstEd) edition = 'first-edition';
    else if (subtype === 'unlimited') edition = 'unlimited';
    if (!finish) { unsupported.push(String(e.type || 'unknown')); continue; }
    const key = edition ? edition + '+' + finish : finish;
    if (!options.includes(key)) options.push(key);
  }
  return { options, unsupported: [...new Set(unsupported)] };
}

// Search terms appended to the provider query for EVERY variant token: the
// provider's capped result pool must be narrowed toward the wanted variant
// before the title filter below makes the final call.
function variantQueryTerms(variantKey) {
  const terms = [];
  for (const t of variantKey.split('+')) {
    if (t === 'first-edition') terms.push('1st edition');
    else if (t === 'unlimited') terms.push('unlimited');
    else if (t === 'holo') terms.push('holo');
    else if (t === 'non-holo') terms.push('non holo');
    else if (t === 'reverse') terms.push('reverse holo');
    else if (t === 'w-promo') terms.push('w promo');
  }
  return terms;
}

// Positive-evidence title match, ALWAYS strict (Main review Nov7 22:33):
// catalog incompleteness means even a single detailed row is not proof no
// other variant exists, so EVERY valued variant requires its tokens to be
// explicitly stated in the sale title; unmarked titles match nothing.
// Contradictory phrases reject both directions: 'reverse holo'/'non-holo'
// contain 'holo' but never count as holo, and a title stating both
// '1st edition' and 'unlimited' matches neither edition.
export function titleMatchesVariant(title, variantKey) {
  if (!variantKey) return true; // legacy aggregate path carries no variant
  if (RE_SHADOWLESS.test(title)) return false;
  const tokens = variantKey.split('+');
  const hasEd = tokens.includes('first-edition');
  const hasUnl = tokens.includes('unlimited');
  const finish = tokens.find(t => t !== 'first-edition' && t !== 'unlimited') || null;
  if (hasEd && !(RE_1ST_ED.test(title) && !RE_UNLIMITED.test(title))) return false;
  if (!hasEd && RE_1ST_ED.test(title)) return false;
  if (hasUnl && !(RE_UNLIMITED.test(title) && !RE_1ST_ED.test(title))) return false;
  if (!hasUnl && RE_UNLIMITED.test(title)) return false;
  if (finish === 'holo' && !(RE_HOLO.test(title) && !RE_REVERSE.test(title) && !RE_NONHOLO.test(title))) return false;
  if (finish === 'non-holo' && !(RE_NONHOLO.test(title) && !RE_REVERSE.test(title))) return false;
  if (finish === 'reverse' && !(RE_REVERSE.test(title) && RE_HOLO.test(title) && !RE_NONHOLO.test(title))) return false;
  if (finish === 'w-promo' && !(RE_WPROMO.test(title) && !RE_REVERSE.test(title) && !RE_NONHOLO.test(title))) return false;
  return true;
}

// Server-side variant resolution (Main review Nov7 22:25): the SERVER, not
// the UI, decides whether a variant is required and which variants a printing
// really has, by reading the TCGdex card record itself. Unknown or missing
// variant data fails closed: no lookup, no price, never a guess.
const TCGDEX_LANG = { English: 'en', Japanese: 'ja', Chinese: 'zh-cn', Korean: 'ko' };
const detailCache = new Map(); // tcg|lang -> { at, detail } (1h, per cold start)
async function fetchTcgdexDetail(tcgId, language) {
  const lang = TCGDEX_LANG[language];
  if (!lang) return null;
  const ck = tcgId + '|' + lang;
  const hit = detailCache.get(ck);
  if (hit && Date.now() - hit.at < 3600_000) return hit.detail;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(`https://api.tcgdex.net/v2/${lang}/cards/${encodeURIComponent(tcgId)}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const detail = await r.json();
    detailCache.set(ck, { at: Date.now(), detail });
    return detail;
  } catch { return null; }
}

// Returns { resolved, options, unsupported, strict } or { error: {status, body} }.
export async function resolveCardVariant(tcgId, language, variantRaw) {
  const variantKey = normalizeVariant(variantRaw);
  if (variantRaw !== undefined && variantRaw !== '' && !variantKey) {
    return { error: { status: 400, body: { error: 'Invalid variant' } } };
  }
  // Language is validated by the record itself (Main review Nov7 22:36):
  // TCGdex serves a card only under the language paths where that printing
  // exists (verified live: /v2/ja/cards/base1-4 -> 404), so a tcg id +
  // language that do not belong together fail closed here. Downstream, both
  // providers additionally require per-sale language evidence (script pattern
  // / API language tag); a sale with insufficient language evidence is
  // excluded, which yields honest no-data rather than cross-language mixing.
  const detail = await fetchTcgdexDetail(tcgId, language);
  const model = detail ? variantOptionsFromDetail(detail.variants_detailed) : null;
  if (!model) return { error: { status: 503, body: { error: 'Variant verification unavailable' } } };
  if (!model.options.length) {
    return { error: { status: 404, body: { error: 'No data found', unsupported: model.unsupported } } };
  }
  let resolved = variantKey;
  if (resolved) {
    if (!model.options.includes(resolved)) {
      return { error: { status: 400, body: { error: 'Variant does not exist for this printing', options: model.options } } };
    }
  } else if (model.options.length === 1) {
    resolved = model.options[0]; // single real variant: implied, still variant-scoped
  } else {
    return { error: { status: 409, body: { error: 'variant_required', options: model.options, unsupported: model.unsupported } } };
  }
  // The card query is DERIVED from the same TCGdex record (Main review Nov7
  // 22:33): the client's free-text card param is never trusted for matching
  // or caching, so a mismatched query with a valid tcg id cannot poison keys.
  const setId = (detail.set && detail.set.id) || String(detail.id || '').split('-').slice(0, -1).join('-');
  if (!detail.name || !detail.localId || !setId) {
    return { error: { status: 503, body: { error: 'Variant verification unavailable' } } };
  }
  const derivedQuery = [String(detail.name), setId, String(detail.localId)].join(' ');
  return { resolved, options: model.options, unsupported: model.unsupported, derivedQuery, cardName: String(detail.name) };
}

export function activeProvider() {
  return (process.env.SALES_PROVIDER || 'scraperapi').toLowerCase() === 'compsapi' ? 'compsapi' : 'scraperapi';
}

// Which env key the active provider needs; the endpoints check this before
// serving so a missing key is a clean 500, never a provider call.
export function providerKeyConfigured() {
  return activeProvider() === 'compsapi' ? !!process.env.COMPS_API_KEY : !!process.env.SCRAPER_API_KEY;
}

// Cache rows are namespaced per provider: a value stored from one provider is
// never served as the other's data, and switching back reuses the old rows.
export function providerCacheTag() {
  return activeProvider() === 'compsapi' ? 'compsapi' : 'scraperapi';
}

export async function fetchSales(cardQuery, grader, grade, language, variantKey) {
  if (activeProvider() === 'compsapi') {
    return fetchCompsApiSales(cardQuery, grader, grade, language, variantKey);
  }
  return fetchScraperApiSales(cardQuery, grader, grade, language, variantKey);
}

// --- ScraperAPI structured eBay search (original integration) ---

async function fetchScraperApiSales(cardQuery, grader, grade, language, variantKey) {
  // eBay's sold view covers roughly the last 90 days; it has no day-range parameter.
  const isRaw = grader === 'RAW';
  let searchString = isRaw ? cardQuery : `${cardQuery} ${grader} ${grade}`;
  if (language !== 'English') searchString += ` ${language}`;
  if (variantKey) searchString += ' ' + variantQueryTerms(variantKey).join(' ');

  const endpoint = 'https://api.scraperapi.com/structured/ebay/search/v2'
    + '?api_key=' + encodeURIComponent(process.env.SCRAPER_API_KEY)
    + '&query=' + encodeURIComponent(searchString)
    + '&show_only=sold_items';

  // Never log endpoint: it contains the API key.
  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error('data provider responded with HTTP ' + response.status);
  }

  let items;
  try {
    items = await response.json();
  } catch (e) {
    throw new Error('unexpected response format from sales provider');
  }
  if (!Array.isArray(items)) {
    throw new Error('unexpected response format from sales provider');
  }

  const listings = [];
  for (const item of items) {
    const title = String(item.product_title || '').trim();
    const p = item.item_price;
    if (!title || !p || JUNK_KEYWORDS.test(title)) continue;
    // A from/to range is not a single sale; only fixed prices count.
    if (typeof p.value !== 'number') continue;
    if (p.currency !== 'USD') continue;        // dollar-denominated prices only

    if (language === 'English') {
      if (Object.values(LANG_PATTERNS).some(regex => regex.test(title))) continue;
    } else {
      if (!LANG_PATTERNS[language].test(title)) continue;
    }

    if (isRaw) {
      // Ungraded only: any graded mention disqualifies the sale from the raw value.
      if (GRADED_TITLE.test(title)) continue;
    } else {
      const exactGradeRegex = new RegExp(`\\b${grader}\\s*-?\\s*${grade}(?!\\d|\\.\\d)`, 'i');
      if (!exactGradeRegex.test(title)) continue;
    }

    if (!titleMatchesVariant(title, variantKey)) continue;

    if (p.value > 0) {
      listings.push({ price: p.value, date: null, title });
    }
  }

  return listings.slice(0, 10);
}

// --- CompsAPI (https://api.compsapi.com, docs: compsapi.com/docs) ---

// Title-language codes the API reports / filters by.
const COMPS_LANG = { English: 'en', Japanese: 'ja', Chinese: 'zh', Korean: 'ko' };
// Flags the docs define as junk; exclude=junk already drops them server-side,
// and we drop them again locally so a flag definition change never leaks one in.
const COMPS_JUNK_FLAGS = new Set(['lot', 'mystery', 'sealed', 'accessory', 'replica', 'keyword_stuffing', 'not_graded_claim', 'title_missing']);

async function fetchCompsApiSales(cardQuery, grader, grade, language, variantKey) {
  const key = process.env.COMPS_API_KEY;
  if (!key) {
    throw new Error('data provider is not configured');
  }
  const isRaw = grader === 'RAW';

  // One request per cell (the click model). /v1/comps is the right endpoint:
  // it scans the newest 200 sales over 90 days and returns the 10 newest that
  // match the card options, while /v1/sold filters only the single page it
  // fetched and can miss graded sales entirely (verified live Nov7: a PSA 9
  // cell that /v1/sold page 1 filtered to 0 came back with real sales here).
  // Grader+grade are passed as card options, not spelled into q, per the docs.
  const qTerms = variantKey ? cardQuery + ' ' + variantQueryTerms(variantKey).join(' ') : cardQuery;
  const params = new URLSearchParams({ q: qTerms, exclude: 'junk' });
  if (isRaw) {
    params.set('graded', 'false');
  } else {
    params.set('grader', grader);
    params.set('grade', String(grade));
  }
  // English is NOT filtered server-side: the lang option drops every title
  // that names no language, which is most English sales. For English we pass
  // no lang and drop the few foreign-tagged rows locally instead.
  if (language !== 'English') params.set('lang', COMPS_LANG[language]);

  const endpoint = 'https://api.compsapi.com/v1/comps?' + params.toString();
  const response = await fetch(endpoint, { headers: { 'X-API-Key': key } });
  if (response.status === 429) {
    // Monthly quota reached: the key pauses until the UTC month resets. No
    // overage charge exists on any plan, so this can never cost money.
    throw new Error('sales provider monthly quota reached; paused until the UTC month reset');
  }
  if (!response.ok) {
    throw new Error('data provider responded with HTTP ' + response.status);
  }

  let body;
  try {
    body = await response.json();
  } catch (e) {
    throw new Error('unexpected response format from sales provider');
  }
  if (!body || body.ok !== true || !Array.isArray(body.items)) {
    throw new Error('unexpected response format from sales provider');
  }

  const listings = [];
  for (const item of body.items) {
    if (typeof item.price !== 'number' || item.price <= 0) continue;
    const c = item.card || {};
    const flags = Array.isArray(c.flags) ? c.flags : [];
    if (flags.some(f => COMPS_JUNK_FLAGS.has(f))) continue;

    if (language === 'English') {
      if (c.language && c.language !== 'en') continue;
    } else if (c.language !== COMPS_LANG[language]) {
      continue;
    }

    if (isRaw) {
      // Raw = the title names no grading company with a grade.
      if (c.graded === true) continue;
    } else {
      if (String(c.grader || '').toUpperCase() !== grader) continue;
      if (String(c.grade || '') !== String(grade)) continue;
    }

    if (!titleMatchesVariant(String(item.title || ''), variantKey)) continue;

    listings.push({ price: item.price, date: item.last_sold || null, title: String(item.title || '') });
  }

  return listings.slice(0, 10);
}
