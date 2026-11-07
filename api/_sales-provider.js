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

export async function fetchSales(cardQuery, grader, grade, language) {
  if (activeProvider() === 'compsapi') {
    return fetchCompsApiSales(cardQuery, grader, grade, language);
  }
  return fetchScraperApiSales(cardQuery, grader, grade, language);
}

// --- ScraperAPI structured eBay search (original integration) ---

async function fetchScraperApiSales(cardQuery, grader, grade, language) {
  // eBay's sold view covers roughly the last 90 days; it has no day-range parameter.
  const isRaw = grader === 'RAW';
  let searchString = isRaw ? cardQuery : `${cardQuery} ${grader} ${grade}`;
  if (language !== 'English') searchString += ` ${language}`;

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

async function fetchCompsApiSales(cardQuery, grader, grade, language) {
  const key = process.env.COMPS_API_KEY;
  if (!key) {
    throw new Error('data provider is not configured');
  }
  const isRaw = grader === 'RAW';

  // One request per cell (the click model): /v1/sold returns the newest page
  // of sales with a parsed card object per item. Grader+grade are passed as
  // card options, not spelled into q, per the docs' guidance.
  const params = new URLSearchParams({ q: cardQuery, size: '200', exclude: 'junk' });
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

  const endpoint = 'https://api.compsapi.com/v1/sold?' + params.toString();
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

    listings.push({ price: item.price, date: item.last_sold || null, title: String(item.title || '') });
  }

  return listings.slice(0, 10);
}
