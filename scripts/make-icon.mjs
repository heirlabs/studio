#!/usr/bin/env node
/**
 * Build electron/icon.png (1024) and electron/icon.icns for macOS packaging.
 * Uses only Node + macOS `sips` / `iconutil` when available.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import zlib from "zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, "../electron");
const pngPath = path.join(outDir, "icon.png");
const icnsPath = path.join(outDir, "icon.icns");

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** Solid dark rounded-ish icon with a simple light diamond (✦-like) — pure PNG writer */
function writePng(size, filePath) {
  // RGBA raw
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const cx = size / 2;
  const cy = size / 2;
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const i = row + 1 + x * 4;
      const dx = (x - cx) / size;
      const dy = (y - cy) / size;
      // rounded square mask
      const ax = Math.abs(dx) * 2.05;
      const ay = Math.abs(dy) * 2.05;
      const r = Math.max(ax, ay);
      const inside = r < 0.92;
      // diamond (manhattan) for star
      const diamond = Math.abs(dx) * 2.2 + Math.abs(dy) * 2.2 < 0.42;
      // vertical/horizontal spikes
      const spike =
        (Math.abs(dx) < 0.06 && Math.abs(dy) < 0.38) ||
        (Math.abs(dy) < 0.06 && Math.abs(dx) < 0.38);
      if (!inside) {
        raw[i] = 0;
        raw[i + 1] = 0;
        raw[i + 2] = 0;
        raw[i + 3] = 0;
      } else if (diamond || spike) {
        // accent blue-white
        raw[i] = 200;
        raw[i + 1] = 220;
        raw[i + 2] = 255;
        raw[i + 3] = 255;
      } else {
        // deep slate fill
        const g = 18 + Math.floor((1 - r) * 30);
        raw[i] = g;
        raw[i + 1] = g + 4;
        raw[i + 2] = g + 14;
        raw[i + 3] = 255;
      }
    }
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 9 });
  const png = Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  fs.writeFileSync(filePath, png);
}

writePng(1024, pngPath);
console.log("wrote", pngPath);

// Build .icns on macOS
try {
  const iconset = path.join(outDir, "icon.iconset");
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset, { recursive: true });
  const sizes = [16, 32, 64, 128, 256, 512, 1024];
  for (const s of sizes) {
    const name =
      s === 1024
        ? "icon_512x512@2x.png"
        : s >= 32 && sizes.includes(s / 2)
          ? null
          : `icon_${s}x${s}.png`;
    // generate both 1x and 2x where applicable
  }
  const map = [
    [16, "icon_16x16.png"],
    [32, "diana.k@example.org"],
    [32, "icon_32x32.png"],
    [64, "ivan.p@example.net"],
    [128, "icon_128x128.png"],
    [256, "wendy.h@example.net"],
    [256, "icon_256x256.png"],
    [512, "wendy.h@example.net"],
    [512, "icon_512x512.png"],
    [1024, "alice.j@example.com"],
  ];
  for (const [s, name] of map) {
    const dest = path.join(iconset, name);
    execFileSync("sips", ["-z", String(s), String(s), pngPath, "--out", dest], {
      stdio: "pipe",
    });
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", icnsPath], {
    stdio: "pipe",
  });
  fs.rmSync(iconset, { recursive: true, force: true });
  console.log("wrote", icnsPath);
} catch (e) {
  console.warn("icns generation skipped:", e.message);
}
