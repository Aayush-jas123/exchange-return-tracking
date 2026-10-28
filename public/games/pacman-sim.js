/* ============================================================================
   Pac-Man — maze + online world
   ----------------------------------------------------------------------------
   The maze lives here once: public/games/pac-man/script.js draws it, and
   RaceHub.js simulates the online match with it. Online the hub owns the
   pellets, the ghosts and every death, so all athletes in a lobby see the very
   same board — clients only stream their own position + facing and render the
   snapshot they get back.

   Behind-touch rule: an athlete who runs into another one from behind (their
   facing points at the other's back, the other is facing away) takes a life
   from them and scores KILL_PTS. Head-on contact is harmless.

   No DOM and no wall-clock reads inside the stepping code — the hub calls
   step(world, dt) on a fixed 100 ms tick.
   ============================================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PacmanSim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const COLS = 28, ROWS = 31;
  const WALL = 1, PELLET = 2, POWER = 3;

  // 0=empty, 1=wall, 2=pellet, 3=power pellet
  const LEVEL = [
    "1111111111111111111111111111",
    "1222222222222222222222222221",
    "1211112111111111111121111221",
    "1311112111111111111121111231",
    "1222222222222222222222222221",
    "1211112111111111111121111221",
    "1222222222222222222222222221",
    "1111112111111111111121111111",
    "0000012222222222222221100000",
    "1111112111111111111121111111",
    "1222222222222222222222222221",
    "1211112111111111111121111221",
    "1222222222222222222222222221",
    "1211112111000000011211112121",
    "1211112111000000011211112121",
    "1211112111000000011211112121",
    "1222222222222222222222222221",
    "1211112111111111111121111221",
    "1222222222222222222222222221",
    "1111112111111111111121111111",
    "0000012222222222222221100000",
    "1111112111111111111121111111",
    "1222222222222222222222222221",
    "1211112111111111111121111221",
    "1311112222222222222222112131",
    "1222222111111111111122222221",
    "1111112111111111111121111111",
    "1222222222222222222222222221",
    "1211111111111111111111112121",
    "1222222222222222222222222221",
    "1111111111111111111111111111"
  ];

  // One corner per athlete, indexed by the colour the hub hands out (0-3).
  const SPAWNS = [{ x: 1, y: 29 }, { x: 26, y: 29 }, { x: 1, y: 1 }, { x: 26, y: 1 }];
  const GHOST_SPAWNS = [
    { x: 12, y: 13, dx: 1, dy: 0 },
    { x: 3, y: 1, dx: 1, dy: 1 },
    { x: 24, y: 1, dx: -1, dy: 1 },
    { x: 3, y: 27, dx: 1, dy: -1 }
  ];
  const HOUSE = { x: 13, y: 14 };
  const EXIT = { x: 13, y: 16 };          // the house opens downward onto row 16
  const inHouse = (c, r) => r >= 13 && r <= 15 && c >= 10 && c <= 16;

  const PELLET_PTS = 10, POWER_PTS = 50, GHOST_PTS = 200, KILL_PTS = 300;
  const LIVES = 3;
  const GHOST_SPEED = 4.2, EYES_SPEED = 6, FEAR_SPEED = 2.4;
  const FEAR_SEC = 6, FREEZE_SEC = 2, INV_SEC = 1.6, HUNT_CD = 1.2;
  const HIT_R = 0.7, BACK_R = 0.9;
  const DIRS = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: -1 }, { x: 0, y: 1 }];

  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const wallAt = (maze, c, r) => (r < 0 || r >= ROWS || c < 0 || c >= COLS) ? true : maze[r][c] === WALL;
  const dirOf = (dx, dy) => dx === 1 ? 0 : dx === -1 ? 1 : dy === -1 ? 2 : dy === 1 ? 3 : 0;

  function blankMaze() {
    const m = [];
    for (let r = 0; r < ROWS; r++) {
      const row = [];
      for (let c = 0; c < COLS; c++) row.push(Number(LEVEL[r][c]));
      m.push(row);
    }
    return m;
  }
  function countPellets(maze) {
    let n = 0;
    for (const row of maze) for (const v of row) if (v === PELLET || v === POWER) n++;
    return n;
  }

  // ── Ghost AI: greedy toward the nearest athlete, away from everyone when
  // frightened. One tile of lookahead is enough for a relayed ghost. ──
  function ghostTarget(g, w) {
    if (g.state === 'eyes') return HOUSE;
    if (inHouse(g.cx, g.cy)) return EXIT;   // walk out first — the room is open, so greedy pathing would circle inside it
    const fear = w.fear > 0;
    let best = null, bd = 0;
    for (const id in w.players) {
      const p = w.players[id];
      if (!p.alive) continue;
      const d = Math.abs(p.x - g.cx) + Math.abs(p.y - g.cy);
      if (!best || (fear ? d > bd : d < bd)) { best = p; bd = d; }
    }
    return best || HOUSE;
  }
  function chooseGhost(g, w) {
    const t = ghostTarget(g, w);
    // Hunters never re-enter the house; a ghost already inside is allowed out.
    const home = inHouse(g.cx, g.cy);
    const opts = DIRS.filter(d => {
      const nx = g.cx + d.x, ny = g.cy + d.y;
      if (wallAt(w.maze, nx, ny)) return false;
      return g.state === 'eyes' || home || !inHouse(nx, ny);
    });
    const fwd = opts.filter(d => !(d.x === -g.vx && d.y === -g.vy));
    const list = fwd.length ? fwd : opts;
    if (!list.length) { g.tx = g.cx; g.ty = g.cy; g.vx = 0; g.vy = 0; return; }
    const away = w.fear > 0 && g.state !== 'eyes';
    let best = list[0], bd = away ? -1 : Infinity;
    for (const d of list) {
      const dd = Math.abs(g.cx + d.x - t.x) + Math.abs(g.cy + d.y - t.y);
      if (away ? dd > bd : dd < bd) { bd = dd; best = d; }
    }
    g.vx = best.x; g.vy = best.y;
    g.tx = g.cx + best.x;
    g.ty = g.cy + best.y;
  }
  // Ghosts travel tile-centre to tile-centre with a 0..1 progress value, so a
  // 100 ms tick can never tunnel them through a wall.
  function stepGhost(g, w, dt) {
    if (g.freeze > 0) {
      g.freeze -= dt;
      if (g.freeze <= 0) {
        g.freeze = 0; g.state = 'hunt';
        g.cx = HOUSE.x; g.cy = HOUSE.y; g.x = g.cx; g.y = g.cy;
        g.k = 0; g.vx = 0; g.vy = -1;
        chooseGhost(g, w);
        g.x = g.cx + (g.tx - g.cx) * g.k;
        g.y = g.cy + (g.ty - g.cy) * g.k;
      }
      return;
    }
    const speed = g.state === 'eyes' ? EYES_SPEED : (w.fear > 0 ? FEAR_SPEED : GHOST_SPEED);
    g.k += speed * dt;
    while (g.k >= 1) {
      g.k -= 1;
      g.cx = g.tx; g.cy = g.ty;
      if (g.state === 'eyes' && g.cx === HOUSE.x && g.cy === HOUSE.y) {
        g.state = 'hunt'; g.freeze = FREEZE_SEC; g.k = 0;
        g.x = g.cx; g.y = g.cy;
        return;
      }
      chooseGhost(g, w);
      if (g.tx === g.cx && g.ty === g.cy) { g.k = 0; break; }
    }
    g.x = g.cx + (g.tx - g.cx) * g.k;
    g.y = g.cy + (g.ty - g.cy) * g.k;
  }

  function createWorld(entries) {
    const maze = blankMaze();
    const w = {
      maze, total: countPellets(maze), left: 0, round: 0, fear: 0, t: 0,
      ghosts: [], players: {}, eaten: [], deaths: []
    };
    w.left = w.total;
    for (const e of entries) {
      const s = SPAWNS[(Number(e.spawn) || 0) % SPAWNS.length];
      w.players[e.id] = {
        id: e.id, x: s.x, y: s.y, dx: 0, dy: 0,
        lives: LIVES, sc: 0, alive: true, inv: INV_SEC, cd: 0, spawn: s
      };
    }
    for (const s of GHOST_SPAWNS) {
      const g = { cx: s.x, cy: s.y, tx: s.x, ty: s.y, x: s.x, y: s.y, k: 0, vx: s.dx, vy: s.dy, state: 'hunt', freeze: 0 };
      w.ghosts.push(g);
      chooseGhost(g, w);
      g.x = g.cx + (g.tx - g.cx) * g.k;
      g.y = g.cy + (g.ty - g.cy) * g.k;
    }
    return w;
  }

  function eat(w, p) {
    const cx = Math.round(p.x), cy = Math.round(p.y);
    const v = w.maze[cy][cx];
    if (v !== PELLET && v !== POWER) return;
    w.maze[cy][cx] = 0;
    w.left--;
    p.sc += v === POWER ? POWER_PTS : PELLET_PTS;
    if (v === POWER) w.fear = FEAR_SEC;
    w.eaten.push(cy * COLS + cx);
    if (w.left <= 0) { w.maze = blankMaze(); w.left = w.total; w.round++; }
  }

  // A client reports where it is and which way it looks; the hub scores the
  // pellet under it so every screen loses the same dot.
  function touch(w, id, x, y, dIdx) {
    const p = w.players[id];
    if (!p || !p.alive) return;
    const nx = clamp(Math.round(Number(x) * 100) / 100, 0, COLS - 1);
    const ny = clamp(Math.round(Number(y) * 100) / 100, 0, ROWS - 1);
    if (!isFinite(nx) || !isFinite(ny)) return;
    if (wallAt(w.maze, Math.round(nx), Math.round(ny))) return; // never trust a position inside a wall
    p.x = nx; p.y = ny;
    const d = DIRS[(Number(dIdx) | 0) % 4] || DIRS[0];
    p.dx = d.x; p.dy = d.y;
    eat(w, p);
  }

  function hurt(w, p, by) {
    p.lives = Math.max(0, p.lives - 1);
    w.deaths.push({ id: p.id, by: by ? by.id : null, lives: p.lives });
    p.dx = 0; p.dy = 0;
    if (p.lives <= 0) { p.alive = false; return; }
    p.x = p.spawn.x; p.y = p.spawn.y;
    p.inv = INV_SEC; p.cd = 0;
  }

  function step(w, dt) {
    w.t += dt;
    if (w.fear > 0) w.fear = Math.max(0, w.fear - dt);

    const live = [];
    for (const id in w.players) {
      const p = w.players[id];
      if (p.inv > 0) p.inv -= dt;
      if (p.cd > 0) p.cd -= dt;
      if (p.alive) live.push(p);
    }

    for (const g of w.ghosts) stepGhost(g, w, dt);

    // Ghost contact — a power pellet flips the table for a few seconds.
    for (const g of w.ghosts) {
      if (g.state === 'eyes' || g.freeze > 0) continue;
      for (const p of live) {
        if (!p.alive || p.inv > 0) continue;
        const dx = g.x - p.x, dy = g.y - p.y;
        if (dx * dx + dy * dy > HIT_R * HIT_R) continue;
        if (w.fear > 0) {
          p.sc += GHOST_PTS;
          g.state = 'eyes';
          chooseGhost(g, w);
        } else {
          hurt(w, p, null);
        }
      }
    }

    // Behind touch — a takes a life from b when a is at b's back and running at it.
    for (const a of live) {
      if (!a.alive) continue;
      for (const b of live) {
        if (a === b || !a.alive || !b.alive) continue;
        if (a.cd > 0 || b.inv > 0) continue;
        if (!b.dx && !b.dy) continue;                 // nothing to hit from behind
        const dx = a.x - b.x, dy = a.y - b.y;
        if (dx * dx + dy * dy > BACK_R * BACK_R) continue;
        if (dx * b.dx + dy * b.dy >= -0.05) continue;  // a is not behind b
        if (-dx * a.dx - dy * a.dy <= 0.05) continue;  // a is not running at b
        a.cd = HUNT_CD;
        a.sc += KILL_PTS;
        hurt(w, b, a);
      }
    }
  }

  function over(w) {
    if (Object.keys(w.players).length < 2 || w.t < 2) return false;
    let n = 0;
    for (const id in w.players) if (w.players[id].alive) n++;
    return n <= 1;
  }

  // Snapshot for the wire: positions in hundredths of a tile, plus the pellet
  // and death deltas since the previous snapshot (the queues are drained here).
  function snapshot(w) {
    const p = [], g = [];
    for (const id in w.players) {
      const pl = w.players[id];
      p.push([pl.id, Math.round(pl.x * 100), Math.round(pl.y * 100), dirOf(pl.dx, pl.dy), pl.lives, Math.floor(pl.sc), pl.alive ? 1 : 0]);
    }
    for (const gh of w.ghosts) {
      g.push([Math.round(gh.x * 100), Math.round(gh.y * 100), gh.state === 'eyes' ? 2 : (w.fear > 0 ? 1 : 0)]);
    }
    const msg = {
      t: 'pm_sync', p, g,
      e: w.eaten.slice(), d: w.deaths.slice(),
      fear: Math.round(w.fear * 10) / 10, round: w.round, left: w.left
    };
    w.eaten.length = 0;
    w.deaths.length = 0;
    return msg;
  }

  return {
    COLS, ROWS, WALL, PELLET, POWER, LEVEL, SPAWNS, LIVES,
    PELLET_PTS, POWER_PTS, GHOST_PTS, KILL_PTS,
    blankMaze, createWorld, touch, step, over, snapshot
  };
});
