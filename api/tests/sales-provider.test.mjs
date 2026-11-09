// Deterministic isolation tests for the sales-matching rules (no network).
// Run: node --experimental-detect-module --test api/tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { titleMatchesPrinting, titleMatchesVariant, variantOptionsFromDetail, normalizeVariant } from '../_sales-provider.js';

const BASE1 = { setId: 'base1', setName: 'Base Set', setToken: 'Base Set', localId: '4', official: 102, year: 1999, numberSlash: '4/102' };
const CGC10 = { graded: true, grader: 'CGC', grade: '10', grade_label: null, card_number: '4/102', year: 1999, language: 'en', first_edition: false, flags: [] };

test('printing: accepts title with slash number + set tokens', () => {
  assert.equal(titleMatchesPrinting('1999 Pokemon Charizard Base Set 4/102 Holo PSA 10', BASE1, 'English'), true);
});
test('printing: accepts zero-padded slash and spaced slash', () => {
  assert.equal(titleMatchesPrinting('Pokemon Charizard Base Set 004/102 PSA 10', BASE1, 'English'), true);
  assert.equal(titleMatchesPrinting('Pokemon Charizard Base Set 4 / 102 PSA 10', BASE1, 'English'), true);
});
test('printing: REJECTS Base Set 2 even when it shares number #4', () => {
  assert.equal(titleMatchesPrinting('Pokemon Charizard Base Set 2 #4 PSA 10', BASE1, 'English'), false);
  assert.equal(titleMatchesPrinting('Pokemon Charizard Base Set 2 4/130 PSA 10', BASE1, 'English'), false);
});
test('printing: bare #4 is no longer number evidence', () => {
  assert.equal(titleMatchesPrinting('Pokemon Charizard Base Set #4 PSA 10', BASE1, 'English'), false);
});
test('printing: rejects dated reprint and reprint collections', () => {
  assert.equal(titleMatchesPrinting('2021 Pokemon Celebrations Charizard Base Set 4/102 PSA 10', BASE1, 'English'), false);
  assert.equal(titleMatchesPrinting('1999 Pokemon Charizard Base Set 4/102 PSA 10', BASE1, 'English'), true);
});
test('printing: structured card_number corroborates slash evidence', () => {
  assert.equal(titleMatchesPrinting('Pokemon Charizard Base Set Holo PSA 10', BASE1, 'English', CGC10), true);
  assert.equal(titleMatchesPrinting('Pokemon Charizard Base Set Holo PSA 10', BASE1, 'English', { ...CGC10, card_number: '4/130' }), false);
  assert.equal(titleMatchesPrinting('Pokemon Charizard Base Set Holo PSA 10', BASE1, 'English', { ...CGC10, card_number: null }), false);
});

