// ═══════════════════════════════════════════════════════════
// OFFCOMFRT Pac-Man — Core Game Logic
// Restructured: CONFIG-driven, progressive difficulty,
// frightened mode, ghost spawning, high score tracking
// ═══════════════════════════════════════════════════════════
(() => {
  'use strict';

  // ═══════════════════════════════════════════════════════
  // 1. CONFIG — All tunable values in one place
  // ═══════════════════════════════════════════════════════
  const CONFIG = {
    // Board
    COLS: 28,
    ROWS: 31,
    TILE: 20,
    get GW() { return this.COLS * this.TILE; },  // 560
    get GH() { return this.ROWS * this.TILE; },  // 620

    // Pac-Man
    pacSpeed: 8,        // tiles per second
    maxLives: 3,

    // Scoring
    pelletScore: 10,
    powerScore: 50,
    ghostEatBase: 200,  // 200, 400, 800, 1600 combo

    // Ghost spawning
    initialGhosts: 4,
    maxGhosts: 7,
    ghostSpawnInterval: 25,  // seconds between new ghosts
    ghostExitTime: 1.0,      // seconds for new ghost to exit house

    // Frightened mode
    frightenedDurations: [8, 7, 6, 5, 4, 4, 3, 3],  // per difficulty level
    frightenedSpeedMult: 0.6,   // ghost speed multiplier when frightened
    eyesSpeedMult: 2.0,         // eyes-only ghost speed multiplier

    // Ghost house (center of maze)
    ghostHouseX: 13,
    ghostHouseY: 14,

    // Ghost AI
    thinkInterval: 0.35,  // seconds between direction reconsideration
    scatterInterval: 5,   // seconds before scatter/chase toggle
    frightenedThinkInterval: 0.2,  // faster direction changes when frightened

    // Difficulty tiers (8 levels, every 15s)
    // All ghost speeds capped below pacSpeed (8) so Pac-Man is always faster
    difficulty: [
      { speed: 4.5, chase: 0.50, proximity: 4  },   // Lv1: 0-15s
      { speed: 5.0, chase: 0.58, proximity: 5  },   // Lv2: 15-30s
      { speed: 5.5, chase: 0.65, proximity: 6  },   // Lv3: 30-45s
      { speed: 6.0, chase: 0.72, proximity: 7  },   // Lv4: 45-60s
      { speed: 6.5, chase: 0.78, proximity: 8  },   // Lv5: 60-75s
      { speed: 7.0, chase: 0.84, proximity: 9  },   // Lv6: 75-90s
      { speed: 7.2, chase: 0.90, proximity: 10 },   // Lv7: 90-105s
      { speed: 7.5, chase: 0.95, proximity: 12 },   // Lv8: 105s+
    ],
    difficultyInterval: 15,  // seconds per level

    // Bonus fruit
    bonusPelletThresholds: [50, 150, 250],  // pellets remaining triggers
    bonusScores: [100, 300, 500],
    bonusDuration: 10,  // seconds fruit stays on map

    // High score
    highScoreKey: 'pacman_highscore',

    // Score popups
    maxPopups: 5,
    popupDuration: 1.0,  // seconds
    popupRise: 30,       // pixels to rise
  };

  // ═══════════════════════════════════════════════════════
  // 2. DOM refs and state variables
  // ═══════════════════════════════════════════════════════
  const $ = id => document.getElementById(id);
  const canvas = $('gameCanvas');
  const ctx = canvas.getContext('2d');
  const screens = document.querySelectorAll('.screen');

  // Game state
  let mode = 'menu';       // menu | lobby | countdown | playing | paused | gameover
  let gameMode = 'single'; // single | online
  let animId = null;
  let lastTime = 0;
  let gameTime = 0;        // elapsed seconds since play started
  let hintTimer = 0;

  // Game objects
  let map = [];
  let pelletsRemaining = 0;
  let totalPellets = 0;
  let pacman, ghosts;
  let score, lives, gameOver;

  // Frightened mode
  let frightenedTimer = 0;   // seconds remaining
  let ghostEatCombo = 0;     // combo multiplier for current frightened window

  // Ghost spawning
  let nextGhostIndex = CONFIG.initialGhosts;
  let ghostSpawnTimer = 0;

  // Bonus fruit
  let bonusFruit = null;     // { x, y, value, timer, thresholdIndex }
  let bonusThresholdIdx = 0;

  // Score popups
  let popups = [];           // [{x, y, text, alpha, age}]

  // High score
  let highScore = 0;
  let highScoreFlash = 0;    // seconds remaining for "NEW BEST!" flash

  // Online multiplayer state — the hub owns the board; these are its snapshots.
  let onlinePlayers = [];      // [{id, name, x, y, dir, lives, score, alive}]
  let onlineGhosts = [];       // [{x, y, state: 0 hunt / 1 frightened / 2 eyes}]
  let onlineNames = {};        // id -> athlete name from the match roster
  let onlineSkins = {};        // id -> rival skin (the corner the hub handed out)
  let onlineSpawn = { x: 1, y: 29 };
  let onlineRound = 0;
  let onlineResult = null;     // { rank, total, won } once the hub ends the match
  let onlineEliminated = false;
  let lastFacing = 0;          // 0 right, 1 left, 2 up, 3 down

  // Cached assets
  let wallCanvas = null;
  let bgGrad = null;
  // Logical board units -> canvas device pixels (set by resizeCanvas)
  let viewScale = 1;

  // HUD cache (skip DOM writes when unchanged)
  let _hudScore = -1, _hudLives = -1, _hudPellets = -1;
  let _hudDiff = -1, _hudGhosts = -1, _hudHighScore = -1;

  // ═══════════════════════════════════════════════════════
  // 3. Maze data and helpers
  // ═══════════════════════════════════════════════════════
  // 0=empty, 1=wall, 2=pellet, 3=power pellet — the grid itself lives in
  // ../pacman-sim.js, shared with the hub, so an online room can never end up
  // with two disagreeing boards.
  const LEVEL = window.PacmanSim.LEVEL;

  function isWall(col, row) {
    if (row < 0 || row >= CONFIG.ROWS || col < 0 || col >= CONFIG.COLS) return true;
    return map[row][col] === 1;
  }

  // ═══════════════════════════════════════════════════════
  // 4. Ghost spawn table
  // ═══════════════════════════════════════════════════════
  const GHOST_SPAWNS = [
    { x: 12, y: 13, personality: 0 },   // Blinky: direct chaser (immediate)
    { x: 3,  y: 1,  personality: 1 },   // Pinky: interceptor (immediate)
    { x: 24, y: 1,  personality: 2 },   // Inky: flanker (immediate)
    { x: 3,  y: 27, personality: 3 },   // Clyde: unpredictable (immediate)
    { x: 13, y: 14, personality: 4 },   // Shadow: adaptive (25s)
    { x: 14, y: 14, personality: 0 },   // Blinky clone (50s)
    { x: 13, y: 13, personality: 1 },   // Pinky clone (75s)
  ];

  function createGhost(spawn) {
    return {
      x: spawn.x,
      y: spawn.y,
      dirX: 0,
      dirY: -1,  // start moving upward (exiting)
      thinkTimer: 0,
      personality: spawn.personality,
      state: 'exiting',    // active | frightened | eyes | exiting
      exitTimer: CONFIG.ghostExitTime,
      mode: 'scatter',     // scatter | chase (AI behavior mode)
      modeTimer: 0,        // seconds spent in current mode
    };
  }

  // ═══════════════════════════════════════════════════════
  // 5. High score helpers
  // ═══════════════════════════════════════════════════════
  function loadHighScore() {
    try {
      const val = localStorage.getItem(CONFIG.highScoreKey);
      return val ? parseInt(val, 10) || 0 : 0;
    } catch (e) { return 0; }
  }

  function saveHighScore(n) {
    try { localStorage.setItem(CONFIG.highScoreKey, String(n)); } catch (e) {}
  }

  function checkHighScore(n) {
    const hs = loadHighScore();
    return { isNew: n > hs, highScore: Math.max(n, hs) };
  }

  // ═══════════════════════════════════════════════════════
  // 6. Init game / reset positions
  // ═══════════════════════════════════════════════════════
  function initGame() {
    // Build map from LEVEL
    map = [];
    pelletsRemaining = 0;
    for (let r = 0; r < CONFIG.ROWS; r++) {
      const row = [];
      for (let c = 0; c < CONFIG.COLS; c++) {
        const val = Number(LEVEL[r][c]);
        if (val === 2 || val === 3) pelletsRemaining++;
        row.push(val);
      }
      map.push(row);
    }
    totalPellets = pelletsRemaining;

    // Pac-Man — online every athlete owns a corner of the shared board
    const start = gameMode === 'online' ? onlineSpawn : { x: 1, y: 29 };
    pacman = { x: start.x, y: start.y, dirX: 0, dirY: 0, nextDirX: 0, nextDirY: 0 };

    // Initial ghosts
    ghosts = [];
    for (let i = 0; i < CONFIG.initialGhosts; i++) {
      const g = createGhost(GHOST_SPAWNS[i]);
      g.state = 'active';  // initial ghosts skip exiting
      g.mode = 'chase';    // initial ghosts start in chase mode
      g.dirX = i === 0 ? 1 : i === 1 ? 1 : i === 2 ? -1 : 1;
      g.dirY = i === 0 ? 0 : i === 1 ? 1 : i === 2 ? 1 : -1;
      ghosts.push(g);
    }

    // Reset state
    score = 0;
    lives = CONFIG.maxLives;
    gameOver = false;
    frightenedTimer = 0;
    ghostEatCombo = 0;
    nextGhostIndex = CONFIG.initialGhosts;
    ghostSpawnTimer = 0;
    bonusFruit = null;
    bonusThresholdIdx = 0;
    popups = [];
    highScore = loadHighScore();
    highScoreFlash = 0;

    // Reset HUD cache
    _hudScore = -1;
    _hudLives = -1;
    _hudPellets = -1;
    _hudDiff = -1;
    _hudGhosts = -1;
    _hudHighScore = -1;

    // Show high score on menu
    const menuHs = $('menuHighScore');
    if (menuHs) menuHs.textContent = highScore > 0 ? 'Best: ' + highScore : '';
  }

  function resetPositions() {
    // Reset Pac-Man position
    pacman.x = 1; pacman.y = 29;
    pacman.dirX = 0; pacman.dirY = 0;
    pacman.nextDirX = 0; pacman.nextDirY = 0;

    // Reset ghost positions
    for (let i = 0; i < ghosts.length; i++) {
      const spawn = GHOST_SPAWNS[i];
      ghosts[i].x = spawn.x;
      ghosts[i].y = spawn.y;
      ghosts[i].dirX = 0;
      ghosts[i].dirY = -1;
      ghosts[i].thinkTimer = 0;
      ghosts[i].state = 'active';
      ghosts[i].mode = 'chase';
      ghosts[i].modeTimer = 0;
    }
    frightenedTimer = 0;
    ghostEatCombo = 0;
  }

  // ═══════════════════════════════════════════════════════
  // 7. Input handling
  // ═══════════════════════════════════════════════════════
  const keys = {};
  document.addEventListener('keydown', e => {
    keys[e.key] = true;
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) e.preventDefault();
    // Desktop shortcut for the on-screen pause chip
    if ((e.key === 'p' || e.key === 'P' || e.key === 'Escape') && (mode === 'playing' || mode === 'paused')) togglePause();
  });
  document.addEventListener('keyup', e => { keys[e.key] = false; });

  function handleKeyboard() {
    let dx = 0, dy = 0;
    if (keys['ArrowUp'] || keys['w'] || keys['W']) { dx = 0; dy = -1; }
    else if (keys['ArrowDown'] || keys['s'] || keys['S']) { dx = 0; dy = 1; }
    else if (keys['ArrowLeft'] || keys['a'] || keys['A']) { dx = -1; dy = 0; }
    else if (keys['ArrowRight'] || keys['d'] || keys['D']) { dx = 1; dy = 0; }
    if (dx !== 0 || dy !== 0) {
      pacman.nextDirX = dx;
      pacman.nextDirY = dy;
    }
  }

  function setDpadDir(dx, dy) {
    pacman.nextDirX = dx;
    pacman.nextDirY = dy;
  }

  // Wire D-pad buttons
  document.addEventListener('DOMContentLoaded', () => {
    const bind = (id, dx, dy) => {
      const btn = $(id);
      if (!btn) return;
      const start = e => { e.preventDefault(); setDpadDir(dx, dy); };
      const end = e => { e.preventDefault(); };
      btn.addEventListener('touchstart', start, { passive: false });
      btn.addEventListener('mousedown', start);
      btn.addEventListener('touchend', end, { passive: false });
      btn.addEventListener('mouseup', end);
      btn.addEventListener('mouseleave', end);
    };
    bind('dpadUp', 0, -1);
    bind('dpadDown', 0, 1);
    bind('dpadLeft', -1, 0);
    bind('dpadRight', 1, 0);
  });

  // Swipe on canvas
  let swipeStartX = 0, swipeStartY = 0, swiping = false;
  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    const t = e.touches[0];
    swipeStartX = t.clientX;
    swipeStartY = t.clientY;
    swiping = true;
  }, { passive: false });
  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    if (!swiping) return;
    const t = e.touches[0];
    const dx = t.clientX - swipeStartX;
    const dy = t.clientY - swipeStartY;
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    if (Math.abs(dx) > Math.abs(dy)) setDpadDir(dx > 0 ? 1 : -1, 0);
    else setDpadDir(0, dy > 0 ? 1 : -1);
    swiping = false;
  }, { passive: false });
  canvas.addEventListener('touchend', () => { swiping = false; });

  // ═══════════════════════════════════════════════════════
  // 8. Pac-Man movement and pellet eating
  // ═══════════════════════════════════════════════════════
  function handleInput() {
    const centerCol = Math.round(pacman.x);
    const centerRow = Math.round(pacman.y);
    const offsetX = Math.abs(pacman.x - centerCol);
    const offsetY = Math.abs(pacman.y - centerRow);
    const aligned = offsetX < 0.35 && offsetY < 0.35;
    const stopped = pacman.dirX === 0 && pacman.dirY === 0;

    if (aligned || stopped) {
      const targetCol = centerCol + pacman.nextDirX;
      const targetRow = centerRow + pacman.nextDirY;
      if (!isWall(targetCol, targetRow)) {
        pacman.dirX = pacman.nextDirX;
        pacman.dirY = pacman.nextDirY;
      }
    }
  }

  function movePacman(dt) {
    handleKeyboard();
    handleInput();

    const speedPerFrame = CONFIG.pacSpeed * dt;
    let newX = pacman.x + pacman.dirX * speedPerFrame;
    let newY = pacman.y + pacman.dirY * speedPerFrame;

    // Tunnel wrap
    if (newX < 0) newX = CONFIG.COLS - 1;
    if (newX > CONFIG.COLS - 1) newX = 0;

    const nextCol = Math.round(newX);
    const nextRow = Math.round(newY);

    if (isWall(nextCol, nextRow)) {
      const dx = pacman.dirX;
      const dy = pacman.dirY;
      pacman.dirX = 0;
      pacman.dirY = 0;
      pacman.x = nextCol - dx;
      pacman.y = nextRow - dy;
      return;
    }

    pacman.x = newX;
    pacman.y = newY;

    // Online the hub owns the pellet grid: it scores the dot under my tile and
    // the removal comes back with the snapshot, so every screen loses the same
    // dot. Local eating here would desync the boards.
    if (gameMode === 'online') return;

    // Eat pellets
    const col = Math.round(pacman.x);
    const row = Math.round(pacman.y);
    if (map[row] && (map[row][col] === 2 || map[row][col] === 3)) {
      const isPower = map[row][col] === 3;
      score += isPower ? CONFIG.powerScore : CONFIG.pelletScore;
      map[row][col] = 0;
      pelletsRemaining--;

      // Trigger frightened mode on power pellet
      if (isPower) {
        const duration = CONFIG.frightenedDurations[getDifficultyLevel()] || 3;
        frightenedTimer = duration;
        ghostEatCombo = 0;
        // Reverse all active ghosts
        for (const g of ghosts) {
          if (g.state === 'active') {
            g.state = 'frightened';
            g.dirX = -g.dirX;
            g.dirY = -g.dirY;
          }
        }
      }

      // Check bonus fruit spawn
      checkBonusFruitSpawn();

      // Check high score mid-game
      if (score > highScore) {
        highScore = score;
        saveHighScore(score);
        highScoreFlash = 2.0;  // flash "NEW BEST!" for 2 seconds
      }

      updateHUD();

      if (pelletsRemaining <= 0) gameOver = true;
    }
  }

  // ═══════════════════════════════════════════════════════
  // 9. Ghost AI
  // ═══════════════════════════════════════════════════════
  function getDifficultyLevel() {
    const idx = Math.floor((gameTime || 0) / CONFIG.difficultyInterval);
    return Math.min(Math.max(idx, 0), CONFIG.difficulty.length - 1);
  }

  function getDiff() {
    const level = getDifficultyLevel();
    return CONFIG.difficulty[level] || CONFIG.difficulty[0];  // fallback to Lv1
  }

  function getValidDirs(ghost) {
    const dirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
    const oppX = -ghost.dirX, oppY = -ghost.dirY;
    return dirs.filter(d => {
      if (d.x === oppX && d.y === oppY) return false;
      const tc = Math.round(ghost.x) + d.x;
      const tr = Math.round(ghost.y) + d.y;
      return !isWall(tc, tr);
    });
  }

  // Get target position based on ghost personality (with randomness)
  function getGhostTarget(ghost) {
    const p = ghost.personality;
    const dist = Math.abs(Math.round(ghost.x) - Math.round(pacman.x)) +
                 Math.abs(Math.round(ghost.y) - Math.round(pacman.y));

    let targetX = pacman.x;
    let targetY = pacman.y;

    if (p === 0) {
      // Blinky: direct chase with slight noise
      targetX = pacman.x + (Math.random() - 0.5) * 2;
      targetY = pacman.y + (Math.random() - 0.5) * 2;
    } else if (p === 1) {
      // Pinky: intercept 3 tiles ahead (reduced from 4) + noise
      targetX = pacman.x + pacman.nextDirX * 3 + (Math.random() - 0.5) * 2;
      targetY = pacman.y + pacman.nextDirY * 3 + (Math.random() - 0.5) * 2;
    } else if (p === 2) {
      // Inky: flanker — vector from ghost through Pac-Man, more noise
      targetX = pacman.x + (pacman.x - Math.round(ghost.x)) * 0.5 + (Math.random() - 0.5) * 6;
      targetY = pacman.y + (pacman.y - Math.round(ghost.y)) * 0.5 + (Math.random() - 0.5) * 6;
    } else if (p === 3) {
      // Clyde: chase when far, scatter to corner when close (< 6 tiles)
      if (dist < 6) {
        targetX = 1; targetY = 1;  // scatter to top-left
      } else {
        targetX = pacman.x + (Math.random() - 0.5) * 3;
        targetY = pacman.y + (Math.random() - 0.5) * 3;
      }
    } else if (p === 4) {
      // Shadow: adaptive — direct when far, intercept when medium, scatter when close
      if (dist > 6) {
        targetX = pacman.x + (Math.random() - 0.5) * 4;
        targetY = pacman.y + (Math.random() - 0.5) * 4;
      } else if (dist >= 3) {
        targetX = pacman.x + pacman.nextDirX * 3 + (Math.random() - 0.5) * 4;
        targetY = pacman.y + pacman.nextDirY * 3 + (Math.random() - 0.5) * 4;
      } else {
        // Close: 40% scatter, 60% chase
        if (Math.random() < 0.4) {
          const corners = [[1,1],[CONFIG.COLS-2,1],[1,CONFIG.ROWS-2],[CONFIG.COLS-2,CONFIG.ROWS-2]];
          const c = corners[Math.floor(Math.random() * corners.length)];
          targetX = c[0]; targetY = c[1];
        }
      }
    }

    return { x: targetX, y: targetY };
  }

  function chooseDirection(ghost, validDirs) {
    const diff = getDiff();
    const distToPac = Math.abs(Math.round(ghost.x) - Math.round(pacman.x)) +
                      Math.abs(Math.round(ghost.y) - Math.round(pacman.y));

    // Proximity trigger: auto-switch to chase if Pac-Man is close
    if (ghost.mode === 'scatter' && distToPac <= diff.proximity) {
      ghost.mode = 'chase';
    }

    // --- SCATTER: pure random wander ---
    if (ghost.mode === 'scatter') {
      const choice = validDirs[Math.floor(Math.random() * validDirs.length)];
      ghost.dirX = choice.x;
      ghost.dirY = choice.y;
      return;
    }

    // --- CHASE: personality-based targeting with randomness ---
    const target = getGhostTarget(ghost);
    const p = ghost.personality;
    let best = null, bestDist = Infinity;

    for (const d of validDirs) {
      const tc = Math.round(ghost.x) + d.x;
      const tr = Math.round(ghost.y) + d.y;
      const dist = Math.abs(tc - target.x) + Math.abs(tr - target.y);
      // Per-personality noise (keeps ghosts from converging into a line)
      const noise = p === 2 ? (Math.random() - 0.5) * 6 :
                    p === 4 ? (Math.random() - 0.5) * 4 :
                    p === 3 ? (Math.random() - 0.5) * 3 :
                    (Math.random() - 0.5) * 2;
      if (dist + noise < bestDist) { bestDist = dist + noise; best = d; }
    }

    if (best) { ghost.dirX = best.x; ghost.dirY = best.y; }
  }

  function moveGhost(ghost, dt) {
    const diff = getDiff();

    // Determine speed based on state
    let speedMult = 1;
    if (ghost.state === 'frightened') speedMult = CONFIG.frightenedSpeedMult;
    else if (ghost.state === 'eyes') speedMult = CONFIG.eyesSpeedMult;

    const speed = diff.speed * speedMult * dt;

    // Eyes-only: navigate directly to ghost house
    if (ghost.state === 'eyes') {
      const hx = CONFIG.ghostHouseX;
      const hy = CONFIG.ghostHouseY;
      const dx = hx - ghost.x;
      const dy = hy - ghost.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < 0.5) {
        // Reached home — respawn
        ghost.state = 'active';
        ghost.x = hx;
        ghost.y = hy;
        ghost.dirX = 0;
        ghost.dirY = -1;
        ghost.thinkTimer = 0;
        return;
      }

      // Move toward home
      const nx = ghost.x + (dx / dist) * speed;
      const ny = ghost.y + (dy / dist) * speed;
      ghost.x = nx;
      ghost.y = ny;

      // Tunnel wrap
      if (ghost.x < 0) ghost.x = CONFIG.COLS - 1;
      if (ghost.x > CONFIG.COLS - 1) ghost.x = 0;
      return;
    }

    // Exiting state
    if (ghost.state === 'exiting') {
      ghost.exitTimer -= dt;
      ghost.y -= speed;  // move upward
      if (ghost.exitTimer <= 0 || isWall(Math.round(ghost.x), Math.round(ghost.y - 1))) {
        ghost.state = 'active';
        ghost.y = Math.max(ghost.y, 1);
        ghost.dirX = Math.random() < 0.5 ? 1 : -1;
        ghost.dirY = 0;
      }
      return;
    }

    // Frightened: random movement
    if (ghost.state === 'frightened') {
      const speed2 = diff.speed * CONFIG.frightenedSpeedMult * dt;
      let newX = ghost.x + ghost.dirX * speed2;
      let newY = ghost.y + ghost.dirY * speed2;

      const nextCol = Math.round(newX);
      const nextRow = Math.round(newY);

      if (isWall(nextCol, nextRow)) {
        const valid = getValidDirs(ghost);
        if (valid.length > 0) {
          const choice = valid[Math.floor(Math.random() * valid.length)];
          ghost.dirX = choice.x;
          ghost.dirY = choice.y;
        }
        return;
      }

      ghost.x = newX;
      ghost.y = newY;
      if (ghost.x < 0) ghost.x = CONFIG.COLS - 1;
      if (ghost.x > CONFIG.COLS - 1) ghost.x = 0;

      // Reconsider at tile center
      const atCenter = Math.abs(ghost.x - Math.round(ghost.x)) < 0.15 &&
                       Math.abs(ghost.y - Math.round(ghost.y)) < 0.15;
      if (atCenter) {
        ghost.thinkTimer += dt;
        if (ghost.thinkTimer >= CONFIG.frightenedThinkInterval) {
          ghost.thinkTimer = 0;
          const valid = getValidDirs(ghost);
          if (valid.length > 0) {
            const choice = valid[Math.floor(Math.random() * valid.length)];
            ghost.dirX = choice.x;
            ghost.dirY = choice.y;
          }
        }
      }
      return;
    }

    // Active: normal AI movement
    let newX = ghost.x + ghost.dirX * speed;
    let newY = ghost.y + ghost.dirY * speed;

    const nextCol = Math.round(newX);
    const nextRow = Math.round(newY);

    if (isWall(nextCol, nextRow)) {
      // Snap to current tile center to prevent overshooting
      ghost.x = Math.round(ghost.x);
      ghost.y = Math.round(ghost.y);
      ghost.dirX = 0;
      ghost.dirY = 0;
      // Pick a new direction from this tile
      const valid = getValidDirs(ghost);
      if (valid.length > 0) chooseDirection(ghost, valid);
      return;
    }

    ghost.x = newX;
    ghost.y = newY;

    // Tunnel wrap
    if (ghost.x < 0) ghost.x = CONFIG.COLS - 1;
    if (ghost.x > CONFIG.COLS - 1) ghost.x = 0;

    // Intersection logic: at tile center, reconsider direction
    const atCenter = Math.abs(ghost.x - Math.round(ghost.x)) < 0.15 &&
                     Math.abs(ghost.y - Math.round(ghost.y)) < 0.15;
    if (atCenter) {
      ghost.thinkTimer += dt;
      if (ghost.thinkTimer >= CONFIG.thinkInterval) {
        ghost.thinkTimer = 0;

        // Toggle scatter/chase mode on interval
        ghost.modeTimer += CONFIG.thinkInterval;
        if (ghost.modeTimer >= CONFIG.scatterInterval) {
          ghost.modeTimer = 0;
          ghost.mode = ghost.mode === 'scatter' ? 'chase' : 'scatter';
        }

        const valid = getValidDirs(ghost);
        if (valid.length >= 2) chooseDirection(ghost, valid);
      }
    } else {
      ghost.thinkTimer = 0;
    }
  }

  // ═══════════════════════════════════════════════════════
  // 10. Collision detection
  // ═══════════════════════════════════════════════════════
  function checkCollisions() {
    for (const ghost of ghosts) {
      if (ghost.state === 'eyes' || ghost.state === 'exiting') continue;

      const dx = ghost.x - pacman.x;
      const dy = ghost.y - pacman.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < 0.7) {
        if (ghost.state === 'frightened') {
          // Eat the ghost
          ghostEatCombo++;
          const points = CONFIG.ghostEatBase * Math.pow(2, ghostEatCombo - 1);
          score += points;
          ghost.state = 'eyes';

          // Score popup
          addPopup(ghost.x, ghost.y, '+' + points);

          // Check high score
          if (score > highScore) {
            highScore = score;
            saveHighScore(score);
            highScoreFlash = 2.0;
          }

          updateHUD();
        } else {
          // Pac-Man loses a life
          lives--;
          updateHUD();
          if (lives <= 0) {
            gameOver = true;
          } else {
            resetPositions();
          }
          break;
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════
  // 11. Score popups
  // ═══════════════════════════════════════════════════════
  function addPopup(x, y, text) {
    if (popups.length >= CONFIG.maxPopups) popups.shift();
    popups.push({ x, y, text, alpha: 1, age: 0 });
  }

  function updatePopups(dt) {
    for (let i = popups.length - 1; i >= 0; i--) {
      const p = popups[i];
      p.age += dt;
      p.alpha = 1 - (p.age / CONFIG.popupDuration);
      p.y -= (CONFIG.popupRise / CONFIG.popupDuration) * dt / CONFIG.TILE;
      if (p.age >= CONFIG.popupDuration) popups.splice(i, 1);
    }
  }

  // ═══════════════════════════════════════════════════════
  // 12. Bonus fruit
  // ═══════════════════════════════════════════════════════
  function checkBonusFruitSpawn() {
    if (bonusFruit) return;  // one at a time
    if (bonusThresholdIdx >= CONFIG.bonusPelletThresholds.length) return;

    const threshold = CONFIG.bonusPelletThresholds[bonusThresholdIdx];
    if (pelletsRemaining <= threshold) {
      bonusFruit = {
        x: CONFIG.ghostHouseX,
        y: 16,  // below ghost house
        value: CONFIG.bonusScores[bonusThresholdIdx],
        timer: CONFIG.bonusDuration,
        thresholdIndex: bonusThresholdIdx,
      };
      bonusThresholdIdx++;
    }
  }

  function updateBonusFruit(dt) {
    if (!bonusFruit) return;

    bonusFruit.timer -= dt;
    if (bonusFruit.timer <= 0) {
      bonusFruit = null;
      return;
    }

    // Check if Pac-Man eats it
    const dx = bonusFruit.x - pacman.x;
    const dy = bonusFruit.y - pacman.y;
    if (Math.sqrt(dx * dx + dy * dy) < 0.8) {
      score += bonusFruit.value;
      addPopup(bonusFruit.x, bonusFruit.y, '+' + bonusFruit.value);

      // Check high score
      if (score > highScore) {
        highScore = score;
        saveHighScore(score);
        highScoreFlash = 2.0;
      }

      bonusFruit = null;
      updateHUD();
    }
  }

  // ═══════════════════════════════════════════════════════
  // 13. Rendering
  // ═══════════════════════════════════════════════════════
  function buildCachedAssets() {
    // Background gradient
    const bg = ctx.createRadialGradient(CONFIG.GW / 2, CONFIG.GH / 2, 0, CONFIG.GW / 2, CONFIG.GH / 2, CONFIG.GW * 0.7);
    bg.addColorStop(0, '#111');
    bg.addColorStop(1, '#000');
    bgGrad = bg;

    // Pre-render walls at 2x so they stay crisp when the board is scaled up on
    // a retina phone or on a full-height desktop window.
    const SS = 2;
    const wc = document.createElement('canvas');
    wc.width = CONFIG.GW * SS;
    wc.height = CONFIG.GH * SS;
    const wx = wc.getContext('2d');
    wx.scale(SS, SS);
    for (let r = 0; r < CONFIG.ROWS; r++) {
      for (let c = 0; c < CONFIG.COLS; c++) {
        if (LEVEL[r][c] === '1') {
          const x = c * CONFIG.TILE;
          const y = r * CONFIG.TILE;
          wx.fillStyle = '#444';
          wx.fillRect(x, y, CONFIG.TILE, CONFIG.TILE);
          wx.strokeStyle = '#666';
          wx.lineWidth = 1;
          wx.strokeRect(x + 0.5, y + 0.5, CONFIG.TILE - 1, CONFIG.TILE - 1);
        }
      }
    }
    wallCanvas = wc;
  }
  buildCachedAssets();

  function render() {
    // Everything below draws in the 560x620 logical board; this transform maps
    // it onto the fitted, device-pixel-sized backing store, so the maze is sharp
    // on a 3x phone instead of a stretched 560px bitmap.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(viewScale, 0, 0, viewScale, 0, 0);

    // Background
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, CONFIG.GW, CONFIG.GH);

    // Walls
    ctx.drawImage(wallCanvas, 0, 0, CONFIG.GW, CONFIG.GH);

    // Ghost house door — centered in the middle section opening (cols 10-16, row 13)
    ctx.fillStyle = '#888';
    ctx.fillRect(11.5 * CONFIG.TILE, 15 * CONFIG.TILE - 7, 4 * CONFIG.TILE, 3);

    // Pellets
    const pulse = 0.7 + 0.3 * Math.sin(gameTime * 4);
    for (let r = 0; r < CONFIG.ROWS; r++) {
      for (let c = 0; c < CONFIG.COLS; c++) {
        const val = map[r][c];
        const cx = c * CONFIG.TILE + CONFIG.TILE / 2;
        const cy = r * CONFIG.TILE + CONFIG.TILE / 2;
        if (val === 2) {
          ctx.fillStyle = '#ccc';
          ctx.beginPath();
          ctx.arc(cx, cy, 3, 0, Math.PI * 2);
          ctx.fill();
        } else if (val === 3) {
          ctx.fillStyle = 'rgba(255,255,255,' + pulse * 0.25 + ')';
          ctx.beginPath();
          ctx.arc(cx, cy, 8, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,' + pulse + ')';
          ctx.beginPath();
          ctx.arc(cx, cy, 5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Bonus fruit
    if (bonusFruit) drawBonusFruit();

    // Ghosts — online they are the room's four, simulated by the hub
    if (gameMode === 'online') {
      for (const g of onlineGhosts) drawSyncedGhost(g);
    } else {
      for (const ghost of ghosts) drawGhost(ghost);
    }

    // Pac-Man
    if (!(gameMode === 'online' && onlineEliminated)) drawPacman();

    // The other athletes on the same board
    if (gameMode === 'online') {
      for (let i = 0; i < onlinePlayers.length; i++) {
        const p = onlinePlayers[i];
        if (p.alive) drawOtherPacman(p, i);
      }
    }

    // Score popups
    drawPopups();
  }

  // ── Rivals: monochrome designs, never colour ─────────────────
  // The board carries no hue anywhere — Pac-Man is white, the ghosts are grey —
  // so a rival wearing one reads as a different game. All four rival skins stay
  // inside the same black/white/grey range and separate by silhouette, surface
  // detail and trim instead. The hub already hands every athlete its own corner
  // index, so a rival keeps the same design for the whole match.
  const OPP_SKINS = 4;
  // Four archetypes, one per corner. Silhouette differs first and surface detail
  // second: at one tile per athlete a rival has to be readable by outline alone
  // before any of the trim is legible.
  //   0 SAWBLADE — toothed cutting disc, bright edge
  //   1 MONARCH  — swept cape, sash, upright crown
  //   2 ORACLE   — one great eye, rim studs, orbiting satellite
  //   3 DRONE    — black hull, sensor visor, twin antennae
  const SKIN_SAW = 0, SKIN_MONARCH = 1, SKIN_ORACLE = 2, SKIN_DRONE = 3;

  function skinIndex(p, fallback) {
    const c = onlineSkins[p.id];
    return (typeof c === 'number' ? c : fallback) % OPP_SKINS;
  }

  // Bite silhouette in the local frame, mouth pointing down +x; every pattern
  // below clips to this path so nothing spills outside the body.
  function oppBodyPath(r, mouth) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r, mouth, Math.PI * 2 - mouth);
    ctx.closePath();
  }

  function oppRim(r, mouth, color, width) {
    oppBodyPath(r, mouth);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  // 0 · SAWBLADE — a ring of cutting teeth, machined hatch, rivets, hot edge.
  function oppSaw(r, mouth) {
    // Teeth first so the hull overlaps their roots. None may sit in the bite.
    ctx.strokeStyle = '#0a0a0a';
    ctx.lineWidth = 0.7;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      if (Math.abs(Math.atan2(Math.sin(a), Math.cos(a))) < mouth + 0.34) continue;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a - 0.2) * r * 0.88, Math.sin(a - 0.2) * r * 0.88);
      ctx.lineTo(Math.cos(a + 0.06) * r * 1.3, Math.sin(a + 0.06) * r * 1.3);
      ctx.lineTo(Math.cos(a + 0.2) * r * 0.88, Math.sin(a + 0.2) * r * 0.88);
      ctx.closePath();
      ctx.fillStyle = '#cfcfcf';
      ctx.fill();
      ctx.stroke();
    }

    oppBodyPath(r, mouth);
    ctx.fillStyle = '#f4f4f4';
    ctx.fill();

    ctx.save();
    oppBodyPath(r, mouth);
    ctx.clip();
    // Machined hatch.
    ctx.strokeStyle = 'rgba(10,10,10,0.16)';
    ctx.lineWidth = 1;
    for (let x = -r * 2; x <= r * 2; x += 3) {
      ctx.beginPath();
      ctx.moveTo(x, -r * 2);
      ctx.lineTo(x + r * 2, r * 2);
      ctx.stroke();
    }
    // Three cooling slots fanned across the tail.
    ctx.fillStyle = 'rgba(10,10,10,0.5)';
    for (let k = -1; k <= 1; k++) {
      ctx.save();
      ctx.rotate(k * 0.34);
      ctx.fillRect(-r * 0.95, -r * 0.06, r * 0.44, r * 0.12);
      ctx.restore();
    }
    // Rivet ring.
    ctx.fillStyle = 'rgba(10,10,10,0.45)';
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      if (Math.abs(Math.atan2(Math.sin(a), Math.cos(a))) < mouth + 0.2) continue;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * r * 0.72, Math.sin(a) * r * 0.72, 0.8, 0, Math.PI * 2);
      ctx.fill();
    }
    // Shaded tail.
    ctx.strokeStyle = 'rgba(10,10,10,0.28)';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.arc(0, 0, r - 1.5, Math.PI * 1.1, Math.PI * 1.9);
    ctx.stroke();
    ctx.restore();

    // Hot cutting edges flanking the bite — the brightest thing on the sprite.
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(0, 0, r - 1, mouth + 0.08, mouth + 1.45);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, r - 1, Math.PI * 2 - mouth - 1.45, Math.PI * 2 - mouth - 0.08);
    ctx.stroke();

    oppRim(r, mouth, '#ffffff', 1);
  }

  // 2 · ORACLE — one enormous almond eye under a heavy brow, with a lid that
  // blinks. No tick marks anywhere: the round shell is plain, so nothing here
  // can be read as a clock face.
  function oppOracle(r, mouth, idx) {
    oppBodyPath(r, mouth);
    ctx.fillStyle = '#e8e8e8';
    ctx.fill();

    ctx.save();
    oppBodyPath(r, mouth);
    ctx.clip();

    const ex = r * 0.24, ey = 0, rx = r * 0.6, ry = r * 0.46;

    // Dark socket first, so the white of the eye never floats on the shell.
    ctx.fillStyle = 'rgba(10,10,10,0.55)';
    ctx.beginPath();
    ctx.ellipse(ex, ey, rx + 1.6, ry + 1.6, 0, 0, Math.PI * 2);
    ctx.fill();

    // Sclera.
    ctx.fillStyle = '#fdfdfd';
    ctx.beginPath();
    ctx.ellipse(ex, ey, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(10,10,10,0.8)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Iris, pupil and specular glint, all pushed forward so the gaze leads.
    ctx.fillStyle = '#1c1c1c';
    ctx.beginPath();
    ctx.arc(ex + rx * 0.3, ey, ry * 0.62, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0a0a0a';
    ctx.beginPath();
    ctx.arc(ex + rx * 0.36, ey, ry * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(ex + rx * 0.18, ey - ry * 0.36, r * 0.1, 0, Math.PI * 2);
    ctx.fill();

    // Brow ridge — the expression, and the second thing that says "eye".
    ctx.strokeStyle = 'rgba(10,10,10,0.85)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(ex - rx * 0.6, ey - ry * 1.42);
    ctx.quadraticCurveTo(ex + rx * 0.3, ey - ry * 2.05, ex + rx * 1.05, ey - ry * 1.1);
    ctx.stroke();

    // The blink: a lid wipes down and back up every few seconds.
    const cycle = (gameTime + idx * 0.7) % 4;
    if (cycle < 0.24) {
      const lid = Math.sin((cycle / 0.24) * Math.PI);
      const top = ey - ry - 1;
      ctx.fillStyle = '#e8e8e8';
      ctx.fillRect(ex - rx - 2, top, (rx + 2) * 2, (ry * 2 + 2) * lid);
      ctx.strokeStyle = 'rgba(10,10,10,0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ex - rx, top + (ry * 2 + 2) * lid);
      ctx.lineTo(ex + rx, top + (ry * 2 + 2) * lid);
      ctx.stroke();
    }
    ctx.restore();

    // Halo: one continuous ring, open across the bite, so it never reads as a dial.
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, r + 2.8, mouth + 0.5, Math.PI * 2 - mouth - 0.5);
    ctx.stroke();
    oppRim(r, mouth, 'rgba(255,255,255,0.9)', 1);

    // A single satellite in orbit — the only moving part besides the lid.
    const sa = gameTime * 1.15 + idx * 1.7;
    const sx = Math.cos(sa) * (r + 2.8), sy = Math.sin(sa) * (r + 2.8);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(sx, sy, 1.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.arc(sx, sy, 2.9, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 1 · MONARCH — a scalloped cape, a dark shoulder mantle trimmed with pearls,
  // and an upright crown. Nothing cuts diagonally across the shell, so it can
  // never be mistaken for a beak or a scythe.
  function oppMonarch(r, mouth) {
    // Cape: two swept wings with a scalloped hem, and a bright leading edge so
    // they read as cloth rather than as a second body.
    for (let s = -1; s <= 1; s += 2) {
      ctx.beginPath();
      ctx.moveTo(-r * 0.1, s * r * 0.9);
      ctx.quadraticCurveTo(-r * 1.32, s * r * 1.3, -r * 1.78, s * r * 0.18);
      ctx.quadraticCurveTo(-r * 1.5, s * r * 0.38, -r * 1.2, s * r * 0.24);
      ctx.quadraticCurveTo(-r * 0.98, s * r * 0.42, -r * 0.72, s * r * 0.26);
      ctx.quadraticCurveTo(-r * 0.5, s * r * 0.4, -r * 0.1, s * r * 0.3);
      ctx.closePath();
      ctx.fillStyle = '#b9b9b9';
      ctx.fill();
      ctx.strokeStyle = '#0a0a0a';
      ctx.lineWidth = 0.7;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(-r * 0.1, s * r * 0.9);
      ctx.quadraticCurveTo(-r * 1.32, s * r * 1.3, -r * 1.78, s * r * 0.18);
      ctx.stroke();
    }

    oppBodyPath(r, mouth);
    ctx.fillStyle = '#fbfbfb';
    ctx.fill();

    ctx.save();
    oppBodyPath(r, mouth);
    ctx.clip();
    // Shoulder mantle: the rear third of the shell hung in dark cloth, with a
    // bright inner trim and a row of pearls along it.
    const m0 = Math.PI * 0.62, m1 = Math.PI * 1.38;
    ctx.beginPath();
    ctx.arc(0, 0, r, m0, m1);
    ctx.arc(0, 0, r * 0.42, m1, m0, true);
    ctx.closePath();
    ctx.fillStyle = 'rgba(10,10,10,0.5)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.42, m0, m1);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    for (let k = 0; k <= 5; k++) {
      const a = m0 + (k / 5) * (m1 - m0);
      ctx.beginPath();
      ctx.arc(Math.cos(a) * r * 0.42, Math.sin(a) * r * 0.42, r * 0.055, 0, Math.PI * 2);
      ctx.fill();
    }
    // Cape clasp closing the mantle at the back.
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(-r * 0.68, 0, r * 0.13, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0a0a0a';
    ctx.beginPath();
    ctx.arc(-r * 0.68, 0, r * 0.055, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Double rim: dark outline, then a bright inner ring.
    oppRim(r, mouth, 'rgba(10,10,10,0.75)', 1.2);
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.arc(0, 0, r - 1.9, mouth + 0.22, Math.PI * 2 - mouth - 0.22);
    ctx.stroke();
  }

  // Drawn outside the rotation, so the crown always sits upright on the head.
  function oppCrownGlyph(cx, cy, s) {
    ctx.beginPath();
    ctx.moveTo(cx - s, cy + s * 0.55);
    ctx.lineTo(cx - s, cy - s * 0.15);
    ctx.lineTo(cx - s * 0.52, cy + s * 0.28);
    ctx.lineTo(cx, cy - s * 0.95);
    ctx.lineTo(cx + s * 0.52, cy + s * 0.28);
    ctx.lineTo(cx + s, cy - s * 0.15);
    ctx.lineTo(cx + s, cy + s * 0.55);
    ctx.closePath();
    ctx.fillStyle = '#f4f4f4';
    ctx.fill();
    ctx.strokeStyle = '#0a0a0a';
    ctx.lineWidth = 0.8;
    ctx.stroke();
    // Base band with three gems.
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(cx - s, cy + s * 0.2, s * 2, s * 0.14);
    ctx.fillStyle = '#f4f4f4';
    for (let k = -1; k <= 1; k++) {
      ctx.beginPath();
      ctx.arc(cx + k * s * 0.52, cy + s * 0.27, s * 0.1, 0, Math.PI * 2);
      ctx.fill();
    }
    // Finials on the three points glint on a slow cycle.
    const glint = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(gameTime * 3));
    ctx.fillStyle = 'rgba(255,255,255,' + glint + ')';
    for (let k = -1; k <= 1; k++) {
      ctx.beginPath();
      ctx.arc(cx + k * s, cy - (k === 0 ? s * 0.95 : s * 0.15), s * 0.12, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 3 · DRONE — flat-backed hexagonal armour with a bright sensor band across
  // the middle. The band is perpendicular to travel, so the bite wedge can never
  // slice it into crescents the way a forward-facing visor was.
  function oppDronePath(r, mouth) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r, mouth, Math.PI * 2 - mouth);
    ctx.lineTo(r * 0.34, -r * 1.0);
    ctx.lineTo(-r * 0.66, -r * 0.94);
    ctx.lineTo(-r * 1.02, 0);
    ctx.lineTo(-r * 0.66, r * 0.94);
    ctx.lineTo(r * 0.34, r * 1.0);
    ctx.lineTo(Math.cos(mouth) * r, Math.sin(mouth) * r);
    ctx.closePath();
  }

  function oppDrone(r, mouth) {
    // Thrust rails behind the hull.
    ctx.strokeStyle = '#d8d8d8';
    ctx.lineWidth = 1.8;
    ctx.lineCap = 'round';
    for (let s = -1; s <= 1; s += 2) {
      ctx.beginPath();
      ctx.moveTo(-r * 0.62, s * r * 0.56);
      ctx.lineTo(-r * 1.5, s * r * 0.56);
      ctx.stroke();
    }
    // Antennae with blinking tips.
    const blink = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(gameTime * 5));
    ctx.lineWidth = 1;
    for (let s = -1; s <= 1; s += 2) {
      ctx.strokeStyle = 'rgba(216,216,216,0.8)';
      ctx.beginPath();
      ctx.moveTo(-r * 0.2, s * r * 0.72);
      ctx.lineTo(-r * 0.66, s * r * 1.18);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,' + blink + ')';
      ctx.beginPath();
      ctx.arc(-r * 0.66, s * r * 1.18, 1.3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.lineCap = 'butt';

    oppDronePath(r, mouth);
    ctx.fillStyle = '#141414';
    ctx.fill();

    ctx.save();
    oppDronePath(r, mouth);
    ctx.clip();
    // Plate seams following the chamfered edges.
    ctx.strokeStyle = 'rgba(240,240,240,0.16)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(r * 0.12, -r * 0.84);
    ctx.lineTo(-r * 0.6, -r * 0.79);
    ctx.moveTo(r * 0.12, r * 0.84);
    ctx.lineTo(-r * 0.6, r * 0.79);
    ctx.stroke();

    // Sensor band: a bright slab straight across the body, dark-framed.
    const bx = -r * 0.2, bw = r * 0.34;
    ctx.fillStyle = '#ededed';
    ctx.fillRect(bx, -r, bw, r * 2);
    ctx.strokeStyle = 'rgba(10,10,10,0.7)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(bx, -r);
    ctx.lineTo(bx, r);
    ctx.moveTo(bx + bw, -r);
    ctx.lineTo(bx + bw, r);
    ctx.stroke();
    // Lens in the middle of the band, with a glint and a dark bezel.
    ctx.fillStyle = '#0a0a0a';
    ctx.beginPath();
    ctx.arc(bx + bw / 2, 0, r * 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.arc(bx + bw / 2, 0, r * 0.28, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath();
    ctx.arc(bx + bw / 2 - r * 0.06, -r * 0.06, r * 0.06, 0, Math.PI * 2);
    ctx.fill();
    // Rear vents: three short slots in the armour.
    ctx.strokeStyle = 'rgba(240,240,240,0.5)';
    ctx.lineWidth = 0.9;
    for (let k = -1; k <= 1; k++) {
      ctx.beginPath();
      ctx.moveTo(-r * 0.44, k * r * 0.3);
      ctx.lineTo(-r * 0.78, k * r * 0.3);
      ctx.stroke();
    }
    ctx.restore();

    // The bright rim is what keeps a black hull visible on a black board.
    oppDronePath(r, mouth);
    ctx.strokeStyle = '#f2f2f2';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(242,242,242,0.3)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.arc(0, 0, r - 2.2, mouth + 0.25, Math.PI * 2 - mouth - 0.25);
    ctx.stroke();
  }

  function oppTagPath(x, y, w, h) {
    const rr = h / 2;
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.arcTo(x + w, y, x + w, y + rr, rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
    ctx.lineTo(x + rr, y + h);
    ctx.arcTo(x, y + h, x, y + h - rr, rr);
    ctx.lineTo(x, y + rr);
    ctx.arcTo(x, y, x + rr, y, rr);
    ctx.closePath();
  }

  // Miniature of the skin, reused by the HUD chips so a name maps to a shape.
  function oppGlyph(cx, cy, skin, color) {
    const s = 2.6;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.9;
    if (skin === SKIN_SAW) {
      // Eight-point saw disc.
      ctx.beginPath();
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const d = k % 2 ? s * 0.62 : s;
        const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
        if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    } else if (skin === SKIN_MONARCH) {
      // Crown.
      ctx.beginPath();
      ctx.moveTo(cx - s, cy + s * 0.75);
      ctx.lineTo(cx - s, cy - s * 0.1);
      ctx.lineTo(cx - s * 0.5, cy + s * 0.3);
      ctx.lineTo(cx, cy - s * 0.9);
      ctx.lineTo(cx + s * 0.5, cy + s * 0.3);
      ctx.lineTo(cx + s, cy - s * 0.1);
      ctx.lineTo(cx + s, cy + s * 0.75);
      ctx.closePath();
      ctx.fill();
    } else if (skin === SKIN_ORACLE) {
      // Eye: a wide almond with its pupil.
      ctx.beginPath();
      ctx.ellipse(cx, cy, s, s * 0.62, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx + s * 0.22, cy, s * 0.3, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Drone: hexagonal hull slit by its sensor band.
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
        const x = cx + Math.cos(a) * s, y = cy + Math.sin(a) * s;
        if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(cx - s * 0.22, cy - s, s * 0.44, s * 2);
    }
  }

  // Name plate: the sprite is monochrome, so the plate is what tells you who is
  // who — dark chip, light text, the skin's glyph, and a leader tick that ties
  // the name to the sprite even when four athletes share one corridor.
  function drawOppTag(p, px, py, r, skin) {
    const name = String(p.name || 'RIVAL').slice(0, 9).toUpperCase();
    ctx.font = 'bold 7.5px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(name).width;
    const w = tw + 16;
    const h = 10;
    const x = px - w / 2;
    // A crowned rival carries its crown above the head, so the plate clears it
    // entirely and the leader tick is dropped rather than drawn through it.
    const crowned = skin === SKIN_MONARCH;
    const top = py - r - (crowned ? 13 : 0) - 7;
    const above = top >= 9;   // on the top row the plate has to hang below
    const y = above ? top : py + r + 9;

    if (!crowned) {
      ctx.strokeStyle = 'rgba(240,240,240,0.32)';
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(px, py + (above ? -r * 0.92 : r * 0.92));
      ctx.lineTo(px, above ? y + h / 2 : y - h / 2);
      ctx.stroke();
    }

    oppTagPath(x, y - h / 2, w, h);
    ctx.fillStyle = 'rgba(10,10,10,0.85)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(240,240,240,0.45)';
    ctx.lineWidth = 0.8;
    ctx.stroke();

    oppGlyph(x + 6, y, skin, '#f0f0f0');
    ctx.fillStyle = '#f0f0f0';
    ctx.fillText(name, x + 10.5, y + 0.4);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
  }

  function drawPacman() {
    const px = pacman.x * CONFIG.TILE + CONFIG.TILE / 2;
    const py = pacman.y * CONFIG.TILE + CONFIG.TILE / 2;

    const angleOffset =
      pacman.dirX === 1 ? 0 :
      pacman.dirX === -1 ? Math.PI :
      pacman.dirY === -1 ? -Math.PI / 2 :
      pacman.dirY === 1 ? Math.PI / 2 : 0;

    const chompSpeed = 18;
    const mouthOpen = 0.08 + 0.28 * (0.5 + 0.5 * Math.sin(gameTime * chompSpeed));

    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.arc(px, py, CONFIG.TILE * 0.6, angleOffset + mouthOpen, angleOffset + Math.PI * 2 - mouthOpen);
    ctx.closePath();
    ctx.fill();

    // Online the plain white Pac-Man is you — every rival wears a skin, so the
    // only unmarked body on the board is the one you drive. Say it out loud.
    if (gameMode === 'online') {
      ctx.font = 'bold 8px -apple-system, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(240,240,240,0.65)';
      const ly = py > CONFIG.GH - 26 ? py - CONFIG.TILE * 0.85 : py + CONFIG.TILE * 0.95;
      ctx.fillText('YOU', px, ly);
    }
  }

  function drawOtherPacman(p, idx) {
    const px = p.x * CONFIG.TILE + CONFIG.TILE / 2;
    const py = p.y * CONFIG.TILE + CONFIG.TILE / 2;
    const skin = skinIndex(p, idx);
    const angle =
      p.dir === 0 ? 0 :
      p.dir === 1 ? Math.PI :
      p.dir === 2 ? -Math.PI / 2 :
      p.dir === 3 ? Math.PI / 2 : 0;
    // Every rival chews at its own cadence, so a cluster never moves in lockstep.
    const mouth = 0.1 + 0.25 * (0.5 + 0.5 * Math.sin(gameTime * (15 + skin * 2) + idx));
    const r = CONFIG.TILE * 0.57;

    // Lift-off glow: a rival has to read against a black maze, and the black
    // drone needs the strongest halo of the four.
    ctx.fillStyle = skin === SKIN_DRONE ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.07)';
    ctx.beginPath();
    ctx.arc(px, py, r + 3.5, 0, Math.PI * 2);
    ctx.fill();

    // Body, cape, teeth and patterns are drawn in a frame rotated to the facing,
    // so every skin turns correctly and the bite always leads the way.
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(angle);
    if (skin === SKIN_SAW) oppSaw(r, mouth);
    else if (skin === SKIN_MONARCH) oppMonarch(r, mouth);
    else if (skin === SKIN_ORACLE) oppOracle(r, mouth, idx);
    else oppDrone(r, mouth);
    ctx.restore();

    // The crown is upright in screen space, whatever way the rival faces.
    if (skin === SKIN_MONARCH) oppCrownGlyph(px, py - r - 3, r * 0.62);

    drawOppTag(p, px, py, r, skin);
  }

  function drawGhost(ghost) {
    drawGhostBody(
      ghost.x, ghost.y,
      Math.round(ghost.x) * CONFIG.TILE + CONFIG.TILE / 2,
      Math.round(ghost.y) * CONFIG.TILE + CONFIG.TILE / 2,
      ghost.state
    );
  }

  // Hub ghosts arrive as tile floats already, so they draw smooth.
  function drawSyncedGhost(g) {
    drawGhostBody(
      g.x, g.y,
      g.x * CONFIG.TILE + CONFIG.TILE / 2,
      g.y * CONFIG.TILE + CONFIG.TILE / 2,
      g.state === 2 ? 'eyes' : g.state === 1 ? 'frightened' : 'active'
    );
  }

  function drawGhostBody(tx, ty, gx, gy, state) {
    const r = CONFIG.TILE * 0.75;

    // Eyes-only state
    if (state === 'eyes') {
      drawGhostEyes(tx, ty, gx, gy, r);
      return;
    }

    // Frightened state
    if (state === 'frightened') {
      drawFrightenedGhost(gx, gy, r);
      return;
    }

    // Normal ghost with glow
    ctx.fillStyle = 'rgba(200,200,200,0.12)';
    ctx.beginPath();
    ctx.arc(gx, gy, r + 4, 0, Math.PI * 2);
    ctx.fill();

    // Body gradient
    const grad = ctx.createLinearGradient(gx, gy - r, gx, gy + r);
    grad.addColorStop(0, '#ddd');
    grad.addColorStop(1, '#999');
    ctx.fillStyle = grad;

    // Classic ghost shape
    ctx.beginPath();
    ctx.arc(gx, gy, r, Math.PI, 0);
    const waveW = (r * 2) / 3;
    ctx.lineTo(gx + r, gy);
    ctx.quadraticCurveTo(gx + r - waveW * 0.5, gy + r * 0.6, gx + r - waveW, gy);
    ctx.quadraticCurveTo(gx, gy + r * 0.6, gx - r + waveW, gy);
    ctx.quadraticCurveTo(gx - r + waveW * 0.5, gy + r * 0.6, gx - r, gy);
    ctx.closePath();
    ctx.fill();

    // Eyes
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(gx - r / 3, gy - r / 5, r / 3, 0, Math.PI * 2);
    ctx.arc(gx + r / 3, gy - r / 5, r / 3, 0, Math.PI * 2);
    ctx.fill();

    // Pupils tracking Pac-Man
    const lookX = pacman.x > tx ? 1 : -1;
    const lookY = pacman.y > ty ? 1 : -1;
    ctx.fillStyle = '#222';
    ctx.beginPath();
    ctx.arc(gx - r / 3 + lookX * r / 6, gy - r / 5 + lookY * r / 6, r / 6, 0, Math.PI * 2);
    ctx.arc(gx + r / 3 + lookX * r / 6, gy - r / 5 + lookY * r / 6, r / 6, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawFrightenedGhost(gx, gy, r) {
    // Pulsing outline
    const pulse = 0.5 + 0.5 * Math.sin(gameTime * 6);
    ctx.fillStyle = 'rgba(255,255,255,' + (0.15 + pulse * 0.15) + ')';
    ctx.beginPath();
    ctx.arc(gx, gy, r + 3, 0, Math.PI * 2);
    ctx.fill();

    // Dark body
    ctx.fillStyle = '#555';
    ctx.beginPath();
    ctx.arc(gx, gy, r, Math.PI, 0);
    const waveW = (r * 2) / 3;
    ctx.lineTo(gx + r, gy);
    ctx.quadraticCurveTo(gx + r - waveW * 0.5, gy + r * 0.6, gx + r - waveW, gy);
    ctx.quadraticCurveTo(gx, gy + r * 0.6, gx - r + waveW, gy);
    ctx.quadraticCurveTo(gx - r + waveW * 0.5, gy + r * 0.6, gx - r, gy);
    ctx.closePath();
    ctx.fill();

    // Disoriented eyes (no directional pupils)
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(gx - r / 3, gy - r / 5, r / 4, 0, Math.PI * 2);
    ctx.arc(gx + r / 3, gy - r / 5, r / 4, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawGhostEyes(fx, fy, gx, gy, r) {
    // Just eyes, no body
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(gx - r / 3, gy - r / 5, r / 3, 0, Math.PI * 2);
    ctx.arc(gx + r / 3, gy - r / 5, r / 3, 0, Math.PI * 2);
    ctx.fill();

    // Pupils tracking ghost house
    const hx = CONFIG.ghostHouseX;
    const hy = CONFIG.ghostHouseY;
    const lookX = hx > fx ? 1 : hx < fx ? -1 : 0;
    const lookY = hy > fy ? 1 : hy < fy ? -1 : 0;
    ctx.fillStyle = '#222';
    ctx.beginPath();
    ctx.arc(gx - r / 3 + lookX * r / 6, gy - r / 5 + lookY * r / 6, r / 6, 0, Math.PI * 2);
    ctx.arc(gx + r / 3 + lookX * r / 6, gy - r / 5 + lookY * r / 6, r / 6, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawBonusFruit() {
    const fx = bonusFruit.x * CONFIG.TILE + CONFIG.TILE / 2;
    const fy = bonusFruit.y * CONFIG.TILE + CONFIG.TILE / 2;
    const size = CONFIG.TILE * 0.5;

    // Pulsing glow
    const pulse = 0.5 + 0.5 * Math.sin(gameTime * 5);
    ctx.fillStyle = 'rgba(255,255,255,' + (0.1 + pulse * 0.1) + ')';
    ctx.beginPath();
    ctx.arc(fx, fy, size + 4, 0, Math.PI * 2);
    ctx.fill();

    // Diamond shape
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#aaa';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(fx, fy - size);
    ctx.lineTo(fx + size * 0.7, fy);
    ctx.lineTo(fx, fy + size);
    ctx.lineTo(fx - size * 0.7, fy);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  function drawPopups() {
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    for (const p of popups) {
      ctx.fillStyle = 'rgba(255,255,255,' + Math.max(0, p.alpha) + ')';
      ctx.fillText(p.text, p.x * CONFIG.TILE + CONFIG.TILE / 2, p.y * CONFIG.TILE);
    }
  }

  // ═══════════════════════════════════════════════════════
  // 14. Game loop
  // ═══════════════════════════════════════════════════════
  function gameLoop(timestamp) {
    if (mode !== 'playing') return;
    const dt = Math.min((timestamp - lastTime) / 1000, 0.05);
    lastTime = timestamp;
    gameTime += dt;

    // An online match never ends locally — the hub ends it for the whole room.
    if (gameMode === 'online') {
      onlineFrame(dt);
      render();
      updateHUD();
      animId = requestAnimationFrame(gameLoop);
      return;
    }

    if (!gameOver) {
      // Update difficulty level
      const newDiff = getDifficultyLevel();
      if (newDiff !== _hudDiff) _hudDiff = -1;  // force HUD refresh

      // Update frightened timer
      if (frightenedTimer > 0) {
        frightenedTimer -= dt;
        if (frightenedTimer <= 0) {
          frightenedTimer = 0;
          // Revert frightened ghosts to active
          for (const g of ghosts) {
            if (g.state === 'frightened') g.state = 'active';
          }
          ghostEatCombo = 0;
        }
      }

      // Ghost spawning
      if (nextGhostIndex < CONFIG.maxGhosts) {
        ghostSpawnTimer += dt;
        if (ghostSpawnTimer >= CONFIG.ghostSpawnInterval) {
          ghostSpawnTimer = 0;
          const spawn = GHOST_SPAWNS[nextGhostIndex];
          ghosts.push(createGhost(spawn));
          nextGhostIndex++;
          _hudGhosts = -1;  // force HUD refresh
        }
      }

      // Move entities
      movePacman(dt);
      for (const g of ghosts) moveGhost(g, dt);
      checkCollisions();

      // Bonus fruit
      updateBonusFruit(dt);

      // Score popups
      updatePopups(dt);

      // High score flash
      if (highScoreFlash > 0) highScoreFlash -= dt;
    }

    render();
    updateHUD();

    if (gameOver) {
      endGame();
      return;
    }

    animId = requestAnimationFrame(gameLoop);
  }

  // ── Online frame: move locally, stream my own spot, paint the hub's board ──
  function onlineFrame(dt) {
    if (!onlineEliminated) {
      movePacman(dt);
      const f = facingIndex(pacman.dirX, pacman.dirY);
      if (f >= 0) lastFacing = f;
      if (window.PacManNet) window.PacManNet.sendState(pacman.x, pacman.y, lastFacing);
    }
    updatePopups(dt);
    if (highScoreFlash > 0) highScoreFlash -= dt;
  }

  function facingIndex(dx, dy) {
    return dx === 1 ? 0 : dx === -1 ? 1 : dy === -1 ? 2 : dy === 1 ? 3 : -1;
  }

  // ═══════════════════════════════════════════════════════
  // 15. HUD
  // ═══════════════════════════════════════════════════════
  function updateHUD() {
    if (score !== _hudScore) { $('hudScore').textContent = _hudScore = score; }
    if (lives !== _hudLives) { $('hudLives').textContent = _hudLives = lives; }
    if (pelletsRemaining !== _hudPellets) { $('hudPellets').textContent = _hudPellets = pelletsRemaining; }

    // Difficulty level
    const diffLv = getDifficultyLevel() + 1;
    if (diffLv !== _hudDiff) {
      _hudDiff = diffLv;
      const el = $('hudDiff');
      if (el) el.textContent = 'Lv.' + diffLv;
    }

    // Ghost count — online it is the room's four, not a local pack
    const ghostCount = gameMode === 'online' ? onlineGhosts.length : ghosts.length;
    if (ghostCount !== _hudGhosts) {
      _hudGhosts = ghostCount;
      const el = $('hudGhosts');
      if (el) el.textContent = ghostCount + '/' + CONFIG.maxGhosts;
    }

    // High score
    const displayHs = Math.max(highScore, score);
    if (displayHs !== _hudHighScore) {
      _hudHighScore = displayHs;
      const el = $('hudHighScore');
      if (el) {
        if (highScoreFlash > 0) {
          el.textContent = 'NEW BEST!';
          el.style.opacity = '1';
        } else {
          el.textContent = displayHs;
          el.style.opacity = '';
        }
      }
    }

    // Frightened indicator
    const fearEl = $('hudFear');
    if (fearEl) {
      if (frightenedTimer > 0) {
        fearEl.textContent = 'FEAR! ' + Math.ceil(frightenedTimer) + 's';
        fearEl.style.opacity = '1';
      } else {
        fearEl.style.opacity = '0';
      }
    }

    // Online scoreboard — the same numbers the hub keeps for the room
    if (gameMode === 'online') {
      const board = $('oppScores');
      if (board) board.hidden = onlinePlayers.length === 0;
      for (let i = 0; i < 3; i++) {
        const scoreEl = $('oppScore' + i);
        const nameEl = $('oppName' + i);
        const p = onlinePlayers[i];
        if (scoreEl) scoreEl.textContent = p ? (p.alive ? p.score : 'OUT') : '';
        if (nameEl) {
          nameEl.textContent = p ? (p.name || 'Athlete') : '';
          // The chip carries the rival's skin glyph, so a name on the HUD maps
          // to one monochrome design on the board.
          if (!p) {
            if (nameEl.dataset.skin) delete nameEl.dataset.skin;
          } else {
            const s = String(skinIndex(p, i));
            if (nameEl.dataset.skin !== s) nameEl.dataset.skin = s;
          }
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════
  // 16. Screen management, countdown, pause, game-over
  // ═══════════════════════════════════════════════════════
  function showScreen(id) {
    for (let i = 0; i < screens.length; i++) screens[i].classList.remove('active');
    $(id).classList.add('active');
  }
  function showOverlay(id) { $(id).classList.remove('hidden'); }
  function hideOverlay(id) { $(id).classList.add('hidden'); }

  // The board owns its own grid cell, so measure that rather than the viewport:
  // the HUD strip and the D-pad are real rows and can never sit on the maze.
  function resizeCanvas() {
    const wrap = $('boardWrap') || canvas.parentElement;
    const ww = wrap ? wrap.clientWidth : 0;
    const wh = wrap ? wrap.clientHeight : 0;
    if (ww < 2 || wh < 2) return;   // game screen is hidden — measure again on show
    const ratio = CONFIG.GW / CONFIG.GH;
    let w = ww, h = ww / ratio;
    if (h > wh) { h = wh; w = h * ratio; }
    w = Math.max(1, Math.floor(w));
    h = Math.max(1, Math.floor(h));
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    viewScale = canvas.width / CONFIG.GW;
  }

  function selectMode(m) {
    gameMode = m;
    if (m === 'online') {
      showScreen('lobbyScreen');
      if (window.PacManNet) window.PacManNet.connect();
    } else {
      startCountdown();
    }
  }

  // `ms` lets an online match line up with the hub's own lead time (go.in), so
  // every athlete starts moving on the same frame.
  function startCountdown(ms) {
    showScreen('gameScreen');
    resizeCanvas();
    initGame();
    mode = 'countdown';
    const step = Math.max(400, Math.min(1200, (ms || 2400) / 3));
    let val = 3;
    $('countdownNum').textContent = val;
    showOverlay('countdownOverlay');
    hideOverlay('gameOverOverlay');
    $('pauseBtn').hidden = true;

    const tick = () => {
      val--;
      if (val <= 0) {
        hideOverlay('countdownOverlay');
        beginPlay();
      } else {
        $('countdownNum').textContent = val;
        const el = $('countdownNum');
        el.style.animation = 'none';
        el.offsetHeight;
        el.style.animation = '';
        setTimeout(tick, step);
      }
    };
    setTimeout(tick, step);
  }

  function beginPlay() {
    mode = 'playing';
    gameTime = 0;
    $('pauseBtn').hidden = false;
    showHint();
    updateHUD();
    if (animId) cancelAnimationFrame(animId);
    lastTime = performance.now();
    animId = requestAnimationFrame(gameLoop);
  }

  function showHint() {
    const el = $('controlsHint');
    el.classList.remove('fade');
    el.textContent = isMobile() ? 'Use D-pad or swipe to move' : 'Arrow keys / WASD to move';
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { el.classList.add('fade'); }, 4000);
  }
  function isMobile() { return 'ontouchstart' in window || navigator.maxTouchPoints > 0; }

  function endGame() {
    mode = 'gameover';
    if (animId) { cancelAnimationFrame(animId); animId = null; }

    const resultEl = $('goResult');
    const online = gameMode === 'online';
    const won = online ? !!(onlineResult && onlineResult.won) : (gameOver && pelletsRemaining <= 0);
    resultEl.textContent = online
      ? (won ? 'Winner!' : onlineResult ? 'Rank #' + onlineResult.rank : 'Match Over')
      : (won ? 'Maze Cleared!' : 'Game Over');
    resultEl.className = 'go-result ' + (won ? 'win' : 'lose');

    $('goScore').textContent = online && onlineResult
      ? 'Score: ' + score + '  \u00b7  ' + onlineResult.rank + ' of ' + onlineResult.total
      : 'Score: ' + score;

    // High score display
    const hsResult = checkHighScore(score);
    const goHs = $('goHighScore');
    const goNew = $('goNewHigh');
    if (goHs) goHs.textContent = 'Best: ' + hsResult.highScore;
    if (goNew) {
      if (hsResult.isNew) {
        goNew.textContent = 'NEW HIGH SCORE!';
        goNew.style.display = 'block';
        saveHighScore(score);
      } else {
        goNew.style.display = 'none';
      }
    }

    // Report XP for single player
    const xpEl = $('goXp');
    xpEl.textContent = '';
    if (gameMode === 'single' && window.AthleteXP) {
      const result = window.AthleteXP.report('pac-man', score);
      if (result && result.then) {
        result.then(r => {
          if (r && r.awarded > 0) {
            let txt = '+' + r.awarded + ' XP';
            if (r.coins_awarded > 0) txt += ' \u00b7 +' + r.coins_awarded + ' coins';
            xpEl.textContent = txt;
          }
        });
      }
    }

    // Online XP is paid by the hub on its own score — nothing to report here.

    showOverlay('gameOverOverlay');
    $('pauseBtn').hidden = true;
  }

  function togglePause() {
    if (mode === 'playing') {
      mode = 'paused';
      if (animId) { cancelAnimationFrame(animId); animId = null; }
      $('pauseBtn').innerHTML = '&#9654;';
    } else if (mode === 'paused') {
      mode = 'playing';
      lastTime = performance.now();
      animId = requestAnimationFrame(gameLoop);
      $('pauseBtn').innerHTML = '&#10074;&#10074;';
    }
  }

  // ═══════════════════════════════════════════════════════
  // 17. UI Event wiring
  // ═══════════════════════════════════════════════════════
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-mode]');
    if (btn) { selectMode(btn.dataset.mode); return; }

    if (e.target.closest('#instrToggle')) {
      const panel = $('instrPanel');
      const toggle = $('instrToggle');
      panel.hidden = !panel.hidden;
      toggle.classList.toggle('open', !panel.hidden);
      return;
    }

    if (e.target === $('goPlayAgain') || e.target.closest('#goPlayAgain')) {
      hideOverlay('gameOverOverlay');
      if (gameMode === 'online') {
        // The room is back in the lobby — rejoin it instead of starting a solo run.
        showScreen('lobbyScreen');
        mode = 'menu';
        if (window.PacManNet) window.PacManNet.connect();
        return;
      }
      startCountdown();
      return;
    }

    if (e.target === $('goChangeMode') || e.target.closest('#goChangeMode')) {
      hideOverlay('gameOverOverlay');
      if (gameMode === 'online' && window.PacManNet) window.PacManNet.disconnect();
      showScreen('menuScreen');
      mode = 'menu';
      return;
    }

    if (e.target === $('pauseBtn') || e.target.closest('#pauseBtn')) {
      togglePause();
      return;
    }

    if (e.target === $('lobbyBackBtn') || e.target.closest('#lobbyBackBtn')) {
      if (window.PacManNet) window.PacManNet.disconnect();
      showScreen('menuScreen');
      mode = 'menu';
      return;
    }
  });

  // ═══════════════════════════════════════════════════════
  // 18. Online callbacks
  // ═══════════════════════════════════════════════════════
  window.openOnlineLobby = function() {
    gameMode = 'online';
    showScreen('lobbyScreen');
    mode = 'menu';
  };

  window.startOnlineGame = function(roster, inMs) {
    gameMode = 'online';
    const myId = window.PacManNet ? String(window.PacManNet.myId) : '';
    const list = roster || [];

    onlineNames = {};
    onlineSkins = {};
    onlinePlayers = [];
    onlineGhosts = [];
    onlineRound = 0;
    onlineResult = null;
    onlineEliminated = false;
    lastFacing = 0;

    let spawn = 0;
    for (const p of list) {
      const id = String(p.id);
      const corner = Number(p.c) || 0;
      onlineNames[id] = p.n || 'Athlete';
      // One skin per corner, handed out by the hub, so nobody on the board
      // ends up wearing the same design as another rival.
      onlineSkins[id] = corner % OPP_SKINS;
      if (id === myId) spawn = corner;
    }
    // Every athlete owns a corner, so nobody starts on top of anybody else.
    const spawns = window.PacmanSim ? window.PacmanSim.SPAWNS : [{ x: 1, y: 29 }];
    onlineSpawn = spawns[spawn % spawns.length] || spawns[0];

    showScreen('gameScreen');
    resizeCanvas();
    startCountdown(inMs);
  };

  // A cleared board comes back full — same rule the hub applies.
  function refillPellets() {
    pelletsRemaining = 0;
    for (let r = 0; r < CONFIG.ROWS; r++) {
      for (let c = 0; c < CONFIG.COLS; c++) {
        const v = Number(LEVEL[r][c]);
        map[r][c] = v;
        if (v === 2 || v === 3) pelletsRemaining++;
      }
    }
  }

  // The hub's board: pellets eaten, ghosts, lives, scores and deaths in one
  // message. Applying it is the only way the maze changes in an online match.
  window.applyOnlineSync = function(m) {
    // Countdown counts too: the hub's clock and mine can start a beat apart, and
    // a dot eaten in that gap must still disappear here.
    if (mode !== 'playing' && mode !== 'paused' && mode !== 'countdown') return;
    const myId = window.PacManNet ? String(window.PacManNet.myId) : '';

    if (typeof m.round === 'number' && m.round !== onlineRound) {
      onlineRound = m.round;
      refillPellets();
    }

    if (m.e && m.e.length) {
      for (const idx of m.e) {
        const r = Math.floor(idx / CONFIG.COLS);
        const c = idx % CONFIG.COLS;
        if (map[r] && map[r][c] !== 0 && map[r][c] !== 1) {
          map[r][c] = 0;
          pelletsRemaining = Math.max(0, pelletsRemaining - 1);
        }
      }
    }
    if (typeof m.left === 'number') pelletsRemaining = m.left;

    // Deaths first — a victim has already been sent back to its corner in the
    // same snapshot, so the popup uses the position we saw before it moved.
    if (m.d && m.d.length) {
      for (const d of m.d) {
        const id = String(d.id);
        if (id === myId) {
          lives = Math.max(0, Number(d.lives) || 0);
          if (lives <= 0) {
            onlineEliminated = true;
            addPopup(pacman.x, pacman.y, 'OUT');
          } else {
            pacman.x = onlineSpawn.x;
            pacman.y = onlineSpawn.y;
            pacman.dirX = 0; pacman.dirY = 0;
            pacman.nextDirX = 0; pacman.nextDirY = 0;
            addPopup(onlineSpawn.x, onlineSpawn.y, 'RESPAWN');
          }
        } else {
          const victim = onlinePlayers.find(p => p.id === id);
          if (victim && d.by && String(d.by) === myId) addPopup(victim.x, victim.y, 'HUNT +300');
          else if (victim) addPopup(victim.x, victim.y, 'OUT');
        }
      }
    }

    const ps = [];
    if (m.p) {
      for (const row of m.p) {
        const id = String(row[0]);
        if (id === myId) {
          lives = Math.max(0, Number(row[4]) || 0);
          score = Number(row[5]) || 0;
          continue;
        }
        ps.push({
          id, name: onlineNames[id] || 'Athlete',
          x: row[1] / 100, y: row[2] / 100, dir: row[3] | 0,
          lives: Number(row[4]) || 0, score: Number(row[5]) || 0,
          alive: row[6] === 1
        });
      }
    }
    onlinePlayers = ps;
    if (window.PacManNet) window.PacManNet.players = ps;

    onlineGhosts = (m.g || []).map(g => ({ x: g[0] / 100, y: g[1] / 100, state: g[2] | 0 }));
  };

  window.endOnlineGame = function(winnerId, rows, reward) {
    if (mode !== 'playing' && mode !== 'paused' && mode !== 'countdown') { window.showOnlineReward(reward); return; }
    const myId = window.PacManNet ? String(window.PacManNet.myId) : '';
    const list = rows || [];
    const mine = list.find(r => String(r.id) === myId);
    if (mine) score = mine.score || 0;
    onlineResult = {
      rank: mine ? (mine.rank || 1) : list.length,
      total: list.length,
      won: !!mine && String(winnerId) === myId
    };
    endGame();
    window.showOnlineReward(reward);
  };

  // Online XP is paid by the hub after this screen is already up (a client that died
  // early still gets its pellets counted), so the reward is written from the result.
  window.showOnlineReward = function(reward) {
    const el = $('goXp');
    if (!el || !reward) return;
    const parts = [];
    if (reward.xp > 0) parts.push('+' + reward.xp + ' XP');
    if (reward.coins > 0) parts.push('+' + reward.coins + ' coins');
    el.textContent = parts.length ? parts.join(' \u00b7 ')
      : reward.why === 'daily_cap' ? 'Daily XP cap reached'
      : reward.why === 'cooldown' ? 'Reward cooldown \u2014 the next match pays'
      : reward.why === 'score_too_low' ? 'Score more to earn XP'
      : '';
  };

  // ═══════════════════════════════════════════════════════
  // 19. Init
  // ═══════════════════════════════════════════════════════
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 120));
  // The board cell also changes size when the HUD wraps (online score chips) or
  // when the browser chrome collapses — a resize listener alone misses that.
  if (window.ResizeObserver) {
    const boardWrap = $('boardWrap');
    if (boardWrap) new ResizeObserver(() => resizeCanvas()).observe(boardWrap);
  }

  // Show high score on menu at load
  const initHs = loadHighScore();
  const menuHsEl = $('menuHighScore');
  if (menuHsEl && initHs > 0) menuHsEl.textContent = 'Best: ' + initHs;

})();
