// The "brain": turns a policy announcement into each persona's reaction.
//
// One Claude call per persona. The persona's identity lives in the system
// prompt; the player's policy is the user message. We constrain the reply to
// a small JSON shape via structured outputs so the frontend gets clean data.

import Anthropic from "@anthropic-ai/sdk";
import { PERSONAS } from "./personas.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";

// Only construct a client if we have a key. Without one we run in MOCK mode so
// the app is fully clickable offline / before anyone sets up billing.
const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY);
const client = HAS_KEY ? new Anthropic() : null;

export const MODE = HAS_KEY ? "live" : "mock";

const STANCES = [
  "strongly_oppose",
  "oppose",
  "neutral",
  "support",
  "strongly_support",
];

// Structured-output schema. Note: JSON-schema numeric bounds (min/max) are not
// supported by structured outputs, so we state the -10..+10 range in the prompt
// and clamp the result server-side.
const REACTION_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      stance: { type: "string", enum: STANCES },
      approval_change: {
        type: "integer",
        description:
          "How this policy shifts your approval of the President, from -10 (furious) to +10 (delighted). 0 means no change.",
      },
      reaction: {
        type: "string",
        description:
          "One or two sentences, in character and in your own voice, reacting to the policy.",
      },
    },
    required: ["stance", "approval_change", "reaction"],
    additionalProperties: false,
  },
};

const WORLD = `The year is 1954 in the Republic of Sordland, a semi-unitary presidential republic. ` +
  `The nation is emerging from the long shadow of the Sordish Civil War and is gripped by the ` +
  `Recession of 1951 — roughly 16% unemployment and 7% inflation. A new President has just taken ` +
  `office. The political landscape runs from the ruling Sollist USP, to the liberal-democratic PFJP, ` +
  `to the nationalist National Front Party, with an underground Malenyevist (communist) current and ` +
  `two superpower blocs (the capitalist ATO and the Malenyevist CSP) watching from abroad.`;

function buildSystem(persona) {
  return (
    `${WORLD}\n\n` +
    `${persona.persona}\n\n` +
    `The President has just announced a policy (below). React to it the way THIS person genuinely would, ` +
    `judging it by how it affects you and people like you — not by what is "correct." Stay fully in character. ` +
    `Then rate how it shifts your approval of the President on a scale from -10 (furious) to +10 (delighted), ` +
    `where 0 means no real change. Be willing to use the extremes when the policy truly delights or enrages you.`
  );
}

function clampDelta(n) {
  const v = Math.round(Number(n) || 0);
  return Math.max(-10, Math.min(10, v));
}

// --- Mock mode -------------------------------------------------------------
// Deterministic, keyless stand-in so the UI works without an API key.
function mockReaction(persona, policy) {
  const seed = (persona.id.length + policy.length) % 5;
  const delta = [-6, -2, 0, 3, 7][seed];
  return {
    stance: STANCES[seed],
    approval_change: delta,
    reaction:
      `[mock] As a ${persona.name.toLowerCase()}, I'd weigh this against what it means for ` +
      `${persona.region}. Set ANTHROPIC_API_KEY for a real, in-character reaction.`,
  };
}

// --- Live mode -------------------------------------------------------------
async function liveReaction(persona, policy) {
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: buildSystem(persona),
    output_config: { format: REACTION_FORMAT, effort: "low" },
    messages: [{ role: "user", content: `Policy announced by the President:\n\n"${policy}"` }],
  });

  const block = resp.content.find((b) => b.type === "text");
  const data = JSON.parse(block.text);
  return {
    stance: STANCES.includes(data.stance) ? data.stance : "neutral",
    approval_change: clampDelta(data.approval_change),
    reaction: String(data.reaction || "").trim(),
  };
}

async function reactOne(persona, policy) {
  try {
    const r = MODE === "live" ? await liveReaction(persona, policy) : mockReaction(persona, policy);
    return { id: persona.id, name: persona.name, region: persona.region, weight: persona.weight, ...r };
  } catch (err) {
    // One persona failing should never sink the whole turn.
    return {
      id: persona.id,
      name: persona.name,
      region: persona.region,
      weight: persona.weight,
      stance: "neutral",
      approval_change: 0,
      reaction: `(no reaction — error: ${err?.message || "unknown"})`,
      error: true,
    };
  }
}

// Run all personas concurrently and roll their swings up into one national number.
export async function runTurn(policy) {
  const reactions = await Promise.all(PERSONAS.map((p) => reactOne(p, policy)));

  let weighted = 0;
  let totalWeight = 0;
  for (const r of reactions) {
    weighted += r.approval_change * r.weight;
    totalWeight += r.weight;
  }
  const nationalApprovalChange = totalWeight ? weighted / totalWeight : 0;

  return {
    mode: MODE,
    model: MODE === "live" ? MODEL : null,
    reactions,
    nationalApprovalChange: Math.round(nationalApprovalChange * 10) / 10,
  };
}
