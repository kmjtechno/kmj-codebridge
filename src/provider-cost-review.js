// Read-only provider quote comparison. No provider calls, billing or routing.
// Caller must independently authenticate the origin, exact model equivalence,
// output settings, licenses and real price before using the findings.
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SPEC = /^[A-Za-z0-9][A-Za-z0-9._:/|@+-]{0,159}$/;
const UNITS = new Set([
  "usd-per-million-input-tokens",
  "usd-per-million-output-tokens",
  "usd-per-image-job",
  "usd-per-video-job",
  "usd-per-audio-job",
]);
const MAX_QUOTE_AGE_MS = 24 * 60 * 60 * 1000;

/** Compares caller-supplied USD micro-dollar price quotes for one exact spec. */
export function reviewProviderCosts({
  quotes,
  referenceProvider,
  modelSpec,
  billingUnit,
  nowMs = Date.now(),
} = {}) {
  if (
    !Array.isArray(quotes) ||
    quotes.length > 32 ||
    !ID.test(referenceProvider ?? "") ||
    !SPEC.test(modelSpec ?? "") ||
    !UNITS.has(billingUnit) ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0
  ) {
    throw new Error("INVALID_PROVIDER_COST_REVIEW");
  }

  const eligible = [];
  const excluded = { differentSpec: 0, differentUnit: 0, staleOrFuture: 0 };
  const seen = new Set();
  for (const q of quotes) {
    if (
      !q ||
      !ID.test(q.provider ?? "") ||
      !SPEC.test(q.modelSpec ?? "") ||
      !UNITS.has(q.billingUnit) ||
      !Number.isSafeInteger(q.priceMicrosUsd) ||
      q.priceMicrosUsd < 0 ||
      !Number.isSafeInteger(q.observedAtMs) ||
      q.observedAtMs < 0 ||
      seen.has(q.provider)
    ) {
      throw new Error("INVALID_PROVIDER_COST_QUOTE");
    }
    seen.add(q.provider);
    if (q.modelSpec !== modelSpec) excluded.differentSpec += 1;
    else if (q.billingUnit !== billingUnit) excluded.differentUnit += 1;
    else if (
      q.observedAtMs > nowMs ||
      nowMs - q.observedAtMs >= MAX_QUOTE_AGE_MS
    ) {
      excluded.staleOrFuture += 1;
    } else {
      eligible.push({ provider: q.provider, priceMicrosUsd: q.priceMicrosUsd });
    }
  }
  eligible.sort(
    (a, b) =>
      a.priceMicrosUsd - b.priceMicrosUsd ||
      a.provider.localeCompare(b.provider),
  );
  const reference = eligible.find((q) => q.provider === referenceProvider);
  const cheapest = eligible[0] ?? null;
  const illustrativeSavingsPct =
    reference && cheapest && reference.priceMicrosUsd > 0
      ? Math.round(
          (1 - cheapest.priceMicrosUsd / reference.priceMicrosUsd) * 10000,
        ) / 100
      : null;
  return {
    comparisonStatus:
      reference && eligible.length > 1
        ? "COMPARABLE_QUOTES"
        : "INSUFFICIENT_QUOTES",
    modelSpec,
    billingUnit,
    referenceProvider,
    quotes: eligible,
    cheapest,
    illustrativeSavingsPct: eligible.length > 1 ? illustrativeSavingsPct : null,
    excluded,
    provenance: "CALLER_SUPPLIED_NOT_INDEPENDENTLY_VERIFIED",
    billableExecutionAuthorized: false,
    providerRequestsMade: 0,
  };
}
