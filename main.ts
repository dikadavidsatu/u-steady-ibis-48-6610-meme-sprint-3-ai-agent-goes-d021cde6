// Meme Sprint 3: AI Agent Goes Rogue — entry program.
// Copies the bundled original meme image (assets/entry.png) to the
// grader's output directory as entry.png. Stdlib only, deterministic.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BYTES = 1_048_576; // gate cap: 1 MiB
const MAX_DIM = 1024; // gate cap: 1024 x 1024 pixels

const here = dirname(fileURLToPath(import.meta.url));
const assetPath = join(here, "assets", "entry.png");
const png = readFileSync(assetPath);

// Validate size against the gate cap before writing anything.
if (png.length > MAX_BYTES) {
  throw new Error(`entry.png is ${png.length} bytes, over the ${MAX_BYTES}-byte gate cap`);
}

// Validate the PNG header: signature + IHDR dimensions within cap.
const sigOk =
  png.length > 24 &&
  png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47 &&
  png[4] === 0x0d && png[5] === 0x0a && png[6] === 0x1a && png[7] === 0x0a;
if (!sigOk) throw new Error("assets/entry.png is not a whole PNG file");
const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);
if (width > MAX_DIM || height > MAX_DIM) {
  throw new Error(`entry.png is ${width}x${height}, over the ${MAX_DIM}x${MAX_DIM} gate cap`);
}

const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "entry.png");
writeFileSync(outPath, png);

// Re-read what landed on disk and confirm it is byte-identical to the
// bundled asset, so a truncated or corrupted write can never be graded.
const written = readFileSync(outPath);
if (!written.equals(png)) {
  throw new Error("written entry.png does not match the bundled asset byte for byte");
}
console.log(`wrote entry.png (${png.length} bytes, ${width}x${height}) to ${outDir}`);
