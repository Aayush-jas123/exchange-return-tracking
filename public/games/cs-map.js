/* ============================================================================
   Counter Strike — Shared map layout + collision math
   ----------------------------------------------------------------------------
   ONE source of truth for arena geometry, loaded twice:
     • browser  : counter-strike/script.js installs these colliders as its physics
                  (the visual builders still draw the meshes themselves)
     • node     : cs-sim.js (hub) uses the same colliders for bot navigation, LOS
                  and bullet validation, through RaceHub.js

   Why this file exists: the hub used to carry a hand-copied collider list. It
   drifted from the client within a few map edits, so in co-op bots hid behind
   walls that are open ground on screen and bullets stopped at geometry the bot
   could walk through. Both sides now read the same table, so drift is impossible.

   Everything here is pure arithmetic — no THREE, no DOM, no wall clock — so it
   runs unchanged inside the Node process.
   ============================================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CSMap = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const WALL_T = 0.6;          // exterior wall thickness
  const STEP = 0.4;            // anything shorter than this is walkable, not a wall
  const EYE = 1.65;            // standing sight height, used for line of sight

  // ── Primitive builders (mirrors script.js addBox/addCylinder exactly) ──
  const makeSink = (out) => (x, z, w, d, h, y = 0) => {
    out.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, minY: y, maxY: y + h });
    return [x, z, w, d, h, y];
  };
  // Cylinders are approximated by their bounding square, same as the client does.
  const cyl = (out) => (x, z, radius, h, y = 0) => {
    out.push({ minX: x - radius, maxX: x + radius, minZ: z - radius, maxZ: z + radius, minY: y, maxY: y + h });
  };

  // A wall run with a centred full-height DOORWAY.
  function doorWall(box, cx, cz, len, axis, baseY, h, gapW) {
    const side = (len - gapW) / 2;
    if (axis === 'x') {
      box(cx - (gapW / 2 + side / 2), cz, side, WALL_T, h, baseY);
      box(cx + (gapW / 2 + side / 2), cz, side, WALL_T, h, baseY);
      box(cx, cz, gapW, WALL_T, 0.9, baseY + h - 0.9);          // lintel over the opening
    } else {
      box(cx, cz - (gapW / 2 + side / 2), WALL_T, side, h, baseY);
      box(cx, cz + (gapW / 2 + side / 2), WALL_T, side, h, baseY);
      box(cx, cz, WALL_T, gapW, 0.9, baseY + h - 0.9);
    }
  }

  // A wall run with a centred WINDOW (sill below, header above, clear view through the opening).
  function winWall(box, cx, cz, len, axis, baseY, h, winW, sillH, headH) {
    const side = (len - winW) / 2;
    if (axis === 'x') {
      box(cx - (winW / 2 + side / 2), cz, side, WALL_T, h, baseY);
      box(cx + (winW / 2 + side / 2), cz, side, WALL_T, h, baseY);
      box(cx, cz, winW, WALL_T, sillH, baseY);
      box(cx, cz, winW, WALL_T, headH, baseY + h - headH);
    } else {
      box(cx, cz - (winW / 2 + side / 2), WALL_T, side, h, baseY);
      box(cx, cz + (winW / 2 + side / 2), WALL_T, side, h, baseY);
      box(cx, cz, WALL_T, winW, sillH, baseY);
      box(cx, cz, WALL_T, winW, headH, baseY + h - headH);
    }
  }

  // Climbable staircase: stacked steps each growing to full height, so groundHeight() can land on
  // any tread and the whole run is walkable from below.
  function stairs(box, x, z, totalH, steps, width, dir) {
    const stepH = totalH / steps, stepD = 0.55;
    for (let i = 0; i < steps; i++) {
      const y = (i + 1) * stepH, off = i * stepD;
      if (dir === 'N') box(x, z - off, width, stepD, y);
      else if (dir === 'S') box(x, z + off, width, stepD, y);
      else if (dir === 'E') box(x + off, z, stepD, width, y);
      else box(x - off, z, stepD, width, y);
    }
  }

  const container = (box, x, z, len, axis, y = 0) =>
    box(x, z, axis === 'x' ? len : 2.4, axis === 'x' ? 2.4 : len, 2.6, y);
  const crate = (box, x, z, s = 1.2, y = 0) => box(x, z, s, s, s, y);
  const platform = (box, x, z, w, d, y) => box(x, z, w, d, 0.3, y);
  const pavement = (box, x, z, w, d) => box(x, z, w, d, 0.18);

  function pillars(box, x, z, w, d, h, count = 4) {
    const pts = count === 4
      ? [[-w / 2 + 0.4, -d / 2 + 0.4], [w / 2 - 0.4, -d / 2 + 0.4], [-w / 2 + 0.4, d / 2 - 0.4], [w / 2 - 0.4, d / 2 - 0.4]]
      : [[0, 0]];
    for (const [ox, oz] of pts) box(x + ox, z + oz, 0.5, 0.5, h - 0.3);
  }

  // ── Duplex building: two walkable floors, interior partition, east stair shaft, roof ──
  function duplexBuilding(box, bx, bz, w, d) {
    const gfH = 3.5, slabT = 0.3, ufH = 2.8;
    const midY = gfH, upY = gfH + slabT, roofY = upY + ufH;
    const hw = w / 2, hd = d / 2;

    winWall(box, bx, bz - hd, w, 'x', 0, gfH, 2.4, 1.1, 1.1);      // north
    doorWall(box, bx, bz + hd, w, 'x', 0, gfH, 2.6);                // south (entry)
    winWall(box, bx - hw, bz, d, 'z', 0, gfH, 2.2, 1.1, 1.1);       // west
    box(bx + hw, bz, WALL_T, d, gfH);                               // east (solid)

    doorWall(box, bx - 1, bz, d - 2, 'z', 0, gfH, 2.2);             // interior partition
    crate(box, bx - hw + 2, bz + hd - 2, 1.4);
    crate(box, bx - hw + 2, bz - hd + 2, 1.2);

    const shaft = 3.5;
    const slabEast = bx + hw - shaft;
    const slabW = slabEast - (bx - hw);
    box(bx - hw + slabW / 2, bz, slabW, d - WALL_T, slabT, midY);   // second-floor slab
    stairs(box, slabEast + shaft / 2, bz + hd - 0.8, upY, 11, 3.0, 'N');

    winWall(box, bx, bz - hd, w, 'x', upY, ufH, 2.6, 0.9, 0.9);
    winWall(box, bx, bz + hd, w, 'x', upY, ufH, 2.6, 0.9, 0.9);
    winWall(box, bx - hw, bz, d, 'z', upY, ufH, 2.2, 0.9, 0.9);
    box(bx + hw, bz, WALL_T, d, ufH);
    doorWall(box, bx - 1, bz, d - 2, 'z', upY, ufH, 2.2);

    box(bx, bz, w + 0.6, d + 0.6, slabT, roofY);                    // roof slab
    box(bx, bz - hd - 0.2, w + 0.6, 0.3, 0.7, roofY + slabT);       // parapets
    box(bx, bz + hd + 0.2, w + 0.6, 0.3, 0.7, roofY + slabT);
  }

  // ── Rounded (octagonal) duplex with a cylindrical roof cap ──
  function roundDuplex(box, cyl, bx, bz, w, d) {
    const gfH = 3.5, slabT = 0.3, ufH = 2.8;
    const midY = gfH, upY = gfH + slabT, roofY = upY + ufH;
    const hw = w / 2, hd = d / 2;
    const c = 2, flatX = w - 2 * c, flatZ = d - 2 * c;
    const co = hw - c / 2, czo = hd - c / 2;

    winWall(box, bx, bz - hd, flatX, 'x', 0, gfH, 2.2, 1.1, 1.1);
    doorWall(box, bx, bz + hd, flatX, 'x', 0, gfH, 2.6);
    winWall(box, bx - hw, bz, flatZ, 'z', 0, gfH, 2.2, 1.1, 1.1);
    box(bx + hw, bz, WALL_T, d, gfH);
    box(bx - co, bz - czo, c, c, gfH);                                // NW chamfer
    box(bx - co, bz + czo, c, c, gfH);                                // SW chamfer
    box(bx + co, bz - czo, c, c, gfH);                                // NE chamfer (SE left open)

    doorWall(box, bx - 1, bz, d - 2, 'z', 0, gfH, 2.2);
    crate(box, bx - hw + 2, bz + hd - 2, 1.4);

    const shaft = 3.5;
    const slabEast = bx + hw - shaft;
    const slabW = slabEast - (bx - hw);
    box(bx - hw + slabW / 2, bz, slabW, d - WALL_T, slabT, midY);
    stairs(box, slabEast + shaft / 2, bz + hd - 0.8, upY, 11, 3.0, 'N');

    winWall(box, bx, bz - hd, flatX, 'x', upY, ufH, 2.4, 0.9, 0.9);
    winWall(box, bx, bz + hd, flatX, 'x', upY, ufH, 2.4, 0.9, 0.9);
    winWall(box, bx - hw, bz, flatZ, 'z', upY, ufH, 2.2, 0.9, 0.9);
    box(bx + hw, bz, WALL_T, d, ufH);
    box(bx - co, bz - czo, c, c, ufH, upY);
    box(bx - co, bz + czo, c, c, ufH, upY);
    box(bx + co, bz - czo, c, c, ufH, upY);
    doorWall(box, bx - 1, bz, d - 2, 'z', upY, ufH, 2.2);

    const rr = Math.max(hw, hd) + 0.3;
    cyl(bx, bz, rr, slabT, roofY);
    cyl(bx, bz, rr, 0.6, roofY + slabT);
    cyl(bx, bz, 0.5, 1.6, roofY + slabT + 0.6);
  }

  // ── Round lookout tower: shaft, walkable deck at h, lamp room, railings, external stair ──
  function roundTower(box, cyl, x, z, radius, h) {
    cyl(x, z, radius - 1.1, h);
    cyl(x, z, radius, 0.35, h);
    cyl(x, z, radius * 0.55, 1.6, h + 0.35);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      box(x + Math.cos(a) * (radius - 0.2), z + Math.sin(a) * (radius - 0.2), 0.2, 0.2, 1, h + 0.35);
    }
    const steps = Math.round(h / 0.35);
    stairs(box, x, z + radius + (steps - 1) * 0.55, h + 0.35, steps, 2.4, 'N');
  }

  // ── Vehicle: truck (climbable 2.6 m bed + cab + step block) or car (jumpable 1.1 m roof) ──
  function vehicle(box, x, z, axis, type) {
    if (type === 'truck') {
      const L = axis === 'x' ? [5, 2.4] : [2.4, 5];
      const C = axis === 'x' ? [2.2, 2.4] : [2.4, 2.2];
      const off = axis === 'x' ? [3.6, 0] : [0, 3.6];
      box(x, z, L[0], L[1], 2.6);
      box(x + off[0], z + off[1], C[0], C[1], 2.2);
      box(x - (axis === 'x' ? 3.2 : 0), z - (axis === 'x' ? 0 : 3.2), 1.2, 1.2, 0.8);
    } else {
      const B = axis === 'x' ? [4, 2] : [2, 4];
      box(x, z, B[0], B[1], 1.1);
      const c = axis === 'x' ? [2, 1.7] : [1.7, 2];
      box(x, z, c[0], c[1], 0.7, 1.1);
    }
  }

  // ══ INDUSTRIAL COMPLEX — 99x99 ════════════════════════════════════════════
  // Six square duplexes + two rounded ones around a central street, industrial filler,
  // pavement avenues, three lookouts and parked vehicles. Order and numbers match
  // buildIndustrialMap() in counter-strike/script.js — change one, change the other.
  function buildIndustrial(out) {
    const box = makeSink(out), cylinder = cyl(out);
    const HALF = 49.5;
    box(0, -HALF, 99, 1, 8); box(0, HALF, 99, 1, 8);
    box(-HALF, 0, 1, 99, 8); box(HALF, 0, 1, 99, 8);

    duplexBuilding(box, -33, -33, 12, 9);
    duplexBuilding(box, 33, -33, 12, 9);
    duplexBuilding(box, -16, 3, 11, 8);
    duplexBuilding(box, 16, 3, 11, 8);
    duplexBuilding(box, -33, 29, 12, 9);
    duplexBuilding(box, 33, 29, 12, 9);
    roundDuplex(box, cylinder, -36, 0, 12, 12);
    roundDuplex(box, cylinder, 36, 0, 12, 12);

    cylinder(0, -30, 3.0, 3.4);
    cylinder(0, -22, 2.4, 3.0);
    container(box, 0, 20, 6, 'x');
    stairs(box, 6.5, 20, 2.6, 8, 2.4, 'W');

    cylinder(-45, -12, 2.8, 9); cylinder(-45, 12, 2.6, 8);
    cylinder(45, -12, 2.6, 8); cylinder(45, 12, 2.8, 10);

    container(box, -45, 0, 6, 'z');
    container(box, 45, 0, 6, 'z');
    container(box, -45, 0, 6, 'z', 2.6);                 // double-stack (west)
    stairs(box, -40, -24, 2.6, 8, 2.4, 'W');
    container(box, -45, -24, 6, 'x');

    box(0, -14, 8, 1.2, 2.6);
    box(-24, -14, 1.2, 8, 2.4); box(24, -14, 1.2, 8, 2.4);
    box(-24, 16, 1.2, 8, 2.6); box(24, 16, 1.2, 8, 2.6);
    box(0, 12, 6, 1.2, 2.2);

    // Overhead pipe rack: high enough to walk under, so it must not block anything at eye level.
    box(0, -6, 20, 0.4, 0.4, 4.8);
    box(-9, -6, 0.4, 0.4, 4.8); box(9, -6, 0.4, 0.4, 4.8);

    pillars(box, 0, -40, 3, 3, 3);
    platform(box, 0, -40, 3.4, 3.4, 3);
    stairs(box, 0, -35, 3, 8, 2, 'N');

    cylinder(-20, -30, 0.6, 1.2); cylinder(20, -30, 0.6, 1.2);
    cylinder(-8, 28, 0.6, 1.3); cylinder(8, 28, 0.5, 1.1);

    pavement(box, 0, 0, 8, 70);
    pavement(box, -28, 0, 5, 70); pavement(box, 28, 0, 5, 70);
    pavement(box, 0, -20, 70, 5); pavement(box, 0, 20, 70, 5);
    pavement(box, 0, 0, 16, 16);
    pavement(box, 0, -32, 44, 4); pavement(box, 0, 32, 44, 4);
    pavement(box, -38, 0, 4, 44); pavement(box, 38, 0, 4, 44);
    pavement(box, -14, 0, 3, 40); pavement(box, 14, 0, 3, 40);

    roundTower(box, cylinder, -28, -2, 3.2, 5);
    roundTower(box, cylinder, 28, 2, 3.2, 5);
    roundTower(box, cylinder, 0, -34, 2.8, 4);

    vehicle(box, -28, -18, 'x', 'truck'); vehicle(box, 28, 18, 'x', 'truck');
    vehicle(box, -4, 30, 'z', 'truck');
    vehicle(box, 6, -28, 'z', 'car'); vehicle(box, -14, 12, 'x', 'car');
    vehicle(box, 14, -12, 'x', 'car'); vehicle(box, 30, -30, 'z', 'car');

    crate(box, -8, -18, 1.4); crate(box, 8, -18, 1.4);
    crate(box, -20, 8, 1.5); crate(box, 20, 8, 1.5);
    crate(box, -8, 30, 1.2); crate(box, 8, 30, 1.2);
  }

  // ══ CLASSIC ARENA — 66x66 ════════════════════════════════════════════════
  function buildClassic(out) {
    const box = makeSink(out);
    box(0, -32.5, 66, 1, 7); box(0, 32.5, 66, 1, 7);
    box(-32.5, 0, 1, 66, 7); box(32.5, 0, 1, 66, 7);
    box(-18, 0, 20, 1.2, 5); box(18, 0, 20, 1.2, 5);
    box(0, 0, 6, 6, 4.2);
    box(-22, -14, 8, 10, 5.5); box(22, 16, 10, 8, 5.5);
    box(-4, 15, 6, 4, 3.5); box(5, -14, 4, 6, 3.5);
    box(-10, 19, 1.2, 12, 4.5); box(11, -20, 1.2, 12, 4.5);
    box(-26, 10, 8, 1.2, 4); box(26, -8, 8, 1.2, 4);
    box(16, 6, 6, 2.4, 2.6); box(-15, -6, 2.4, 6, 2.6);
    crate(box, -21, 21, 2); crate(box, -19, 21, 2); crate(box, -21, 21, 1.3, 2);
    crate(box, -16, 25, 1.2); crate(box, -25, 17, 1.4);
    crate(box, 21, -16, 2); crate(box, 21, -18, 2); crate(box, 21, -16, 1.3, 2);
    crate(box, 16, -12, 1.2); crate(box, 25, -22, 1.4); crate(box, 26, -24, 1.1);
    crate(box, -6, -6, 1.3); crate(box, 6, 6, 1.3); crate(box, -3, 7, 1.1); crate(box, 3, -8, 1.1);
    crate(box, -12, -24, 1.4); crate(box, 12, 25, 1.4); crate(box, -28, -28, 1.6); crate(box, 28, 28, 1.6);
    crate(box, -28, 2.5, 1.2); crate(box, 28, -2.5, 1.2); crate(box, 0, 22, 1.2); crate(box, 0, -22, 1.2);
  }

  const BUILDERS = { industrial: buildIndustrial, classic: buildClassic };
  const MAPS = {
    industrial: {
      size: 99, half: 48,
      ct: { xMin: -8, xMax: 8, zMin: -45, zMax: -40 },
      t: { xMin: -20, xMax: 20, zMin: 35, zMax: 45 },
    },
    classic: {
      size: 66, half: 32,
      ct: { xMin: -8, xMax: 8, zMin: -25, zMax: -20 },
      t: { xMin: -20, xMax: 20, zMin: 20, zMax: 25 },
    },
  };

  // Built once per map and frozen: every consumer must see the identical array.
  const _cache = {};
  function collidersFor(name) {
    const key = BUILDERS[name] ? name : 'industrial';
    if (!_cache[key]) { const out = []; BUILDERS[key](out); _cache[key] = out; }
    return _cache[key];
  }
  function info(name) { return MAPS[BUILDERS[name] ? name : 'industrial']; }

  // ── Collision math, shared verbatim ──
  function circleHitsBox(x, z, r, c) {
    const dx = x - clamp(x, c.minX, c.maxX), dz = z - clamp(z, c.minZ, c.maxZ);
    return dx * dx + dz * dz < r * r;
  }

  // Height-aware: a collider only blocks when it spans the mover's body band. Low props (pavement,
  // stair treads under the step height) are walked over; overhead slabs are ignored from below.
  function collide(colliders, pos, r, h, step = STEP) {
    for (const c of colliders) {
      if (c.maxY <= pos.y + step || c.minY >= pos.y + h) continue;
      const cx = clamp(pos.x, c.minX, c.maxX), cz = clamp(pos.z, c.minZ, c.maxZ);
      const dx = pos.x - cx, dz = pos.z - cz, d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        pos.x += (dx / d) * (r - d);
        pos.z += (dz / d) * (r - d);
      } else {
        const pl = pos.x - c.minX, pr = c.maxX - pos.x, pb = pos.z - c.minZ, pf = c.maxZ - pos.z;
        const m = Math.min(pl, pr, pb, pf);
        if (m === pl) pos.x = c.minX - r; else if (m === pr) pos.x = c.maxX + r;
        else if (m === pb) pos.z = c.minZ - r; else pos.z = c.maxZ + r;
      }
    }
  }

  function groundHeight(colliders, pos, r, step = STEP) {
    let g = 0;
    for (const c of colliders) {
      if (c.maxY <= pos.y + step && c.maxY > g && circleHitsBox(pos.x, pos.z, r * 0.85, c)) g = c.maxY;
    }
    return g;
  }

  // Footprint-only on purpose: isFree() gates spawn points, waypoints and where trees/bushes may
  // land, and the arena's owner wants thin raised pavement counted as occupied so vegetation never
  // spawns on a walkway. Passability over those low props comes from collide()'s step height, not
  // from here.
  function isFree(colliders, half, x, z, r) {
    if (Math.abs(x) > half - r || Math.abs(z) > half - r) return false;
    return !colliders.some(c => circleHitsBox(x, z, r, c));
  }

  // Ground line of sight: only geometry that actually covers eye height blocks the view, which is
  // what makes windows see-through and pavements irrelevant to a bot's targeting.
  function hasLOS(colliders, x1, z1, x2, z2, eyeY = EYE) {
    const dx = x2 - x1, dz = z2 - z1, dist = Math.hypot(dx, dz);
    const steps = Math.ceil(dist / 0.5);
    for (let i = 1; i < steps; i++) {
      const t = i / steps, x = x1 + dx * t, z = z1 + dz * t;
      for (const c of colliders) {
        if (x < c.minX || x > c.maxX || z < c.minZ || z > c.maxZ) continue;
        if (c.minY <= eyeY && c.maxY >= eyeY) return false;
      }
    }
    return true;
  }

  // Bullets: march in 3D and stop on whatever spans the ray's height at that point, so a bot
  // crouched behind a low barrier is genuinely hard to hit and a raised deck genuinely shields.
  // `step` is exposed because the same march serves two very different jobs: the hub validates a
  // fired bullet and needs 25 cm precision, while a cabinet drawing a teammate's tracer only needs
  // to know which wall it stops on and would otherwise march 564 volumes 400 times per shot.
  function rayBlock(colliders, ox, oy, oz, dx, dy, dz, maxDist, step = 0.25) {
    const steps = Math.ceil(maxDist / step);
    for (let i = 1; i <= steps; i++) {
      const t = i * step;
      const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
      if (y < 0 || y > 12) return { wall: true, dist: t };
      for (const c of colliders) {
        if (x < c.minX || x > c.maxX || z < c.minZ || z > c.maxZ) continue;
        if (c.minY <= y && c.maxY >= y) return { wall: true, dist: t };
      }
    }
    return null;
  }

  // Hub-side patrol points. The client makes its own (THREE.Vector2), so this only serves cs-sim.
  function waypoints(name, count) {
    const m = info(name), col = collidersFor(name), out = [];
    let guard = 0;
    while (out.length < count && guard++ < count * 200) {
      const x = (Math.random() - 0.5) * 2 * (m.half - 3);
      const z = (Math.random() - 0.5) * 2 * (m.half - 3);
      if (isFree(col, m.half, x, z, 0.9)) out.push({ x, z });
    }
    return out;
  }

  return {
    MAPS, STEP, EYE, info, collidersFor, waypoints,
    collide, groundHeight, isFree, hasLOS, rayBlock, circleHitsBox,
  };
});
