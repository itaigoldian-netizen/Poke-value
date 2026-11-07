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
// wamid...QUMwQjNGRTc0MEVDN0Y3NzIyMzM2MUUwRDg0QUM5QjAA) ---
// Sales of different variants of the SAME printing (1st edition vs unlimited,
// holo vs reverse holo vs non-holo, W promo stamp) are never merged into one
// value. The card picker offers a variant choice whenever TCGdex flags more
// than one variant for the card; the chosen variant is part of the cache key
// and of the sales matching below.
//
// Matching rules (applied to every candidate sale title, both providers):
// - A variant the title must positively state (marked): first-edition,
//   reverse, holo, w-promo. A sale whose title does not say it does not count.
// - Unlimited is the edition convention: sellers always advertise 1st
//   edition, so an old-set title without "1st ed"/"shadowless" reads as
//   unlimited. Titles naming either are rejected from unlimited.
// - 'normal' (non-holo) must be positively stated too (non-holo / non holo):
//   a title that says nothing about finish is AMBIGUOUS when the card has
//   more than one finish, and ambiguous sales count toward no variant
//   (owner + Main Nov7 22:15: ambiguous variant data must not produce a
//   precise price - the cell shows 'no data' instead).
// - 'shadowless' is not modelled as a variant anywhere: shadowless titles are
//   rejected from every variant lookup.
const VARIANT_TOKENS = new Set(['first-edition', 'unlimited', 'normal', 'holo', 'reverse', 'w-promo']);
const RE_1ST_ED = /\b1st[\s-]*(ed|edition)\b/i;
const RE_SHADOWLESS = /\bshadowless\b/i;
const RE_REVERSE = /\breverse\b/i;
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
  const finishes = tokens.filter(t => t !== 'first-edition' && t !== 'unlimited');
  if (editions.length > 1 || finishes.length > 1) return null;
  return tokens.sort().join('+');
}

// Search terms appended to the provider query for marked variants: they bias
// the results toward the wanted variant, but the title filter below is what
// actually decides - a sale never counts without matching it.
function variantQueryTerms(variantKey) {
  const terms = [];
  for (const t of variantKey.split('+')) {
    if (t === 'first-edition') terms.push('1st edition');
    else if (t === 'reverse') terms.push('reverse holo');
    else if (t === 'w-promo') terms.push('promo');
  }
  return terms;
}

// Decides whether one sale title belongs to the requested variant. Every
// marked token in the key must be stated; any marked variant NOT in the key
// disqualifies (1st ed / reverse / w-promo); shadowless always disqualifies.
// 'holo'/'normal' mentions do not disqualify other variants: a single-finish
// card's sales often say "holo", and the positive rules below already gate
// the holo/normal buckets.
export function titleMatchesVariant(title, variantKey) {
  if (!variantKey) return true; // single-variant card: no separation needed
  const tokens = variantKey.split('+');
  if (RE_SHADOWLESS.test(title)) return false;
  if (!tokens.includes('first-edition') && RE_1ST_ED.test(title)) return false;
  if (!tokens.includes('reverse') && RE_REVERSE.test(title)) return false;
  if (!tokens.includes('w-promo') && RE_WPROMO.test(title)) return false;
  for (const t of tokens) {
    if (t === 'first-edition' && !RE_1ST_ED.test(title)) return false;
    if (t === 'reverse' && !(RE_REVERSE.test(title) && RE_HOLO.test(title))) return false;
    if (t === 'w-promo' && !RE_WPROMO.test(title)) return false;
    if (t === 'holo' && !(RE_HOLO.test(title) && !RE_REVERSE.test(title) && !RE_NONHOLO.test(title))) return false;
    if (t === 'normal' && !(RE_NONHOLO.test(title) && !RE_REVERSE.test(title))) return false;
  }
  return true;
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
