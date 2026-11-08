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
const VARIANT_TOKENS = new Set(['first-edition', 'unlimited', 'shadowless', 'holo', 'non-holo', 'reverse', 'w-promo']);
// Sellers write both '1st ed' and 'first edition'.
const RE_1ST_ED = /\b1st[\s-]*(ed|edition)\b|\bfirst[\s-]*edition\b/i;
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
  const editions = tokens.filter(t => t === 'first-edition' || t === 'unlimited' || t === 'shadowless');
  if (editions.length > 1) return null;
  const finishes = tokens.filter(t => t !== 'first-edition' && t !== 'unlimited' && t !== 'shadowless');
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
    // A stamp other than 1st-edition (e.g. prerelease/staff/winner) has no
    // modeled title-evidence path yet: it becomes an explicit no-data label
    // instead of silently merging stamped sales into the plain variant.
    const otherStamps = stamps.filter(s => s !== '1st-edition');
    if (otherStamps.length) {
      unsupported.push((finish || String(e.type || 'unknown')) + ' stamp:' + otherStamps.join(','));
      continue;
    }
    let edition = null;
    if (subtype && subtype !== 'unlimited' && subtype !== 'shadowless') {
      // 1999-2000-copyright and any unmodelled subtype: no reliable title
      // evidence exists, so they stay explicit no-data variants.
      unsupported.push(firstEd ? subtype + ' 1st-edition' : subtype);
      continue;
    }
    // Base Set first edition is physically shadowless (TCGdex: subtype
    // 'shadowless' + stamp '1st-edition'); sellers state '1st edition', so
    // that stamp is the edition evidence - requiring 'shadowless' too would
    // zero the pool. Plain shadowless (no stamp) is its own edition.
    if (firstEd) edition = 'first-edition';
    else if (subtype === 'unlimited') edition = 'unlimited';
    else if (subtype === 'shadowless') edition = 'shadowless';
    if (!finish) { unsupported.push(String(e.type || 'unknown')); continue; }
    const key = edition ? edition + '+' + finish : finish;
    if (!options.includes(key)) options.push(key);
  }
  return { options, unsupported: [...new Set(unsupported)] };
}