test('variant unlimited+holo: matrix', () => {
  assert.equal(titleMatchesVariant('Charizard Base Set 4/102 Unlimited Holo PSA 10', 'unlimited+holo'), true);
  assert.equal(titleMatchesVariant('Charizard Base Set 4/102 Holo PSA 10', 'unlimited+holo'), false); // no edition evidence
  assert.equal(titleMatchesVariant('Charizard Base Set 4/102 1st Edition Holo PSA 10', 'unlimited+holo'), false);
  assert.equal(titleMatchesVariant('Charizard Base Set 4/102 Shadowless Holo PSA 10', 'unlimited+holo'), false);
  assert.equal(titleMatchesVariant('Charizard Base Set 4/102 Unlimited Reverse Holo', 'unlimited+holo'), false);
});
test('variant first-edition+holo: title or structured, unlimited contradicts', () => {
  assert.equal(titleMatchesVariant('Charizard Base Set 4/102 1st Edition Holo PSA 10', 'first-edition+holo'), true);
  assert.equal(titleMatchesVariant('Charizard Base Set 4/102 First Edition Holo PSA 10', 'first-edition+holo'), true);
  assert.equal(titleMatchesVariant('Charizard Base Set 4/102 1st Ed. Shadowless Holo', 'first-edition+holo'), true);
  assert.equal(titleMatchesVariant('Charizard Base Set 4/102 Holo PSA 10', 'first-edition+holo', { first_edition: true }), true);
  assert.equal(titleMatchesVariant('Charizard Base Set 4/102 Unlimited 1st Edition Holo', 'first-edition+holo'), false);
  assert.equal(titleMatchesVariant('Charizard Base Set 4/102 Holo PSA 10', 'first-edition+holo'), false);
});
test('variant shadowless+holo: requires shadowless, rejects 1st ed and unlimited', () => {
  assert.equal(titleMatchesVariant('Charizard Base Set 4/102 Shadowless Holo PSA 10', 'shadowless+holo'), true);
  assert.equal(titleMatchesVariant('Charizard Base Set 4/102 1st Edition Shadowless Holo', 'shadowless+holo'), false);
  // 'Unlimited Shadowless' is how sellers write the non-1st-edition shadowless
  // run: the unlimited word is tolerated here, while the shadowless word is
  // rejected from unlimited cells above, so the variants stay separated.
  assert.equal(titleMatchesVariant('Charizard Base Set 4/102 Unlimited Shadowless Holo', 'shadowless+holo'), true);
  assert.equal(titleMatchesVariant('Charizard Base Set 4/102 Holo PSA 10', 'shadowless+holo'), false);
  assert.equal(titleMatchesVariant('Charizard Base Set 4/102 Shadowless Holo', 'shadowless+holo', { first_edition: true }), false);
});

test('variantOptionsFromDetail: real TCGdex base1-4 (Charizard) entries', () => {
  const detailed = [
    { type: 'holo', subtype: 'unlimited' },
    { type: 'holo', subtype: 'shadowless', stamp: ['1st-edition'] },
    { type: 'holo', subtype: 'shadowless' },
    { type: 'holo', subtype: '1999-2000-copyright' },
  ];
  const m = variantOptionsFromDetail(detailed);
  assert.deepEqual(m.options.sort(), ['first-edition+holo', 'shadowless+holo', 'unlimited+holo'].sort());
  assert.deepEqual(m.unsupported, ['1999-2000-copyright']);
});
test('variantOptionsFromDetail: unknown stamp never merges silently', () => {
  const m = variantOptionsFromDetail([{ type: 'holo', subtype: 'unlimited', stamp: ['staff'] }]);
  assert.deepEqual(m.options, []);
  assert.deepEqual(m.unsupported, ['holo stamp:staff']);
});
test('normalizeVariant: shadowless is an edition token', () => {
  assert.equal(normalizeVariant('shadowless+holo'), 'shadowless+holo');
  assert.equal(normalizeVariant('holo+shadowless'), 'shadowless+holo');
  assert.equal(normalizeVariant('first-edition+shadowless+holo'), null);
  assert.equal(normalizeVariant('unlimited+shadowless'), null);
});

import { acceptsGradedSale, titleMatchesSpecialGrade, titleSpecialEvidence } from '../_sales-provider.js';

test('special grade: normal-10 exclusion is per grader', () => {
  // CGC specials: Pristine 10 and Perfect 10 never enter a normal CGC 10.
  assert.equal(acceptsGradedSale({ grader: 'CGC', grade: 10, specialLabel: null, gradeLabel: 'pristine', title: 'Charizard CGC 10' }), false);
  assert.equal(acceptsGradedSale({ grader: 'CGC', grade: 10, specialLabel: null, gradeLabel: 'perfect', title: 'Charizard CGC 10' }), false);
  // BGS gold-label Pristine 10 is the REGULAR BGS 10: it stays.
  assert.equal(acceptsGradedSale({ grader: 'BGS', grade: 10, specialLabel: null, gradeLabel: 'pristine', title: 'Charizard BGS 10' }), true);
  // BGS special is only Black Label.
  assert.equal(acceptsGradedSale({ grader: 'BGS', grade: 10, specialLabel: null, gradeLabel: 'black label', title: 'Charizard BGS 10' }), false);
  // Ordinary labels and unlabeled sales stay in normal-10.
  assert.equal(acceptsGradedSale({ grader: 'CGC', grade: 10, specialLabel: null, gradeLabel: 'gem mint', title: 'Charizard CGC 10' }), true);
  assert.equal(acceptsGradedSale({ grader: 'CGC', grade: 10, specialLabel: null, gradeLabel: null, title: 'Charizard CGC 10' }), true);
  // Only grade 10 has specials.
  assert.equal(acceptsGradedSale({ grader: 'CGC', grade: 9, specialLabel: null, gradeLabel: 'pristine', title: 'Charizard CGC 9' }), true);
});

