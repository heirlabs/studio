#!/usr/bin/env node
/**
 * Build electron/icon.png (1024) and electron/icon.icns from the official
 * HEIR geometric mark (red on black). Also copies the 1024 PNG to the iOS
 * AppIcon slot so both apps stay in lockstep.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "electron");
const svgPath = path.join(outDir, "icon-source.svg");
const pngPath = path.join(outDir, "icon.png");
const icnsPath = path.join(outDir, "icon.icns");
const iosIcon = path.join(
  root,
  "ios/HeirStudio/Assets.xcassets/AppIcon.appiconset/AppIcon.png",
);

if (!fs.existsSync(svgPath)) {
  throw new Error(`missing ${svgPath}`);
}

execFileSync(
  "rsvg-convert",
  ["-w", "1024", "-h", "1024", svgPath, "-o", pngPath],
  { stdio: "pipe" },
);
console.log("wrote", pngPath);

fs.mkdirSync(path.dirname(iosIcon), { recursive: true });
fs.copyFileSync(pngPath, iosIcon);
console.log("wrote", iosIcon);

try {
  const iconset = path.join(outDir, "icon.iconset");
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset, { recursive: true });
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
