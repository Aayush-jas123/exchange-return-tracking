// ═══════════════════════════════════════════════════════════
// OFFCOMFRT Ping Pong — Core Game Logic
// ═══════════════════════════════════════════════════════════
(() => {
  'use strict';

  // ── DOM refs (cached) ──
  const $ = id => document.getElementById(id);
  const canvas = $('gameCanvas');
  const pointIndicator = $('pointIndicator');
  const pointLabel = $('pointLabel');
  const ctx = canvas.getContext('2d');
  const screens = document.querySelectorAll('.screen');
  let canvasRect = null;

  // ── Constants ──
  const GW = 600;   // game width (logical)
  const GH = 400;   // game height (logical)
  const PADDLE_W = 10;
  const PADDLE_H = 80;
  const PADDLE_CURVE = 12;  // how far the arc bows outward (px)
  const BALL_R = 8;
  const MAX_SCORE = 5;
  const BASE_SPEED = 4.5;
  const MAX_SPEED = 11;
  const SPEED_INCREMENT = 0.04;   // per paddle hit
  const POINT_SPEED_BONUS = 0.15; // per total point scored
  const PADDLE_SPEED = 10;
  const TRAIL_LENGTH = 8;
  const PARTICLE_COUNT = 7;
  const PARTICLE_LIFE = 15;
  const SQUASH_FRAMES = 6;
  const BORDER_FLASH_FRAMES = 20;
  const BALL_GLOW_BLUR = 22;
  const BALL_GLOW_COLOR = 'rgba(255,255,255,0.70)';

  // ── Difficulty table ──
  const DIFFICULTIES = {
    low:    { label: 'Low',    aiReaction: 0.02, aiError: 50, aiImprove: 0.001, aiMax: 0.05, xpMult: 1, baseSpeed: 3.5, maxSpeed: 8,  speedIncrement: 0.03, pointSpeedBonus: 0.10 },
    medium: { label: 'Medium', aiReaction: 0.06, aiError: 18, aiImprove: 0.003, aiMax: 0.14, xpMult: 2, baseSpeed: 4.5, maxSpeed: 11, speedIncrement: 0.04, pointSpeedBonus: 0.15 },
    high:   { label: 'High',   aiReaction: 0.11, aiError: 4,  aiImprove: 0.006, aiMax: 0.22, xpMult: 3, baseSpeed: 5.5, maxSpeed: 14, speedIncrement: 0.06, pointSpeedBonus: 0.20 },
  };

  // ── State ──
  let mode = 'menu';       // menu | lobby | countdown | playing | paused | gameover
  let gameMode = 'single'; // single | online
  let difficulty = 'medium'; // low | medium | high
  let animId = null;
  let lastTime = 0;
  let hintTimer = 0;
  let hintVisible = true;

  // Game objects
  let ball, p1, p2, trail, rallyCount, totalPoints, speedMult;
  let countdownVal = 3, countdownTimer = null;

  // Visual effects state
  let particles = [];
  let squashTimer = 0;
  let borderFlash = 0;
  let pointPause = false;
  let pointPauseFrames = 0;
  let lastScorer = 0; // 1 = player, 2 = AI/bot
  const POINT_PAUSE_FRAMES = 120; // 2 seconds at 60fps

  // ── Taunt Bank ──
  const TAUNT_TIER1 = [
    { t: 'COMFORTABLE?', icon: 'FLAT' },
    { t: 'THAT ONE WAS YOURS.', icon: 'WHOOSH' },
    { t: 'WATCHED IT GO PAST.', icon: 'SIDE' },
    { t: 'NICE STRETCH.', icon: 'CLAP' },
    { t: 'STILL WARMING UP?', icon: 'CLOCK' },
    { t: 'DID YOU WANT IT?', icon: 'BROW' },
    { t: 'BLINK AND IT\'S GONE.', icon: 'WHOOSH' },
    { t: 'THAT\'S A GIFT.', icon: 'CLAP' },
    { t: 'PLENTY OF TIME.', icon: 'CLOCK' },
    { t: 'LOOKED EASY.', icon: 'FLAT' },
  ];
  const TAUNT_TIER2 = [
    { t: 'TWO IN A ROW.', icon: 'SIDE' },
    { t: 'YOUR COMFORT IS SHOWING.', icon: 'YAWN' },
    { t: 'WERE YOU RESTING?', icon: 'SLEEP' },
    { t: 'STILL LOOKING FOR IT.', icon: 'GLASS' },
    { t: 'NOT EVEN CLOSE.', icon: 'WHOOSH' },
    { t: 'GOING EASY ON YOURSELF.', icon: 'YAWN' },
    { t: 'SAY SOMETHING BACK.', icon: 'BROW' },
    { t: 'IT WAS RIGHT THERE.', icon: 'GLASS' },
    { t: 'WARM IN THERE?', icon: 'YAWN' },
    { t: 'TRY MOVING.', icon: 'CLOCK' },
  ];
  const TAUNT_TIER3 = [
    { t: 'THREE. IN A ROW.', icon: 'ZERO' },
    { t: 'ZERO COMFORT LOOKS FAR FROM HERE.', icon: 'ZERO' },
    { t: 'THIS IS THE COMFORT ZONE.', icon: 'SLEEP' },
    { t: 'SOMEBODY WAKE THEM.', icon: 'SLEEP' },
    { t: 'PADDLE IS THE WHITE ONE.', icon: 'GLASS' },
    { t: 'HARDEST PART WAS THE PADDLE.', icon: 'ZERO' },
    { t: 'ARE YOU STILL THERE?', icon: 'SLEEP' },
    { t: 'WE CAN WAIT.', icon: 'CLOCK' },
    { t: 'THAT WAS NOT A RALLY.', icon: 'WHOOSH' },
    { t: 'PUT IT ON THE LOGBOOK.', icon: 'FLAT' },
  ];
  const TAUNT_MATCH_POINT = [
    { t: 'MATCH POINT. BREATHE.', icon: 'CLOCK' },
    { t: 'ONE MORE AND IT\'S OVER.', icon: 'BROW' },
    { t: 'LAST CHANCE TO BE INTERESTING.', icon: 'SIDE' },
    { t: 'SAVE IT, OR EXPLAIN IT LATER.', icon: 'FLAT' },
    { t: 'THIS IS THE ONE YOU REMEMBER.', icon: 'GLASS' },
    { t: 'HOLD THIS POINT AND WE TALK.', icon: 'CLAP' },
    { t: 'COMFORT WOULD LET THIS ONE GO.', icon: 'YAWN' },
    { t: 'ONE RALLY FROM THE HANDSHAKE.', icon: 'WHOOSH' },
    { t: 'NOTHING AFTER THIS IS PRACTICE.', icon: 'ZERO' },
    { t: 'EVERYONE IS WATCHING THIS POINT.', icon: 'GLASS' },
    { t: 'STILL TIME. BARELY.', icon: 'CLOCK' },
    { t: 'ZERO COMFORT IS ONE POINT AWAY.', icon: 'ZERO' },
  ];

  const TAUNT_FONT = '-apple-system, BlinkMacSystemFont, Inter, Segoe UI, sans-serif';
  const TAUNT_DISPLAY_FRAMES = 90;
  const MATCH_POINT_THRESHOLD = MAX_SCORE - 1;
  let lastTauntIdx = -1;
  let tauntState = { active: false, text: '', icon: '', misser: 0, y: 0, fs: 22, iconSize: 24, textX: 0, iconCx: 0, alpha: 0, phase: 'idle', framesLeft: 0 };

  // Input
  const keys = {};
  let touchP1 = null;  // Y position from touch (0-1 normalized)

  // ── Helpers ──
  function resetBall(direction) {
    const angle = (Math.random() * 0.8 - 0.4); // -0.4 to 0.4 rad
    const spd = curDiff.baseSpeed + totalPoints * curDiff.pointSpeedBonus;
    ball = {
      x: GW / 2,
      y: GH / 2,
      vx: Math.cos(angle) * spd * (direction || (Math.random() > 0.5 ? 1 : -1)),
      vy: Math.sin(angle) * spd
    };
    trail = [];
  }

  function initGame() {
    const d = DIFFICULTIES[difficulty];
    p1 = { y: GH / 2 - PADDLE_H / 2, score: 0, misses: 0, hitFlash: 0, consecMiss: 0 };
    p2 = { y: GH / 2 - PADDLE_H / 2, score: 0, misses: 0, hitFlash: 0, consecMiss: 0 };
    rallyCount = 0;
    totalPoints = 0;
    speedMult = 1;
    particles = [];
    squashTimer = 0;
    borderFlash = 0;
    pointPause = false;
    pointPauseFrames = 0;
    lastTauntIdx = -1;
    tauntState = { active: false, text: '', icon: '', x: 0, y: 0, alpha: 0, phase: 'idle', framesLeft: 0 };
    pointIndicator.classList.remove('visible');
    canvas.parentElement.classList.remove('paused');
    aiReaction = d.aiReaction;
    curDiff = d;
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
    } else if (m === 'single') {
      showScreen('diffScreen');
    }
  }

  function selectDifficulty(d) {
    difficulty = d;
    // Update active button state
    const btns = document.querySelectorAll('.diff-btn');
    for (let i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].dataset.diff === d);
    }
    startCountdown();
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
        countdownTimer = setTimeout(tick, 1000);
      }
    };
    countdownTimer = setTimeout(tick, 1000);
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
    el.textContent = isMobile() ? 'Touch & drag to move paddle' : 'Arrow keys to move';
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
    $('hudP1Name').textContent = 'You';
    $('hudP2Name').textContent = gameMode === 'single' ? 'AI' :
      (window.PingPongNet && window.PingPongNet.opponentName ? window.PingPongNet.opponentName : 'Opponent');
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
    if (keys['ArrowUp']) { p1.y -= PADDLE_SPEED; }
    if (keys['ArrowDown']) { p1.y += PADDLE_SPEED; }
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
  let aiReaction = DIFFICULTIES.medium.aiReaction;
  let curDiff = DIFFICULTIES.medium; // current difficulty row, set in initGame()
  function moveAI() {
    const d = DIFFICULTIES[difficulty];
    aiReaction = Math.min(d.aiMax, d.aiReaction + rallyCount * d.aiImprove);
    const target = ball.y - PADDLE_H / 2 + (Math.random() * 2 - 1) * d.aiError;
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

    // Score
    if (ball.x < -BALL_R * 2) {
      p2.score++;
      totalPoints++;
      p1.consecMiss++;
      onPointScored(2);
    } else if (ball.x > GW + BALL_R * 2) {
      p1.score++;
      totalPoints++;
      p2.consecMiss++;
      onPointScored(1);
    }
  }

  function onPaddleHit(player) {
    rallyCount++;
    speedMult = 1 + rallyCount * curDiff.speedIncrement;
    const spd = (curDiff.baseSpeed + totalPoints * curDiff.pointSpeedBonus) * speedMult;
    const clampedSpd = Math.min(spd, curDiff.maxSpeed);

    // Add slight angle variation based on where ball hit paddle
    const paddle = player === 1 ? p1 : p2;
    const hitPos = (ball.y - paddle.y) / PADDLE_H - 0.5; // -0.5 to 0.5
    const angle = hitPos * 1.2; // max ~68 degrees

    ball.vx = (player === 1 ? 1 : -1) * Math.cos(angle) * clampedSpd;
    ball.vy = Math.sin(angle) * clampedSpd;

    // Hit flash
    paddle.hitFlash = 6;
    paddle.consecMiss = 0; // rally won, streak broken

    // Squash effect
    squashTimer = SQUASH_FRAMES;

    // Spawn hit particles
    spawnParticles(ball.x, ball.y, ball.vx);

    // Send paddle state in online mode
    if (gameMode === 'online' && window.PingPongNet) {
      window.PingPongNet.sendState(p1.y / GH, rallyCount);
    }

    updateHUD();
  }

  function onPointScored(scorer) {
    rallyCount = 0;
    speedMult = 1;
    aiReaction = DIFFICULTIES[difficulty].aiReaction;

    // Border flash on score
    borderFlash = BORDER_FLASH_FRAMES;

    // Check win by score
    if (p1.score >= MAX_SCORE) { endGame(1, 'score'); return; }
    if (p2.score >= MAX_SCORE) { endGame(2, 'score'); return; }

    // Pause 2 seconds, show scorer, then serve from scorer's side
    lastScorer = scorer;
    pointPause = true;
    pointPauseFrames = POINT_PAUSE_FRAMES;
    pointLabel.textContent = scorer === 1 ? 'YOUR POINT' : 'AI POINT';
    pointIndicator.classList.add('visible');
    canvas.parentElement.classList.add('paused');
    updateHUD();
  }

  // Measure once; shrink font + icon until icon+gap+text fits one half-court
  function fitTauntLayout(text) {
    const pad = 10;                 // reserve from center line and frame edge
    const gap = 10;                 // icon-to-text gap
    const avail = GW / 2 - pad * 2; // 280px budget for icon+gap+text
    const baseFs = 22;
    let fs = baseFs;
    let iconSize = 24;
    ctx.font = '700 ' + baseFs + 'px ' + TAUNT_FONT;
    let textW = ctx.measureText(text).width;
    if (iconSize + gap + textW > avail) {
      const scale = (avail / (iconSize + gap + textW)) * 0.97; // safety epsilon
      fs = Math.max(11, Math.floor(baseFs * scale));
      iconSize = Math.max(14, Math.round(24 * scale));
      ctx.font = '700 ' + fs + 'px ' + TAUNT_FONT;
      textW = ctx.measureText(text).width;
      if (iconSize + gap + textW > avail) { // second clamp if font floor was hit
        fs = Math.max(10, Math.floor(fs * (avail - iconSize - gap) / textW));
        ctx.font = '700 ' + fs + 'px ' + TAUNT_FONT;
        textW = ctx.measureText(text).width;
      }
    }
    return { fs: fs, iconSize: iconSize, textW: textW };
  }

  function scheduleTaunt(scorer) {
    const misser = scorer === 1 ? 2 : 1;
    const consec = misser === 1 ? p1.consecMiss : p2.consecMiss;
    const scorerScore = scorer === 1 ? p1.score : p2.score;

    let pool;
    if (scorerScore >= MATCH_POINT_THRESHOLD) {
      pool = TAUNT_MATCH_POINT;
    } else if (consec >= 3) {
      pool = TAUNT_TIER3;
    } else if (consec >= 2) {
      pool = TAUNT_TIER2;
    } else {
      pool = TAUNT_TIER1;
    }

    // Pick non-repeating line (reroll up to 8 times)
    let idx, attempts = 0;
    do { idx = Math.floor(Math.random() * pool.length); attempts++; }
    while (idx === lastTauntIdx && attempts < 8 && pool.length > 1);
    lastTauntIdx = idx;

    // Layout is computed once here — render() never re-measures per frame
    const fit = fitTauntLayout(pool[idx].t);
    let textX, iconCx;
    if (misser === 2) {
      // Player scored: right edge pinned before center line
      textX = GW / 2 - 10 - fit.textW;
      iconCx = textX - 10 - fit.iconSize / 2;
    } else {
      // AI scored: left edge pinned after center line
      textX = GW / 2 + 10 + fit.iconSize + 10;
      iconCx = GW / 2 + 10 + fit.iconSize / 2;
    }

    tauntState = { active: true, text: pool[idx].t, icon: pool[idx].icon, misser: misser, y: GH * 0.5, fs: fit.fs, iconSize: fit.iconSize, textX: textX, iconCx: iconCx, alpha: 0, phase: 'fade-in', framesLeft: TAUNT_DISPLAY_FRAMES };
  }

  // ── End game ──
  function endGame(winner, reason) {
    mode = 'gameover';
    if (animId) { cancelAnimationFrame(animId); animId = null; }
    tauntState.active = false;

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
      const d = DIFFICULTIES[difficulty];
      const xpScore = p1.score * d.xpMult;
      const result = window.AthleteXP.report('ping-pong', xpScore);
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
    
    // Show difficulty label
    const diffEl = $('goDifficulty');
    if (diffEl) diffEl.textContent = DIFFICULTIES[difficulty].label + ' difficulty';

    showOverlay('gameOverOverlay');
    $('pauseBtn').hidden = true;
  }

  // ── Particles ──
  function spawnParticles(x, y, dirX) {
    const dir = dirX > 0 ? 1 : -1;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const angle = (Math.random() - 0.5) * 1.2; // cone spread
      const speed = 1.5 + Math.random() * 3;
      particles.push({
        x: x,
        y: y,
        vx: Math.cos(angle) * speed * dir,
        vy: Math.sin(angle) * speed,
        life: PARTICLE_LIFE,
        maxLife: PARTICLE_LIFE,
        size: 1.5 + Math.random() * 1.5
      });
    }
  }

  function updateParticles() {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.94;
      p.vy *= 0.94;
      p.life--;
      if (p.life <= 0) particles.splice(i, 1);
    }
  }

  function drawParticles() {
    for (const p of particles) {
      const alpha = (p.life / p.maxLife) * 0.7;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,' + alpha + ')';
      ctx.fill();
    }
  }

  // ── Taunt icon drawing ──
  function drawTauntIcon(type, cx, cy, size) {
    const s = size;
    const h = s / 2;
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.fillStyle = '#fff';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    switch (type) {
      case 'FLAT':
        ctx.beginPath();
        ctx.arc(cx + h * 0.3, cy + h * 0.35, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cx + h * 1.2, cy + h * 0.35, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(cx + h * 0.2, cy + h * 1.3);
        ctx.lineTo(cx + h * 1.3, cy + h * 1.3);
        ctx.stroke();
        break;

      case 'WHOOSH':
        for (let i = 0; i < 3; i++) {
          const ay = cy + h * 0.25 + i * h * 0.55;
          ctx.beginPath();
          ctx.moveTo(cx + h * 0.1, ay);
          ctx.lineTo(cx + h * 1.3, ay);
          ctx.moveTo(cx + h * 1.0, ay - h * 0.2);
          ctx.lineTo(cx + h * 1.4, ay);
          ctx.lineTo(cx + h * 1.0, ay + h * 0.2);
          ctx.stroke();
        }
        break;

      case 'SIDE':
        ctx.beginPath();
        ctx.arc(cx + h * 0.35, cy + h * 0.4, h * 0.22, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx + h * 1.15, cy + h * 0.4, h * 0.22, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx + h * 0.5, cy + h * 1.35);
        ctx.lineTo(cx + h * 1.0, cy + h * 1.35);
        ctx.stroke();
        break;

      case 'CLAP':
        ctx.beginPath();
        ctx.arc(cx + h * 0.4, cy + h * 0.9, h * 0.3, -Math.PI * 0.7, Math.PI * 0.5);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx + h * 1.1, cy + h * 0.9, h * 0.3, Math.PI * 0.5, -Math.PI * 0.7, true);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx + h * 0.5, cy + h * 0.2, 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cx + h * 1.0, cy + h * 0.2, 2, 0, Math.PI * 2);
        ctx.fill();
        break;

      case 'CLOCK':
        ctx.beginPath();
        ctx.arc(cx + h, cy + h, h * 0.75, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx + h, cy + h);
        ctx.lineTo(cx + h * 0.65, cy + h * 0.35);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx + h, cy + h);
        ctx.lineTo(cx + h * 1.3, cy + h * 0.7);
        ctx.stroke();
        break;

      case 'BROW':
        ctx.beginPath();
        ctx.arc(cx + h * 0.4, cy + h * 0.65, h * 0.18, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx + h * 1.1, cy + h * 0.65, h * 0.18, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx + h * 0.75, cy + h * 0.15, h * 0.55, Math.PI * 1.1, Math.PI * 1.9);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx + h * 0.75, cy + h * 1.15, h * 0.25, Math.PI * 0.15, Math.PI * 0.85);
        ctx.stroke();
        break;

      case 'SLEEP':
        ctx.font = 'bold ' + Math.round(s * 0.42) + 'px -apple-system, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('Z', cx + h * 0.9, cy + h * 0.05);
        ctx.font = 'bold ' + Math.round(s * 0.34) + 'px -apple-system, sans-serif';
        ctx.fillText('Z', cx + h * 0.5, cy + h * 0.45);
        ctx.font = 'bold ' + Math.round(s * 0.26) + 'px -apple-system, sans-serif';
        ctx.fillText('z', cx + h * 0.15, cy + h * 0.8);
        break;

      case 'GLASS':
        ctx.beginPath();
        ctx.arc(cx + h * 0.7, cy + h * 0.65, h * 0.45, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx + h * 1.0, cy + h * 1.0);
        ctx.lineTo(cx + h * 1.45, cy + h * 1.45);
        ctx.stroke();
        break;

      case 'ZERO':
        ctx.beginPath();
        ctx.arc(cx + h, cy + h, h * 0.7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx + h * 0.4, cy + h * 0.4);
        ctx.lineTo(cx + h * 1.6, cy + h * 1.6);
        ctx.stroke();
        break;
    }

    ctx.restore();
  }

  // ── Render ──
  function render() {
    ctx.clearRect(0, 0, GW, GH);

    // 1. Court background — cached radial gradient
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, GW, GH);

    // 2. Court border lines
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, GW - 1, GH - 1);

    // 3. Center line — pre-rendered offscreen canvas
    ctx.drawImage(centerLineCanvas, 0, 0);

    // 4. Ball trail — smooth tapered path
    drawTrail();

    // 5. Particles
    drawParticles();

    // 6. Ball — 3D sphere with glow
    drawBall();

    // 7. Paddles — gradient with shadow
    drawPaddle(0, p1.y, p1.hitFlash);
    drawPaddle(GW - PADDLE_W, p2.y, p2.hitFlash);

    // Decay hit flash
    if (p1.hitFlash > 0) p1.hitFlash--;
    if (p2.hitFlash > 0) p2.hitFlash--;

    // Decay squash timer
    if (squashTimer > 0) squashTimer--;

    // Decay border flash
    if (borderFlash > 0) borderFlash--;

    // 8. Vignette overlay — cached gradient
    ctx.fillStyle = vignetteGrad;
    ctx.fillRect(0, 0, GW, GH);

    // 8b. Taunt overlay — drawn icon + text + subtitle
    if (tauntState.active) {
      ctx.save();

      if (tauntState.phase === 'fade-in') {
        tauntState.alpha = Math.min(1, tauntState.alpha + 0.1);
        if (tauntState.alpha >= 1) tauntState.phase = 'display';
      } else if (tauntState.framesLeft <= 10) {
        tauntState.alpha = Math.max(0, tauntState.alpha - 0.1);
      }

      ctx.globalAlpha = tauntState.alpha;

      // Layout (fs, iconSize, textX, iconCx) was precomputed in scheduleTaunt()
      ctx.font = '700 ' + tauntState.fs + 'px ' + TAUNT_FONT;
      drawTauntIcon(tauntState.icon, tauntState.iconCx, tauntState.y - tauntState.iconSize / 2, tauntState.iconSize);

      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(tauntState.text, tauntState.textX, tauntState.y);

      const subtitle = tauntState.misser === 1 ? 'YOU MISSED' : 'THEY MISSED';
      ctx.font = '600 10px SF Mono, Fira Code, Consolas, monospace';
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fillText(subtitle, tauntState.textX, tauntState.y + Math.round(tauntState.fs * 0.95));

      ctx.restore();

      tauntState.framesLeft--;
      if (tauntState.framesLeft <= 0 || tauntState.alpha <= 0) {
        tauntState.active = false;
      }
    }

    // 9. Border flash
    if (borderFlash > 0) {
      const alpha = (borderFlash / BORDER_FLASH_FRAMES) * 0.3;
      ctx.strokeStyle = 'rgba(255,255,255,' + alpha + ')';
      ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, GW - 2, GH - 2);
    }
  }

  function drawTrail() {
    if (trail.length < 2) return;
    for (let i = 0; i < trail.length; i++) {
      const t = i / trail.length;
      const alpha = t * 0.25;
      const r = BALL_R * t * 0.7;
      ctx.beginPath();
      ctx.arc(trail[i].x, trail[i].y, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,' + alpha + ')';
      ctx.fill();
    }
  }

  function drawBall() {
    ctx.save();

    // Squash/stretch transform
    if (squashTimer > 0) {
      const progress = 1 - squashTimer / SQUASH_FRAMES;
      const ease = 1 - Math.pow(1 - progress, 3); // ease-out cubic
      const scaleX = 1 + 0.3 * Math.sin(ease * Math.PI);
      const scaleY = 1 - 0.4 * Math.sin(ease * Math.PI);
      ctx.translate(ball.x, ball.y);
      ctx.scale(scaleX, scaleY);
      ctx.translate(-ball.x, -ball.y);
    }

    // Glow
    ctx.shadowBlur = BALL_GLOW_BLUR;
    ctx.shadowColor = BALL_GLOW_COLOR;

    // 3D sphere — gradient must be at ball position (absolute coords)
    const grad = ctx.createRadialGradient(
      ball.x - BALL_R * 0.3, ball.y - BALL_R * 0.3, BALL_R * 0.1,
      ball.x, ball.y, BALL_R
    );
    grad.addColorStop(0, '#fff');
    grad.addColorStop(0.6, '#ddd');
    grad.addColorStop(1, '#999');

    ctx.beginPath();
    ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.restore();
  }

  // ─ Cached static assets (position-independent, built once) ──
  let bgGrad = null;
  let vignetteGrad = null;
  let centerLineCanvas = null;

  function buildCachedAssets() {
    // Background radial gradient
    const bg = ctx.createRadialGradient(GW / 2, GH / 2, 0, GW / 2, GH / 2, GW * 0.7);
    bg.addColorStop(0, '#111');
    bg.addColorStop(1, '#000');
    bgGrad = bg;

    // Vignette overlay
    const vg = ctx.createRadialGradient(GW / 2, GH / 2, GH * 0.3, GW / 2, GH / 2, GW * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.45)');
    vignetteGrad = vg;

    // Pre-render center line to offscreen canvas (static, never changes)
    const clc = document.createElement('canvas');
    clc.width = GW;
    clc.height = GH;
    const clx = clc.getContext('2d');
    const dashLen = 10;
    const gapLen = 8;
    const segments = Math.floor(GH / (dashLen + gapLen));
    const startY = (GH - segments * (dashLen + gapLen)) / 2;
    for (let i = 0; i < segments; i++) {
      const y = startY + i * (dashLen + gapLen);
      const midY = y + dashLen / 2;
      const distFromCenter = Math.abs(midY - GH / 2) / (GH / 2);
      const alpha = Math.max(0.04, 0.15 * (1 - distFromCenter * 0.7));
      clx.strokeStyle = 'rgba(255,255,255,' + alpha + ')';
      clx.lineWidth = 2;
      clx.beginPath();
      clx.moveTo(GW / 2, y);
      clx.lineTo(GW / 2, y + dashLen);
      clx.stroke();
    }
    centerLineCanvas = clc;
  }
  buildCachedAssets();

  function drawPaddle(x, y, flash) {
    ctx.save();

    // Hit reaction: eased scale factor (peaks at flash=6, decays to 0)
    const hitT = flash / 6;

    // Paddle grows ~15% taller on hit, centered on its midpoint
    const growExtra = PADDLE_H * 0.15 * hitT;
    const effH = PADDLE_H + growExtra;
    const effY = y - growExtra / 2;

    // Paddle shifts ~3px toward the ball on hit (pushed-back feel)
    const shiftX = (x < GW / 2 ? 1 : -1) * 3 * hitT;
    const effX = x + shiftX;

    // Drop shadow
    ctx.shadowBlur = flash > 0 ? 16 : 12;
    ctx.shadowColor = flash > 0 ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.20)';

    // Determine curve direction: left paddle bows left, right paddle bows right
    const curveDir = x < GW / 2 ? 1 : -1;

    // Vertical gradient along the paddle stroke
    const grad = ctx.createLinearGradient(effX, effY, effX, effY + effH);
    if (flash > 0) {
      grad.addColorStop(0, '#fff');
      grad.addColorStop(0.5, '#fff');
      grad.addColorStop(1, '#eee');
    } else {
      grad.addColorStop(0, '#fff');
      grad.addColorStop(0.4, '#ddd');
      grad.addColorStop(1, '#777');
    }
    ctx.strokeStyle = grad;
    ctx.lineWidth = PADDLE_W;
    ctx.lineCap = 'round';

    // Curved arc paddle — quadratic bezier from top to bottom
    const startX = effX + PADDLE_W / 2;
    const endX = effX + PADDLE_W / 2;
    const cpX = startX + curveDir * PADDLE_CURVE;
    const cpY = effY + effH / 2;
    ctx.beginPath();
    ctx.moveTo(startX, effY);
    ctx.quadraticCurveTo(cpX, cpY, endX, effY + effH);
    ctx.stroke();

    ctx.restore();
  }

  // ── Game loop ──
  function gameLoop(timestamp) {
    if (mode !== 'playing') return;
    lastTime = timestamp;
    movePaddles();
    if (pointPause) {
      pointPauseFrames--;
      if (pointPauseFrames <= 0) {
        pointPause = false;
        pointIndicator.classList.remove('visible');
        canvas.parentElement.classList.remove('paused');
        resetBall(lastScorer === 1 ? -1 : 1);
        scheduleTaunt(lastScorer);
      }
    } else {
      updateBall();
    }
    updateParticles();
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

    const diffBtn = e.target.closest('.diff-btn');
    if (diffBtn) { selectDifficulty(diffBtn.dataset.diff); return; }

    if (e.target === $('diffBackBtn') || e.target.closest('#diffBackBtn')) {
      showScreen('menuScreen');
      mode = 'menu';
      return;
    }

    if (e.target.closest('#instrToggle')) {
      const panel = $('instrPanel');
      const toggle = $('instrToggle');
      panel.hidden = !panel.hidden;
      toggle.classList.toggle('open', !panel.hidden);
      return;
    }

    if (e.target === $('goPlayAgain') || e.target.closest('#goPlayAgain')) {
      hideOverlay('gameOverOverlay');
      if (gameMode === 'single') {
        showScreen('diffScreen');
        mode = 'menu';
      } else {
        startCountdown();
      }
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
