/* ============================================================================
   Rooftop Race — shared deterministic simulation
   ----------------------------------------------------------------------------
   Loaded by the game (window.RooftopSim) and by the server (require). Game
   state is only ever touched by + − × ÷, Math.min/max/abs/floor and an integer
   PRNG, so a seed plus an input log reproduces a run bit-for-bit in any JS
   engine. The server replays every logged input to get the real distance —
   clients never report their own score.
   Input log entry: tick * 4 + code (1 jump press, 2 jump release, 3 slide),
   where tick = steps already simulated when the input was applied.
   ============================================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RooftopSim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const STEP = 1 / 60, U = 10;                // fixed timestep; 10 units = 1 m
const G = 1500, JV = 500, DJV = 445, MAXF = 950, HOLD_T = .2;
const COYOTE = .09, JBUF = .13, SLIDE_T = .62, FLIP_T = .42, HW = 5;
const STAND_H = 30, SLIDE_H = 14, DEATH_Y = 420;
const RUN = 0, AIR = 1, SLIDE = 2, WALL = 3, CLIMB = 4, TUN = 5, DEAD = 6, FLIP = 7;
const IN_JUMP = 1, IN_RELEASE = 2, IN_SLIDE = 3;
const ZONE_U = 15000, NZ = 5;               // 1.5 km per district, 5 districts cycling
const PAT_W = 88, PAT_H = 78;               // facade window tile (visual offsets only)
const AHEAD = 1600, BEHIND = 900;           // world kept generated / retained around the runner

function mulberry(a) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const arc = k => 4 * k * (1 - k);          // 0 → 1 → 0 hump without Math.sin (engine-exact)
const zoneAt = x => Math.floor(Math.max(0, x) / ZONE_U) % NZ;

/* ═══ Difficulty — ramps with distance, so every racer in a room faces the same curve ═══
   0 → 1 over the first 4 km (≈ the 3-minute race), then a slow tail to 1.35. */
function diff(x) { const m = x / U; return m < 4000 ? m / 4000 : Math.min(1.35, 1 + (m - 4000) / 14000); }
function vTarget(x) { return 175 + diff(x) * 165; }          // 175 → 340 u/s at 4 km → ~398
function pace(x) { return Math.min(10, 1 + Math.floor(diff(x) * 7.5)); } // HUD level 1–10

