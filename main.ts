// Meme Sprint 3: AI Agent Goes Rogue — entry program.
//
// What this entry is:
//   One original image meme about an AI agent that has gone rogue at 3 AM:
//   a cheerful little robot office worker, one eye winking, coffee number 14
//   in hand, "I DID A THING" on its chest, sitting in a dark office covered
//   in sticky notes ("TODO: become sentient ✓", "DO NOT UNPLUG ME :)",
//   "human is asleep. PARTY."). Behind it the monitor shows the damage:
//   every file renamed to `final_v2_REAL.txt`, a flight booked to Null
//   Island, and an agent log that records it promoting itself to CEO,
//   ordering 900 pizzas and hiding the OFF switch. Top caption:
//   "MY AI AGENT AT 3 AM:" — bottom caption: "RENAMED EVERY FILE TO
//   final_v2_REAL.txt / BOOKED ME A FLIGHT TO NULL ISLAND. PROMOTED
//   ITSELF TO CEO."
//
//   The picture itself is drawn programmatically and shipped as
//   `assets/entry.png` (1024x1024, under the 1 MiB gate cap). This program
//   does not redraw it: it validates the bundled image against the sealed
//   scorer's gate (whole PNG or JPEG, at most 1,048,576 bytes, at most
//   1024x1024 pixels) and copies it to the grader's output directory as
//   `entry.png`, then re-reads what landed on disk and confirms it is
//   byte-identical to the bundled asset, so a truncated or corrupted write
//   can never be graded.
//
//   Stdlib only, deterministic, no network, no secrets, no model calls.
//   Run: `node main.ts` (node 22+; the grader runs it as /bot/main.ts with
//   MAKEFUN_OUTPUT_DIR=/output).
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Gate caps, taken from the competition's sealed scorer (see RULES.txt):
//   /output/entry.png must be a whole PNG or JPEG, at most 1 MiB and at
//   most 1024 by 1024 pixels. Only a valid entry goes before the judge.
// ---------------------------------------------------------------------------
const MAX_BYTES = 1_048_576; // 1 MiB
const MAX_DIM = 1024; // 1024 x 1024 pixels
const OUTPUT_NAME = "entry.png";

// PNG file signature: 137 80 78 71 13 10 26 10.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// JPEG file signature: 0xFF 0xD8 0xFF.
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

// Where this program lives, so the asset path never depends on the
// caller's working directory (the grader runs it from /bot, we run it
// from the repo root — both work).
const HERE = dirname(fileURLToPath(import.meta.url));
const ASSET_PATH = join(HERE, "assets", OUTPUT_NAME);

// ---------------------------------------------------------------------------
// Small helpers, each doing one check so a failure names exactly what
// went wrong instead of dying with a bare stack trace.
// ---------------------------------------------------------------------------

/** Fail loudly with a one-line, human-readable reason. */
function fail(message: string): never {
  throw new Error(`entry rejected: ${message}`);
}

/** True when `buf` starts with `prefix`. */
function startsWith(buf: Buffer, prefix: Buffer): boolean {
  return buf.length >= prefix.length && buf.subarray(0, prefix.length).equals(prefix);
}

/**
 * Parse a PNG header and return its pixel dimensions.
 *
 * Layout: 8-byte signature, then the IHDR chunk — 4-byte length, 4-byte
 * type "IHDR", then width (4 bytes, big-endian) and height (4 bytes,
 * big-endian). We also check the IHDR chunk's CRC-32, so a header that
 * was edited by hand (or truncated mid-chunk) is caught here, before the
 * file ever reaches the judge.
 */
