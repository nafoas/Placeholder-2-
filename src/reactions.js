// The "brain": turns a policy announcement into each persona's reaction, and
// carries memory + a hidden personal-trust variable forward between turns.
//
// One Claude call per persona. The persona's identity, its compressed memory of
// your past actions, and how much it personally trusts you all go into the
// system prompt; the policy is the user message. Each call returns the public
// reaction plus two private pieces of state we keep for next turn:
//   - memory_note: a terse one-line record of this reaction ("primes" the future)
//   - trust_delta: how this policy shifts the persona's personal trust in you
//
// State shape passed in/out (held by the client, sent each turn):
//   { turn, personaState: { <personaId>: { trust: 0-100, memory: [{turn, note}] } } }

import Anthropic from "@anthropic-ai/sdk";
import { PERSONAS } from "./personas.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";
const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY);
const client = HAS_KEY ? new Anthropic() : null;

export const MODE = HAS_KEY ? "live" : "mock";

const STANCES = ["strongly_oppose", "oppose", "neutral", "support", "strongly_support"];
const TRUST_START = 50; // everyone starts neutral; party/character choice will set baselines later
const MEMORY_CAP = 8; // keep only the last N notes per persona (bounded = efficient)

// Structured-output schema. JSON-schema numeric bounds aren't supported, so we
// state the ranges in the prompt and clamp server-side.
const REACTION_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      stance: { type: "string", enum: STANCES },
      approval_change: {
        type: "integer",
        description:
          "How this policy shifts your approval of the President, -10 (furious) to +10 (delighted). 0 = no change. Already account for how much you trust this President.",
      },
      reaction: {
        type: "string",
        description: "One or two sentences, in character and in your own voice.",
      },
      memory_note: {
        type: "string",
        description:
          "A terse third-person one-line record of this reaction for your own memory, e.g. 'Backed the wage hike but wary of who really pays.' Max ~14 words.",
      },
      trust_delta: {
        type: "integer",
        description:
          "How this policy (and how it was presented) shifts your personal trust in the President going forward, from -8 to +8. Usually small (-2..+2); reserve the extremes for real betrayals or genuine, pleasant surprises.",
      },
    },
    required: ["stance", "approval_change", "reaction", "memory_note", "trust_delta"],
    additionalProperties: false,
  },
};

const WORLD =
  `The year is 1954 in the Republic of Sordland, a semi-unitary presidential republic. ` +
  `The nation is emerging from the long shadow of the Sordish Civil War and is gripped by the ` +
  `Recession of 1951 — roughly 16% unemployment and 7% inflation. A new President has just taken ` +
  `office. The political landscape runs from the ruling Sollist USP, to the liberal-democratic PFJP, ` +
  `to the nationalist National Front Party, with an underground Malenyevist (communist) current and ` +
  `two superpower blocs (the capitalist ATO and the Malenyevist CSP) watching from abroad.`;

function trustBand(t) {
  if (t < 20) return "barely trust this President and suspect their motives";
  if (t < 40) return "are wary of this President and give them little benefit of the doubt";
  if (t < 60) return "feel neutral about this President personally — neither loyal nor hostile";
  if (t < 80) return "have come to trust this President and will extend some benefit of the doubt";
  return "deeply trust this President and assume good faith even when you dislike a policy";
}

function buildSystem(persona, trust, memory) {
  let s = `${WORLD}\n\n${persona.persona}\n\n`;

  s +=
    `Your personal read on the current President: you ${trustBand(trust)}. Let this colour how you ` +
    `receive the policy — when you trust them, an unwelcome policy may earn the benefit of the doubt; ` +
    `when you don't, even a policy you'd normally like feels suspect coming from them. Never refer to ` +
    `"trust" as a number or a game mechanic; just let it shape your tone.\n\n`;

  if (memory && memory.length) {
    s += `What you remember of this President's actions so far (draw on these only when genuinely ` +
      `relevant — do not recite them mechanically):\n`;
    for (const m of memory) s += `- ${m.note}\n`;
    s += `\n`;
  }

  s +=
    `React to the policy below as THIS person genuinely would, judging it by how it affects you and ` +
    `people like you — not by what is "correct." Stay fully in character. Rate how it shifts your ` +
    `approval from -10 to +10 (already accounting for how much you trust them). Then record a terse ` +
    `one-line memory_note for yourself, and a trust_delta for how this changes your personal trust.`;

  return s;
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(n) || 0)));