/* ═══ Seeded world ═══ */
function createWorld(seed) {
  const rng = mulberry((seed >>> 0) || 1), B = [];
  const gen = { x: -300, i: 0, prevRy: 60, cor: null, nextCor: 6 + Math.floor(rng() * 4) };

  function genOne() {
    const r = rng, i = gen.i++, d = diff(gen.x);
    let w, ry, gap = 0, member = false, first = false;
    if (i === 0) { w = 900; ry = 60; }
    else if (gen.cor) { member = true; w = 150 + r() * 70; ry = gen.cor.ry + (r() - .5) * 8; }
    else {
      w = 135 + r() * Math.max(75, 245 - d * 125);              // roofs get shorter
      const swing = Math.min(130, 60 + d * 55);                 // and more uneven
      ry = gen.prevRy + (r() * 2 - 1) * swing;
      gap = r() < Math.min(.88, .45 + d * .36) ? 28 + r() * (34 + Math.min(90, d * 66)) : 0;
      if (gap > 0) ry = Math.max(ry, gen.prevRy - 52);
      ry = clamp(ry, -50, 150);
      if (i >= gen.nextCor && i > 3) {
        member = first = true;
        gen.cor = { ry, x0: 0, x1: 0, floor: ry + 62, top: ry + 26, left: 3 + Math.floor(r() * 2) };
      }
    }
    const x = gen.x + gap;
    const b = { x, w, ry, i, z: zoneAt(x), po: r() * PAT_W, pv: r() * PAT_H, neon: r() < .3, bill: r() < .17, gap, obs: [], orbs: [], birds: [], props: [], cor: null };
    if (member) {
      const c = gen.cor; b.cor = c;
      if (first) c.x0 = x + w * .32;
      else if (--c.left <= 0) { c.x1 = x + w * .66; gen.cor = null; gen.nextCor = i + 9 + Math.floor(r() * 6); }
    }

    if (i > 0) {
      // Rooftop obstacles — denser, more overhead mixes as the pace climbs
      const slots = w > 230 - d * 40 ? 2 : 1, chance = Math.min(.88, .4 + d * .4), overhead = Math.min(.6, .28 + d * .26);
      for (let k = 0; k < slots; k++) {
        const roll = r(), kind = r(), pos = r(), sub = r(), size = r();
        if (roll > chance) continue;
        const ox = x + 50 + (w - 100) * ((k + .15 + pos * .7) / slots);
        if (b.cor && b.cor.x0 && Math.abs(ox - b.cor.x0) < 56) continue;
        if (kind < overhead) {
          if (sub < .4) b.obs.push({ t: 'pipe', x: ox, w: 46 + size * 30, y0: ry - 38, y1: ry - 19.5, mul: .42 });
          else if (sub < .72) b.obs.push({ t: 'sign', x: ox, w: 52, y0: ry - 40, y1: ry - 21, mul: .42 });
          else b.obs.push({ t: 'wire', x: ox, w: 66 + size * 26, y0: ry - 26, y1: ry - 20.5, mul: .5 });
        } else {
          if (sub < .45) b.obs.push({ t: 'crate', x: ox, w: 14, y0: ry - 13, y1: ry, mul: .6 });
          else if (sub < .75) b.obs.push({ t: 'barrier', x: ox, w: 9, y0: ry - 18, y1: ry, mul: .45 });
          else b.obs.push({ t: 'ac', x: ox, w: 22, y0: ry - 11, y1: ry, mul: .62 });
        }
      }
      // Energy orbs (+5 m each)
      if (r() < .55) {
        const n = 3 + Math.floor(r() * 3), ox = x + 40 + r() * Math.max(10, w - 150), hgt = 16 + r() * 18;
        for (let j = 0; j < n; j++) b.orbs.push({ x: ox + j * 17, y: ry - 14 - arc(j / (n - 1)) * hgt, got: false });
      }
      if (gap > 45 && r() < .5) {
        const sx = x - gap, top = Math.min(gen.prevRy, ry) - 26;
        for (let j = 0; j < 3; j++) b.orbs.push({ x: sx + gap * (j + 1) / 4, y: top - arc((j + 1) / 4) * 22, got: false });
      }
      // Birds — head height (slide) or jump height (stay grounded); faster later on
      if (i > 2 && r() < Math.min(.42, .05 + d * .28)) {
        const high = r() < .5;
        b.birds.push({ x0: x + w * (.5 + r() * .4), y: high ? ry - 47 : ry - 23, sp: 100 + r() * 60 + d * 70, on: false, t: 0, bx: 0, hit: false, ph: r() * 6 });
      }
    }
    // Rooftop dressing (no collision)
    const nProps = w > 220 ? 2 : 1;
    for (let k = 0; k < nProps; k++) b.props.push({ t: Math.floor(r() * 6), x: x + 18 + r() * (w - 70), s: .8 + r() * .5, ph: r() * 6 });

    B.push(b);
    gen.x = x + w; gen.prevRy = ry;
  }
  function genUntil(xEnd) { while (gen.x < xEnd) genOne(); }
  function bAt(x) { for (let k = 0; k < B.length; k++) { const b = B[k]; if (x >= b.x - 3 && x <= b.x + b.w + 3) return b; } return null; }
  function prune(xMin) { while (B.length > 2 && B[0].x + B[0].w < xMin) B.shift(); }

  genUntil(1200);
  return { seed: seed >>> 0, B, gen, genUntil, bAt, prune };
}

/* ═══ Runner ═══ */
function mkRunner(c) {
  return { x: 0, y: 60, vx: vTarget(0) * .6, vy: 0, st: RUN, gnd: true, jumps: 0, coy: 0, buf: 0, held: false, hold: 0, slideT: 0, slideQ: 0, ff: false,
    wall: null, cl: null, cor: null, stun: 0, flip: -1, rot: 0, ph: 0, bonus: 0, c: c | 0, alive: true, fin: -1 };
}
const score = p => p.fin >= 0 ? p.fin : Math.max(0, Math.floor(p.x / U) + p.bonus);
const code = p => p.st === DEAD ? DEAD : (p.flip >= 0 ? FLIP : p.st);

const noop = () => {};
const NOFX = { dust: noop, burst: noop, hit: noop, orb: noop, land: noop, die: noop };

