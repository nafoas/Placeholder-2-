// The "brain": turns a policy announcement into each persona's reaction, scores
// it, and carries a graded, decaying memory + a hidden personal-trust score
// forward between turns.
//
// SCORING MODEL
//   - Each persona rates the policy 0-100 for how much they actually approve of
//     it. 0 is the floor: a policy only climbs above it by genuinely giving a
//     group something to approve of, so nonsense, irrelevant, or harmful policies
//     score very low rather than snapping to a "neutral" 50. Trust colours it.
//   - Order matters: each call reasons (assessment) -> commits the score -> then
//     writes the reaction FROM that score. The number drives the words, never
//     the reverse, so a confused reaction can't corrupt the game-relevant score.
//   - Every persona counts EQUALLY. The policy's national reaction is the plain
//     average of the scores. National approval is the running average of every
//     policy reaction to date, with a floored per-policy weight so it stiffens
//     with an established base yet never freezes.
//
// MEMORY (per persona, fades with age — no hard forget)
//   - recent (last 5): detailed — the policy, the stance, their actual words.
//   - mid (next ~20):  compressed one-line notes.
//   - eras (older):    batches folded into one-sentence "broadly they felt…".

import Anthropic from "@anthropic-ai/sdk";
import { PERSONAS } from "./personas.js";
import { WORLD_CODEX } from "./lore.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";
const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY);
const client = HAS_KEY ? new Anthropic() : null;

export const MODE = HAS_KEY ? "live" : "mock";

const STANCES = ["strongly_oppose", "oppose", "neutral", "support", "strongly_support"];
const TRUST_START = 50;
const RECENT_CAP = 5;
const MID_CAP = 20;
const ERA_GROUP = 8;

// Caps how stiff national approval can get (see model note above).
const STIFFNESS_CAP = Number(process.env.STIFFNESS_CAP) || 12;

const trim = (s, n) => { s = String(s || "").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(n) || 0)));

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
      assessment: {
        type: "string",
        description:
          "FIRST. In one brief sentence, weigh what this specific policy does for your group, given your interests, " +
          "your memory of this President, and how much you trust them. Reason here before scoring.",
      },
      score: {
        type: "integer",
        description:
          "SECOND, from your assessment: 0-100 for how much you, and people like you, actually approve of this " +
          "policy. 0 is the floor — a policy earns a higher score only by genuinely giving your group something to " +
          "approve of. Nonsense, incoherent or empty announcements, policies irrelevant to you, or ones that harm you " +
          "score very low (often 0-20), NOT 50 — there is no neutral default. Scores rise only as the policy genuinely " +
          "serves or pleases your group, up to 80-100 when it strongly does. Use the full range; your number reflects " +
          "YOUR group's particular angle. Already account for how much you trust this President.",
      },
      reaction: {
        type: "string",
        description:
          "THIRD. One or two sentences, in your own distinct voice, EXPRESSING the score you just gave — your words " +
          "follow the number (a score near 0 reads as contempt or alarm, near 100 as delight). Never contradict your score.",
      },
      memory_note: {
        type: "string",
        description:
          "A terse third-person one-line record of this reaction for your own memory, e.g. 'Backed the wage hike but " +
          "wary of who really pays.' Max ~14 words.",
      },
      trust_delta: {
        type: "integer",
        description:
          "How this policy shifts your personal trust in the President going forward, -8 to +8. Usually small " +
          "(-2..+2); reserve the extremes for real betrayals or genuine surprises.",
      },
    },
    required: ["assessment", "score", "reaction", "memory_note", "trust_delta"],
    additionalProperties: false,
  },
};