// Search terms appended to the provider query: FINISH tokens only. The query
// is discovery - it narrows the provider's capped result pool toward the
// wanted variant; MATCHING stays with the strict title filter below. Edition
// terms ('unlimited', '1st edition') are deliberately NOT put in the query:
// sellers rarely state them, so they would zero the pool before the title
// filter (which still requires positive edition evidence) can judge.
function variantQueryTerms(variantKey) {
  const terms = [];
  for (const t of variantKey.split('+')) {
    if (t === 'holo') terms.push('holo');
    else if (t === 'non-holo') terms.push('non holo');
    else if (t === 'reverse') terms.push('reverse holo');
    else if (t === 'w-promo') terms.push('w promo');
    // 'shadowless' is REQUIRED title evidence for shadowless variants, so
    // putting it in the query can only drop sales the filter would reject
    // anyway. Edition terms 'unlimited'/'1st edition' stay out of the query:
    // 1st edition is passed as the provider's first_edition option instead.
    else if (t === 'shadowless') terms.push('shadowless');
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
// cardFields (CompsAPI structured card object) is corroborating evidence
// only: it can confirm 1st edition, and a structured first_edition===true
// contradicts every non-1st-edition variant. It never overrides an explicit
// title contradiction.
export function titleMatchesVariant(title, variantKey, cardFields) {
  if (!variantKey) return true; // legacy aggregate path carries no variant
  const tokens = variantKey.split('+');
  const edition = tokens.find(t => t === 'first-edition' || t === 'unlimited' || t === 'shadowless') || null;
  const finish = tokens.find(t => t !== 'first-edition' && t !== 'unlimited' && t !== 'shadowless') || null;
  const structFirstEd = !!(cardFields && cardFields.first_edition === true);
  if (edition === 'first-edition') {
    if (!RE_1ST_ED.test(title) && !structFirstEd) return false;
    if (RE_UNLIMITED.test(title)) return false;
  } else {
    if (RE_1ST_ED.test(title) || structFirstEd) return false;
  }
  if (edition === 'unlimited' && !RE_UNLIMITED.test(title)) return false;
  if (!edition && RE_UNLIMITED.test(title)) return false;
  if (edition === 'shadowless') {
    if (!RE_SHADOWLESS.test(title)) return false;
  } else if (edition !== 'first-edition' && RE_SHADOWLESS.test(title)) {
    // Base Set 1st edition IS shadowless, so a 1st-edition variant tolerates
    // the word; every other variant rejects it.
    return false;
  }
  if (finish === 'holo' && !(RE_HOLO.test(title) && !RE_REVERSE.test(title) && !RE_NONHOLO.test(title))) return false;
  if (finish === 'non-holo' && !(RE_NONHOLO.test(title) && !RE_REVERSE.test(title))) return false;
  if (finish === 'reverse' && !(RE_REVERSE.test(title) && RE_HOLO.test(title) && !RE_NONHOLO.test(title))) return false;
  if (finish === 'w-promo' && !(RE_WPROMO.test(title) && !RE_REVERSE.test(title) && !RE_NONHOLO.test(title))) return false;
  return true;
}

// --- Canonical query identity (repair Nov8, Main-approved direction) ---
// The provider query must be built from the tokens eBay sellers actually
// write: canonical ENGLISH card name, set evidence (English set NAME for
// English printings; the set CODE - 'S8b', 'sv2a' - for JP/KR/CN printings,
// which sellers do include) and number/printed-total. The previous format
// (TCGdex name + set id + bare localId) matched nothing at the source, so
// every cell came back honest-but-empty (verified live Nov8: CompsAPI
// count_before_filters=0 for 'Charizard base1 4 unlimited holo' and for
// 'リザードン S8b 017 holo', while the same provider returns real sales for
// canonical queries).
//
// Cross-language name resolution happens only when the identity binding is
// PROVEN (Main Nov8): the TCGdex record's dexId resolves the species through
// PokéAPI (canonical en/ja/ko/zh names); the local-language card name must
// START WITH the local species name and carry nothing after it except known
// Latin form tokens. Trainers/Energy, multi-species (&), unknown suffixes
// and missing species data all fail CLOSED: no query, no provider call,
// honest no-data. A guessed translation is never emitted.
const FORM_TOKENS = ['V-UNION', 'VSTAR', 'VMAX', 'BREAK', 'PRIME', 'GX', 'EX', 'ex', 'V'];
const POKEAPI_LANG = { Japanese: 'ja', Korean: 'ko', Chinese: 'zh-Hans' };
const speciesCache = new Map(); // dexId -> { at, names } (1h, per cold start)
async function fetchSpeciesNames(dexId) {
  const ck = String(dexId);
  const hit = speciesCache.get(ck);
  if (hit && Date.now() - hit.at < 3600_000) return hit.names;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(`https://pokeapi.co/api/v2/pokemon-species/${ck}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const body = await r.json();
    const names = {};
    for (const n of (body && body.names) || []) {
      const lang = n && n.language && n.language.name;
      if (lang && n.name) names[lang] = n.name;
    }
    speciesCache.set(ck, { at: Date.now(), names });
    return names;
  } catch { return null; }
}

// Returns the proven canonical English card name, or null (fail closed).
async function canonicalEnglishName(detail, language) {
  const localName = String(detail.name || '').trim();
  if (!localName) return null;
  if (language === 'English') return localName;
  if (String(detail.category || 'Pokemon') !== 'Pokemon') return null;
  const dexIds = Array.isArray(detail.dexId) ? detail.dexId : (detail.dexId ? [detail.dexId] : []);
  if (dexIds.length !== 1) return null; // multi-species or unknown: fail closed
  const names = await fetchSpeciesNames(dexIds[0]);
  if (!names || !names.en) return null;
  const localSpecies = names[POKEAPI_LANG[language]];
  if (!localSpecies || !localName.startsWith(localSpecies)) return null;
  const suffix = localName.slice(localSpecies.length).trim();
  if (!suffix) return names.en;
  const tokens = suffix.split(/[\s\u3000]+/).filter(Boolean);
  if (!tokens.length || !tokens.every(t => FORM_TOKENS.includes(t))) return null;
  return names.en + ' ' + tokens.join(' ');
}

// Printing identity for query construction and title-side verification.
function printingIdentity(detail, language) {
  const set = detail.set || {};
  const setId = String(set.id || '').trim();
  const setName = String(set.name || '').trim();
  const localId = String(detail.localId || '').trim();
  const cc = set.cardCount || {};
  const official = Number(cc.official) > 0 ? Number(cc.official) : null;
  const ym = String(set.releaseDate || '').match(/^(\d{4})/);
  const year = ym ? Number(ym[1]) : null;
  if (!setId || !localId) return null;
  const setToken = language === 'English' ? setName : setId;
  if (!setToken) return null;
  return { setId, setName, setToken, localId, official, year, numberSlash: official ? localId + '/' + official : null };
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Positive print/set/number evidence (Main direction Nov8): a sale counts
// only when its title positively supports THIS printing and nothing in it
// contradicts the identity. Absence of evidence excludes; contradiction
// rejects. Year consistency is evidence-based: when a title states a year
// and the set year is known they must agree, which rejects dated reprints
// (e.g. a 2021 'Celebrations Classic 4/102' in a 1999 Base Set cell) without
// any claim that a marker list is exhaustive.
//
// Number evidence is the SLASH form only ('4/102', number/printed-total),
// matched in the title or in the provider's structured card.card_number
// field. The bare '#4' form was dropped (Nov8): it is not printing identity,
// because sets reuse collector numbers - Base Set 2 Charizard is also #4, so
// '#4' + 'base set' tokens matched Base Set 2 sales into Base Set cells.
const RE_TITLE_YEAR = /\b(19|20)\d{2}\b/;
const RE_REPRINT_COLLECTION = /\b(celebrations|classic collection|anniversary|mcdonald'?s|trick or trade)\b/i;
function slashNumberRegex(localId, official) {
  return new RegExp('\\b0*' + escapeRegExp(localId) + '\\s*/\\s*0*' + escapeRegExp(String(official)) + '(?!\\d)', 'i');
}
export function titleMatchesPrinting(title, printing, language, cardFields) {
  const t = String(title || '');
  if (!printing || !t) return false;
  const lower = t.toLowerCase();
  // Set evidence
  let setOk;
  if (language === 'English') {
    const tokens = String(printing.setName || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w && w !== 'the' && w !== 'of');
    setOk = tokens.length > 0 && tokens.every(w => lower.includes(w));
  } else {
    setOk = new RegExp('\\b' + escapeRegExp(printing.setId) + '\\b', 'i').test(t);
  }
  if (!setOk) return false;
  // Number evidence: '4/102' in the title, zero-padding tolerant, or the
  // provider's structured card_number field parsed from that title.
  const official = printing.numberSlash ? printing.numberSlash.split('/')[1] : null;
  const re = official ? slashNumberRegex(printing.localId, official) : null;
  const hasSlash = re ? re.test(t) : false;
  const structuredNumber = cardFields && cardFields.card_number ? String(cardFields.card_number).trim() : '';
  const hasStructuredSlash = re ? re.test(structuredNumber) : false;
  if (!hasSlash && !hasStructuredSlash) return false;
  // Year consistency (only when the title states a year)
  if (printing.year) {
    const ym = t.match(RE_TITLE_YEAR);
    if (ym && Number(ym[0]) !== printing.year) return false;
  }
  // Reprint-collection contradiction, unless the card's own set IS that collection
  if (RE_REPRINT_COLLECTION.test(t)) {
    const own = (String(printing.setName || '') + ' ' + String(printing.setId || '')).toLowerCase();
    if (!RE_REPRINT_COLLECTION.test(own)) return false;
  }
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
  // Since Nov8 it is built from canonical ENGLISH identity (name + set
  // evidence + number/total) - the tokens sellers actually write. When the
  // identity cannot be PROVEN (cross-language species unresolvable, missing
  // set data), the cell fails closed with honest no-data.
  const enName = await canonicalEnglishName(detail, language);
  const printing = printingIdentity(detail, language);
  if (!enName || !printing) {
    return { error: { status: 404, body: { error: 'No data found' } } };
  }
  const derivedQuery = [enName, printing.setToken, printing.numberSlash || printing.localId].join(' ');
  return { resolved, options: model.options, unsupported: model.unsupported, derivedQuery, cardName: String(detail.name), printing, enName };
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

// Special grades sit ABOVE a regular 10 (Nov8 18:02, owner), and they are
// PER COMPANY: CGC "Pristine 10" and "Perfect 10" are specials, but a BGS
// gold-label "Pristine 10" is the REGULAR BGS 10 - only a BGS "Black Label"
// is special. Labels never transfer across graders.
const SPECIAL_LABELS_BY_GRADER = {
  CGC: new Set(['pristine', 'perfect']),
  BGS: new Set(['black label'])
};

// Positive special evidence in a title, per grader, or null.
export function titleSpecialEvidence(title, grader) {
  const t = String(title || '');
  if (grader === 'CGC') {
    if (/perfect\s*10/i.test(t)) return 'perfect';
    if (/\bpristine\b/i.test(t)) return 'pristine';
  }
  if (grader === 'BGS' && /black\s*label/i.test(t)) return 'black label';
  return null;
}

// One decision for a graded sale, combining the structured grade_label and
// the title. A normal-10 cell rejects a sale when EITHER source carries
// positive special evidence (a numeric 10 never overrides it); an unlabeled
// sale stays, because most sellers state no label. A special cell requires
// the exact structured label and rejects a contradicting title.
export function acceptsGradedSale({ grader, grade, specialLabel, gradeLabel, title }) {
  const label = String(gradeLabel || '').toLowerCase().trim();
  const titleEvidence = titleSpecialEvidence(title, grader);
  if (specialLabel) {
    if (label !== specialLabel) return false;
    return titleEvidence === null || titleEvidence === specialLabel;
  }
  if (Number(grade) !== 10) return true;
  const specials = SPECIAL_LABELS_BY_GRADER[grader];
  if (specials && specials.has(label)) return false;
  return titleEvidence === null;
}

// Title-only decision for the scraper fallback (no structured fields).
export function titleMatchesSpecialGrade(title, grader, grade, specialLabel) {
  const ev = titleSpecialEvidence(title, grader);
  if (specialLabel) return ev === specialLabel;
  return !(Number(grade) === 10 && ev !== null);
}

export async function fetchSales(cardQuery, grader, grade, language, variantKey, printing, specialLabel) {
  if (activeProvider() === 'compsapi') {
    return fetchCompsApiSales(cardQuery, grader, grade, language, variantKey, printing, specialLabel);
  }
  return fetchScraperApiSales(cardQuery, grader, grade, language, variantKey, printing, specialLabel);
}

// --- ScraperAPI structured eBay search (original integration) ---

async function fetchScraperApiSales(cardQuery, grader, grade, language, variantKey, printing, specialLabel) {
  // eBay's sold view covers roughly the last 90 days; it has no day-range parameter.
  const isRaw = grader === 'RAW';
  let searchString = isRaw ? cardQuery : `${cardQuery} ${grader} ${grade}`;
  if (specialLabel) searchString += specialLabel === 'black label' ? ' Black Label' : ' Pristine';
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
      // Special cell: exact label required; normal-10: labeled specials out.
      if (!titleMatchesSpecialGrade(title, grader, grade, specialLabel)) continue;
    }

    if (!titleMatchesVariant(title, variantKey)) continue;
    // Printing identity evidence (Nov8): only when a verified printing was
    // supplied; the legacy aggregate path carries none and stays permissive.
    if (printing && !titleMatchesPrinting(title, printing, language)) continue;

    if (p.value > 0) {
      listings.push({ price: p.value, date: null, title });
    }
  }

  // Owner rule: a cell price comes from the latest THREE accepted sales, not
  // ten. This dormant fallback has no sale dates, so it takes the provider's
  // own newest-first order and honestly reports the count used.
  return listings.slice(0, 3);
}

// --- CompsAPI (https://api.compsapi.com, docs: compsapi.com/docs) ---

// Title-language codes the API reports / filters by.
const COMPS_LANG = { English: 'en', Japanese: 'ja', Chinese: 'zh', Korean: 'ko' };
// Flags the docs define as junk; exclude=junk already drops them server-side,
// and we drop them again locally so a flag definition change never leaks one in.
const COMPS_JUNK_FLAGS = new Set(['lot', 'mystery', 'sealed', 'accessory', 'replica', 'keyword_stuffing', 'not_graded_claim', 'title_missing']);

async function fetchCompsApiSales(cardQuery, grader, grade, language, variantKey, printing, specialLabel) {
  const key = process.env.COMPS_API_KEY;
  if (!key) {
    throw new Error('data provider is not configured');
  }
  const isRaw = grader === 'RAW';

  // One request per cell (the click model). /v1/sold with the maximum page
  // size: it returns up to 240 newest matching sales (docs: "newest sale
  // first", size 10..240) with the same card options as /v1/comps, so the
  // strict local filters below judge up to 240 candidates instead of the 10
  // newest items /v1/comps exposes. That is the Nov8 repair for cells whose
  // 10-item slice happened to contain no title with positive printing
  // evidence. Grader+grade are passed as card options, not spelled into q,
  // per the docs.
  const qTerms = variantKey ? cardQuery + ' ' + variantQueryTerms(variantKey).join(' ') : cardQuery;
  const params = new URLSearchParams({ q: qTerms, exclude: 'junk', size: '240' });
  if (isRaw) {
    params.set('graded', 'false');
  } else {
    params.set('grader', grader);
    params.set('grade', String(grade));
  }
  // Edition evidence the provider parses itself: 1st-edition variants ask for
  // the first_edition option (docs: "1st edition cards only (or false for
  // none)"), and every other variant excludes detected 1st-edition sales.
  // Local checks below still verify; the option only narrows the pool.
  if (variantKey) {
    params.set('first_edition', variantKey.split('+').includes('first-edition') ? 'true' : 'false');
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
  if (!body || !Array.isArray(body.items)) {
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
      // Structured grade_label (docs: "gem mint, pristine, black label, mint
      // or near mint", null when unstated) is the only evidence separating a
      // special grade from a regular 10.
      // grade check above passed; special/label decision needs the title
      // too, so it runs just after the title is read below.
    }

    const title = String(item.title || '');
    if (!isRaw && !acceptsGradedSale({ grader, grade, specialLabel, gradeLabel: c.grade_label, title })) continue;
    if (!titleMatchesVariant(title, variantKey, c)) continue;
    // Printing identity evidence (Nov8): required for every counted sale; the
    // provider's structured card_number is accepted as slash-number evidence.
    if (printing && !titleMatchesPrinting(title, printing, language, c)) continue;
    // Owner rule: the price is computed from the latest THREE accepted sales.
    // A sale without a verifiable date cannot prove recency, so it never
    // enters the cell.
    const date = item.last_sold ? new Date(item.last_sold) : null;
    if (!date || isNaN(date.getTime())) continue;

    listings.push({ price: item.price, date: item.last_sold, title });
  }

  // Never trust the provider's order: sort by the sale date itself, newest
  // first, and keep the latest three. Fewer than three is reported honestly
  // through the sales count; printings are never mixed to reach three.
  listings.sort((a, b) => new Date(b.date) - new Date(a.date));
  return listings.slice(0, 3);
}
