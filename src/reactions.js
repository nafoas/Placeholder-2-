// The "brain": turns a policy announcement into each persona's reaction, and
// carries a graded, decaying memory + a hidden personal-trust score forward
// between turns.
//
// Memory works in three tiers per persona, getting fuzzier with age (like real
// memory), so history never needs a hard "forget":
//   - recent (last 5):  detailed — the policy, the stance, their actual words.
//   - mid (next ~20):   compressed one-line notes ("backed the wage hike, wary").
//   - eras (older):     batches folded into one-sentence "broadly they felt…".
//
// One Claude call per persona per turn returns the public reaction plus a
// memory_note and a trust_delta. A separate, occasional call folds an aged-out
// batch of notes into an era summary.
//
// Per-persona state shape (held by the client, sent each turn):
//   { trust: 0-100,
//     recent: [{turn, policy, stance, delta, reaction, note}],
//     mid:    [{turn, note}],
//     eras:   [{fromTurn, toTurn, summary}],
//     pendingEra: [{turn, note}] }   // overflow waiting to be summarized

import Anthropic from "@anthropic-ai/sdk";
import { PERSONAS } from "./personas.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";
const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY);
const client = HAS_KEY ? new Anthropic() : null;

export const MODE = HAS_KEY ? "live" : "mock";

const STANCES = ["strongly_oppose", "oppose", "neutral", "support", "strongly_support"];
const TRUST_START = 50;
const RECENT_CAP = 5; // detailed memories kept verbatim
const MID_CAP = 20; // compressed notes kept after that
const ERA_GROUP = 8; // fold into an era summary once this many notes age out of mid

const trim = (s, n) => { s = String(s || "").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(n) || 0)));

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
      reaction: { type: "string", description: "One or two sentences, in character and in your own voice." },
      memory_note: {
        type: "string",
        description:
          "A terse third-person one-line record of this reaction for your own memory, e.g. 'Backed the wage hike but wary of who really pays.' Max ~14 words.",
      },
      trust_delta: {
        type: "integer",
        description:
          "How this policy shifts your personal trust in the President going forward, -8 to +8. Usually small (-2..+2); reserve the extremes for real betrayals or genuine surprises.",
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

// Accept either the new tiered shape or the older {trust, memory[]} shape.
function normalize(prior) {
  const trust = typeof prior?.trust === "number" ? prior.trust : TRUST_START;
  if (prior && (Array.isArray(prior.recent) || Array.isArray(prior.mid) || Array.isArray(prior.eras))) {
    return {
      trust,
      recent: Array.isArray(prior.recent) ? prior.recent : [],
      mid: Array.isArray(prior.mid) ? prior.mid : [],
      eras: Array.isArray(prior.eras) ? prior.eras : [],
      pendingEra: Array.isArray(prior.pendingEra) ? prior.pendingEra : [],
    };
  }
  // migrate old flat memory -> mid notes
  const old = Array.isArray(prior?.memory) ? prior.memory : [];
  return { trust, recent: [], mid: old.slice(-MID_CAP), eras: [], pendingEra: [] };
}

function buildSystem(persona, mem) {
  let s = `${WORLD}\n\n${persona.persona}\n\n`;

  s +=
    `Your personal read on the current President: you ${trustBand(mem.trust)}. Let this colour how you ` +
    `receive the policy — when you trust them, an unwelcome policy may earn the benefit of the doubt; ` +
    `when you don't, even a policy you'd normally like feels suspect coming from them. Never refer to ` +
    `"trust" as a number or a game mechanic; just let it shape your tone.\n\n`;

  if (mem.eras.length) {
    s += `Your faded sense of this President's earlier record (broad strokes, long ago):\n`;
    for (const e of mem.eras) s += `- Around turns ${e.fromTurn}-${e.toTurn}: ${e.summary}\n`;
    s += `\n`;
  }

  const olderNotes = [...mem.pendingEra, ...mem.mid];
  if (olderNotes.length) {
    s += `Compressed memories of more recent turns (reference only if genuinely relevant):\n`;
    for (const m of olderNotes) s += `- ${m.note}\n`;
    s += `\n`;
  }

  if (mem.recent.length) {
    s += `Your clearest, freshest memories of the last few turns:\n`;
    for (const r of mem.recent) {
      s += `- (turn ${r.turn}) On "${r.policy}" you felt ${r.stance.replace(/_/g, " ")}: ${r.reaction}\n`;
    }
    s += `\n`;
  }

  s +=
    `React to the policy below as THIS person genuinely would, judging it by how it affects you and ` +
    `people like you. Stay fully in character, and let your memory of this President shape how you ` +
    `hear them now. Rate how it shifts your approval from -10 to +10 (already accounting for trust). ` +
    `Then record a terse one-line memory_note for yourself, and a trust_delta for how this changes ` +
    `your personal trust.`;

  return s;
}

// --- Era summarization (rare): fold a batch of aged-out notes into one line --
function heuristicEra(notes) {
  return `a blur of ${notes.length} smaller decisions, leaving a vague overall impression`;
}

async function summarizeEra(persona, notes) {
  if (MODE !== "live") return heuristicEra(notes);
  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      system:
        `You are condensing the fading memories of a Sordish citizen. ${persona.persona}\n\n` +
        `Below are brief notes of how they reacted to the President over a span of past turns. In ONE ` +
        `third-person sentence (under ~25 words), capture the broad arc of how this person felt about ` +
        `the President during that period and any drift in their trust. Just the sentence.`,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: notes.map((n) => `- ${n.note}`).join("\n") }],
    });
    const block = resp.content.find((b) => b.type === "text");
    return trim(block?.text || heuristicEra(notes), 200);
  } catch {
    return heuristicEra(notes);
  }
}

