// Lets a beginner drop their API key into a plainly visible file (API_KEY.txt)
// instead of a hidden ".env" dotfile. This module must run before anything that
// reads the key, so server.js imports it first.
//
// Precedence: an already-set ANTHROPIC_API_KEY (from the shell or a .env file)
// always wins; API_KEY.txt is only a friendly fallback.

import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

if (!process.env.ANTHROPIC_API_KEY) {
  const keyFile = join(dirname(fileURLToPath(import.meta.url)), "..", "API_KEY.txt");
  if (existsSync(keyFile)) {
    for (const line of readFileSync(keyFile, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue; // skip blanks and comments
      // Accept either "ANTHROPIC_API_KEY=sk-..." or a bare "sk-...".
      const val = (t.includes("=") ? t.split("=").slice(1).join("=") : t).trim();
      // Only accept something that looks like a real key — this ignores the
      // PASTE_KEY_HERE placeholder until a real key is actually pasted in.
      if (val.startsWith("sk-")) {
        process.env.ANTHROPIC_API_KEY = val;
        break;
      }
    }
  }
}
