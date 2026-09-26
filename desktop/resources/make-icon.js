#!/usr/bin/env node
/**
 * Generates resources/icon.png (1024x1024) without any dependencies:
 * a dark rounded square, a bright "360" rotation ring with an arrow head,
 * and three soft gaussian blobs (the "splats").
 *
 * electron-builder converts icon.png into icon.icns at build time.
 *
 *   node resources/make-icon.js [out.png] [size]
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const out = process.argv[2] || path.join(__dirname, "icon.png");
const SIZE = Number(process.argv[3] || 1024);

// ---------- tiny drawing helpers ----------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;

function sdRoundedBox(px, py, half, r) {
  const qx = Math.abs(px) - half + r;
  const qy = Math.abs(py) - half + r;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

// ---------- scene ----------
const W = SIZE, H = SIZE;
const cx = W / 2, cy = H / 2;
const s = SIZE / 1024;
const boxHalf = 470 * s, boxR = 220 * s;
const ringR = 300 * s, ringW = 54 * s;
const gapStart = -0.35, gapEnd = 0.35; // radians of the gap (around +x axis)
const blobs = [
  { x: cx - 120 * s, y: cy + 20 * s, r: 90 * s, col: [79, 209, 197] },
  { x: cx + 40 * s, y: cy - 90 * s, r: 70 * s, col: [255, 196, 86] },
  { x: cx + 110 * s, y: cy + 100 * s, r: 60 * s, col: [255, 120, 150] },
];

const AA = 1.0 * s;
const pixels = Buffer.alloc(W * H * 4);

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const px = x + 0.5 - cx, py = y + 0.5 - cy;
    let r = 0, g = 0, b = 0, a = 0;

    // background rounded square with subtle vertical gradient
    const dBox = sdRoundedBox(px, py, boxHalf, boxR);
    const boxA = 1 - smooth(-AA, AA, dBox);
    if (boxA > 0) {
      const t = (y / H);
      r = mix(30, 14, t); g = mix(34, 18, t); b = mix(44, 26, t);
      a = boxA;

      // blobs (soft gaussians, additive)
      for (const bl of blobs) {
        const d2 = ((px + cx - bl.x) ** 2 + (py + cy - bl.y) ** 2) / (bl.r * bl.r);
        const w = Math.exp(-d2 * 1.6) * 0.85;
        r = mix(r, bl.col[0], w); g = mix(g, bl.col[1], w); b = mix(b, bl.col[2], w);
      }

      // ring with a gap
      const dist = Math.hypot(px, py);
      const ang = Math.atan2(py, px);
      const inGap = ang > gapStart && ang < gapEnd;
      const dRing = Math.abs(dist - ringR) - ringW / 2;
      let ringA = 1 - smooth(-AA, AA, dRing);
      if (inGap) ringA = 0;
      // round the ring ends
      for (const endAng of [gapStart, gapEnd]) {
        const ex = Math.cos(endAng) * ringR, ey = Math.sin(endAng) * ringR;
        const dEnd = Math.hypot(px - ex, py - ey) - ringW / 2;
        ringA = Math.max(ringA, 1 - smooth(-AA, AA, dEnd));
      }
      // arrow head at the top end of the gap (gapStart), pointing clockwise
      {
        const tipAng = gapStart - 0.02;
        const ex = Math.cos(tipAng) * ringR, ey = Math.sin(tipAng) * ringR;
        const tx = Math.cos(tipAng + Math.PI / 2), ty = Math.sin(tipAng + Math.PI / 2); // tangent
        const nx = Math.cos(tipAng), ny = Math.sin(tipAng); // radial
        const lx = px - ex, ly = py - ey;
        const along = lx * tx + ly * ty;   // along tangent (positive = clockwise direction)
        const across = lx * nx + ly * ny;  // radial offset
        const len = 120 * s, half = 95 * s;
        if (along > -len * 0.1 && along < len) {
          const allowed = half * (1 - along / len);
          const dTri = Math.abs(across) - allowed;
          const triA = (1 - smooth(-AA, AA, dTri)) * (1 - smooth(len - AA, len + AA, along));
          ringA = Math.max(ringA, triA);
        }
      }
      if (ringA > 0) {
        // ring gradient: teal (top-left) -> pale (bottom-right), periodic so there is no seam
        const t = 0.5 - 0.5 * Math.cos(ang - Math.PI * 0.75);
        const rr = mix(79, 210, t), gg = mix(209, 240, t), bb = mix(197, 255, t);
        r = mix(r, rr, ringA); g = mix(g, gg, ringA); b = mix(b, bb, ringA);
      }

      // inner highlight on the top edge of the box
      const hl = (1 - smooth(-AA, 6 * s, dBox + 3 * s)) * 0.10 * (1 - y / H);
      r += 255 * hl; g += 255 * hl; b += 255 * hl;
    }

    const i = (y * W + x) * 4;
    pixels[i] = clamp(Math.round(r), 0, 255);
    pixels[i + 1] = clamp(Math.round(g), 0, 255);
    pixels[i + 2] = clamp(Math.round(b), 0, 255);
    pixels[i + 3] = clamp(Math.round(a * 255), 0, 255);
  }
}

// ---------- PNG encoder ----------
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0; // filter: none
  pixels.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${W}x${H}, ${png.length} bytes)`);