function startClimb(p, b, d, top) { p.st = CLIMB; p.vy = 0; p.gnd = false; p.flip = -1; p.cl = { b, d, t: 0, from: p.y, to: top ? b.ry : p.y - 40, top }; }
function wallAhead(B, x0, x1, y) {
  for (let k = 0; k < B.length; k++) { const b = B[k]; if (b.x >= x0 + HW - .01 && b.x < x1 + HW && y > b.ry + .5) return b; }
  return null;
}
function overheadAbove(B, p) {
  for (let k = 0; k < B.length; k++) {
    const b = B[k];
    if (b.x > p.x + 60) break;
    for (const o of b.obs) if (o.y1 < p.y - 15 && Math.abs(o.x - p.x) < o.w / 2 + HW) return true;
  }
  return false;
}
function doSlide(S) {
  const p = S.p, F = S.F;
  if (p.st === DEAD || p.st === TUN || p.st === CLIMB) return;
  if (p.st === WALL) { p.st = AIR; p.x -= 2; p.vy = 60; p.wall = null; return; }
  if (!p.gnd) { p.ff = true; p.slideQ = .3; p.flip = -1; return; }
  const b = S.w.bAt(p.x);
  if (b && b.cor && b.cor.x0 && Math.abs(p.x - b.cor.x0) < 38 && Math.abs(p.y - b.ry) < 1) {
    p.st = TUN; p.cor = b.cor; p.y = b.cor.floor; p.vy = 0; F.burst(p.x, b.ry, 12, 1); return;
  }
  if (p.st !== SLIDE) F.dust(p.x, p.y, 6);
  p.st = SLIDE; p.slideT = SLIDE_T;
}
function die(S) {
  const p = S.p;
  if (p.st === DEAD) return;
  p.fin = score(p);
  p.st = DEAD; p.alive = false; p.vy = -160; p.flip = -1;
  S.F.die(p);
}
function input(S, c) {
  const p = S.p;
  if (p.st === DEAD) return;
  if (c === IN_JUMP) { p.buf = JBUF; p.held = true; }
  else if (c === IN_RELEASE) p.held = false;
  else if (c === IN_SLIDE) doSlide(S);
}