test('special grade: positive title evidence overrides a bare numeric 10', () => {
  // Structured label missing/gem mint but the title says Pristine: excluded.
  assert.equal(acceptsGradedSale({ grader: 'CGC', grade: 10, specialLabel: null, gradeLabel: null, title: 'Charizard CGC Pristine 10' }), false);
  assert.equal(acceptsGradedSale({ grader: 'CGC', grade: 10, specialLabel: null, gradeLabel: 'gem mint', title: 'Charizard CGC Pristine 10' }), false);
  assert.equal(acceptsGradedSale({ grader: 'BGS', grade: 10, specialLabel: null, gradeLabel: null, title: 'Charizard BGS Black Label 10' }), false);
  // BGS title "Pristine" is the regular gold label: stays in normal 10.
  assert.equal(acceptsGradedSale({ grader: 'BGS', grade: 10, specialLabel: null, gradeLabel: null, title: 'Charizard BGS Pristine 10' }), true);
});

test('special grade: special cells need the exact structured label and reject contradictions', () => {
  assert.equal(acceptsGradedSale({ grader: 'CGC', grade: 10, specialLabel: 'pristine', gradeLabel: 'pristine', title: 'Charizard CGC Pristine 10' }), true);
  assert.equal(acceptsGradedSale({ grader: 'CGC', grade: 10, specialLabel: 'pristine', gradeLabel: 'pristine', title: 'Charizard CGC 10' }), true);
  // Title alone is not enough: the structured label must match exactly.
  assert.equal(acceptsGradedSale({ grader: 'CGC', grade: 10, specialLabel: 'pristine', gradeLabel: null, title: 'Charizard CGC Pristine 10' }), false);
  assert.equal(acceptsGradedSale({ grader: 'CGC', grade: 10, specialLabel: 'pristine', gradeLabel: 'gem mint', title: 'Charizard CGC Pristine 10' }), false);
  // A contradicting title disqualifies even with the right structured label.
  assert.equal(acceptsGradedSale({ grader: 'CGC', grade: 10, specialLabel: 'pristine', gradeLabel: 'pristine', title: 'Charizard CGC Perfect 10' }), false);
  assert.equal(acceptsGradedSale({ grader: 'BGS', grade: 10, specialLabel: 'black label', gradeLabel: 'black label', title: 'Charizard BGS Black Label 10' }), true);
  assert.equal(acceptsGradedSale({ grader: 'BGS', grade: 10, specialLabel: 'black label', gradeLabel: 'pristine', title: 'Charizard BGS Pristine 10' }), false);
});

test('special grade: scraper title-only rule mirrors per-grader evidence', () => {
  assert.equal(titleMatchesSpecialGrade('Charizard CGC Pristine 10', 'CGC', 10, null), false);
  assert.equal(titleMatchesSpecialGrade('Charizard CGC Perfect 10', 'CGC', 10, null), false);
  assert.equal(titleMatchesSpecialGrade('Charizard CGC 10 Gem Mint', 'CGC', 10, null), true);
  assert.equal(titleMatchesSpecialGrade('Charizard BGS Pristine 10', 'BGS', 10, null), true); // gold = regular
  assert.equal(titleMatchesSpecialGrade('Charizard BGS Black Label 10', 'BGS', 10, null), false);
  assert.equal(titleMatchesSpecialGrade('Charizard CGC Pristine 10', 'CGC', 10, 'pristine'), true);
  assert.equal(titleMatchesSpecialGrade('Charizard CGC 10', 'CGC', 10, 'pristine'), false);
  assert.equal(titleMatchesSpecialGrade('Charizard BGS 10 Black Label', 'BGS', 10, 'black label'), true);
});

