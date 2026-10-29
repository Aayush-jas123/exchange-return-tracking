// Generates the athlete portal app icons as a borderless dark disc with the
// OFFCOMFRT white bar, on a transparent canvas (so the corners render round,
// not square, in the browser tab, iOS home screen and PWA manifest).
// Run: node generate-app-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [15, 15, 15];      // #0F0F0F disc
const BAR = [255, 255, 255];  // white brand bar
const SS = 4;                  // supersampling factor for the circle edge
const OUT_DIR = path.join(__dirname, 'public', 'images');

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 6;   // RGBA
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (width * 4 + 1)] = 0; // filter: none
        rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

// Bar geometry matches the original square icon: 70% of the disc width, 3.2% tall.
function render(size) {
    const pixels = Buffer.alloc(size * size * 4);
    const cx = size / 2;
    const cy = size / 2;
    // Slight inset so the anti-aliased rim completes inside the canvas instead of
    // being clipped at the four tangent points.
    const r = size / 2 - size * 0.015;
    const barW = size * 0.70;
    const barH = Math.max(2, Math.round(size * 0.032));
    const barX = cx - barW / 2;
    const barY = cy - barH / 2;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            // Coverage of the circle, supersampled so the edge stays smooth.
            let inside = 0;
            for (let sy = 0; sy < SS; sy++) {
                for (let sx = 0; sx < SS; sx++) {
                    const px = x + (sx + 0.5) / SS;
                    const py = y + (sy + 0.5) / SS;
                    const dx = px - cx;
                    const dy = py - cy;
                    if (dx * dx + dy * dy <= r * r) inside++;
                }
            }
            const cover = inside / (SS * SS);
            const i = (y * size + x) * 4;
            if (cover === 0) continue; // transparent corner
            const onBar = x + 0.5 >= barX && x + 0.5 <= barX + barW &&
                          y + 0.5 >= barY && y + 0.5 <= barY + barH;
            const rgb = onBar ? BAR : BG;
            pixels[i] = rgb[0];
            pixels[i + 1] = rgb[1];
            pixels[i + 2] = rgb[2];
            pixels[i + 3] = Math.round(cover * 255);
        }
    }
    return encodePng(size, size, pixels);
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <circle cx="256" cy="256" r="256" fill="#0F0F0F"/>
  <rect x="77" y="248" width="358" height="16" fill="#FFFFFF"/>
</svg>
`;

[512, 192].forEach(size => {
    const file = path.join(OUT_DIR, size === 512 ? 'app-icon.png' : `app-icon-${size}.png`);
    fs.writeFileSync(file, render(size));
    console.log('wrote', file);
});

const svgFile = path.join(OUT_DIR, 'app-icon.svg');
fs.writeFileSync(svgFile, SVG);
console.log('wrote', svgFile);
