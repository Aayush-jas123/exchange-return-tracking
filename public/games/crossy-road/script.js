// ═══════════════════════════════════════════════════════════
// OFFCOMFRT Crossy Road — rebuilt from the raw source in
// html-css-javascript-games-main/07-Crossy-Road-Game/script.js
//
// The gameplay core below (constants, constructors, lane model,
// camera, lights, collision) is the original game. The portal
// shell — screens, XP report, RaceHub relay — is layered around
// it and never changes a gameplay constant.
// ═══════════════════════════════════════════════════════════
(() => {
  'use strict';

  // ── DOM refs ──
  const $ = (id) => document.getElementById(id);
  const counterDOM = $('counter');
  const grassTimerDOM = $('grassTimer');
  const menuScreen = $('menuScreen');
  const lobbyScreen = $('lobbyScreen');
  const gameScreen = $('gameScreen');
  const gameOverScreen = $('gameOverScreen');
  const goScore = $('goScore');
  const goXP = $('goXP');
  const goRank = $('goRank');
  const goResults = $('goResults');
  const canvasWrap = $('canvasWrap');

  // ── Scene + camera (source) ──
  const scene = new THREE.Scene();

  const distance = 500;
  const camera = new THREE.OrthographicCamera(
    window.innerWidth / -2,
    window.innerWidth / 2,
    window.innerHeight / 2,
    window.innerHeight / -2,
    0.1,
    10000
  );

  camera.rotation.x = (50 * Math.PI) / 180;
  camera.rotation.y = (20 * Math.PI) / 180;
  camera.rotation.z = (10 * Math.PI) / 180;

  const initialCameraPositionY = -Math.tan(camera.rotation.x) * distance;
  const initialCameraPositionX =
    Math.tan(camera.rotation.y) *
    Math.sqrt(distance ** 2 + initialCameraPositionY ** 2);
  camera.position.y = initialCameraPositionY;
  camera.position.x = initialCameraPositionX;
  camera.position.z = distance;

  const zoom = 2;

  const chickenSize = 15;

  const positionWidth = 42;
  const columns = 17;
  const boardWidth = positionWidth * columns;

  const stepTime = 200; // Miliseconds it takes for the chicken to take a step forward, backward, left or right

  let lanes;
  let currentLane;
  let currentColumn;

  let previousTimestamp;
  let startMoving;
  let moves;
  let stepStartTimestamp;

  // ── Shared world (online only) ──
  // An online room races one map: the hub's seed drives every random lane choice,
  // so all four screens build the same traffic from the same numbers. Solo keeps
  // Math.random and is untouched.
  let rng = Math.random; // active lane generator
  let myColor = 0; // seat colour 0..3 — also this runner's monochrome kit
  let raceT0 = 0; // traffic clock, restarted with every run
  const rand = () => rng();

  function seedWorld(seed) {
    const s = (Number(seed) || 0) >>> 0;
    if (!s) {
      rng = Math.random;
      return;
    }
    let a = s;
    // mulberry32 — four bytes of seed, no allocation, identical in every browser.
    rng = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Seat spawn columns, centre first: seating a runner never moves anyone else.
  const SPAWN_COLUMNS = [8, 6, 10, 4];
  const spawnColumn = (color) => SPAWN_COLUMNS[(((Number(color) | 0) % 4) + 4) % 4];

  // A cell is walkable when it is on the board and no tree or billboard claims it.
  function blockedAt(lane, column) {
    if (column < 0 || column >= columns || lane < 0) return true;
    const ln = lanes[lane];
    return !!(ln && ln.occupiedPositions && ln.occupiedPositions.has(column));
  }

  const colX = (column) =>
    (column * positionWidth + positionWidth / 2) * zoom - (boardWidth * zoom) / 2;
  const rowY = (lane) => lane * positionWidth * zoom;

  // Four monochrome kits, one per seat: ink, inverse, ash, slate. Body and plate
  // swap, so a bird stays readable on black road lanes and white grass alike.
  // Declared up here because the local bird is built before the constructors.
  const SKINS = [
    { body: 0x111111, plate: 0xffffff, band: 0xffffff, on: false },
    { body: 0xffffff, plate: 0x111111, band: 0x111111, on: true },
    { body: 0x6f6f6f, plate: 0xf4f4f4, band: 0x111111, on: true },
    { body: 0xa6a6a6, plate: 0x111111, band: 0xffffff, on: true }
  ];
  let _chickenGeo = null;

  // ── Portal state (additive only) ──
  let gameActive = false;
  let gameOverShown = false;
  let finalScore = 0;
  // An online race is paid by the RaceHub on the lanes each runner reports, so the
  // local portal report must stay off for it — otherwise the run pays twice.
  let onlineRun = false;

  // ── Grass is not a safe haven: 5 s standing still ends the run ──
  const GRASS_LIMIT = 5000;
  let grassLane = null; // lane the current countdown belongs to
  let grassMs = 0; // time accumulated on it
  let grassHudText = null; // last value pushed to the countdown chip

  // ── Vehicle face textures (source) ──
  const carFrontTexture = new Texture(40, 80, [{ x: 0, y: 10, w: 30, h: 60 }]);
  const carBackTexture = new Texture(40, 80, [{ x: 10, y: 10, w: 30, h: 60 }]);
  const carRightSideTexture = new Texture(110, 40, [
    { x: 10, y: 0, w: 50, h: 30 },
    { x: 70, y: 0, w: 30, h: 30 },
  ]);
  const carLeftSideTexture = new Texture(110, 40, [
    { x: 10, y: 10, w: 50, h: 30 },
    { x: 70, y: 10, w: 30, h: 30 },
  ]);

  const truckFrontTexture = new Texture(30, 30, [{ x: 15, y: 0, w: 10, h: 30 }]);
  const truckRightSideTexture = new Texture(25, 30, [
    { x: 0, y: 15, w: 10, h: 10 },
  ]);
  const truckLeftSideTexture = new Texture(25, 30, [
    { x: 0, y: 5, w: 10, h: 10 },
  ]);

  // One bold black line inside every truck roof panel. Built once, shared.
  const truckRoofStripeGeometry = new THREE.BoxBufferGeometry(
    52 * zoom,
    5 * zoom,
    0.6 * zoom
  );
  const truckRoofStripeMaterial = new THREE.MeshBasicMaterial({
    color: 0x0a0a0a,
  });

  // ── Lane generation (source) ──
  const generateLanes = () =>
    [-9, -8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
      .map((index) => {
        const lane = new Lane(index);
        lane.mesh.position.y = index * positionWidth * zoom;
        scene.add(lane.mesh);
        return lane;
      })
      .filter((lane) => lane.index >= 0);

  const addLane = () => {
    const index = lanes.length;
    const lane = new Lane(index);
    lane.mesh.position.y = index * positionWidth * zoom;
    scene.add(lane.mesh);
    lanes.push(lane);
  };

  const chicken = new Chicken();
  scene.add(chicken);

  // ── Lights (source) ──
  let hemiLight = new THREE.HemisphereLight(0xffffff, 0xffffff, 0.6);
  scene.add(hemiLight);

  const initialDirLightPositionX = -100;
  const initialDirLightPositionY = -100;
  let dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
  dirLight.position.set(initialDirLightPositionX, initialDirLightPositionY, 200);
  dirLight.castShadow = true;
  dirLight.target = chicken;
  scene.add(dirLight);

  dirLight.shadow.mapSize.width = 2048;
  dirLight.shadow.mapSize.height = 2048;
  const d = 500;
  dirLight.shadow.camera.left = -d;
  dirLight.shadow.camera.right = d;
  dirLight.shadow.camera.top = d;
  dirLight.shadow.camera.bottom = -d;

  let backLight = new THREE.DirectionalLight(0x000000, 0.4);
  backLight.position.set(200, 200, 50);
  backLight.castShadow = true;
  scene.add(backLight);

  const laneTypes = ['car', 'truck', 'forest'];
  const laneSpeeds = [2, 2.5, 3];
  const vechicleColors = [0xffffff, 0xd8d8d8, 0xa8a8a8];
  const threeHeights = [20, 45, 60];

  // Short brand lines carried by the grass billboards.
  const QUOTES = [
    'PAIN IS THE TUITION',
    'COMFORT BREEDS DECAY',
    'POTENTIAL MEANS NOTHING',
    'BUILT THROUGH RESISTANCE',
    'DISCIPLINE OVER DESIRE',
    'EASY NOW. EXPENSIVE LATER.',
    'PROGRESS DEMANDS DISCOMFORT',
    'BECOME BEYOND RECOGNITION',
  ];

  // Drawn once and shared by every billboard, before any lane exists.
  let _bannerTextures = QUOTES.map(buildBannerTexture);
  let _bannerBoardGeometry = null;
  let _bannerBackGeometry = null;
  let _bannerPostGeometry = null;
  let _bannerBoardMaterial = null;
  let _bannerPostMaterial = null;
  const _bannerFaceMaterials = new Map();

  // Grass lanes are the only safe lanes in the source; both variants count.
  const isGrass = (lane) =>
    !!lane && (lane.type === 'field' || lane.type === 'forest');

  // Writes only when the displayed value actually changes -- ~10 writes/sec.
  function updateGrassHud(secondsLeft) {
    if (!grassTimerDOM) return;
    const text = secondsLeft === null ? '' : secondsLeft.toFixed(1) + 's';
    if (text === grassHudText) return;
    grassHudText = text;
    grassTimerDOM.textContent = text;
    grassTimerDOM.classList.toggle('on', !!text);
    grassTimerDOM.classList.toggle(
      'danger',
      secondsLeft !== null && secondsLeft <= 2
    );
  }

  const initaliseValues = () => {
    lanes = generateLanes();

    currentLane = 0;
    currentColumn = spawnColumn(myColor);

    previousTimestamp = null;

    startMoving = false;
    moves = [];
    stepStartTimestamp = null;

    grassLane = null;
    grassMs = 0;
    updateGrassHud(null);

    // Everyone starts on their own column, so four birds never stack on spawn.
    const startX = colX(currentColumn);
    chicken.position.x = startX;
    chicken.position.y = 0;
    chicken.position.z = 0;

    camera.position.y = initialCameraPositionY;
    camera.position.x = initialCameraPositionX + startX;

    dirLight.position.x = initialDirLightPositionX + startX;
    dirLight.position.y = initialDirLightPositionY;

    // Traffic phase runs from the start of the run, so every screen shows the
    // same truck in the same place at the same moment.
    raceT0 = performance.now();
  };

  initaliseValues();

  // ── Renderer (source) ──
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
  });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setSize(window.innerWidth, window.innerHeight);
  (canvasWrap || document.body).appendChild(renderer.domElement);

  window.addEventListener('resize', onResize);

  function onResize() {
    camera.left = window.innerWidth / -2;
    camera.right = window.innerWidth / 2;
    camera.top = window.innerHeight / 2;
    camera.bottom = window.innerHeight / -2;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  // ══════════════════════════════════════════
  // Mesh constructors — unchanged from source
  // ══════════════════════════════════════════
  function Texture(width, height, rects) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.fillStyle = 'rgba(0,0,0,0.6)';
    rects.forEach((rect) => {
      context.fillRect(rect.x, rect.y, rect.w, rect.h);
    });
    return new THREE.CanvasTexture(canvas);
  }

  // Black board, white bold lettering. Built once per quote and shared.
  function buildBannerTexture(quote) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const context = canvas.getContext('2d');

    context.fillStyle = '#0a0a0a';
    context.fillRect(0, 0, canvas.width, canvas.height);

    context.fillStyle = '#ffffff';
    context.font = 'bold 72px -apple-system, Segoe UI, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';

    const lines = [];
    let line = '';
    quote.split(' ').forEach((word) => {
      const next = line ? line + ' ' + word : word;
      if (context.measureText(next).width > 448 && line) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    });
    if (line) lines.push(line);

    const step = 78;
    const startY = 128 - ((lines.length - 1) * step) / 2;
    lines.forEach((text, i) => {
      context.fillText(text, 256, startY + i * step);
    });

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  function Wheel() {
    const wheel = new THREE.Mesh(
      new THREE.BoxBufferGeometry(12 * zoom, 33 * zoom, 12 * zoom),
      new THREE.MeshLambertMaterial({ color: 0x333333, flatShading: true })
    );
    wheel.position.z = 6 * zoom;
    return wheel;
  }

  function Car() {
    const car = new THREE.Group();
    const color =
      vechicleColors[Math.floor(rand() * vechicleColors.length)];

    const main = new THREE.Mesh(
      new THREE.BoxBufferGeometry(60 * zoom, 30 * zoom, 15 * zoom),
      new THREE.MeshPhongMaterial({ color, flatShading: true })
    );
    main.position.z = 12 * zoom;
    main.castShadow = true;
    main.receiveShadow = true;
    car.add(main);

    const cabin = new THREE.Mesh(
      new THREE.BoxBufferGeometry(33 * zoom, 24 * zoom, 12 * zoom),
      [
        new THREE.MeshPhongMaterial({
          color: 0xcccccc,
          flatShading: true,
          map: carBackTexture,
        }),
        new THREE.MeshPhongMaterial({
          color: 0xcccccc,
          flatShading: true,
          map: carFrontTexture,
        }),
        new THREE.MeshPhongMaterial({
          color: 0xcccccc,
          flatShading: true,
          map: carRightSideTexture,
        }),
        new THREE.MeshPhongMaterial({
          color: 0xcccccc,
          flatShading: true,
          map: carLeftSideTexture,
        }),
        new THREE.MeshPhongMaterial({ color: 0xcccccc, flatShading: true }), // top
        new THREE.MeshPhongMaterial({ color: 0xcccccc, flatShading: true }), // bottom
      ]
    );
    cabin.position.x = 6 * zoom;
    cabin.position.z = 25.5 * zoom;
    cabin.castShadow = true;
    cabin.receiveShadow = true;
    car.add(cabin);

    const frontWheel = new Wheel();
    frontWheel.position.x = -18 * zoom;
    car.add(frontWheel);

    const backWheel = new Wheel();
    backWheel.position.x = 18 * zoom;
    car.add(backWheel);

    car.castShadow = true;
    car.receiveShadow = false;

    return car;
  }

  function Truck() {
    const truck = new THREE.Group();
    const color =
      vechicleColors[Math.floor(rand() * vechicleColors.length)];

    const base = new THREE.Mesh(
      new THREE.BoxBufferGeometry(100 * zoom, 25 * zoom, 5 * zoom),
      new THREE.MeshLambertMaterial({ color: 0xe8e8e8, flatShading: true })
    );
    base.position.z = 10 * zoom;
    truck.add(base);

    const cargo = new THREE.Mesh(
      new THREE.BoxBufferGeometry(75 * zoom, 35 * zoom, 40 * zoom),
      new THREE.MeshPhongMaterial({ color: 0xe8e8e8, flatShading: true })
    );
    cargo.position.x = 15 * zoom;
    cargo.position.z = 30 * zoom;
    cargo.castShadow = true;
    cargo.receiveShadow = true;
    truck.add(cargo);

    // Sits inside the roof panel: 11.5 units of roof left at each end,
    // 15 units either side, 0.1 above the surface so it cannot z-fight.
    const roofStripe = new THREE.Mesh(
      truckRoofStripeGeometry,
      truckRoofStripeMaterial
    );
    roofStripe.position.x = 15 * zoom;
    roofStripe.position.z = 50.4 * zoom;
    truck.add(roofStripe);

    const cabin = new THREE.Mesh(
      new THREE.BoxBufferGeometry(25 * zoom, 30 * zoom, 30 * zoom),
      [
        new THREE.MeshPhongMaterial({ color, flatShading: true }), // back
        new THREE.MeshPhongMaterial({
          color,
          flatShading: true,
          map: truckFrontTexture,
        }),
        new THREE.MeshPhongMaterial({
          color,
          flatShading: true,
          map: truckRightSideTexture,
        }),
        new THREE.MeshPhongMaterial({
          color,
          flatShading: true,
          map: truckLeftSideTexture,
        }),
        new THREE.MeshPhongMaterial({ color, flatShading: true }), // top
        new THREE.MeshPhongMaterial({ color, flatShading: true }), // bottom
      ]
    );
    cabin.position.x = -40 * zoom;
    cabin.position.z = 20 * zoom;
    cabin.castShadow = true;
    cabin.receiveShadow = true;
    truck.add(cabin);

    const frontWheel = new Wheel();
    frontWheel.position.x = -38 * zoom;
    truck.add(frontWheel);

    const middleWheel = new Wheel();
    middleWheel.position.x = -10 * zoom;
    truck.add(middleWheel);

    const backWheel = new Wheel();
    backWheel.position.x = 30 * zoom;
    truck.add(backWheel);

    return truck;
  }

  function Three() {
    const three = new THREE.Group();

    const trunk = new THREE.Mesh(
      new THREE.BoxBufferGeometry(15 * zoom, 15 * zoom, 20 * zoom),
      new THREE.MeshPhongMaterial({ color: 0x1f1f1f, flatShading: true })
    );
    trunk.position.z = 10 * zoom;
    trunk.castShadow = true;
    trunk.receiveShadow = true;
    three.add(trunk);

    const height =
      threeHeights[Math.floor(rand() * threeHeights.length)];

    const crown = new THREE.Mesh(
      new THREE.BoxBufferGeometry(30 * zoom, 30 * zoom, height * zoom),
      new THREE.MeshLambertMaterial({ color: 0x4a4a4a, flatShading: true })
    );
    crown.position.z = (height / 2 + 20) * zoom;
    crown.castShadow = true;
    crown.receiveShadow = false;
    three.add(crown);

    return three;
  }

  function skinOf(color) {
    const n = ((Number(color) | 0) % SKINS.length + SKINS.length) % SKINS.length;
    return SKINS[n];
  }

  // One set of boxes for every chicken on screen: four runners must not build
  // four copies of the same geometry.
  function chickenGeometries() {
    if (!_chickenGeo) {
      _chickenGeo = {
        plate: new THREE.BoxBufferGeometry(
          (chickenSize + 6) * zoom,
          (chickenSize + 6) * zoom,
          2 * zoom
        ),
        body: new THREE.BoxBufferGeometry(
          chickenSize * zoom,
          chickenSize * zoom,
          20 * zoom
        ),
        rowel: new THREE.BoxBufferGeometry(2 * zoom, 4 * zoom, 2 * zoom),
        band: new THREE.BoxBufferGeometry(
          (chickenSize + 1) * zoom,
          4 * zoom,
          20.4 * zoom
        )
      };
    }
    return _chickenGeo;
  }

  // Re-tint an existing bird in place — no rebuild, no new materials.
  function applySkin(chicken, color) {
    const parts = chicken.userData.parts;
    if (!parts) return;
    const skin = skinOf(color);
    parts.plate.material.color.setHex(skin.plate);
    parts.body.material.color.setHex(skin.body);
    parts.band.material.color.setHex(skin.band);
    parts.band.visible = skin.on;
    parts.rowel.material.color.setHex(skin.band);
  }

  function Chicken(color) {
    const skin = skinOf(color);
    const geo = chickenGeometries();
    const chicken = new THREE.Group();

    // Base slab: the dark bird stays readable on the black road lanes and is
    // hidden inside the grass block while standing on a grass lane.
    const plate = new THREE.Mesh(
      geo.plate,
      new THREE.MeshBasicMaterial({ color: skin.plate })
    );
    plate.position.z = 1 * zoom;
    chicken.add(plate);

    const body = new THREE.Mesh(
      geo.body,
      new THREE.MeshPhongMaterial({ color: skin.body, flatShading: true })
    );
    body.position.z = 10 * zoom;
    body.castShadow = true;
    body.receiveShadow = true;
    chicken.add(body);

    // Seat stripe: the mark that tells two monochrome birds apart at a glance.
    const band = new THREE.Mesh(
      geo.band,
      new THREE.MeshBasicMaterial({ color: skin.band })
    );
    band.position.z = 13 * zoom;
    band.visible = skin.on;
    chicken.add(band);

    const rowel = new THREE.Mesh(
      geo.rowel,
      new THREE.MeshLambertMaterial({ color: skin.band, flatShading: true })
    );
    rowel.position.z = 21 * zoom;
    rowel.castShadow = true;
    rowel.receiveShadow = false;
    chicken.add(rowel);

    chicken.userData.parts = { plate, body, band, rowel };
    return chicken;
  }

  function Road() {
    const road = new THREE.Group();

    const createSection = (color) =>
      new THREE.Mesh(
        new THREE.PlaneBufferGeometry(boardWidth * zoom, positionWidth * zoom),
        new THREE.MeshPhongMaterial({ color })
      );

    const middle = createSection(0x0a0a0a);
    middle.receiveShadow = true;
    road.add(middle);

    const left = createSection(0x141414);
    left.position.x = -boardWidth * zoom;
    road.add(left);

    const right = createSection(0x141414);
    right.position.x = boardWidth * zoom;
    road.add(right);

    return road;
  }

  function Grass() {
    const grass = new THREE.Group();

    const createSection = (color) =>
      new THREE.Mesh(
        new THREE.BoxBufferGeometry(
          boardWidth * zoom,
          positionWidth * zoom,
          3 * zoom
        ),
        new THREE.MeshPhongMaterial({ color })
      );

    const middle = createSection(0xffffff);
    middle.receiveShadow = true;
    grass.add(middle);

    const left = createSection(0xe4e4e4);
    left.position.x = -boardWidth * zoom;
    grass.add(left);

    const right = createSection(0xe4e4e4);
    right.position.x = boardWidth * zoom;
    grass.add(right);

    grass.position.z = 1.5 * zoom;
    return grass;
  }

  // One billboard per grass lane: lettering faces the player, two posts below.
  function Banner(texture) {
    const banner = new THREE.Group();

    if (!_bannerBoardGeometry) {
      _bannerBoardGeometry = new THREE.BoxBufferGeometry(
        30 * zoom,
        1.2 * zoom,
        26 * zoom
      );
      _bannerBackGeometry = new THREE.PlaneBufferGeometry(
        30 * zoom,
        26 * zoom
      );
      _bannerPostGeometry = new THREE.BoxBufferGeometry(
        2 * zoom,
        2 * zoom,
        20 * zoom
      );
      _bannerBoardMaterial = new THREE.MeshLambertMaterial({
        color: 0x0a0a0a,
        flatShading: true,
      });
      _bannerPostMaterial = new THREE.MeshLambertMaterial({
        color: 0x1a1a1a,
        flatShading: true,
      });
    }

    const board = new THREE.Mesh(_bannerBoardGeometry, _bannerBoardMaterial);
    board.position.z = 30 * zoom;
    board.castShadow = true;
    board.receiveShadow = true;
    banner.add(board);

    let face = _bannerFaceMaterials.get(texture);
    if (!face) {
      face = new THREE.MeshBasicMaterial({ map: texture });
      _bannerFaceMaterials.set(texture, face);
    }

    // The +90deg X rotation maps the plane's normal onto -Y (the camera side)
    // and its local up onto +Z, so the lettering faces and reads upright.
    const painted = new THREE.Mesh(_bannerBackGeometry, face);
    painted.rotation.x = Math.PI / 2;
    painted.position.y = -0.7 * zoom;
    painted.position.z = 30 * zoom;
    banner.add(painted);

    [-15, 15].forEach((x) => {
      const post = new THREE.Mesh(_bannerPostGeometry, _bannerPostMaterial);
      post.position.x = x * zoom;
      post.position.z = 10 * zoom;
      post.castShadow = true;
      banner.add(post);
    });

    return banner;
  }

  // Lane type is a plain 1-in-3 draw, exactly like the source.
  function Lane(index) {
    this.index = index;
    this.type =
      index <= 0
        ? 'field'
        : laneTypes[Math.floor(rand() * laneTypes.length)];

    switch (this.type) {
      case 'field': {
        this.type = 'field';
        this.mesh = new Grass();
        break;
      }
      case 'forest': {
        this.mesh = new Grass();

        this.occupiedPositions = new Set();
        // The billboard claims one column, so the tree count drops by one and
        // a grass lane still blocks exactly four columns.
        const treeCount = _bannerTextures.length ? 3 : 4;
        this.threes = [1, 2, 3, 4].slice(0, treeCount).map(() => {
          const three = new Three();
          let position;
          do {
            position = Math.floor(rand() * columns);
          } while (this.occupiedPositions.has(position));
          this.occupiedPositions.add(position);
          three.position.x =
            (position * positionWidth + positionWidth / 2) * zoom -
            (boardWidth * zoom) / 2;
          this.mesh.add(three);
          return three;
        });

        if (_bannerTextures.length) {
          let position;
          do {
            position = Math.floor(rand() * columns);
          } while (this.occupiedPositions.has(position));
          this.occupiedPositions.add(position);

          const banner = new Banner(
            _bannerTextures[
              Math.floor(rand() * _bannerTextures.length)
            ]
          );
          banner.position.x =
            (position * positionWidth + positionWidth / 2) * zoom -
            (boardWidth * zoom) / 2;
          this.mesh.add(banner);
        }
        break;
      }
      case 'car': {
        this.mesh = new Road();
        this.direction = rand() >= 0.5;

        const occupiedPositions = new Set();
        const count = index >= 45 ? 4 : index >= 15 ? 3 : 2;
        this.vechicles = Array.from({ length: count }, () => {
          const vechicle = new Car();
          let position;
          do {
            position = Math.floor((rand() * columns) / 2);
          } while (occupiedPositions.has(position));
          occupiedPositions.add(position);
          vechicle.position.x =
            (position * positionWidth * 2 + positionWidth / 2) * zoom -
            (boardWidth * zoom) / 2;
          vechicle.userData.x0 = vechicle.position.x;
          if (!this.direction) vechicle.rotation.z = Math.PI;
          this.mesh.add(vechicle);
          return vechicle;
        });

        this.speed =
          laneSpeeds[Math.floor(rand() * laneSpeeds.length)] *
          (1 + Math.min(index, 60) * 0.012);
        break;
      }
      case 'truck': {
        this.mesh = new Road();
        this.direction = rand() >= 0.5;

        const occupiedPositions = new Set();
        const count = index >= 25 ? 3 : 2;
        this.vechicles = Array.from({ length: count }, () => {
          const vechicle = new Truck();
          let position;
          do {
            position = Math.floor((rand() * columns) / 3);
          } while (occupiedPositions.has(position));
          occupiedPositions.add(position);
          vechicle.position.x =
            (position * positionWidth * 3 + positionWidth / 2) * zoom -
            (boardWidth * zoom) / 2;
          vechicle.userData.x0 = vechicle.position.x;
          if (!this.direction) vechicle.rotation.z = Math.PI;
          this.mesh.add(vechicle);
          return vechicle;
        });

        this.speed =
          laneSpeeds[Math.floor(rand() * laneSpeeds.length)] *
          (1 + Math.min(index, 60) * 0.012);
        break;
      }
    }
  }

  // ══════════════════════════════════════════
  // Portal shell
  // ══════════════════════════════════════════
  function showScreen(el) {
    [menuScreen, lobbyScreen, gameScreen, gameOverScreen].forEach((s) => {
      if (s) s.classList.remove('active');
    });
    if (el) el.classList.add('active');
    document.body.classList.toggle('in-game', el === gameScreen);
  }

  function resetGame() {
    lanes.forEach((lane) => scene.remove(lane.mesh));
    initaliseValues();
    gameOverShown = false;
    if (counterDOM) counterDOM.textContent = 0;
  }

  function startSoloGame() {
    onlineRun = false;
    myColor = 0;
    seedWorld(0);
    applySkin(chicken, myColor);
    clearRemotePlayers();
    showScreen(gameScreen);
    resetGame();
    gameActive = true;
  }

  // The hub names the race seed and this athlete's seat: the seed builds the map
  // for everyone, the seat picks the spawn column and the monochrome kit.
  function startOnlineGame(opts) {
    const o = opts || {};
    myColor = Number(o.color) || 0;
    seedWorld(o.seed);
    applySkin(chicken, myColor);
    onlineRun = true;
    clearRemotePlayers();
    showScreen(gameScreen);
    resetGame();
    gameActive = true;
  }

  function triggerGameOver(reason) {
    if (gameOverShown) return;
    gameOverShown = true;
    gameActive = false;
    finalScore = currentLane;

    // Solo runs pay through the portal bridge; the hub pays every runner of an
    // online race, so report to exactly one of them.
    if (!onlineRun && typeof AthleteXP !== 'undefined' && AthleteXP.report) {
      const paid = AthleteXP.report('crossy-road', finalScore);
      if (paid && paid.then) {
        paid.then(r => { if (r && r.awarded > 0 && goXP) goXP.textContent = '+' + r.awarded; });
      }
    }
    if (onlineRun && typeof Net !== 'undefined' && Net.sendEnd) {
      // The step that killed you never reached the end of `animate`, so the room
      // would keep seeing your previous cell: send the final one unconditionally.
      if (Net.sendState) Net.sendState(currentLane, currentColumn, currentLane, true);
      Net.sendEnd(finalScore);
    }

    if (goScore) goScore.textContent = finalScore;
    if (goXP) goXP.textContent = '--';
    if (goRank) goRank.textContent = '--';
    // An online scoreboard is written by the hub's results, so a crash must not
    // wipe it with the solo message.
    if (goResults && !onlineRun)
      goResults.textContent =
        reason === 'grass' ? 'Caught standing on the grass.' : '';
    updateGrassHud(null);
    showScreen(gameOverScreen);
  }

  // ── Remote runners (online only) ──
  // One record per opponent: the bird, the cell it is heading for and the hop it
  // is playing right now. Nothing in here allocates during a race.
  const remoteChickens = new Map(); // playerId -> { g, lane, col, fx, fy, t0 }

  // A name tag above each opponent, drawn once per runner and disposed with them.
  function nameTag(name) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 88;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, 256, 88);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, 250, 82);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 44px -apple-system, Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = String(name || 'Runner').trim().split(/\s+/)[0].toUpperCase();
    ctx.fillText(label.slice(0, 9), 128, 46);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false })
    );
    sprite.scale.set(72, 25, 1);
    sprite.position.z = 34 * zoom;
    return sprite;
  }

  function updateRemotePlayer(id, lane, column, name, color) {
    const l = Math.max(0, Number(lane) | 0);
    const c = Math.max(0, Math.min(columns - 1, Number(column) | 0));
    let r = remoteChickens.get(id);
    if (!r) {
      const g = Chicken(color);
      g.add(nameTag(name));
      g.position.x = colX(c);
      g.position.y = rowY(l);
      scene.add(g);
      remoteChickens.set(id, { g, lane: l, col: c, fx: colX(c), fy: rowY(l), t0: 0 });
      return;
    }
    // 10Hz relays land on whole cells: a repeated cell costs nothing at all.
    if (r.lane === l && r.col === c) return;
    r.lane = l;
    r.col = c;
    r.fx = r.g.position.x;
    r.fy = r.g.position.y;
    r.t0 = performance.now();
  }

  function disposeRemote(r) {
    // Geometry is shared by every bird, so only the per-runner materials and the
    // name tag texture are released here.
    r.g.traverse((o) => {
      if (o.material) {
        if (o.material.map) o.material.map.dispose();
        o.material.dispose();
      }
    });
    scene.remove(r.g);
  }

  function removeRemotePlayer(id) {
    const r = remoteChickens.get(id);
    if (!r) return;
    disposeRemote(r);
    remoteChickens.delete(id);
  }

  function clearRemotePlayers() {
    remoteChickens.forEach(disposeRemote);
    remoteChickens.clear();
  }

  // ── Shoving ──
  const PUSH_DIRECTIONS = {
    forward: { lane: 1, column: 0 },
    backward: { lane: -1, column: 0 },
    left: { lane: 0, column: -1 },
    right: { lane: 0, column: 1 }
  };

  // The map is shared, so the pusher can prove the shove is legal for everyone:
  // the runner standing on the cell this hop lands on is displaced one cell
  // further along the same heading, and only when that cell is walkable.
  function tryPush(cell, direction) {
    if (typeof Net === 'undefined' || !Net.playerAt || !Net.push) return;
    const d = PUSH_DIRECTIONS[direction];
    if (!d) return;
    // `cell` is where the step starts, so the landing cell is one step further.
    const landLane = cell.lane + d.lane;
    const landColumn = cell.column + d.column;
    const victim = Net.playerAt(landLane, landColumn);
    if (!victim) return;
    const lane = landLane + d.lane;
    const column = landColumn + d.column;
    if (blockedAt(lane, column)) return;
    Net.push(victim.id, lane, column);
  }

  // A shove the hub relayed. The victim's own screen applies it too, so the
  // crash (or the rescue) lands exactly where every runner saw it happen.
  function applyPush(id, lane, column) {
    const l = Math.max(0, Number(lane) | 0);
    const c = Math.max(0, Math.min(columns - 1, Number(column) | 0));

    if (typeof Net !== 'undefined' && Net.myId && String(id) === String(Net.myId)) {
      if (!gameActive) return;
      // Queued steps belong to the cell I was pushed out of.
      moves = [];
      stepStartTimestamp = null;
      currentLane = l;
      currentColumn = c;
      if (counterDOM) counterDOM.textContent = currentLane;
      const x = colX(c);
      const y = rowY(l);
      chicken.position.x = x;
      chicken.position.y = y;
      chicken.position.z = 0;
      camera.position.x = initialCameraPositionX + x;
      camera.position.y = initialCameraPositionY + y;
      dirLight.position.x = initialDirLightPositionX + x;
      dirLight.position.y = initialDirLightPositionY + y;
      return;
    }

    updateRemotePlayer(id, l, c);
  }

  // ══════════════════════════════════════════
  // Input
  // ══════════════════════════════════════════
  document
    .getElementById('forward')
    .addEventListener('click', () => move('forward'));

  document
    .getElementById('backward')
    .addEventListener('click', () => move('backward'));

  document.getElementById('left').addEventListener('click', () => move('left'));

  document.getElementById('right').addEventListener('click', () => move('right'));

  window.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp' || event.key === 'w' || event.key === 'W') {
      event.preventDefault();
      move('forward');
    } else if (
      event.key === 'ArrowDown' ||
      event.key === 's' ||
      event.key === 'S'
    ) {
      event.preventDefault();
      move('backward');
    } else if (
      event.key === 'ArrowLeft' ||
      event.key === 'a' ||
      event.key === 'A'
    ) {
      event.preventDefault();
      move('left');
    } else if (
      event.key === 'ArrowRight' ||
      event.key === 'd' ||
      event.key === 'D'
    ) {
      event.preventDefault();
      move('right');
    }
  });

  // Swipe: portal addition, mobile parity with the D-pad.
  (() => {
    let sx = 0;
    let sy = 0;
    gameScreen.addEventListener(
      'touchstart',
      (e) => {
        sx = e.touches[0].clientX;
        sy = e.touches[0].clientY;
      },
      { passive: true }
    );
    gameScreen.addEventListener(
      'touchend',
      (e) => {
        const dx = e.changedTouches[0].clientX - sx;
        const dy = e.changedTouches[0].clientY - sy;
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);
        if (Math.max(absDx, absDy) < 30) return;
        if (absDx > absDy) move(dx > 0 ? 'right' : 'left');
        else move(dy > 0 ? 'backward' : 'forward');
      },
      { passive: true }
    );
  })();

  // Portal buttons
  (() => {
    const soloBtn = $('btnSolo');
    const onlineBtn = $('btnOnline');
    const retryBtn = $('btnRetry');
    const backBtn = $('btnBackMenu');
    const instrToggle = $('instrToggle');
    const instrPanel = $('instrPanel');

    if (soloBtn) soloBtn.addEventListener('click', startSoloGame);
    // Every lobby entry funnels through openOnlineLobby, so a room link or an
    // invite toast lands in the live lobby instead of the menu.
    if (onlineBtn) onlineBtn.addEventListener('click', () => openOnlineLobby({ create: true }));
    if (retryBtn) retryBtn.addEventListener('click', () => {
      // A rematch of an online race happens in the room, not against the local world.
      if (onlineRun) { openOnlineLobby(); return; }
      startSoloGame();
    });
    if (backBtn) backBtn.addEventListener('click', () => showScreen(menuScreen));
    if (instrToggle)
      instrToggle.addEventListener('click', () => {
        instrToggle.classList.toggle('open');
        if (instrPanel) instrPanel.hidden = !instrPanel.hidden;
      });
  })();

  // ══════════════════════════════════════════
  // Movement — source logic, gated on an active run
  // ══════════════════════════════════════════
  function move(direction) {
    if (!gameActive) return;

    const finalPositions = moves.reduce(
      (position, move) => {
        if (move === 'forward')
          return { lane: position.lane + 1, column: position.column };
        if (move === 'backward')
          return { lane: position.lane - 1, column: position.column };
        if (move === 'left')
          return { lane: position.lane, column: position.column - 1 };
        if (move === 'right')
          return { lane: position.lane, column: position.column + 1 };
        return position;
      },
      { lane: currentLane, column: currentColumn }
    );

    if (direction === 'forward') {
      if (
        lanes[finalPositions.lane + 1] &&
        lanes[finalPositions.lane + 1].occupiedPositions &&
        lanes[finalPositions.lane + 1].occupiedPositions.has(
          finalPositions.column
        )
      )
        return;
      if (!stepStartTimestamp) startMoving = true;
      addLane();
    } else if (direction === 'backward') {
      if (finalPositions.lane === 0) return;
      if (
        lanes[finalPositions.lane - 1] &&
        lanes[finalPositions.lane - 1].occupiedPositions &&
        lanes[finalPositions.lane - 1].occupiedPositions.has(
          finalPositions.column
        )
      )
        return;
      if (!stepStartTimestamp) startMoving = true;
    } else if (direction === 'left') {
      if (finalPositions.column === 0) return;
      if (
        lanes[finalPositions.lane].occupiedPositions &&
        lanes[finalPositions.lane].occupiedPositions.has(
          finalPositions.column - 1
        )
      )
        return;
      if (!stepStartTimestamp) startMoving = true;
    } else if (direction === 'right') {
      if (finalPositions.column === columns - 1) return;
      if (
        lanes[finalPositions.lane].occupiedPositions &&
        lanes[finalPositions.lane].occupiedPositions.has(
          finalPositions.column + 1
        )
      )
        return;
      if (!stepStartTimestamp) startMoving = true;
    }
    // Online: landing on another runner shoves them on. Only a fresh step shoves
    // and only onto a walkable cell, so nobody is ever pushed into a tree.
    if (onlineRun && moves.length === 0) tryPush(finalPositions, direction);

    moves.push(direction);
  }

  // ══════════════════════════════════════════
  // Loop — source animation + portal hooks
  // ══════════════════════════════════════════
  function animate(timestamp) {
    requestAnimationFrame(animate);

    // Nothing moves while the menu, lobby or results are on screen.
    if (!gameActive) return;

    if (!previousTimestamp) previousTimestamp = timestamp;
    const delta = timestamp - previousTimestamp;
    previousTimestamp = timestamp;

    // Traffic is a pure function of (lane, elapsed), never of accumulated frame
    // deltas: every runner in the room sees the same truck in the same place at
    // the same instant, and a throttled tab cannot desync the lane.
    const laneStart = (-boardWidth * zoom) / 2 - positionWidth * 2 * zoom;
    const laneSpan = boardWidth * zoom + positionWidth * 4 * zoom;
    const elapsed = timestamp - raceT0;
    lanes.forEach((lane) => {
      if (lane.type !== 'car' && lane.type !== 'truck') return;
      const v = (lane.speed / 16) * (lane.direction ? -1 : 1);
      for (const vechicle of lane.vechicles) {
        const x = vechicle.userData.x0 + v * elapsed;
        vechicle.position.x =
          laneStart + (((x - laneStart) % laneSpan) + laneSpan) % laneSpan;
      }
    });

    // Remote runners hop between relayed cells: three objects at most, and only
    // while one of them is mid-step.
    if (remoteChickens.size) {
      for (const r of remoteChickens.values()) {
        if (!r.t0) continue;
        const p = (timestamp - r.t0) / stepTime;
        const e = p >= 1 ? 1 : p;
        const tx = colX(r.col);
        const ty = rowY(r.lane);
        r.g.position.x = r.fx + (tx - r.fx) * e;
        r.g.position.y = r.fy + (ty - r.fy) * e;
        r.g.position.z = Math.sin(e * Math.PI) * 8 * zoom;
        if (e >= 1) {
          r.t0 = 0;
          r.g.position.x = tx;
          r.g.position.y = ty;
          r.g.position.z = 0;
        }
      }
    }

    if (startMoving) {
      stepStartTimestamp = timestamp;
      startMoving = false;
    }

    if (stepStartTimestamp) {
      const moveDeltaTime = timestamp - stepStartTimestamp;
      const moveDeltaDistance =
        Math.min(moveDeltaTime / stepTime, 1) * positionWidth * zoom;
      const jumpDeltaDistance =
        Math.sin(Math.min(moveDeltaTime / stepTime, 1) * Math.PI) * 8 * zoom;
      switch (moves[0]) {
        case 'forward': {
          const positionY =
            currentLane * positionWidth * zoom + moveDeltaDistance;
          camera.position.y = initialCameraPositionY + positionY;
          dirLight.position.y = initialDirLightPositionY + positionY;
          chicken.position.y = positionY; // initial chicken position is 0

          chicken.position.z = jumpDeltaDistance;
          break;
        }
        case 'backward': {
          const positionY =
            currentLane * positionWidth * zoom - moveDeltaDistance;
          camera.position.y = initialCameraPositionY + positionY;
          dirLight.position.y = initialDirLightPositionY + positionY;
          chicken.position.y = positionY;

          chicken.position.z = jumpDeltaDistance;
          break;
        }
        case 'left': {
          const positionX =
            (currentColumn * positionWidth + positionWidth / 2) * zoom -
            (boardWidth * zoom) / 2 -
            moveDeltaDistance;
          camera.position.x = initialCameraPositionX + positionX;
          dirLight.position.x = initialDirLightPositionX + positionX;
          chicken.position.x = positionX; // initial chicken position is 0
          chicken.position.z = jumpDeltaDistance;
          break;
        }
        case 'right': {
          const positionX =
            (currentColumn * positionWidth + positionWidth / 2) * zoom -
            (boardWidth * zoom) / 2 +
            moveDeltaDistance;
          camera.position.x = initialCameraPositionX + positionX;
          dirLight.position.x = initialDirLightPositionX + positionX;
          chicken.position.x = positionX;

          chicken.position.z = jumpDeltaDistance;
          break;
        }
      }
      // Once a step has ended
      if (moveDeltaTime > stepTime) {
        switch (moves[0]) {
          case 'forward': {
            currentLane++;
            counterDOM.textContent = currentLane;
            break;
          }
          case 'backward': {
            currentLane--;
            counterDOM.textContent = currentLane;
            break;
          }
          case 'left': {
            currentColumn--;
            break;
          }
          case 'right': {
            currentColumn++;
            break;
          }
        }
        moves.shift();
        // If more steps are to be taken then restart counter otherwise stop stepping
        stepStartTimestamp = moves.length === 0 ? null : timestamp;
      }
    }

    // Standing on grass is fatal: five seconds per lane, and only changing
    // lanes restarts the clock -- hopping left and right buys no time.
    const standingOnGrass = isGrass(lanes[currentLane]);
    if (grassLane !== currentLane) {
      grassLane = currentLane;
      grassMs = 0;
    }
    grassMs = standingOnGrass ? grassMs + Math.min(delta, 200) : 0;

    if (standingOnGrass) {
      updateGrassHud(Math.max(0, (GRASS_LIMIT - grassMs) / 1000));
      // Only a settled player dies, so a hop begun at 4.9 s still escapes.
      if (moves.length === 0 && grassMs > GRASS_LIMIT) triggerGameOver('grass');
    } else {
      updateGrassHud(null);
    }

    // Hit test
    if (
      lanes[currentLane] &&
      (lanes[currentLane].type === 'car' ||
        lanes[currentLane].type === 'truck')
    ) {
      const chickenMinX = chicken.position.x - (chickenSize * zoom) / 2;
      const chickenMaxX = chicken.position.x + (chickenSize * zoom) / 2;
      const vechicleLength = { car: 60, truck: 105 }[lanes[currentLane].type];
      lanes[currentLane].vechicles.forEach((vechicle) => {
        const carMinX = vechicle.position.x - (vechicleLength * zoom) / 2;
        const carMaxX = vechicle.position.x + (vechicleLength * zoom) / 2;
        if (chickenMaxX > carMinX && chickenMinX < carMaxX) {
          triggerGameOver();
        }
      });
    }

    // Live position for the other runners in an online room.
    if (typeof Net !== 'undefined' && Net.sendState) {
      Net.sendState(currentLane, currentColumn, currentLane);
    }

    renderer.render(scene, camera);
  }

  // Every lobby entry (menu button, portal room link, invite toast) funnels
  // through here, so the cabinet is on the lobby screen before it seats.
  // Only the menu button asks for a room of its own; links join an existing one.
  function openOnlineLobby(opts) {
    showScreen(lobbyScreen);
    if (typeof Net !== 'undefined' && Net.connect) Net.connect(opts);
  }

  // ── Expose to the net module ──
  window.openOnlineLobby = openOnlineLobby;

  window.CrossyRoad = {
    startOnlineGame,
    updateRemotePlayer,
    removeRemotePlayer,
    clearRemotePlayers,
    applyPush,
    spawnColumn,
    triggerGameOver,
    showScreen,
    get screen() {
      return {
        menu: menuScreen,
        lobby: lobbyScreen,
        game: gameScreen,
        over: gameOverScreen,
      };
    },
  };

  showScreen(menuScreen);
  requestAnimationFrame(animate);
})();
