const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))
  ]);
}
function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const R = 0.22;
  const top = [0.50, 0.20], ur = [0.79, 0.365], lr = [0.79, 0.665], bot = [0.50, 0.83], ll = [0.21, 0.665], ul = [0.21, 0.365], ct = [0.50, 0.53];
  const fTop = [top, ur, ct, ul], fLeft = [ul, ct, bot, ll], fRight = [ct, ur, lr, bot];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size, v = (y + 0.5) / size;
      const i = (y * size + x) * 4;
      const cx = Math.max(Math.abs(u - 0.5) - (0.5 - R), 0);
      const cy = Math.max(Math.abs(v - 0.5) - (0.5 - R), 0);
      const outside = Math.hypot(cx, cy) > R;
      if (outside) { buf[i + 3] = 0; continue; }
      let r = Math.round(16 + 10 * (1 - v)), g = Math.round(24 + 14 * (1 - v)), b = Math.round(34 + 22 * (1 - v));
      if (inPoly(u, v, fTop)) { r = 96; g = 165; b = 250; }
      else if (inPoly(u, v, fLeft)) { r = 29; g = 78; b = 216; }
      else if (inPoly(u, v, fRight)) { r = 59; g = 130; b = 246; }
      const dEdge = Math.min(
        distSeg(u, v, ul[0], ul[1], top[0], top[1]),
        distSeg(u, v, top[0], top[1], ur[0], ur[1]),
        distSeg(u, v, ul[0], ul[1], ct[0], ct[1]),
        distSeg(u, v, ur[0], ur[1], ct[0], ct[1])
      );
      if (dEdge < 0.022) { r = 245; g = 165; b = 36; }
      const dC = Math.hypot(u - ct[0], v - ct[1]);
      if (dC < 0.045) { r = 255; g = 214; b = 120; }
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
    }
  }
  return buf;
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map(s => ({ size: s, data: png(s, render(s)) }));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
const entries = [];
let offset = 6 + images.length * 16;
images.forEach(im => {
  const e = Buffer.alloc(16);
  e[0] = im.size === 256 ? 0 : im.size;
  e[1] = im.size === 256 ? 0 : im.size;
  e[2] = 0; e[3] = 0;
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(im.data.length, 8); e.writeUInt32LE(offset, 12);
  entries.push(e); offset += im.data.length;
});
const ico = Buffer.concat([header].concat(entries, images.map(i => i.data)));
const out = path.join(__dirname, 'icon.ico');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, ico);
console.log('icon.ico written:', ico.length, 'bytes,', images.length, 'sizes');
