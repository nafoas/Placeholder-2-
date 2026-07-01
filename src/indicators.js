// National indicators: the material STATE of the country, moved by policy.
//
// This is the counterpart to the 24 personas' opinions. Where they track how
// the nation FEELS, this tracks the substance — the treasury, jobs, prices,
// internal order, and standing abroad. Each turn one neutral "state ledger"
// assessment reads the policy and estimates its concrete effects as signed
// deltas; those are applied here with sane clamps. Opinion and substance
// together are the state of the nation, and they can diverge — a popular policy
// can still wreck the budget, and a hated one can still steady prices.

export const INDICATOR_DEFAULTS = {
  treasury: -1.2,    // budget balance, billions of ren (negative = deficit)
  unemployment: 16,  // percent of the workforce out of work
  inflation: 7,      // percent
  stability: 55,     // 0-100 internal order and public calm
  standing: 45,      // 0-100 respect/standing abroad
};

// Presentation hints the UI leans on. `higherIsBetter` drives delta colouring;
// `kind` drives formatting (a signed balance, a percent rate, or a 0-100 gauge).
export const INDICATOR_META = {
  treasury:     { label: "Treasury",     kind: "balance", higherIsBetter: true },
  unemployment: { label: "Unemployment", kind: "percent", higherIsBetter: false },
  inflation:    { label: "Inflation",    kind: "percent", higherIsBetter: false },
  stability:    { label: "Stability",    kind: "gauge",   higherIsBetter: true },
  standing:     { label: "Standing",     kind: "gauge",   higherIsBetter: true },
};

// The structured output the ledger call must return. Reason first (assessment),
// then commit the five signed deltas, then a terse note — same discipline as a
// persona reaction, so the numbers drive the summary and never the reverse.
export const NATIONAL_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      assessment: {
        type: "string",
        description:
          "FIRST. As a cold, neutral state analyst, briefly weigh the policy's concrete material effects — fiscal " +
          "cost or saving, jobs, prices, public order, and standing abroad — before committing any numbers. No opinion.",
      },
      treasury_delta: {
        type: "number",
        description:
          "Change to the budget balance in billions of ren (negative = it costs money / widens the deficit; positive " +
          "= saves or raises revenue). Most single policies are modest, roughly -3.0..+3.0; reserve larger for sweeping ones.",
      },
      unemployment_delta: {
        type: "number",
        description:
          "Change in the unemployment rate in percentage points. NEGATIVE means fewer people out of work (good); " +
          "positive means more joblessness. Usually -3.0..+3.0.",
      },
      inflation_delta: {
        type: "number",
        description:
          "Change in the inflation rate in percentage points. Positive = prices rise faster (bad). Usually -3.0..+3.0.",
      },
      stability_delta: {
        type: "integer",
        description:
          "Change in internal stability/order, -15..+15. Negative = unrest, protest, disorder; positive = calm and " +
          "confidence. Crossing a national red line or enraging a major bloc should be sharply negative.",
      },
      standing_delta: {
        type: "integer",
        description:
          "Change in Sordland's international standing, -15..+15. Negative = alarms neighbours or the great powers, or " +
          "erodes the respect its neutrality commands; positive = burnishes it.",
      },
      ledger_note: {
        type: "string",
        description:
          "One terse, technocratic line summarising the national effect, e.g. 'Costly to the treasury but eases " +
          "joblessness in the mills.' Max ~16 words.",
      },
    },
    required: ["assessment", "treasury_delta", "unemployment_delta", "inflation_delta", "stability_delta", "standing_delta", "ledger_note"],
    additionalProperties: false,
  },
};

// The ledger's own system block (the shared WORLD_CODEX is prepended separately,
// so this stays focused on the neutral, technocratic task).
export function buildNationalSystem() {
  return (
    `YOU ARE THE STATE LEDGER — a cold, neutral analyst inside the Sordland finance and interior ministries in 1954. ` +
    `You hold no opinion and speak for no faction; you estimate the concrete, material consequences of a policy for the ` +
    `nation: its cost or saving to the treasury, its effect on unemployment and inflation, on internal stability and ` +
    `public order, and on Sordland's standing abroad. Judge realistically and proportionately — most single policies ` +
    `move the needle only modestly, while a sweeping, reckless, or red-line-crossing one can move it hard. Ground every ` +
    `estimate in the country's actual condition: a deep recession, high unemployment and inflation, heavy debt, a ` +
    `fragile currency, and simmering tensions (the Bludish question, the Rumburg threat, the courting great powers). ` +
    `Work strictly in order: first 'assessment' (reason briefly), then the five signed deltas derived from it, then a ` +
    `terse 'ledger_note'. Empty, incoherent, or purely symbolic announcements should move little or nothing.`
  );
}

// Pure: fold a turn's deltas into the indicators with sane clamps and rounding.
export function applyDeltas(indicators, deltas) {
  const cur = { ...INDICATOR_DEFAULTS, ...(indicators || {}) };
  const d = deltas || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const round1 = (n) => Math.round(n * 10) / 10;
  const clampPct = (n) => Math.max(0, Math.min(60, n));   // rates stay in a sane band
  const clampGauge = (n) => Math.max(0, Math.min(100, n));

  return {
    treasury:     round1(cur.treasury + num(d.treasury_delta)),
    unemployment: round1(clampPct(cur.unemployment + num(d.unemployment_delta))),
    inflation:    round1(clampPct(cur.inflation + num(d.inflation_delta))),
    stability:    Math.round(clampGauge(cur.stability + num(d.stability_delta))),
    standing:     Math.round(clampGauge(cur.standing + num(d.standing_delta))),
  };
}

// Deterministic stand-in when no API key is set, so the UI still moves in mock mode.
export function mockDeltas(policy) {
  const seed = String(policy || "").length % 5;
  return {
    assessment: "[mock] rough material estimate.",
    treasury_delta: [-0.6, -0.2, 0, 0.3, 0.8][seed],
    unemployment_delta: [0.4, 0.1, 0, -0.2, -0.5][seed],
    inflation_delta: [0.5, 0.2, 0, -0.1, -0.3][seed],
    stability_delta: [-6, -2, 0, 2, 5][seed],
    standing_delta: [-5, -1, 0, 1, 4][seed],
    ledger_note: "[mock] estimated national effect.",
  };
}
