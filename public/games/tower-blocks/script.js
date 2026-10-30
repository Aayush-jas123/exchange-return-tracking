// ═══════════════════════════════════════════════════════════
// OFFCOMFRT Tower Blocks — rebuilt from the raw source in
// html-css-javascript-games-main/13-Tower-Blocks/script.js
//
// Part 1 below (Stage / Block / Game) is the original game: the
// same constants, the same stack model, the same tweens. Part 2
// is the portal shell — screens and the XP report — layered
// around it and never changing a gameplay value.
// Single player only: there is no net module for this cabinet.
// ═══════════════════════════════════════════════════════════
(() => {
  'use strict';

  // ── DOM refs (cached once) ──
  const $ = (id) => document.getElementById(id);
  const menuScreen = $('menuScreen');
  const gameScreen = $('gameScreen');
  const gameOverScreen = $('gameOverScreen');
  const goScore = $('goScore');
  const goXP = $('goXP');
  const goRank = $('goRank');
  const goResults = $('goResults');
  const quoteDOM = $('quote');

  // ── Palette (monochrome cabinet: pale board, two-tone stack) ──
  const C_BG = 0xd0d0d0;
  const C_BASE = 0x101010;
  const C_LIGHT = 0xe9e9e9;
  const C_DARK = 0x4a4a4a;

  // One material per shade, shared by every mesh cut from that block.
  const materials = new Map();
  function materialFor(color) {
    let material = materials.get(color);
    if (!material) {
      material = new THREE.MeshToonMaterial({ color: color });
      materials.set(color, material);
    }
    return material;
  }

  // The source builds each box with a half-extent translation so a block's
  // position is its corner, not its centre.
  function makeMesh(dimension, material) {
    const geometry = new THREE.BoxBufferGeometry(
      dimension.width,
      dimension.height,
      dimension.depth
    );
    geometry.translate(
      dimension.width / 2,
      dimension.height / 2,
      dimension.depth / 2
    );
    return new THREE.Mesh(geometry, material);
  }

  // ══════════════════════════════════════════
  // Part 1 — source game
  // ══════════════════════════════════════════

  // ── Stage: renderer, orthographic camera, lights (source) ──
  function Stage() {
    this.container = document.getElementById('game');

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(C_BG, 1);
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();

    const aspect = window.innerWidth / window.innerHeight;
    const d = 20;
    this.camera = new THREE.OrthographicCamera(
      -d * aspect,
      d * aspect,
      d,
      -d,
      -100,
      1000
    );
    this.camera.position.x = 2;
    this.camera.position.y = 2;
    this.camera.position.z = 2;
    this.camera.lookAt(new THREE.Vector3(0, 0, 0));

    this.light = new THREE.DirectionalLight(0xffffff, 0.5);
    this.light.position.set(0, 499, 0);
    this.scene.add(this.light);

    this.softLight = new THREE.AmbientLight(0xffffff, 0.4);
    this.scene.add(this.softLight);

    window.addEventListener('resize', () => this.onResize());
    this.onResize();
  }

  Stage.prototype.render = function () {
    this.renderer.render(this.scene, this.camera);
  };

  Stage.prototype.add = function (elem) {
    this.scene.add(elem);
  };

  Stage.prototype.remove = function (elem) {
    this.scene.remove(elem);
  };

  Stage.prototype.setCamera = function (y, speed) {
    if (speed === undefined) speed = 0.3;
    TweenLite.to(this.camera.position, speed, {
      y: y + 4,
      ease: Power1.easeInOut,
    });
    TweenLite.to(this.camera.lookAt, speed, { y: y, ease: Power1.easeInOut });
  };

  Stage.prototype.onResize = function () {
    const viewSize = 30;
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.camera.left = window.innerWidth / -viewSize;
    this.camera.right = window.innerWidth / viewSize;
    this.camera.top = window.innerHeight / viewSize;
    this.camera.bottom = window.innerHeight / -viewSize;
    this.camera.updateProjectionMatrix();
  };

  // ── Block: one slab of the tower (source) ──
  function Block(targetBlock) {
    this.STATES = { ACTIVE: 'active', STOPPED: 'stopped', MISSED: 'missed' };
    this.MOVE_AMOUNT = 12;
    this.dimension = { width: 0, height: 0, depth: 0 };
    this.position = { x: 0, y: 0, z: 0 };
    this.targetBlock = targetBlock;

    this.index = (targetBlock ? targetBlock.index : 0) + 1;
    this.workingPlane = this.index % 2 ? 'x' : 'z';
    this.workingDimension = this.index % 2 ? 'width' : 'depth';

    // Dimensions, position and the working axis all come from the block below.
    this.dimension.width = targetBlock ? targetBlock.dimension.width : 10;
    this.dimension.height = targetBlock ? targetBlock.dimension.height : 2;
    this.dimension.depth = targetBlock ? targetBlock.dimension.depth : 10;
    this.position.x = targetBlock ? targetBlock.position.x : 0;
    this.position.y = this.dimension.height * this.index;
    this.position.z = targetBlock ? targetBlock.position.z : 0;

    // Two-tone greyscale: neighbours never share a shade, so every joint
    // reads against the block under it (the source used a pastel sin ramp).
    this.color = !targetBlock ? C_BASE : this.index % 2 ? C_LIGHT : C_DARK;

    this.state = this.index > 1 ? this.STATES.ACTIVE : this.STATES.STOPPED;

    this.speed = -0.1 - this.index * 0.005;
    if (this.speed < -4) this.speed = -4;
    this.direction = this.speed;

    this.material = materialFor(this.color);
    this.mesh = makeMesh(this.dimension, this.material);
    this.mesh.position.set(this.position.x, this.position.y, this.position.z);

    if (this.state === this.STATES.ACTIVE) {
      this.position[this.workingPlane] =
        Math.random() > 0.5 ? -this.MOVE_AMOUNT : this.MOVE_AMOUNT;
      this.mesh.position[this.workingPlane] = this.position[this.workingPlane];
    }
  }

  Block.prototype.reverseDirection = function () {
    this.direction = this.direction > 0 ? this.speed : Math.abs(this.speed);
  };

  Block.prototype.place = function () {
    this.state = this.STATES.STOPPED;
    let overlap =
      this.targetBlock.dimension[this.workingDimension] -
      Math.abs(
        this.position[this.workingPlane] -
          this.targetBlock.position[this.workingPlane]
      );
    const blocksToReturn = {
      plane: this.workingPlane,
      direction: this.direction,
    };

    // Within a hair of perfect: snap back to the full footprint and pay a bonus.
    if (this.dimension[this.workingDimension] - overlap < 0.3) {
      overlap = this.dimension[this.workingDimension];
      blocksToReturn.bonus = true;
      this.position.x = this.targetBlock.position.x;
      this.position.z = this.targetBlock.position.z;
      this.dimension.width = this.targetBlock.dimension.width;
      this.dimension.depth = this.targetBlock.dimension.depth;
    }

    if (overlap > 0) {
      const choppedDimensions = {
        width: this.dimension.width,
        height: this.dimension.height,
        depth: this.dimension.depth,
      };
      choppedDimensions[this.workingDimension] -= overlap;
      this.dimension[this.workingDimension] = overlap;

      const placedMesh = makeMesh(this.dimension, this.material);
      const choppedMesh = makeMesh(choppedDimensions, this.material);

      const choppedPosition = {
        x: this.position.x,
        y: this.position.y,
        z: this.position.z,
      };
      if (
        this.position[this.workingPlane] <
        this.targetBlock.position[this.workingPlane]
      ) {
        this.position[this.workingPlane] = this.targetBlock.position[
          this.workingPlane
        ];
      } else {
        choppedPosition[this.workingPlane] += overlap;
      }
      placedMesh.position.set(
        this.position.x,
        this.position.y,
        this.position.z
      );
      choppedMesh.position.set(
        choppedPosition.x,
        choppedPosition.y,
        choppedPosition.z
      );

      blocksToReturn.placed = placedMesh;
      if (!blocksToReturn.bonus) blocksToReturn.chopped = choppedMesh;
    } else {
      this.state = this.STATES.MISSED;
    }

    this.dimension[this.workingDimension] = overlap;
    return blocksToReturn;
  };

  Block.prototype.tick = function () {
    if (this.state === this.STATES.ACTIVE) {
      const value = this.position[this.workingPlane];
      if (value > this.MOVE_AMOUNT || value < -this.MOVE_AMOUNT)
        this.reverseDirection();
      this.position[this.workingPlane] += this.direction;
      this.mesh.position[this.workingPlane] = this.position[this.workingPlane];
    }
  };

  // ── Game: the tower, its state machine and the render loop (source) ──
  function Game() {
    this.STATES = {
      LOADING: 'loading',
      PLAYING: 'playing',
      READY: 'ready',
      ENDED: 'ended',
      RESETTING: 'resetting',
    };
    this.blocks = [];
    this.state = this.STATES.LOADING;
    this.onEnd = null;

    this.stage = new Stage();
    this.mainContainer = document.getElementById('container');
    this.scoreContainer = document.getElementById('score');
    this.instructions = document.getElementById('instructions');
    this.scoreContainer.innerHTML = '0';

    this.newBlocks = new THREE.Group();
    this.placedBlocks = new THREE.Group();
    this.choppedBlocks = new THREE.Group();
    this.stage.add(this.newBlocks);
    this.stage.add(this.placedBlocks);
    this.stage.add(this.choppedBlocks);

    this.addBlock();
    this.tick();
    this.updateState(this.STATES.READY);
  }

  Game.prototype.updateState = function (newState) {
    for (const key in this.STATES)
      this.mainContainer.classList.remove(this.STATES[key]);
    this.mainContainer.classList.add(newState);
    this.state = newState;
  };

  // Ready -> start, playing -> drop. An ended run is handled by the results
  // screen (the source restarted straight from the click, the portal does not).
  Game.prototype.onAction = function () {
    switch (this.state) {
      case this.STATES.READY:
        this.startGame();
        break;
      case this.STATES.PLAYING:
        this.placeBlock();
        break;
    }
  };

  Game.prototype.startGame = function () {
    if (this.state !== this.STATES.PLAYING) {
      this.scoreContainer.innerHTML = '0';
      this.updateState(this.STATES.PLAYING);
      this.addBlock();
    }
  };

  Game.prototype.restartGame = function () {
    this.updateState(this.STATES.RESETTING);

    const oldBlocks = this.placedBlocks.children;
    const removeSpeed = 0.2;
    const delayAmount = 0.02;

    for (let i = 0; i < oldBlocks.length; i++) {
      const mesh = oldBlocks[i];
      TweenLite.to(mesh.scale, removeSpeed, {
        x: 0,
        y: 0,
        z: 0,
        delay: (oldBlocks.length - i) * delayAmount,
        ease: Power1.easeIn,
        onComplete: () => {
          this.placedBlocks.remove(mesh);
          mesh.geometry.dispose();
        },
      });
      TweenLite.to(mesh.rotation, removeSpeed, {
        y: 0.5,
        delay: (oldBlocks.length - i) * delayAmount,
        ease: Power1.easeIn,
      });
    }

    const cameraMoveSpeed = removeSpeed * 2 + oldBlocks.length * delayAmount;
    this.stage.setCamera(2, cameraMoveSpeed);

    const countdown = { value: this.blocks.length - 1 };
    TweenLite.to(countdown, cameraMoveSpeed, {
      value: 0,
      onUpdate: () => {
        this.scoreContainer.innerHTML = String(Math.round(countdown.value));
      },
    });

    this.blocks = this.blocks.slice(0, 1);
    setTimeout(() => {
      this.startGame();
    }, cameraMoveSpeed * 1000);
  };

  Game.prototype.placeBlock = function () {
    const currentBlock = this.blocks[this.blocks.length - 1];
    const newBlocks = currentBlock.place();

    this.newBlocks.remove(currentBlock.mesh);
    currentBlock.mesh.geometry.dispose();

    if (newBlocks.placed) this.placedBlocks.add(newBlocks.placed);

    if (newBlocks.chopped) {
      this.choppedBlocks.add(newBlocks.chopped);
      const positionParams = {
        y: '-=30',
        ease: Power1.easeIn,
        onComplete: () => {
          this.choppedBlocks.remove(newBlocks.chopped);
          newBlocks.chopped.geometry.dispose();
        },
      };
      const rotateRandomness = 10;
      const rotationParams = {
        delay: 0.05,
        x:
          newBlocks.plane === 'z'
            ? Math.random() * rotateRandomness - rotateRandomness / 2
            : 0.1,
        z:
          newBlocks.plane === 'x'
            ? Math.random() * rotateRandomness - rotateRandomness / 2
            : 0.1,
        y: Math.random() * 0.1,
      };
      if (
        newBlocks.chopped.position[newBlocks.plane] >
        newBlocks.placed.position[newBlocks.plane]
      ) {
        positionParams[newBlocks.plane] =
          '+=' + 40 * Math.abs(newBlocks.direction);
      } else {
        positionParams[newBlocks.plane] =
          '-=' + 40 * Math.abs(newBlocks.direction);
      }
      TweenLite.to(newBlocks.chopped.position, 1, positionParams);
      TweenLite.to(newBlocks.chopped.rotation, 1, rotationParams);
    }

    this.addBlock();
  };

  Game.prototype.addBlock = function () {
    const lastBlock = this.blocks[this.blocks.length - 1];
    if (lastBlock && lastBlock.state === lastBlock.STATES.MISSED) {
      return this.endGame();
    }

    this.scoreContainer.innerHTML = String(this.blocks.length - 1);

    // Hand the live count to the shell so the HUD copy can follow it.
    if (typeof this.onScore === 'function') this.onScore(this.blocks.length - 1);

    const newKidOnTheBlock = new Block(lastBlock);
    this.newBlocks.add(newKidOnTheBlock.mesh);
    this.blocks.push(newKidOnTheBlock);

    this.stage.setCamera(this.blocks.length * 2);
    if (this.blocks.length >= 5) this.instructions.classList.add('hide');
  };

  Game.prototype.endGame = function () {
    this.updateState(this.STATES.ENDED);
    if (typeof this.onEnd === 'function') this.onEnd(this.blocks.length - 1);
  };

  Game.prototype.tick = function () {
    // The source loop runs forever from construction; the cabinet only steps
    // and draws while a run is on screen, so the menu costs nothing.
    const running =
      this.state === this.STATES.PLAYING ||
      this.state === this.STATES.RESETTING;
    if (running) {
      this.blocks[this.blocks.length - 1].tick();
      this.stage.render();
    }
    requestAnimationFrame(() => this.tick());
  };

  /* ══════════════════════════════════════════
     Part 2 — portal shell
     ══════════════════════════════════════════ */

  const game = new Game();

  function showScreen(el) {
    [menuScreen, gameScreen, gameOverScreen].forEach((screen) => {
      if (screen) screen.classList.remove('active');
    });
    if (el) el.classList.add('active');
  }

  function startSoloGame() {
    goScore.textContent = '0';
    goXP.textContent = '--';
    goRank.textContent = '--';
    goResults.textContent = '';
    nextQuote();
    showScreen(gameScreen);
    if (game.state === game.STATES.ENDED) game.restartGame();
    else game.startGame();
  }

  // A finished run pays through the portal bridge; the tile then reports what
  // the server actually credited, which is not always the raw block count.
  function endRun(score) {
    goScore.textContent = score;
    goRank.textContent = score;
    goXP.textContent = '--';
    goResults.textContent = '';
    showScreen(gameOverScreen);

    if (typeof AthleteXP === 'undefined' || !AthleteXP.report) return;
    AthleteXP.report('tower-blocks', score).then((result) => {
      if (result) goXP.textContent = '+' + (result.awarded || 0) + ' XP';
      else goXP.textContent = '--';
    });
  }

  // ── Comfort-zone copy: a new line under the count every 3 blocks ──
  // Short, unattributed sayings in the brand's register: discomfort in, growth out.
  const QUOTES = [
    'Comfort is a ceiling.',
    'Nothing grows on the ground floor.',
    "You don't grow where it's safe.",
    'Discomfort is the price of becoming.',
    'The tower only rises off the base.',
    'Friction first, strength after.',
    'Easy keeps you exactly where you are.',
    'Uncomfortable is the direction of growth.',
    "Pressure is proof you're climbing.",
    'Harder drop, higher floor.',
    'Every hard rep is a brick you keep.',
    'Grow against gravity.',
    'The edge is where your shape changes.',
    'Outgrow the ground you were given.',
    'Move before you feel ready.',
    'Comfort zone, waiting room.',
    'Height is built one risk at a time.',
    'Be the one who never settles.',
    'Fall forward, then stack again.',
    'A little higher, a little less safe.',
    'Strong is what uncomfortable leaves behind.'
  ];

  // Shuffled bag: every line is used once before any of them repeats.
  let quoteBag = [];

  function nextQuote() {
    if (!quoteBag.length) {
      quoteBag = QUOTES.map((_, index) => index);
      for (let i = quoteBag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const held = quoteBag[i];
        quoteBag[i] = quoteBag[j];
        quoteBag[j] = held;
      }
    }
    const line = QUOTES[quoteBag.pop()];
    if (quoteDOM && quoteDOM.textContent !== line) quoteDOM.textContent = line;
  }

  // Every run opens with a fresh line (see startSoloGame); after that the copy
  // turns over each time the tower grows by three.
  function onScore(score) {
    if (score > 0 && score % 3 === 0) nextQuote();
  }

  game.onEnd = endRun;
  game.onScore = onScore;

  // Drop the block on a tap or click anywhere on the board. The portal-back
  // chip, the menu and the result buttons sit outside this screen (and the
  // chip stops its own events), so none of them can place a block.
  gameScreen.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    game.onAction();
  });

  window.addEventListener('keydown', (event) => {
    if (event.key !== ' ' && event.code !== 'Space') return;
    if (!gameScreen.classList.contains('active')) return;
    event.preventDefault();
    game.onAction();
  });

  // ── Portal buttons ──
  (() => {
    const soloBtn = $('btnSolo');
    const retryBtn = $('btnRetry');
    const backBtn = $('btnBackMenu');
    const instrToggle = $('instrToggle');
    const instrPanel = $('instrPanel');

    if (soloBtn) soloBtn.addEventListener('click', startSoloGame);
    if (retryBtn) retryBtn.addEventListener('click', startSoloGame);
    if (backBtn) backBtn.addEventListener('click', () => showScreen(menuScreen));
    if (instrToggle)
      instrToggle.addEventListener('click', () => {
        instrToggle.classList.toggle('open');
        if (instrPanel) instrPanel.hidden = !instrPanel.hidden;
      });
  })();
})();
