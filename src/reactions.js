// The "brain": turns a policy announcement into each persona's reaction, scores
// it, and carries a graded, decaying memory + a hidden personal-trust score
// forward between turns.
//
// SCORING MODEL
//   - Each persona rates the policy 0-100 for how much they actually approve of
//     it. 0 is the floor: a policy only climbs above it by genuinely giving a
//     group something to approve of, so nonsense, irrelevant, or harmful policies
//     score very low rather than snapping to a "neutral" 50. Trust colours it.
//   - Every persona counts EQUALLY: an individual elite wields far more power
//     than an individual worker, so a small elite bloc balances a large popular
//     one. The policy's national reaction is the plain average of the scores.
//   - National approval (0-100) is the running average of every policy reaction
//     to date — your standing IS the mean of how the nation received everything
//     you have passed. Each new policy's pull on approval shrinks as your record
//     grows (an established base stabilises you), but is floored at a cap so the
//     public can always still move you and approval never freezes. Balance is
//     emergent (a 95 from one group tends to come with a 5 from another), but
//     broad-appeal policies can still score high and broadly-hated ones low;
//     nothing is flattened toward 50.
//
// MEMORY (per persona, fades with age — no hard forget)
//   - recent (last 5): detailed — the policy, the stance, their actual words.
//   - mid (next ~20):  compressed one-line notes.
//   - eras (older):    batches folded into one-sentence "broadly they felt…".

import Anthropic from "@anthropic-ai/sdk";
import { PERSONAS } from "./personas.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";
const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY);
const client = HAS_KEY ? new Anthropic() : null;

export const MODE = HAS_KEY ? "live" : "mock";

const STANCES = ["strongly_oppose", "oppose", "neutral", "support", "strongly_support"];
const TRUST_START = 50;
const RECENT_CAP = 5;
const MID_CAP = 20;
const ERA_GROUP = 8;

// Caps how stiff national approval can get. Early policies count a lot (you have
// no base yet); once you have ~this many policies on the record, each new one
// keeps a steady ~1/(cap+1) share of influence rather than shrinking forever, so
// approval stabilises with an established base but never freezes.
const STIFFNESS_CAP = Number(process.env.STIFFNESS_CAP) || 12;

const trim = (s, n) => { s = String(s || "").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(n) || 0)));

// Map a 0-100 score to one of five stance labels for the UI.
function stanceFromScore(score) {
  if (score < 20) return "strongly_oppose";
  if (score < 40) return "oppose";
  if (score < 60) return "neutral";
  if (score < 80) return "support";
  return "strongly_support";
}

const REACTION_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      score: {
        type: "integer",
        description:
          "0-100: how much you, and people like you, actually approve of this policy. 0 is the floor — a policy " +
          "earns a higher score only by genuinely giving your group something to approve of. Nonsense, incoherent " +
          "or empty announcements, policies irrelevant to you, or ones that harm you give you little to approve, " +
          "so they score very low (often 0-20), NOT 50 — there is no neutral default. Scores rise only as the " +
          "policy genuinely serves or pleases your group, reaching 80-100 when it strongly does. Already account " +
          "for how much you trust this President.",
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
    required: ["score", "reaction", "memory_note", "trust_delta"],
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
    `people like you, and let your memory of this President shape how you hear them now. Stay fully in ` +
    `character. Then rate the policy from 0 to 100 for how much you actually approve of it: 0 is the floor, ` +
    `and a policy only climbs above it by genuinely giving you something to approve of. Nonsense, incoherent ` +
    `or empty announcements, anything irrelevant to you, or anything that harms you scores very low (often ` +
    `0-20) — there is no neutral 50 to fall back on. If the announcement is gibberish or unserious, that is ` +
    `alarming from a head of state, so score it very low and react accordingly. Finally, record a terse ` +
    `one-line memory_note, and a trust_delta for how this changes your personal trust.`;

  return s;
}

// --- Era summarization (rare) ----------------------------------------------
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
    score: [15, 38, 50, 65, 88][seed],
    reaction: `[mock] As a ${persona.name.toLowerCase()} I'd weigh this for ${persona.region}.`,
    memory_note: `Rated a policy touching ${persona.region} around ${[15, 38, 50, 65, 88][seed]}/100.`,
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

    const score = clamp(r.score, 0, 100);
    const stance = stanceFromScore(score);
    const newTrust = clamp(mem.trust + clamp(r.trust_delta, -8, 8), 0, 100);

    const record = {
      turn, policy: trim(policy, 120), stance, score,
      reaction: trim(r.reaction, 240), note: trim(r.memory_note, 120),
    };
    let recent = [...mem.recent, record];
    let mid = [...mem.mid];
    let pendingEra = [...mem.pendingEra];
    const eras = [...mem.eras];

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
        score, stance, reaction: record.reaction,
      },
      state: { trust: newTrust, recent, mid, eras, pendingEra },
    };
  } catch (err) {
    return {
      reaction: {
        id: persona.id, name: persona.name, region: persona.region, weight: persona.weight,
        score: 50, stance: "neutral",
        reaction: `(no reaction — error: ${err?.message || "unknown"})`, error: true,
      },
      state: mem,
    };
  }
}

export async function runTurn(policy, incoming) {
  const turn = Number(incoming?.turn) || 1;
  const approval = typeof incoming?.approval === "number" ? incoming.approval : 50;
  const policyCount = Number(incoming?.policyCount) || 0; // policies enacted so far
  const prevState = incoming?.personaState || {};

  const results = await Promise.all(PERSONAS.map((p) => reactOne(p, policy, turn, prevState[p.id])));

  const reactions = results.map((r) => r.reaction);
  const personaState = {};
  PERSONAS.forEach((p, i) => { personaState[p.id] = results[i].state; });

  // Policy's national reaction = plain, equal-weight average of persona scores.
  const policyReaction = reactions.length
    ? reactions.reduce((sum, r) => sum + r.score, 0) / reactions.length
    : 50;

  // National approval = running average of policy reactions, but the per-policy
  // weight is floored so approval stiffens with an established base yet never
  // freezes. While count < cap this is the true cumulative mean (count = 0 makes
  // the first policy set approval directly, discarding the 50 placeholder); past
  // the cap it behaves like a rolling average of the last ~STIFFNESS_CAP
  // policies, so old reactions gradually fade out.
  const effectiveCount = Math.min(policyCount, STIFFNESS_CAP);
  const newApproval = Math.max(0, Math.min(100, approval + (policyReaction - approval) / (effectiveCount + 1)));

  return {
    mode: MODE,
    model: MODE === "live" ? MODEL : null,
    reactions,
    policyReaction: Math.round(policyReaction * 10) / 10,
    approval: Math.round(newApproval * 10) / 10,
    approvalChange: Math.round((newApproval - approval) * 10) / 10,
    state: { turn: turn + 1, approval: newApproval, policyCount: policyCount + 1, personaState },
  };
}
