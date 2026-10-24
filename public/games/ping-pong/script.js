// ═══════════════════════════════════════════════════════════
// OFFCOMFRT Ping Pong — Core Game Logic
// ═══════════════════════════════════════════════════════════
(() => {
  'use strict';

  // ── DOM refs (cached) ──
  const $ = id => document.getElementById(id);
  const canvas = $('gameCanvas');
  const ctx = canvas.getContext('2d');
  const screens = document.querySelectorAll('.screen');
  let canvasRect = null;

  // ── Constants ──
  const GW = 600;   // game width (logical)
  const GH = 400;   // game height (logical)
  const PADDLE_W = 10;
  const PADDLE_H = 70;
  const BALL_R = 8;
  const MAX_SCORE = 10;
  const MAX_MISSES = 3;
  const BASE_SPEED = 4.5;
  const MAX_SPEED = 11;
  const SPEED_INCREMENT = 0.04;   // per paddle hit
  const POINT_SPEED_BONUS = 0.15; // per total point scored
  const PADDLE_SPEED = 10;
  const AI_BASE_REACTION = 0.06;  // lerp factor
  const AI_REACTION_IMPROVE = 0.003; // per rally hit
  const AI_MAX_REACTION = 0.14;
  const AI_ERROR = 18;            // px random offset
  const TRAIL_LENGTH = 8;

  // ── State ──
  let mode = 'menu';       // menu | lobby | countdown | playing | paused | gameover
  let gameMode = 'single'; // single | online
  let animId = null;
  let lastTime = 0;
  let hintTimer = 0;
  let hintVisible = true;

  // Game objects
  let ball, p1, p2, trail, rallyCount, totalPoints, speedMult;
  let countdownVal = 3, countdownTimer = null;

  // Input
  const keys = {};
  let touchP1 = null;  // Y position from touch (0-1 normalized)

  // ── Helpers ──
  function resetBall(direction) {
    const angle = (Math.random() * 0.8 - 0.4); // -0.4 to 0.4 rad
    const spd = BASE_SPEED + totalPoints * POINT_SPEED_BONUS;
    ball = {
      x: GW / 2,
      y: GH / 2,
      vx: Math.cos(angle) * spd * (direction || (Math.random() > 0.5 ? 1 : -1)),
      vy: Math.sin(angle) * spd
    };
    trail = [];
  }

  function initGame() {
    p1 = { y: GH / 2 - PADDLE_H / 2, score: 0, misses: 0, hitFlash: 0 };
    p2 = { y: GH / 2 - PADDLE_H / 2, score: 0, misses: 0, hitFlash: 0 };
    rallyCount = 0;
    totalPoints = 0;
    speedMult = 1;
    resetBall();
  }

  // ─ Canvas sizing ──
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
    canvasRect = null; // invalidate cached rect
  }

  // ── Screen management ──
  function showScreen(id) {
    for (let i = 0; i < screens.length; i++) screens[i].classList.remove('active');
    $(id).classList.add('active');
  }

  function showOverlay(id) { $(id).classList.remove('hidden'); }
  function hideOverlay(id) { $(id).classList.add('hidden'); }

  // ── Mode select ──
  function selectMode(m) {
    gameMode = m;
    if (m === 'online') {
      showScreen('lobbyScreen');
      if (window.PingPongNet) window.PingPongNet.connect();
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
    countdownVal = 3;
    $('countdownNum').textContent = countdownVal;
    showOverlay('countdownOverlay');
    hideOverlay('gameOverOverlay');
    $('pauseBtn').hidden = true;

    const tick = () => {
      countdownVal--;
      if (countdownVal <= 0) {
        hideOverlay('countdownOverlay');
        beginPlay();
      } else {
        $('countdownNum').textContent = countdownVal;
        // Re-trigger animation
        const el = $('countdownNum');
        el.style.animation = 'none';
        el.offsetHeight; // reflow
        el.style.animation = '';
        countdownTimer = setTimeout(tick, 800);
      }
    };
    countdownTimer = setTimeout(tick, 800);
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
    hintVisible = true;
    el.classList.remove('fade');
    el.textContent = isMobile() ? 'Touch & drag to move paddle' : 'W / S keys to move';
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { el.classList.add('fade'); hintVisible = false; }, 4000);
  }

  function isMobile() {
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  }

  // ── HUD (skip DOM writes when values unchanged) ──
  let _hudP1 = -1, _hudP2 = -1, _hudSpeed = '';
  function updateHUD() {
    if (p1.score !== _hudP1) { $('hudP1Pts').textContent = _hudP1 = p1.score; }
    if (p2.score !== _hudP2) { $('hudP2Pts').textContent = _hudP2 = p2.score; }
    const spdText = rallyCount > 2 ? 'Rally \u00d7' + speedMult.toFixed(1) : '';
    if (spdText !== _hudSpeed) { $('hudSpeed').textContent = _hudSpeed = spdText; }
    renderMissDots('hudP1Misses', p1.misses);
    renderMissDots('hudP2Misses', p2.misses);
    $('hudP1Name').textContent = 'You';
    $('hudP2Name').textContent = gameMode === 'single' ? 'AI' :
      (window.PingPongNet && window.PingPongNet.opponentName ? window.PingPongNet.opponentName : 'Opponent');
  }

  function renderMissDots(containerId, count) {
    const el = $(containerId);
    if (!el.children.length) return;
    for (let i = 0; i < MAX_MISSES; i++) {
      if (i < count) el.children[i].classList.add('filled');
      else el.children[i].classList.remove('filled');
    }
  }

  // ─ Input handling ──
  document.addEventListener('keydown', e => {
    keys[e.key] = true;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === ' ') e.preventDefault();
  });
  document.addEventListener('keyup', e => { keys[e.key] = false; });

  // Touch
  canvas.addEventListener('touchstart', handleTouch, { passive: false });
  canvas.addEventListener('touchmove', handleTouch, { passive: false });
  canvas.addEventListener('touchend', () => { touchP1 = null; });

  function handleTouch(e) {
    e.preventDefault();
    if (!canvasRect) canvasRect = canvas.getBoundingClientRect();
    for (const touch of e.touches) {
      touchP1 = Math.max(0, Math.min(1, (touch.clientY - canvasRect.top) / canvasRect.height));
    }
  }

  // Mouse (desktop single player)
  let mouseActive = false;
  canvas.addEventListener('mousedown', e => { mouseActive = true; handleMouse(e); });
  canvas.addEventListener('mousemove', e => { if (mouseActive) handleMouse(e); });
  document.addEventListener('mouseup', () => { mouseActive = false; });

  function handleMouse(e) {
    if (gameMode !== 'single') return;
    if (!canvasRect) canvasRect = canvas.getBoundingClientRect();
    touchP1 = Math.max(0, Math.min(1, (e.clientY - canvasRect.top) / canvasRect.height));
  }

  // ── Paddle movement ──
  function movePaddles() {
    // Player paddle (left)
    if (keys['w'] || keys['W']) { p1.y -= PADDLE_SPEED; }
    if (keys['s'] || keys['S']) { p1.y += PADDLE_SPEED; }
    if (touchP1 !== null) {
      p1.y = touchP1 * GH - PADDLE_H / 2;
    }
    p1.y = Math.max(0, Math.min(GH - PADDLE_H, p1.y));

    // Opponent paddle (right) — AI or online opponent
    if (gameMode === 'single') {
      moveAI();
    } else if (window.PingPongNet && window.PingPongNet.opponentY !== null) {
      p2.y = window.PingPongNet.opponentY * GH - PADDLE_H / 2;
    }
  }

  // ── AI Bot ──
  let aiReaction = AI_BASE_REACTION;
  function moveAI() {
    // Scale reaction with rally count
    aiReaction = Math.min(AI_MAX_REACTION, AI_BASE_REACTION + rallyCount * AI_REACTION_IMPROVE);
    const target = ball.y - PADDLE_H / 2 + (Math.random() * 2 - 1) * AI_ERROR;
    p2.y += (target - p2.y) * aiReaction;
    p2.y = Math.max(0, Math.min(GH - PADDLE_H, p2.y));
  }

  // ── Ball physics ─
  function updateBall() {
    ball.x += ball.vx;
    ball.y += ball.vy;

    // Top/bottom bounce
    if (ball.y - BALL_R < 0) { ball.y = BALL_R; ball.vy = Math.abs(ball.vy); }
    if (ball.y + BALL_R > GH) { ball.y = GH - BALL_R; ball.vy = -Math.abs(ball.vy); }

    // Trail
    trail.push({ x: ball.x, y: ball.y });
    if (trail.length > TRAIL_LENGTH) trail.shift();

    // Left paddle collision
    if (ball.vx < 0 && ball.x - BALL_R <= PADDLE_W &&
        ball.y >= p1.y && ball.y <= p1.y + PADDLE_H) {
      ball.vx = Math.abs(ball.vx);
      onPaddleHit(1);
    }

    // Right paddle collision
    if (ball.vx > 0 && ball.x + BALL_R >= GW - PADDLE_W &&
        ball.y >= p2.y && ball.y <= p2.y + PADDLE_H) {
      ball.vx = -Math.abs(ball.vx);
      onPaddleHit(2);
    }

    // Score / miss
    if (ball.x < -BALL_R * 2) {
      // Ball passed left side — P2 scores, P1 misses
      p2.score++;
      p1.misses++;
      p2.misses = 0; // P2 hit it last
      totalPoints++;
      onPointScored();
    } else if (ball.x > GW + BALL_R * 2) {
      // Ball passed right side — P1 scores, P2 misses
      p1.score++;
      p2.misses++;
      p1.misses = 0;
      totalPoints++;
      onPointScored();
    }
  }

  function onPaddleHit(player) {
    rallyCount++;
    speedMult = 1 + rallyCount * SPEED_INCREMENT;
    const spd = (BASE_SPEED + totalPoints * POINT_SPEED_BONUS) * speedMult;
    const clampedSpd = Math.min(spd, MAX_SPEED);

    // Add slight angle variation based on where ball hit paddle
    const paddle = player === 1 ? p1 : p2;
    const hitPos = (ball.y - paddle.y) / PADDLE_H - 0.5; // -0.5 to 0.5
    const angle = hitPos * 1.2; // max ~68 degrees

    ball.vx = (player === 1 ? 1 : -1) * Math.cos(angle) * clampedSpd;
    ball.vy = Math.sin(angle) * clampedSpd;

    // Hit flash
    paddle.hitFlash = 6;

    // Send paddle state in online mode
    if (gameMode === 'online' && window.PingPongNet) {
      window.PingPongNet.sendState(p1.y / GH, rallyCount);
    }

    updateHUD();
  }

  function onPointScored() {
    rallyCount = 0;
    speedMult = 1;
    aiReaction = AI_BASE_REACTION;

    // Check 3-miss rule
    if (p1.misses >= MAX_MISSES) {
      endGame(2, 'misses');
      return;
    }
    if (p2.misses >= MAX_MISSES) {
      endGame(1, 'misses');
      return;
    }

    // Check win by score
    if (p1.score >= MAX_SCORE) { endGame(1, 'score'); return; }
    if (p2.score >= MAX_SCORE) { endGame(2, 'score'); return; }

    // Reset ball toward the scorer
    const dir = p1.score > p2.score ? -1 : 1;
    resetBall(dir);
    updateHUD();
  }

  // ── End game ──
  function endGame(winner, reason) {
    mode = 'gameover';
    if (animId) { cancelAnimationFrame(animId); animId = null; }

    const resultEl = $('goResult');
    resultEl.textContent = winner === 1 ? 'You Win!' : 'You Lose';
    resultEl.className = 'go-result ' + (winner === 1 ? 'win' : 'lose');

    if (reason === 'misses') {
      resultEl.textContent += ' (3 Misses)';
    }

    $('goScore').textContent = p1.score + ' — ' + p2.score;

    // Report XP for single player
    const xpEl = $('goXp');
    xpEl.textContent = '';
    if (gameMode === 'single' && window.AthleteXP) {
      const result = window.AthleteXP.report('ping-pong', p1.score);
      if (result && result.then) {
        result.then(r => {
          if (r && r.awarded > 0) {
            let txt = '+' + r.awarded + ' XP';
            if (r.coins_awarded > 0) txt += ' · +' + r.coins_awarded + ' coins';
            xpEl.textContent = txt;
          }
        });
      }
    }

    showOverlay('gameOverOverlay');
    $('pauseBtn').hidden = true;
  }

  // ── Render ──
  function render() {
    ctx.clearRect(0, 0, GW, GH);

    // Background
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, GW, GH);

    // Center line
    ctx.setLineDash([8, 8]);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(GW / 2, 0);
    ctx.lineTo(GW / 2, GH);
    ctx.stroke();
    ctx.setLineDash([]);

    // Ball trail
    for (let i = 0; i < trail.length; i++) {
      const alpha = (i / trail.length) * 0.3;
      const r = BALL_R * (i / trail.length) * 0.8;
      ctx.beginPath();
      ctx.arc(trail[i].x, trail[i].y, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,' + alpha + ')';
      ctx.fill();
    }

    // Ball
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();

    // Paddles
    drawPaddle(0, p1.y, p1.hitFlash);
    drawPaddle(GW - PADDLE_W, p2.y, p2.hitFlash);

    // Decay hit flash
    if (p1.hitFlash > 0) p1.hitFlash--;
    if (p2.hitFlash > 0) p2.hitFlash--;
  }

  function drawPaddle(x, y, flash) {
    ctx.fillStyle = flash > 0 ? '#fff' : '#ccc';
    ctx.fillRect(x, y, PADDLE_W, PADDLE_H);
    // Rounded ends
    ctx.beginPath();
    ctx.arc(x + PADDLE_W / 2, y, PADDLE_W / 2, Math.PI, 0);
    ctx.arc(x + PADDLE_W / 2, y + PADDLE_H, PADDLE_W / 2, 0, Math.PI);
    ctx.fill();
  }

  // ── Game loop ──
  function gameLoop(timestamp) {
    if (mode !== 'playing') return;
    lastTime = timestamp;
    movePaddles();
    updateBall();
    render();
    animId = requestAnimationFrame(gameLoop);
  }

  // ── Pause ──
  function togglePause() {
    if (mode === 'playing') {
      mode = 'paused';
      if (animId) { cancelAnimationFrame(animId); animId = null; }
      $('pauseBtn').innerHTML = '&#9654;'; // play icon
    } else if (mode === 'paused') {
      mode = 'playing';
      lastTime = performance.now();
      animId = requestAnimationFrame(gameLoop);
      $('pauseBtn').innerHTML = '&#10074;&#10074;'; // pause icon
    }
  }

  // ── UI Event wiring ──
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
      if (gameMode === 'online' && window.PingPongNet) window.PingPongNet.disconnect();
      showScreen('menuScreen');
      mode = 'menu';
      return;
    }

    if (e.target === $('pauseBtn') || e.target.closest('#pauseBtn')) {
      togglePause();
      return;
    }

    if (e.target === $('lobbyBackBtn') || e.target.closest('#lobbyBackBtn')) {
      if (window.PingPongNet) window.PingPongNet.disconnect();
      showScreen('menuScreen');
      mode = 'menu';
      return;
    }
  });

  // ── Online game start callback (called by ping-pong-net.js) ──
  window.startOnlineGame = function(opponentName) {
    showScreen('gameScreen');
    resizeCanvas();
    initGame();
    if (opponentName) $('hudP2Name').textContent = opponentName;
    startCountdown();
  };

  // ── Online paddle update callback ─
  window.updateOpponentPaddle = function(normalizedY) {
    if (mode === 'playing' || mode === 'countdown') {
      p2.y = normalizedY * GH - PADDLE_H / 2;
    }
  };

  // ── Online game end callback ──
  window.endOnlineGame = function(winner, score1, score2) {
    if (mode !== 'playing') return;
    p1.score = score1;
    p2.score = score2;
    endGame(winner, 'score');
  };

  // ── Init ──
  resizeCanvas();
  window.addEventListener('resize', () => {
    if (mode === 'playing' || mode === 'paused') resizeCanvas();
  });

})();