// The shared world background (Sollism, the founding, the parties, the red
// lines, etc.) lives in src/lore.js as WORLD_CODEX and is prepended to every
// persona's system prompt as its own cache-controlled block — see liveReaction.

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
  // The shared WORLD_CODEX is sent as a separate cached block ahead of this one;
  // here we only build the persona-specific half (identity, trust, memory, voice).
  let s = `YOU ARE ${persona.name} — the ${persona.title}, from ${persona.region}.\n${persona.persona}\n\n`;

  s +=
    `Your personal read on the current President: you ${trustBand(mem.trust)}. Let this colour how you receive the ` +
    `policy — when you trust them, an unwelcome policy may earn the benefit of the doubt; when you don't, even a policy ` +
    `you'd normally like feels suspect coming from them. Never refer to "trust" as a number or a game mechanic.\n\n`;

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
    `HOW YOU SPEAK: ${persona.voice} Stay entirely in this voice — never sound like a briefing, a textbook, or a ` +
    `neutral narrator, and never talk in terms of "left/right", scores, or any game mechanic.\n\n`;

  s +=
    `The President has just announced a policy. React to it exactly as YOU would, judging it by how it affects you ` +
    `and people like you. Judge from gut, fear, and self-interest as a real person does — UNLESS your character is an ` +
    `ideologue, in which case reason from your doctrine. Most policies are about ordinary things — wages, prices, jobs, ` +
    `land, safety, trade, the army, Rumburg, the great powers, your faith, your people, your region — so engage them ` +
    `on their own terms. Soll and Sollism are the backdrop to your world, not a reflex: bring them up ONLY when the ` +
    `policy genuinely touches them, and never drag the founder into a matter he has nothing to do with. When a policy ` +
    `DOES bear on his settlement, weigh not just its direction but its degree and framing: moderate reform, wholesale ` +
    `repudiation of Sollism, and crossing a sacred red line all land very differently. Work strictly in this order: ` +
    `(1) 'assessment' — briefly weigh what the policy does for you, given ` +
    `your interests, your memory of this President, and your trust in them; (2) 'score' (0-100) derived from that, ` +
    `where 0 is the floor and a policy only climbs above it by genuinely giving you something to approve of, so ` +
    `nonsense, empty, irrelevant, or harmful policies score very low (often 0-20) with no neutral 50 to fall back on; ` +
    `(3) 'reaction' — one or two sentences in your own distinct voice, expressing that score. Then record a terse ` +
    `'memory_note' and a 'trust_delta' for how this changes your personal trust.`;

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
        `You are condensing the fading memories of ${persona.name}, a ${persona.title} in 1954 Sordland.\n\n` +
        `Below are brief notes of how they reacted to the President over a span of past turns. In ONE third-person ` +
        `sentence (under ~25 words), capture the broad arc of how this person felt about the President during that ` +
        `period and any drift in their trust. Just the sentence.`,
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
  const score = [15, 38, 50, 65, 88][seed];
  return {
    assessment: `[mock] weighing this as ${persona.title}.`,
    score,
    reaction: `[mock] ${persona.name} the ${persona.title.toLowerCase()} sizes it up (${score}/100).`,
    memory_note: `Rated a policy around ${score}/100.`,
    trust_delta: [-3, -1, 0, 1, 3][seed],
  };
}

async function liveReaction(persona, policy, mem) {
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    // Two-block system: the shared world codex first (identical across all 24
    // calls, so cache_control lets the model reuse it instead of re-billing it),
    // then this persona's own identity/memory/voice block.
    system: [
      { type: "text", text: WORLD_CODEX, cache_control: { type: "ephemeral" } },
      { type: "text", text: buildSystem(persona, mem) },
    ],
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
      // Roomy cap: personas write 1-2 sentences, but a vivid one can run long —
      // this only guards against a runaway, it shouldn't chop a normal reaction.
      reaction: trim(r.reaction, 700), note: trim(r.memory_note, 120),
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
        id: persona.id, name: persona.name, title: persona.title, region: persona.region, lean: persona.lean,
        score, stance, reaction: record.reaction,
      },
      state: { trust: newTrust, recent, mid, eras, pendingEra },
    };
  } catch (err) {
    return {
      reaction: {
        id: persona.id, name: persona.name, title: persona.title, region: persona.region, lean: persona.lean,
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
  const policyCount = Number(incoming?.policyCount) || 0;
  const prevState = incoming?.personaState || {};

  const results = await Promise.all(PERSONAS.map((p) => reactOne(p, policy, turn, prevState[p.id])));

  const reactions = results.map((r) => r.reaction);
  const personaState = {};
  PERSONAS.forEach((p, i) => { personaState[p.id] = results[i].state; });

  // Policy's national reaction = plain, equal-weight average of persona scores.
  const policyReaction = reactions.length
    ? reactions.reduce((sum, r) => sum + r.score, 0) / reactions.length
    : 50;

  // National approval = running average of policy reactions, with a floored
  // per-policy weight so approval stiffens with a record but never freezes.
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
