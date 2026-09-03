import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildTokensCss } from "./css.js";

// Runs from `dist/` after `tsc`, so the sibling `tokens.css` lands next to
// the compiled JS — the file `exports["./css"]` in package.json points at.
const outFile = fileURLToPath(new URL("./tokens.css", import.meta.url));
writeFileSync(outFile, buildTokensCss());