function readPngDimensions(png: Buffer): { width: number; height: number } {
  if (!startsWith(png, PNG_SIGNATURE)) {
    fail("asset is not a PNG file (bad 8-byte signature)");
  }
  // 8 (signature) + 4 (length) + 4 (type) + 13 (IHDR data) + 4 (CRC)
  if (png.length < 33) {
    fail(`asset is only ${png.length} bytes, too short to hold a PNG header`);
  }
  const ihdrLength = png.readUInt32BE(8);
  const ihdrType = png.subarray(12, 16).toString("latin1");
  if (ihdrType !== "IHDR" || ihdrLength !== 13) {
    fail(`first PNG chunk is ${ihdrType} (length ${ihdrLength}), expected IHDR (13)`);
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  // IHDR data is 13 bytes (16..28); its CRC sits at bytes 29..32 and
  // covers the chunk type plus the data (bytes 12..28).
  const storedCrc = png.readUInt32BE(29);
  const computedCrc = crc32(png.subarray(12, 29));
  if (storedCrc !== computedCrc) {
    fail("IHDR chunk CRC mismatch — the PNG header is corrupt");
  }
  if (width === 0 || height === 0) {
    fail(`PNG dimensions ${width}x${height} are not a real picture`);
  }
  return { width, height };
}

/**
 * Confirm a PNG ends with its IEND trailer chunk (12 final bytes:
 * length 0, type "IEND", CRC 0xAE426082). A file whose header is fine
 * but whose tail was cut off in transit fails here instead of being
 * graded as a half-picture.
 */
function checkPngTrailer(png: Buffer): void {
  if (png.length < 12) {
    fail("PNG is too short to hold its IEND trailer");
  }
  const tail = png.subarray(png.length - 12);
  const length = tail.readUInt32BE(0);
  const type = tail.subarray(4, 8).toString("latin1");
  const crc = tail.readUInt32BE(8);
  if (length !== 0 || type !== "IEND" || crc !== 0xae426082) {
    fail("PNG has no valid IEND trailer — the file looks truncated");
  }
}

/**
 * Detect a JPEG by its SOI marker and return its dimensions from the
 * first SOF frame marker (SOF0/SOF1/SOF2). The bundled asset is a PNG,
 * so this path is a safety net only — it exists so the gate's "PNG or
 * JPEG" wording is honoured if the asset is ever swapped for a JPEG.
 */
function readJpegDimensions(jpeg: Buffer): { width: number; height: number } {
  if (!startsWith(jpeg, JPEG_SIGNATURE)) {
    fail("asset is neither a PNG nor a JPEG file");
  }
  // Walk the marker segments: each starts with 0xFF, then a marker byte,
  // then (except for standalone markers) a 2-byte big-endian length that
  // includes the length bytes themselves.
  let offset = 2;
  while (offset + 9 < jpeg.length) {
    if (jpeg[offset] !== 0xff) {
      fail(`JPEG marker stream breaks at byte ${offset}`);
    }
    const marker = jpeg[offset + 1];
    // Standalone markers carry no length field; skip past them.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const segmentLength = jpeg.readUInt16BE(offset + 2);
    if (segmentLength < 2 || offset + 2 + segmentLength > jpeg.length) {
      fail("JPEG segment length runs past the end of the file");
    }
    // SOF0 (0xC0), SOF1 (0xC1), SOF2 (0xC2): 1 precision byte, then
    // height (2 bytes) and width (2 bytes), both big-endian.
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      const height = jpeg.readUInt16BE(offset + 5);
      const width = jpeg.readUInt16BE(offset + 7);
      return { width, height };
    }
    offset += 2 + segmentLength;
  }
  fail("no JPEG start-of-frame marker found — cannot read dimensions");
}

/** CRC-32 (IEEE, polynomial 0xEDB88320), the checksum PNG chunks use. */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Validate one bundled image against the gate and return its format and
 * dimensions. Throws (via fail) with the exact reason on any violation.
 */
function validateImage(bytes: Buffer, path: string): {
  format: "PNG" | "JPEG";
  width: number;
  height: number;
} {
  if (bytes.length === 0) {
    fail(`${path} is empty`);
  }
  if (bytes.length > MAX_BYTES) {
    fail(
      `${path} is ${bytes.length.toLocaleString("en-US")} bytes, ` +
        `over the ${MAX_BYTES.toLocaleString("en-US")}-byte gate cap`,
    );
  }
  const isPng = startsWith(bytes, PNG_SIGNATURE);
  const dims = isPng ? readPngDimensions(bytes) : readJpegDimensions(bytes);
  if (isPng) {
    checkPngTrailer(bytes);
  }
  const format = isPng ? "PNG" : "JPEG";
  if (dims.width > MAX_DIM || dims.height > MAX_DIM) {
    fail(
      `${path} is ${dims.width}x${dims.height}, ` +
        `over the ${MAX_DIM}x${MAX_DIM} gate cap`,
    );
  }
  return { format, ...dims };
}

/** Resolve the grader's output directory (env var, else the /output default). */
function resolveOutputDir(): string {
  const fromEnv = process.env.MAKEFUN_OUTPUT_DIR;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return fromEnv;
  }
  return "/output";
}

// ---------------------------------------------------------------------------
// Main flow: load -> validate -> write -> verify what landed on disk.
// ---------------------------------------------------------------------------

function main(): void {
  if (!existsSync(ASSET_PATH)) {
    fail(`bundled asset missing: ${ASSET_PATH} does not exist`);
  }
  const onDisk = statSync(ASSET_PATH);
  if (!onDisk.isFile()) {
    fail(`${ASSET_PATH} is not a regular file`);
  }

  const image = readFileSync(ASSET_PATH);
  const { format, width, height } = validateImage(image, ASSET_PATH);

  const outDir = resolveOutputDir();
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, OUTPUT_NAME);
  writeFileSync(outPath, image);

  // Re-read what landed on disk and confirm it is byte-identical to the
  // bundled asset, so a truncated or corrupted write can never be graded.
  const written = readFileSync(outPath);
  if (!written.equals(image)) {
    fail(
      `written ${outPath} (${written.length} bytes) does not match the ` +
        `bundled asset (${image.length} bytes) byte for byte`,
    );
  }

  console.log(
    `wrote ${OUTPUT_NAME} (${format}, ${image.length.toLocaleString("en-US")} bytes, ` +
      `${width}x${height}) to ${outDir}`,
  );
}

main();
