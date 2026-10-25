// ═══════════════════════════════════════════════════════════
// OFFCOMFRT Pac-Man — Core Game Logic
// ═══════════════════════════════════════════════════════════
(() => {
  'use strict';

  // ── DOM refs (cached) ──
  const $ = id => document.getElementById(id);
  const canvas = $('gameCanvas');
  const ctx = canvas.getContext('2d');
  const screens = document.querySelectorAll('.screen');

  // ── Constants ──
  const COLS = 28;
  const ROWS = 31;
  const TILE = 20;          // corridor tile size
  const GW = COLS * TILE;   // 560
  const GH = ROWS * TILE;   // 620
  const PAC_SPEED = 8;      // tiles per second
  const MAX_LIVES = 3;
  const PELLET_SCORE = 10;
  const POWER_SCORE = 50;

  // ── Difficulty scaling ──
  // Level increases every 30s: speed, chase chance, proximity aggression
  const DIFFICULTY = [
    { speed: 7,  chase: 0.70, proximity: 5  },  // Lv1: 0-30s
    { speed: 8,  chase: 0.80, proximity: 7  },  // Lv2: 30-60s
    { speed: 9,  chase: 0.90, proximity: 9  },  // Lv3: 60-90s
    { speed: 10, chase: 0.95, proximity: 12 },  // Lv4: 90s+
  ];
  let difficultyLevel = 0;
  function getDiff() { return DIFFICULTY[Math.min(difficultyLevel, DIFFICULTY.length - 1)]; }

  let _hudDiff = -1;

  // ─ Maze layout (0=empty, 1=wall, 2=pellet, 3=power pellet) ──
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

  // ── State ──
  let mode = 'menu';       // menu | lobby | countdown | playing | paused | gameover
  let gameMode = 'single'; // single | online
  let animId = null;
  let lastTime = 0;
  let gameTime = 0;
  let hintTimer = 0;

  // Game objects
  let map = [];
  let pelletsRemaining = 0;
  let pacman, ghosts;
  let score, lives, gameOver;

  // Online multiplayer state
  let onlinePlayers = [];  // [{id, name, x, y, score, alive}]
  let myPlayerIndex = 0;

  // ── Cached assets ──
  let wallCanvas = null;   // pre-rendered walls
  let bgGrad = null;

  function buildCachedAssets() {
    // Background
    const bg = ctx.createRadialGradient(GW / 2, GH / 2, 0, GW / 2, GH / 2, GW * 0.7);
    bg.addColorStop(0, '#111');
    bg.addColorStop(1, '#000');
    bgGrad = bg;

    // Pre-render walls to offscreen canvas
    const wc = document.createElement('canvas');
    wc.width = GW;
    wc.height = GH;
    const wx = wc.getContext('2d');
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (LEVEL[r][c] === '1') {
          const x = c * TILE;
          const y = r * TILE;
          wx.fillStyle = '#444';
          wx.fillRect(x, y, TILE, TILE);
          wx.strokeStyle = '#666';
          wx.lineWidth = 1;
          wx.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);
        }
      }
    }
    wallCanvas = wc;
  }
  buildCachedAssets();

  // ── Screen management ──
  function showScreen(id) {
    for (let i = 0; i < screens.length; i++) screens[i].classList.remove('active');
    $(id).classList.add('active');
  }
  function showOverlay(id) { $(id).classList.remove('hidden'); }
  function hideOverlay(id) { $(id).classList.add('hidden'); }

  // ── Canvas sizing ──
  function resizeCanvas() {
    const wrap = canvas.parentElement;
    const ww = wrap.clientWidth;
    const wh = wrap.clientHeight;
    const ratio = GW / GH;
    let w, h;
    if (ww / wh > ratio) { h = wh; w = h * ratio; }
    else { w = ww; h = w / ratio; }
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = GW;
    canvas.height = GH;
  }

  // ─ Mode select ──
  function selectMode(m) {
    gameMode = m;
    if (m === 'online') {
      showScreen('lobbyScreen');
      if (window.PacManNet) window.PacManNet.connect();
    } else {
      startCountdown();
    }
  }

  // ── Countdown ──
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
    $('pauseBtn').hidden = false;
    showHint();
    updateHUD();
    if (animId) cancelAnimationFrame(animId);
    lastTime = performance.now();
    animId = requestAnimationFrame(gameLoop);
  }

  // ── Hint ──
  function showHint() {
    const el = $('controlsHint');
    el.classList.remove('fade');
    el.textContent = isMobile() ? 'Use D-pad or swipe to move' : 'Arrow keys / WASD to move';
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { el.classList.add('fade'); }, 4000);
  }
  function isMobile() { return 'ontouchstart' in window || navigator.maxTouchPoints > 0; }

  // ── HUD (skip DOM writes when unchanged) ──
  let _hudScore = -1, _hudLives = -1, _hudPellets = -1;
  function updateHUD() {
    if (score !== _hudScore) { $('hudScore').textContent = _hudScore = score; }
    if (lives !== _hudLives) { $('hudLives').textContent = _hudLives = lives; }
    if (pelletsRemaining !== _hudPellets) { $('hudPellets').textContent = _hudPellets = pelletsRemaining; }
    // Difficulty level indicator
    const diffLv = difficultyLevel + 1;
    if (diffLv !== _hudDiff) {
      _hudDiff = diffLv;
      const diffEl = $('hudDiff');
      if (diffEl) diffEl.textContent = 'Lv.' + diffLv;
    }
    // Online: update opponent scores
    if (gameMode === 'online' && window.PacManNet) {
      const players = window.PacManNet.players || [];
      for (let i = 0; i < players.length; i++) {
        const el = $('oppScore' + i);
        if (el && players[i].score !== undefined) {
          el.textContent = players[i].score;
        }
        const nameEl = $('oppName' + i);
        if (nameEl && players[i].name) {
          nameEl.textContent = players[i].name;
        }
      }
    }
  }

  // ── Init game ──
  function initGame() {
    map = [];
    pelletsRemaining = 0;
    for (let r = 0; r < ROWS; r++) {
      const row = [];
      for (let c = 0; c < COLS; c++) {
        const val = Number(LEVEL[r][c]);
        if (val === 2 || val === 3) pelletsRemaining++;
        row.push(val);
      }
      map.push(row);
    }

    pacman = { x: 1, y: 29, dirX: 0, dirY: 0, nextDirX: 0, nextDirY: 0 };
    ghosts = [
      { x: 12, y: 13, dirX: 1, dirY: 0, thinkTimer: 0, personality: 0 },   // Blinky: direct chaser
      { x: 3, y: 1, dirX: 1, dirY: 1, thinkTimer: 0, personality: 1 },    // Pinky: interceptor
      { x: 24, y: 1, dirX: -1, dirY: 1, thinkTimer: 0, personality: 2 },  // Inky: flanker
      { x: 3, y: 27, dirX: 1, dirY: -1, thinkTimer: 0, personality: 3 }   // Clyde: unpredictable
    ];

    score = 0;
    lives = MAX_LIVES;
    gameOver = false;
    difficultyLevel = 0;
    _hudScore = -1;
    _hudLives = -1;
    _hudPellets = -1;
    _hudDiff = -1;
  }

  // ── Input: Keyboard ──
  const keys = {};
  document.addEventListener('keydown', e => {
    keys[e.key] = true;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === ' ') e.preventDefault();
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

  // ── Input: Touch D-pad ──
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

  // ── Input: Swipe on canvas ──
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
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return; // dead zone
    if (Math.abs(dx) > Math.abs(dy)) {
      setDpadDir(dx > 0 ? 1 : -1, 0);
    } else {
      setDpadDir(0, dy > 0 ? 1 : -1);
    }
    swiping = false;
  }, { passive: false });
  canvas.addEventListener('touchend', () => { swiping = false; });

  // ─ Maze helpers ──
  function isWall(col, row) {
    if (row < 0 || row >= ROWS || col < 0 || col >= COLS) return true;
    return map[row][col] === 1;
  }

  function trySetDirection(dx, dy) {
    pacman.nextDirX = dx;
    pacman.nextDirY = dy;
  }

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

  // ── Move Pac-Man ──
  function movePacman(dt) {
    handleKeyboard();
    handleInput();

    const speedPerFrame = PAC_SPEED * dt;
    let newX = pacman.x + pacman.dirX * speedPerFrame;
    let newY = pacman.y + pacman.dirY * speedPerFrame;

    // Tunnel wrap
    if (newX < 0) newX = COLS - 1;
    if (newX > COLS - 1) newX = 0;

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
      if (map[row][col] === 2) score += PELLET_SCORE;
      else score += POWER_SCORE;
      map[row][col] = 0;
      pelletsRemaining--;
      updateHUD();

      if (pelletsRemaining <= 0) {
        gameOver = true;
      }
    }
  }

  // ── Ghost AI ──
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

  function chooseDirection(ghost, validDirs) {
    const diff = getDiff();
    const distToPac = Math.abs(Math.round(ghost.x) - Math.round(pacman.x)) + Math.abs(Math.round(ghost.y) - Math.round(pacman.y));
    const p = ghost.personality || 0;

    // Each ghost has a different targeting strategy
    let targetX = pacman.x;
    let targetY = pacman.y;

    if (p === 1) {
      // Pinky: target 4 tiles ahead of Pac-Man (interceptor)
      targetX = pacman.x + pacman.nextDirX * 4;
      targetY = pacman.y + pacman.nextDirY * 4;
    } else if (p === 2) {
      // Inky: flanker — target opposite side of Pac-Man
      targetX = pacman.x + (pacman.x - Math.round(ghost.x)) * 0.5;
      targetY = pacman.y + (pacman.y - Math.round(ghost.y)) * 0.5;
    } else if (p === 3) {
      // Clyde: unpredictable — chase when far, scatter when close
      if (distToPac < 8) {
        // Scatter to corner
        targetX = 1;
        targetY = 1;
      }
    }

    // Personality-based chase probability
    let chaseChance = diff.chase;
    if (p === 0) chaseChance = Math.min(1, diff.chase + 0.1);       // Blinky: most aggressive
    else if (p === 1) chaseChance = diff.chase;                      // Pinky: standard
    else if (p === 2) chaseChance = diff.chase - 0.1;               // Inky: less predictable
    else if (p === 3) chaseChance = distToPac < 8 ? 0.3 : diff.chase; // Clyde: lazy when close

    const shouldChase = distToPac <= diff.proximity || Math.random() < chaseChance;

    if (shouldChase && validDirs.length > 0) {
      let best = null, bestDist = Infinity;
      for (const d of validDirs) {
        const tc = Math.round(ghost.x) + d.x;
        const tr = Math.round(ghost.y) + d.y;
        const dist = Math.abs(tc - targetX) + Math.abs(tr - targetY);
        // Add small randomness so ghosts don't all pick identical paths
        const noise = p === 2 ? (Math.random() - 0.5) * 4 : (Math.random() - 0.5) * 1.5;
        if (dist + noise < bestDist) { bestDist = dist + noise; best = d; }
      }
      if (best) { ghost.dirX = best.x; ghost.dirY = best.y; return; }
    }
    // Random fallback — weighted by personality
    if (validDirs.length > 0) {
      if (p === 3 && Math.random() < 0.4) {
        // Clyde: extra random — pick any valid direction
        const choice = validDirs[Math.floor(Math.random() * validDirs.length)];
        ghost.dirX = choice.x; ghost.dirY = choice.y;
      } else {
        const choice = validDirs[Math.floor(Math.random() * validDirs.length)];
        ghost.dirX = choice.x; ghost.dirY = choice.y;
      }
    }
  }

  function moveGhost(ghost, dt) {
    const diff = getDiff();
    const speed = diff.speed * dt;
    let newX = ghost.x + ghost.dirX * speed;
    let newY = ghost.y + ghost.dirY * speed;

    const nextCol = Math.round(newX);
    const nextRow = Math.round(newY);

    if (isWall(nextCol, nextRow)) {
      // Hit a wall — pick new direction immediately
      const valid = getValidDirs(ghost);
      if (valid.length > 0) chooseDirection(ghost, valid);
      return;
    }

    ghost.x = newX;
    ghost.y = newY;

    // Tunnel wrap
    if (ghost.x < 0) ghost.x = COLS - 1;
    if (ghost.x > COLS - 1) ghost.x = 0;

    // Intersection logic: at tile center, reconsider direction
    const atCenter = Math.abs(ghost.x - Math.round(ghost.x)) < 0.15 &&
                     Math.abs(ghost.y - Math.round(ghost.y)) < 0.15;
    if (atCenter) {
      ghost.thinkTimer = (ghost.thinkTimer || 0) + dt;
      if (ghost.thinkTimer >= 0.35) {
        ghost.thinkTimer = 0;
        const valid = getValidDirs(ghost);
        if (valid.length >= 2) {
          chooseDirection(ghost, valid);
        }
      }
    } else {
      ghost.thinkTimer = 0;
    }
  }

  // ── Collision detection ──
  function checkCollisions() {
    for (const ghost of ghosts) {
      const dx = ghost.x - pacman.x;
      const dy = ghost.y - pacman.y;
      if (Math.sqrt(dx * dx + dy * dy) < 0.7) {
        lives--;
        updateHUD();
        if (lives <= 0) {
          gameOver = true;
        } else {
          // Reset positions but keep score and map
          pacman.x = 1; pacman.y = 29;
          pacman.dirX = 0; pacman.dirY = 0;
          pacman.nextDirX = 0; pacman.nextDirY = 0;
          ghosts[0].x = 12; ghosts[0].y = 13; ghosts[0].dirX = 1; ghosts[0].dirY = 0; ghosts[0].thinkTimer = 0;
          ghosts[1].x = 3; ghosts[1].y = 1; ghosts[1].dirX = 1; ghosts[1].dirY = 1; ghosts[1].thinkTimer = 0;
          ghosts[2].x = 24; ghosts[2].y = 1; ghosts[2].dirX = -1; ghosts[2].dirY = 1; ghosts[2].thinkTimer = 0;
          ghosts[3].x = 3; ghosts[3].y = 27; ghosts[3].dirX = 1; ghosts[3].dirY = -1; ghosts[3].thinkTimer = 0;
        }
        break;
      }
    }
  }

  // ── Render ──
  function render() {
    ctx.clearRect(0, 0, GW, GH);

    // Background
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, GW, GH);

    // Pre-rendered walls
    ctx.drawImage(wallCanvas, 0, 0);

    // Pellets (dynamic layer)
    const pulse = 0.7 + 0.3 * Math.sin(gameTime * 4);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const val = map[r][c];
        const cx = c * TILE + TILE / 2;
        const cy = r * TILE + TILE / 2;
        if (val === 2) {
          ctx.fillStyle = '#ccc';
          ctx.beginPath();
          ctx.arc(cx, cy, 3, 0, Math.PI * 2);
          ctx.fill();
        } else if (val === 3) {
          // Power pellet with glow ring
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

    // Ghosts
    for (const ghost of ghosts) drawGhost(ghost);

    // Pac-Man
    drawPacman();

    // Online players (other pac-men)
    if (gameMode === 'online') {
      for (const p of onlinePlayers) {
        if (p.alive !== false) drawOtherPacman(p);
      }
    }
  }

  function drawPacman() {
    const px = pacman.x * TILE + TILE / 2;
    const py = pacman.y * TILE + TILE / 2;

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
    ctx.arc(px, py, TILE * 0.6, angleOffset + mouthOpen, angleOffset + Math.PI * 2 - mouthOpen);
    ctx.closePath();
    ctx.fill();
  }

  function drawOtherPacman(p) {
    const px = p.x * TILE + TILE / 2;
    const py = p.y * TILE + TILE / 2;
    ctx.fillStyle = '#aaa';
    ctx.beginPath();
    ctx.arc(px, py, TILE * 0.5, 0, Math.PI * 2);
    ctx.fill();
    // Label
    ctx.fillStyle = '#666';
    ctx.font = '8px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(p.name ? p.name[0] : '?', px, py + 3);
  }

  function drawGhost(ghost) {
    const gx = Math.round(ghost.x) * TILE + TILE / 2;
    const gy = Math.round(ghost.y) * TILE + TILE / 2;
    const r = TILE * 0.75;

    // Subtle glow behind ghost
    ctx.fillStyle = 'rgba(200,200,200,0.12)';
    ctx.beginPath();
    ctx.arc(gx, gy, r + 4, 0, Math.PI * 2);
    ctx.fill();

    // Body gradient for depth
    const grad = ctx.createLinearGradient(gx, gy - r, gx, gy + r);
    grad.addColorStop(0, '#ddd');
    grad.addColorStop(1, '#999');
    ctx.fillStyle = grad;

    // Classic ghost shape: dome top + wavy bottom
    ctx.beginPath();
    ctx.arc(gx, gy, r, Math.PI, 0); // top half circle
    // Wavy bottom skirt (3 arcs)
    const waveW = (r * 2) / 3;
    ctx.lineTo(gx + r, gy);
    ctx.quadraticCurveTo(gx + r - waveW * 0.5, gy + r * 0.6, gx + r - waveW, gy);
    ctx.quadraticCurveTo(gx, gy + r * 0.6, gx - r + waveW, gy);
    ctx.quadraticCurveTo(gx - r + waveW * 0.5, gy + r * 0.6, gx - r, gy);
    ctx.closePath();
    ctx.fill();

    // Eyes — white sclera
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(gx - r / 3, gy - r / 5, r / 3, 0, Math.PI * 2);
    ctx.arc(gx + r / 3, gy - r / 5, r / 3, 0, Math.PI * 2);
    ctx.fill();

    // Pupils — dark dots looking toward Pac-Man
    const lookX = pacman.x > ghost.x ? 1 : -1;
    const lookY = pacman.y > ghost.y ? 1 : -1;
    ctx.fillStyle = '#222';
    ctx.beginPath();
    ctx.arc(gx - r / 3 + lookX * r / 6, gy - r / 5 + lookY * r / 6, r / 6, 0, Math.PI * 2);
    ctx.arc(gx + r / 3 + lookX * r / 6, gy - r / 5 + lookY * r / 6, r / 6, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── Game loop ──
  function gameLoop(timestamp) {
    if (mode !== 'playing') return;
    const dt = Math.min((timestamp - lastTime) / 1000, 0.05); // cap at 50ms
    lastTime = timestamp;
    gameTime = timestamp / 1000;

    if (!gameOver) {
      // Update difficulty every 30 seconds
      const newDiff = Math.min(Math.floor(gameTime / 30), DIFFICULTY.length - 1);
      if (newDiff !== difficultyLevel) {
        difficultyLevel = newDiff;
        _hudDiff = -1; // force HUD refresh
      }

      movePacman(dt);
      for (const g of ghosts) moveGhost(g, dt);
      checkCollisions();

      // Send state in online mode
      if (gameMode === 'online' && window.PacManNet) {
        window.PacManNet.sendState(pacman.x, pacman.y, score);
        // Update online players from net module
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

  // ── End game ──
  function endGame() {
    mode = 'gameover';
    if (animId) { cancelAnimationFrame(animId); animId = null; }

    const resultEl = $('goResult');
    const won = gameOver && pelletsRemaining <= 0;
    resultEl.textContent = won ? 'Maze Cleared!' : 'Game Over';
    resultEl.className = 'go-result ' + (won ? 'win' : 'lose');

    $('goScore').textContent = 'Score: ' + score;

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

  // ── Pause ──
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

  // ─ UI Event wiring ──
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

  // ── Online game callbacks (called by pac-man-net.js) ──
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
    // Find my score
    const myId = window.PacManNet ? window.PacManNet.myId : '';
    const myEntry = (scores || []).find(s => String(s.id) === String(myId));
    if (myEntry) score = myEntry.score || 0;
    endGame();
  };

  // ── Init ──
  resizeCanvas();
  window.addEventListener('resize', () => {
    if (mode === 'playing' || mode === 'paused') resizeCanvas();
  });

})();
