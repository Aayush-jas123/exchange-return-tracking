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

  // Online multiplayer state
  let onlinePlayers = [];
  let myPlayerIndex = 0;

  // Cached assets
  let wallCanvas = null;
  let bgGrad = null;

  // HUD cache (skip DOM writes when unchanged)
  let _hudScore = -1, _hudLives = -1, _hudPellets = -1;
  let _hudDiff = -1, _hudGhosts = -1, _hudHighScore = -1;

  // ═══════════════════════════════════════════════════════
  // 3. Maze data and helpers
  // ═══════════════════════════════════════════════════════
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
    "1111111111111111111111111111",
  ];

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

    // Pac-Man
    pacman = { x: 1, y: 29, dirX: 0, dirY: 0, nextDirX: 0, nextDirY: 0 };

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

    // Pre-render walls
    const wc = document.createElement('canvas');
    wc.width = CONFIG.GW;
    wc.height = CONFIG.GH;
    const wx = wc.getContext('2d');
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
    ctx.clearRect(0, 0, CONFIG.GW, CONFIG.GH);

    // Background
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, CONFIG.GW, CONFIG.GH);

    // Walls
    ctx.drawImage(wallCanvas, 0, 0);

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

    // Ghosts
    for (const ghost of ghosts) drawGhost(ghost);

    // Pac-Man
    drawPacman();

    // Online players
    if (gameMode === 'online') {
      for (const p of onlinePlayers) {
        if (p.alive !== false) drawOtherPacman(p);
      }
    }

    // Score popups
    drawPopups();
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
  }

  function drawOtherPacman(p) {
    const px = p.x * CONFIG.TILE + CONFIG.TILE / 2;
    const py = p.y * CONFIG.TILE + CONFIG.TILE / 2;
    ctx.fillStyle = '#aaa';
    ctx.beginPath();
    ctx.arc(px, py, CONFIG.TILE * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#666';
    ctx.font = '8px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(p.name ? p.name[0] : '?', px, py + 3);
  }

  function drawGhost(ghost) {
    const gx = Math.round(ghost.x) * CONFIG.TILE + CONFIG.TILE / 2;
    const gy = Math.round(ghost.y) * CONFIG.TILE + CONFIG.TILE / 2;
    const r = CONFIG.TILE * 0.75;

    // Eyes-only state
    if (ghost.state === 'eyes') {
      drawGhostEyes(ghost, gx, gy, r);
      return;
    }

    // Frightened state
    if (ghost.state === 'frightened') {
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
    const lookX = pacman.x > ghost.x ? 1 : -1;
    const lookY = pacman.y > ghost.y ? 1 : -1;
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

  function drawGhostEyes(ghost, gx, gy, r) {
    // Just eyes, no body
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(gx - r / 3, gy - r / 5, r / 3, 0, Math.PI * 2);
    ctx.arc(gx + r / 3, gy - r / 5, r / 3, 0, Math.PI * 2);
    ctx.fill();

    // Pupils tracking ghost house
    const hx = CONFIG.ghostHouseX;
    const hy = CONFIG.ghostHouseY;
    const lookX = hx > ghost.x ? 1 : hx < ghost.x ? -1 : 0;
    const lookY = hy > ghost.y ? 1 : hy < ghost.y ? -1 : 0;
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

      // Online state sync
      if (gameMode === 'online' && window.PacManNet) {
        window.PacManNet.sendState(pacman.x, pacman.y, score);
        onlinePlayers = window.PacManNet.players || [];
      }
    }

    render();
    updateHUD();

    if (gameOver) {
      endGame();
      return;
    }

    animId = requestAnimationFrame(gameLoop);
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

    // Ghost count
    const ghostCount = ghosts.length;
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

    // Online opponent scores
    if (gameMode === 'online' && window.PacManNet) {
      const players = window.PacManNet.players || [];
      for (let i = 0; i < players.length; i++) {
        const el = $('oppScore' + i);
        if (el && players[i].score !== undefined) el.textContent = players[i].score;
        const nameEl = $('oppName' + i);
        if (nameEl && players[i].name) nameEl.textContent = players[i].name;
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

  function resizeCanvas() {
    const wrap = canvas.parentElement;
    const ww = wrap.clientWidth;
    const wh = wrap.clientHeight;
    const ratio = CONFIG.GW / CONFIG.GH;
    let w, h;
    if (ww / wh > ratio) { h = wh; w = h * ratio; }
    else { w = ww; h = w / ratio; }
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = CONFIG.GW;
    canvas.height = CONFIG.GH;
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

  function startCountdown() {
    showScreen('gameScreen');
    resizeCanvas();
    initGame();
    mode = 'countdown';
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
        setTimeout(tick, 800);
      }
    };
    setTimeout(tick, 800);
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
    const won = gameOver && pelletsRemaining <= 0;
    resultEl.textContent = won ? 'Maze Cleared!' : 'Game Over';
    resultEl.className = 'go-result ' + (won ? 'win' : 'lose');

    $('goScore').textContent = 'Score: ' + score;

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

    // End online game
    if (gameMode === 'online' && window.PacManNet) {
      window.PacManNet.endGame(score);
    }

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
  window.startOnlineGame = function(players) {
    showScreen('gameScreen');
    resizeCanvas();
    initGame();
    onlinePlayers = (players || []).filter(p => p.id !== (window.PacManNet ? window.PacManNet.myId : ''));
    startCountdown();
  };

  window.updateOnlinePlayers = function(players) {
    onlinePlayers = players || [];
  };

  window.endOnlineGame = function(winnerId, scores) {
    if (mode !== 'playing') return;
    const myId = window.PacManNet ? window.PacManNet.myId : '';
    const myEntry = (scores || []).find(s => String(s.id) === String(myId));
    if (myEntry) score = myEntry.score || 0;
    endGame();
  };

  // ═══════════════════════════════════════════════════════
  // 19. Init
  // ═══════════════════════════════════════════════════════
  resizeCanvas();
  window.addEventListener('resize', () => {
    if (mode === 'playing' || mode === 'paused') resizeCanvas();
  });

  // Show high score on menu at load
  const initHs = loadHighScore();
  const menuHsEl = $('menuHighScore');
  if (menuHsEl && initHs > 0) menuHsEl.textContent = 'Best: ' + initHs;

})();
