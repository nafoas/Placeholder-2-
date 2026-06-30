// Tiny backend. It holds the Claude API key (never the browser) and exposes a
// single endpoint the frontend calls each turn. Serves the static UI too.

import "./src/loadkey.js"; // must be first: loads the key from API_KEY.txt
import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { runTurn, MODE } from "./src/reactions.js";
import { PERSONAS } from "./src/personas.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "64kb" }));
app.use(express.static(join(__dirname, "public")));

// Lightweight metadata so the UI can render the cast and show the mode.
app.get("/api/state", (req, res) => {
  res.json({
    mode: MODE,
    personas: PERSONAS.map(({ id, name, region, weight }) => ({ id, name, region, weight })),
  });
});

// The core loop: a policy goes in, every persona's reaction comes back.
app.post("/api/turn", async (req, res) => {
  const policy = (req.body?.policy || "").toString().trim();
  if (!policy) return res.status(400).json({ error: "Provide a non-empty 'policy'." });
  if (policy.length > 4000) return res.status(400).json({ error: "Policy is too long (max 4000 chars)." });

  try {
    const result = await runTurn(policy);
    res.json(result);
  } catch (err) {
    console.error("turn failed:", err);
    res.status(500).json({ error: err?.message || "Turn failed." });
  }
});

app.listen(PORT, () => {
  console.log(`Sordland Simulator running at http://localhost:${PORT}  [${MODE} mode]`);
  if (MODE === "mock") {
    console.log("No ANTHROPIC_API_KEY set — serving stub reactions. Set the key for live AI reactions.");
  }
});