import { fetchSales } from '../_sales-provider.js';

// Regression (Nov8): the graded (non-RAW) fetchSales branch must pass the
// structured grade_label into the accept decision. A block-scoped
// `pendingLabel` there threw ReferenceError in production and 502d every
// provider cell while the pure matching tests above stayed green.
test('fetchSales graded branch: structured grade_label reaches the accept decision (pendingLabel regression)', async () => {
  process.env.SALES_PROVIDER = 'compsapi';
  process.env.COMPS_API_KEY = 'test-key';
  const realFetch = globalThis.fetch;
  const mk = (label, title) => ({
    price: 100,
    title,
    last_sold: '2026-10-01T00:00:00Z',
    card: { graded: true, grader: 'CGC', grade: '10', grade_label: label, card_number: '4/102', year: 1999, language: 'en', first_edition: false, flags: [] },
  });
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ items: [
    mk(null, 'Pokemon Charizard Base Set 4/102 Unlimited Holo CGC 10'),
    mk('gem mint', 'Pokemon Charizard Base Set 4/102 Unlimited Holo CGC 10 Gem Mint'),
    mk('pristine', 'Pokemon Charizard Base Set 4/102 Unlimited Holo CGC Pristine 10'),
  ] }) });
  try {
    const sales = await fetchSales('Charizard Base Set 4/102', 'CGC', 10, 'English', 'unlimited+holo', BASE1, null);
    // Unlabeled and gem-mint sales enter the normal-10 cell; the structured
    // pristine label is special evidence and stays out of it.
    assert.equal(sales.length, 2);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.SALES_PROVIDER;
    delete process.env.COMPS_API_KEY;
  }
});

// Recall repair (Nov9): the provider search is a literal AND over title
// words, so q keeps only name + set tokens; the slash number and finish
// words are verified by the more precise local gates instead. Asserts the
// outgoing query shape and that a zero-padded-number, "holographic"-worded
// sale passes the unchanged local identity gates end to end.
test('fetchSales CompsAPI query: slash number and finish words stay out of q, whole page judged locally (recall repair Nov9 x2)', async () => {
  process.env.SALES_PROVIDER = 'compsapi';
  process.env.COMPS_API_KEY = 'test-key';
  const realFetch = globalThis.fetch;
  let seenUrl = null;
  globalThis.fetch = async (url) => { seenUrl = url; return { ok: true, status: 200, json: async () => ({ items: [
    { price: 100, title: 'Pokemon Charizard Base Set 004/102 Unlimited Holographic PSA 10', last_sold: '2026-10-01T00:00:00Z',
      card: { graded: true, grader: 'PSA', grade: '10', grade_label: null, card_number: '004/102', year: 1999, language: 'en', first_edition: false, flags: [] } },
  ] }) } };
  try {
    const sales = await fetchSales('Charizard Base Set 4/102', 'PSA', 10, 'English', 'unlimited+holo', BASE1, null);
    assert.equal(sales.length, 1); // local gates accept zero-padded number + "holographic"
    const u = new URL(seenUrl);
    const q = u.searchParams.get('q') || '';
    assert.equal(q.includes('4/102'), false);   // number left to the local zero-pad-tolerant gate
    assert.equal(q.includes('holo'), false);    // finish left to the local finish regex
    assert.ok(q.includes('Charizard') && q.includes('Base') && q.includes('Set'));
    // Full-pool judging (Nov9, owner request): no provider-side card options -
    // the whole q-matched page is judged by the local gates instead.
    assert.equal(u.searchParams.get('size'), '240');
    assert.equal(u.searchParams.get('cards'), '1');
    assert.equal(u.searchParams.get('exclude'), 'none');
    assert.equal(u.searchParams.get('grader'), null);
    assert.equal(u.searchParams.get('grade'), null);
    assert.equal(u.searchParams.get('first_edition'), null);
    assert.equal(u.searchParams.get('lang'), null);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.SALES_PROVIDER;
    delete process.env.COMPS_API_KEY;
  }
});

