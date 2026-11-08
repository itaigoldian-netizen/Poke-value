// EAS formula (owner decisions Nov8): a weighted blend of per-company
// arithmetic MEANS - never a pooled mean over all sales, and never a median
// (Nov8 17:51). Each company's USD mean for the card's exact
// tcg+language+variant+integer-grade is computed first, then blended:
//   EAS estimate = sum(weight * companyMean) / sum(active weights)
// Weights (owner-resolved): PSA .35, BGS .25, CGC .15, EAS .15, TAG .1.
// SGC is NOT in the formula. A company with no usable mean is dropped and the
// remaining weights renormalize. USD only - ILS community reports are kept
// and labeled separately, never converted (no approved FX source). Special
// grades (CGC Pristine/Perfect 10, BGS Black Label) are structurally absent:
// callers only ever pass normal-grade means (Nov8 18:02).
export const EAS_FORMULA_WEIGHTS = { PSA: 0.35, BGS: 0.25, CGC: 0.15, EAS: 0.15, TAG: 0.1 };

// means: { PSA?: number, BGS?: number, CGC?: number, EAS?: number, TAG?: number }
// Returns the blended USD estimate, the contributing companies, and the total
// active weight; null when nothing usable exists.
export function easFormulaEstimate(means) {
  let sum = 0;
  let activeWeight = 0;
  const contributors = [];
  for (const [grader, weight] of Object.entries(EAS_FORMULA_WEIGHTS)) {
    const m = means ? means[grader] : undefined;
    if (typeof m === 'number' && isFinite(m) && m > 0) {
      sum += weight * m;
      activeWeight += weight;
      contributors.push(grader);
    }
  }
  if (activeWeight === 0) return null;
  return {
    price: Math.round((sum / activeWeight) * 100) / 100,
    contributors,
    activeWeight: Math.round(activeWeight * 1000) / 1000
  };
}