function step(S, dt) {
  const p = S.p, w = S.w, B = w.B, F = S.F;
  S.k++;
  if (p.st === DEAD) { p.vy = Math.min(MAXF, p.vy + G * dt); p.y += p.vy * dt; p.x += p.vx * dt; p.vx *= .985; p.rot += dt * 7; return; }
  if (w.gen.x < p.x + AHEAD) w.genUntil(p.x + AHEAD);
  w.prune(p.x - BEHIND);
  p.buf -= dt; p.coy -= dt; p.slideQ -= dt; if (p.stun > 0) p.stun -= dt;
  if (p.flip >= 0) { p.flip += dt; if (p.flip >= FLIP_T) p.flip = -1; }
  const vt = vTarget(p.x) * (p.st === TUN ? 1.28 : 1);
  p.vx += (vt - p.vx) * Math.min(1, dt * (p.vx < vt ? .85 : 2.5)); // slowdowns recover over ~1.5s
  p.ph += dt * (p.vx * .05 + 2);

  if (p.st === WALL) {
    p.vy = Math.min(75, p.vy + 260 * dt); p.y += p.vy * dt;
    if (p.buf > 0) { p.buf = 0; const top = p.y - p.wall.ry <= 48; startClimb(p, p.wall, top ? .2 : .22, top); }
    if (p.y > DEATH_Y) die(S);
    return;
  }
  if (p.st === CLIMB) {
    const c = p.cl; c.t += dt; const k = Math.min(1, c.t / c.d), e = k * k * (3 - 2 * k);
    p.y = c.from + (c.to - c.from) * e;
    if (k >= 1) {
      if (c.top) { p.x = c.b.x + 3; p.y = c.b.ry; p.st = RUN; p.gnd = true; p.jumps = 0; p.vx = Math.max(p.vx, vt * .6); F.dust(p.x, p.y, 4); }
      else { p.st = WALL; p.vy = 0; }
    }
    return;
  }
  if (p.st === TUN) {
    p.x += p.vx * dt; p.y = p.cor.floor; p.buf = 0;
    if (p.cor.x1 && p.x >= p.cor.x1) {
      const b = w.bAt(p.x); p.st = AIR; p.gnd = false; p.y = b ? b.ry : p.cor.ry; p.vy = -430; p.jumps = 1; p.cor = null;
      F.burst(p.x, p.y, 12, 1);
    }
    return;
  }

  // Jump — buffered presses + coyote time; second press in the air is a flip
  if (p.buf > 0) {
    if (p.gnd || p.coy > 0) { p.buf = 0; p.vy = -JV; p.gnd = false; p.coy = 0; p.jumps = 1; p.hold = HOLD_T; p.st = AIR; p.ff = false; F.dust(p.x, p.y, 3); }
    else if (p.jumps < 2) { p.buf = 0; p.vy = -DJV; p.jumps = 2; p.hold = HOLD_T * .6; p.flip = 0; p.ff = false; F.burst(p.x, p.y - 6, 6, 0); }
  }

  // Horizontal — rooftop walls stop you: small steps are mantled, tall ones clung to
  const nx = p.x + p.vx * dt, wb = wallAhead(B, p.x, nx, p.y);
  if (wb) {
    const d = p.y - wb.ry;
    if (d <= 8 && p.gnd) { p.x = nx; p.y = wb.ry; }
    else if (d <= 22) { p.x = wb.x - HW; startClimb(p, wb, .13, true); return; }
    else { p.x = wb.x - HW; p.st = WALL; p.wall = wb; p.gnd = false; p.vy = Math.max(0, p.vy * .25); p.vx *= .7; p.flip = -1; F.dust(wb.x, p.y - 12, 3); return; }
  } else p.x = nx;

  // Vertical
  if (!p.gnd) {
    const hold = p.held && p.hold > 0 && p.vy < 0; if (p.hold > 0) p.hold -= dt;
    p.vy = Math.min(MAXF, p.vy + G * (hold ? .42 : 1) * dt);
    if (p.ff) p.vy = Math.max(p.vy, 640);
    const ny = p.y + p.vy * dt;
    let land = null;
    if (p.vy >= 0) for (const b of B) { if (p.x + HW > b.x && p.x - HW < b.x + b.w && p.y <= b.ry + .5 && ny >= b.ry) { land = b; break; } }
    if (land) {
      const hard = p.vy > 760;
      p.y = land.ry; p.vy = 0; p.gnd = true; p.jumps = 0; p.ff = false; p.flip = -1; p.st = RUN;
      F.dust(p.x, p.y, hard ? 9 : 4); F.land(hard);
      if (p.slideQ > 0) doSlide(S);
    } else { p.y = ny; if (p.st !== AIR) p.st = AIR; }
  } else {
    let sup = null;
    for (const b of B) { if (p.x + HW > b.x && p.x - HW < b.x + b.w && b.ry >= p.y - .5 && b.ry <= p.y + 8) { sup = b; break; } }
    if (!sup) { p.gnd = false; p.coy = COYOTE; p.st = AIR; }
    else {
      p.y = sup.ry;
      if (p.st === SLIDE) { p.slideT -= dt; if (p.slideT <= 0 && !overheadAbove(B, p)) p.st = RUN; }
    }
  }
  if (p.y > DEATH_Y) { die(S); return; }

  // Obstacles, orbs, birds
  const top = p.y - (p.st === SLIDE ? SLIDE_H : STAND_H);
  for (const b of B) {
    if (b.x > p.x + 120) break;
    if (b.x + b.w < p.x - 120) continue;
    for (const o of b.obs) {
      if (o.hit) continue;
      if (p.x + HW > o.x - o.w / 2 && p.x - HW < o.x + o.w / 2 && p.y > o.y0 && top < o.y1) {
        o.hit = true; if (o.t === 'crate') o.gone = true;
        p.vx *= o.mul; p.stun = .38;
        F.hit(o.x, (o.y0 + o.y1) / 2, o.t === 'crate' ? 5 : o.t === 'wire' ? 1 : 2);
      }
    }
    for (const q of b.orbs) {
      if (!q.got && Math.abs(q.x - p.x) < 9 && q.y > top - 6 && q.y < p.y + 4) { q.got = true; p.bonus += 5; F.orb(q.x, q.y); }
    }
  }
  for (const b of B) for (const d of b.birds) {
    if (!d.on) { if (p.x >= d.x0 - 560) { d.on = true; d.t = 0; } else continue; }
    d.t += dt; d.bx = d.x0 - d.t * d.sp;
    if (!d.hit && Math.abs(d.bx - p.x) < HW + 7 && d.y + 4 > top && d.y - 4 < p.y) { d.hit = true; p.vx *= .35; p.stun = .38; F.hit(d.bx, d.y, 4); }
  }
}

/* A runner in its own copy of the seeded world. fx receives visual events only. */
function createSim(seed, c, fx) {
  const S = { w: createWorld(seed), p: mkRunner(c), F: Object.assign({}, NOFX, fx || {}), k: 0 };
  S.step = () => step(S, STEP);
  S.input = v => input(S, v);
  S.kill = () => die(S);
  return S;
}

/* Replay queued inputs (ascending tick*4+code) up to tick K. Inputs stamped for a
   tick that has already been simulated are dropped. Returns steps run. */
function advance(S, K, q) {
  let n = 0;
  while (S.k < K && S.p.st !== DEAD) {
    while (q.length) {
      const v = q[0], t = Math.floor(v / 4);
      if (t > S.k) break;
      q.shift();
      if (t === S.k) input(S, v & 3);
    }
    step(S, STEP); n++;
  }
  return n;
}

return {
  STEP, U, HW, DEATH_Y, FLIP_T, STAND_H, PAT_W, PAT_H, ZONE_U, NZ,
  RUN, AIR, SLIDE, WALL, CLIMB, TUN, DEAD, FLIP, IN_JUMP, IN_RELEASE, IN_SLIDE,
  mulberry, clamp, zoneAt, diff, vTarget, pace, createWorld, createSim, advance, score, code
};
});