test('fetchSales CompsAPI: every accepted sale is returned, no latest-three cap (Nov9 owner rule)', async () => {
  process.env.SALES_PROVIDER = 'compsapi';
  process.env.COMPS_API_KEY = 'test-key';
  const realFetch = globalThis.fetch;
  const mk = (price, day) => ({ price, title: '1999 Pokemon Charizard Base Set 4/102 Unlimited Holo PSA 10', last_sold: '2026-10-0' + day + 'T00:00:00Z',
    card: { graded: true, grader: 'PSA', grade: '10', grade_label: null, card_number: '4/102', year: 1999, language: 'en', first_edition: false, flags: [] } });
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ items: [
    mk(100, 1), mk(200, 2), mk(300, 3), mk(400, 4), mk(500, 5),
  ] }) });
  try {
    const sales = await fetchSales('Charizard Base Set 4/102', 'PSA', 10, 'English', 'unlimited+holo', BASE1, null);
    assert.equal(sales.length, 5); // all five accepted sales feed the mean
    assert.deepEqual(sales.map(x => x.price), [500, 400, 300, 200, 100]); // still date-sorted newest first
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.SALES_PROVIDER;
    delete process.env.COMPS_API_KEY;
  }
});

test('fetchSales CompsAPI: unfiltered pool is judged by the local identity gates (Nov9)', async () => {
  // With no provider-side options the page now holds every q-match; items the
  // old options used to drop must be rejected by the LOCAL gates instead.
  process.env.SALES_PROVIDER = 'compsapi';
  process.env.COMPS_API_KEY = 'test-key';
  const realFetch = globalThis.fetch;
  const mk = (price, title, card) => ({ price, title, last_sold: '2026-11-02T00:00:00Z', card });
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ items: [
    mk(900, '1999 Pokemon Charizard Base Set 4/102 Unlimited Holo PSA 9',
      { graded: true, grader: 'PSA', grade: '9', grade_label: null, card_number: '4/102', year: 1999, language: 'en', first_edition: false, flags: [] }),   // wrong grade: local grade gate
    mk(950, '1999 Pokemon Charizard Base Set 4/102 Unlimited Holo BGS 10',
      { graded: true, grader: 'BGS', grade: '10', grade_label: null, card_number: '4/102', year: 1999, language: 'en', first_edition: false, flags: [] }),  // wrong grader: local grader gate
    mk(4000, '1999 Pokemon Charizard Base Set 4/102 1st Edition Holo PSA 10',
      { graded: true, grader: 'PSA', grade: '10', grade_label: null, card_number: '4/102', year: 1999, language: 'en', first_edition: true, flags: [] }),   // 1st edition: local variant gate
    mk(120, '1999 Pokemon Charizard Base Set 4/102 Unlimited Holo',
      { graded: false, grader: null, grade: null, grade_label: null, card_number: '4/102', year: 1999, language: 'en', first_edition: false, flags: [] }),  // raw card: local grader gate
    mk(600, '1999 Pokemon Charizard Base Set 4/102 Unlimited Holo PSA 10',
      { graded: true, grader: 'PSA', grade: '10', grade_label: null, card_number: '4/102', year: 1999, language: 'en', first_edition: false, flags: [] }),  // the one valid sale
  ] }) });
  try {
    const sales = await fetchSales('Charizard Base Set 4/102', 'PSA', 10, 'English', 'unlimited+holo', BASE1, null);
    assert.deepEqual(sales.map(x => x.price), [600]);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.SALES_PROVIDER;
    delete process.env.COMPS_API_KEY;
  }
});

// --- Poison-gap repair (Nov9, verified live against check #2 candidates) ---