// --- Per-turn reaction (live or mock) --------------------------------------
function mockReaction(persona, policy) {
  const seed = (persona.id.length + policy.length) % 5;
  return {
    stance: STANCES[seed],
    approval_change: [-6, -2, 0, 3, 7][seed],
    reaction: `[mock] As a ${persona.name.toLowerCase()} I'd weigh this for ${persona.region}.`,
    memory_note: `Reacted (${STANCES[seed].replace(/_/g, " ")}) to a policy touching ${persona.region}.`,
    trust_delta: [-3, -1, 0, 1, 3][seed],
  };
}

async function liveReaction(persona, policy, mem) {
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: buildSystem(persona, mem),
    output_config: { format: REACTION_FORMAT, effort: "low" },
    messages: [{ role: "user", content: `Policy announced by the President:\n\n"${policy}"` }],
  });
  const block = resp.content.find((b) => b.type === "text");
  return JSON.parse(block.text);
}

async function reactOne(persona, policy, turn, prior) {
  const mem = normalize(prior);
  try {
    const r = MODE === "live" ? await liveReaction(persona, policy, mem) : mockReaction(persona, policy);

    const delta = clamp(r.approval_change, -10, 10);
    const stance = STANCES.includes(r.stance) ? r.stance : "neutral";
    const newTrust = clamp(mem.trust + clamp(r.trust_delta, -8, 8), 0, 100);

    // Newest detailed memory goes on the recent tier.
    const record = {
      turn,
      policy: trim(policy, 120),
      stance,
      delta,
      reaction: trim(r.reaction, 240),
      note: trim(r.memory_note, 120),
    };
    let recent = [...mem.recent, record];
    let mid = [...mem.mid];
    let pendingEra = [...mem.pendingEra];
    const eras = [...mem.eras];

    // Demote what overflows each tier, getting fuzzier as it falls.
    while (recent.length > RECENT_CAP) {
      const d = recent.shift();
      mid.push({ turn: d.turn, note: d.note });
    }
    while (mid.length > MID_CAP) pendingEra.push(mid.shift());

    if (pendingEra.length >= ERA_GROUP) {
      const summary = await summarizeEra(persona, pendingEra);
      eras.push({ fromTurn: pendingEra[0].turn, toTurn: pendingEra[pendingEra.length - 1].turn, summary });
      pendingEra = [];
    }

    return {
      reaction: {
        id: persona.id, name: persona.name, region: persona.region, weight: persona.weight,
        stance, approval_change: delta, reaction: record.reaction,
      },
      state: { trust: newTrust, recent, mid, eras, pendingEra },
    };
  } catch (err) {
    return {
      reaction: {
        id: persona.id, name: persona.name, region: persona.region, weight: persona.weight,
        stance: "neutral", approval_change: 0,
        reaction: `(no reaction — error: ${err?.message || "unknown"})`, error: true,
      },
      state: mem,
    };
  }
}

export async function runTurn(policy, incoming) {
  const turn = Number(incoming?.turn) || 1;
  const prevState = incoming?.personaState || {};

  const results = await Promise.all(PERSONAS.map((p) => reactOne(p, policy, turn, prevState[p.id])));

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
