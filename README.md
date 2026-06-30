# Sordland Simulator

An AI-powered political simulator set in the **Republic of Sordland** (the fictional
nation from *Suzerain*). You play the President. You announce policies; AI personas
representing Sordish demographics react in character, and your national standing
shifts accordingly.

This is a non-commercial, friends-only project. It is an **original** implementation
of the "AI demographics react to your policies" concept — its own code and its own
country — not a copy of any existing simulator.

## What's here so far (the first vertical slice)

The core loop is working: **policy in → each persona reacts via Claude → approval shifts.**

- `src/personas.js` — the cast of demographic voices (Bergia steelworker, Bludish
  activist, Lachaven financier, Lorren farmer, Sollist veteran, Young Sord nationalist,
  PFJP student, trade unionist, army officer). Each has a population weight.
- `src/reactions.js` — the "brain". One Claude call per persona; structured JSON back
  (stance, approval change −10..+10, in-character reaction). Runs all personas
  concurrently and rolls their swings up into one national number.
- `server.js` — a tiny backend that holds the API key and exposes `/api/turn`.
- `public/index.html` — a minimal test UI.

The API key lives **only on the server** — never ship it in the browser.

## Run it

```bash
npm install
# optional but recommended — live AI reactions:
export ANTHROPIC_API_KEY=sk-ant-...    # get one at https://console.anthropic.com/
npm start
# open http://localhost:3000
```

Without a key the server runs in **mock mode** (deterministic stub reactions) so you
can click around offline. Set the key to get real, in-character reactions.

## Model & cost

Defaults to `claude-opus-4-8`. A turn is ~9 Claude calls (one per persona), so for a
casual friends game you can set a cheaper model and save a lot:

```bash
export CLAUDE_MODEL=claude-sonnet-4-6    # or claude-haiku-4-5
```

Both are more than capable of persona role-play.

## Sharing it with friends

Host the whole thing (frontend + backend) somewhere small — a cheap VPS, Render,
Fly.io, Railway, etc. — set `ANTHROPIC_API_KEY` there, and send friends the URL. The
key stays on the server; friends never need their own.

## Next steps (not built yet)

- Region-level standing (the 7 Sordish regions), not just one national number
- The Grand National Assembly and Supreme Court (checks & balances)
- Economy state (recession, the "Big Four" corporations) that policies move
- Custom character creation; play from any party (USP / PFJP / NFP)
- Memory across turns so the nation remembers what you've done

## Credits / rights

Sordland and the *Suzerain* setting are the creation of Torpor Games. This is a
non-commercial fan project and is kept free.