test('printing: reprint-collection abbreviations reject (CELEB CLSC. COLL.)', () => {
  // The exact live candidate wording, minus its 2021 year: abbreviated
  // Celebrations Classic Collection markers alone must reject.
  assert.equal(titleMatchesPrinting('CHARIZARD HOLO POKEMON CELEB CLSC. COLL. BASE SET HOLOFOIL EN 4/102 PSA 10', BASE1, 'English'), false);
  // ...and with the year (year gate already rejected it; both gates now hold).
  assert.equal(titleMatchesPrinting('CHARIZARD HOLO POKEMON CELEB CLSC. COLL. BASE SET HOLOFOIL EN 2021 4/102 PSA 10', BASE1, 'English'), false);
  // 'celebrity' and honest 'from my collection' do NOT trip the markers.
  assert.equal(titleMatchesPrinting('1999 Pokemon Charizard Base Set 4/102 PSA 10 from my collection', BASE1, 'English'), true);
});

test('printing: structured year is NOT a rejection source (post-review Nov9)', () => {
  // The provider's card.year is 'Year in the title' (docs) - the same
  // evidence the title-year gate already judges. A disagreeing structured
  // year with a yearless title stays neutral, so a copyright/region-year
  // parse never rejects a genuine sale of another set.
  assert.equal(titleMatchesPrinting('Pokemon Charizard Base Set 4/102 PSA 10', BASE1, 'English', { ...CGC10, year: 2021 }), true);
  assert.equal(titleMatchesPrinting('2021 Pokemon Charizard Base Set 4/102 PSA 10', BASE1, 'English', CGC10), false); // title year still rejects
});

test('fetchSales CompsAPI: sealed-product title is junk even when the provider missed the flag', async () => {
  process.env.SALES_PROVIDER = 'compsapi';
  process.env.COMPS_API_KEY = 'test-key';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ items: [
    // English-worded sibling of the live "$2,009 Japanese Booster Pack PSA 10"
    // candidate: unflagged by the provider, caught by the local title gate.
    { price: 2009.62, title: 'Pokemon Base Set Unlimited Booster Pack PSA 10', last_sold: '2026-11-01T00:00:00Z',
      card: { graded: true, grader: 'PSA', grade: '10', grade_label: null, card_number: '4/102', year: 1999, language: 'en', first_edition: false, flags: [] } },
    { price: 500, title: '1999 Pokemon Charizard Base Set 4/102 Unlimited Holo PSA 10', last_sold: '2026-11-02T00:00:00Z',
      card: { graded: true, grader: 'PSA', grade: '10', grade_label: null, card_number: '4/102', year: 1999, language: 'en', first_edition: false, flags: [] } },
  ] }) });
  try {
    const sales = await fetchSales('Charizard Base Set 4/102', 'PSA', 10, 'English', 'unlimited+holo', BASE1, null);
    assert.equal(sales.length, 1);
    assert.equal(sales[0].price, 500);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.SALES_PROVIDER;
    delete process.env.COMPS_API_KEY;
  }
});

test('fetchSales CompsAPI: sealed-slab single card stays; factory-sealed product is junk (post-review Nov9)', async () => {
  process.env.SALES_PROVIDER = 'compsapi';
  process.env.COMPS_API_KEY = 'test-key';
  const realFetch = globalThis.fetch;
  const mk = (price, title) => ({ price, title, last_sold: '2026-11-02T00:00:00Z',
    card: { graded: true, grader: 'PSA', grade: '10', grade_label: null, card_number: '4/102', year: 1999, language: 'en', first_edition: false, flags: [] } });
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ items: [
    mk(600, '1999 Pokemon Charizard Base Set 4/102 Unlimited Holo PSA 10 sealed slab'),       // single graded card: stays
    mk(700, '1999 Pokemon Charizard Base Set 4/102 Unlimited Holo PSA 10 pack fresh'),        // condition wording: stays
    mk(2009.62, 'Pokemon Charizard Base Set 4/102 Unlimited factory sealed booster box PSA 10'), // product: junk
    mk(1500, 'Pokemon Charizard Base Set 4/102 Unlimited sealed pack PSA 10'),                // product: junk
  ] }) });
  try {
    const sales = await fetchSales('Charizard Base Set 4/102', 'PSA', 10, 'English', 'unlimited+holo', BASE1, null);
    assert.deepEqual(sales.map(x => x.price).sort((a, b) => a - b), [600, 700]);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.SALES_PROVIDER;
    delete process.env.COMPS_API_KEY;
  }
});