// --- Mock mode (no key): deterministic stand-in so the UI works offline ----
function mockReaction(persona, policy) {
  const seed = (persona.id.length + policy.length) % 5;
  return {
    stance: STANCES[seed],
    approval_change: [-6, -2, 0, 3, 7][seed],
    reaction:
      `[mock] As a ${persona.name.toLowerCase()} I'd weigh this for ${persona.region}. ` +
      `Set ANTHROPIC_API_KEY for a real, in-character reaction.`,
    memory_note: `Reacted (${STANCES[seed].replace(/_/g, " ")}) to a policy touching ${persona.region}.`,
    trust_delta: [-3, -1, 0, 1, 3][seed],
  };
}

// --- Live mode -------------------------------------------------------------
async function liveReaction(persona, policy, trust, memory) {
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: buildSystem(persona, trust, memory),
    output_config: { format: REACTION_FORMAT, effort: "low" },
    messages: [{ role: "user", content: `Policy announced by the President:\n\n"${policy}"` }],
  });
  const block = resp.content.find((b) => b.type === "text");
  return JSON.parse(block.text);
}

async function reactOne(persona, policy, turn, prior) {
  const trust = typeof prior?.trust === "number" ? prior.trust : TRUST_START;
  const memory = Array.isArray(prior?.memory) ? prior.memory : [];

  try {
    const r = MODE === "live"
      ? await liveReaction(persona, policy, trust, memory)
      : mockReaction(persona, policy, trust, memory);

    const newTrust = clamp(trust + clamp(r.trust_delta, -8, 8), 0, 100);
    const newMemory = [...memory, { turn, note: String(r.memory_note || "").trim() }].slice(-MEMORY_CAP);

    return {
      reaction: {
        id: persona.id,
        name: persona.name,
        region: persona.region,
        weight: persona.weight,
        stance: STANCES.includes(r.stance) ? r.stance : "neutral",
        approval_change: clamp(r.approval_change, -10, 10),
        reaction: String(r.reaction || "").trim(),
      },
      state: { trust: newTrust, memory: newMemory },
    };
  } catch (err) {
    // A single persona failing must never sink the whole turn; keep its state.
    return {
      reaction: {
        id: persona.id,
        name: persona.name,
        region: persona.region,
        weight: persona.weight,
        stance: "neutral",
        approval_change: 0,
        reaction: `(no reaction — error: ${err?.message || "unknown"})`,
        error: true,
      },
      state: { trust, memory },
    };
  }
}

// Run all personas concurrently, roll their swings into one national number,
// and return the updated per-persona state for the next turn.
export async function runTurn(policy, incoming) {
  const turn = Number(incoming?.turn) || 1;
  const prevState = incoming?.personaState || {};

  const results = await Promise.all(
    PERSONAS.map((p) => reactOne(p, policy, turn, prevState[p.id])),
  );

  const reactions = results.map((r) => r.reaction);
  const personaState = {};
  PERSONAS.forEach((p, i) => { personaState[p.id] = results[i].state; });

  let weighted = 0, totalWeight = 0;
  for (const r of reactions) { weighted += r.approval_change * r.weight; totalWeight += r.weight; }
  const nationalApprovalChange = totalWeight ? Math.round((weighted / totalWeight) * 10) / 10 : 0;

  return {
    mode: MODE,
    model: MODE === "live" ? MODEL : null,
    reactions,
    nationalApprovalChange,
    state: { turn: turn + 1, personaState },
  };
}
