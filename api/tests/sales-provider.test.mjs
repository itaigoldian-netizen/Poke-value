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
