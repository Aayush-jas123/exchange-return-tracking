import * as THREE from 'three';

// ════════════════════════════════════════════════════════════
//  OFFCOMFRT Arcade — Counter Strike
//  Portal-integrated FPS engine · Three.js v0.160
// ════════════════════════════════════════════════════════════

// ── Screen management ──
const menuScreen = document.getElementById('menuScreen');
const gameScreen = document.getElementById('gameScreen');
const gameOverScreen = document.getElementById('gameOverScreen');
const lobbyScreen = document.getElementById('lobbyScreen');
const pauseOverlay = document.getElementById('pauseOverlay');

function showScreen(el) {
  [menuScreen, gameScreen, gameOverScreen, lobbyScreen, missionSelectScreen, missionBriefingScreen, missionCompleteScreen].forEach(s => {
    if (s) s.classList.remove('active');
  });
  if (el) el.classList.add('active');
}

// Instructions toggle
const instrToggle = document.getElementById('instrToggle');
const instrPanel = document.getElementById('instrPanel');
instrToggle.addEventListener('click', () => {
  const open = instrPanel.toggleAttribute('hidden') === false;
  instrToggle.classList.toggle('open', open);
});

// ── Map Selection ──
let selectedMap = 'industrial'; // Default to new industrial complex
const mapOptions = document.querySelectorAll('.map-option');
mapOptions.forEach(btn => {
  btn.addEventListener('click', () => {
    mapOptions.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedMap = btn.dataset.map;
    console.log('[CS] Map selected:', selectedMap);
    // Update multiplayer network module if available
    if (typeof window.CSNet !== 'undefined' && window.CSNet.setMap) {
      window.CSNet.setMap(selectedMap);
    }
  });
});

// ── Mobile detection (needed before renderer setup) ──
const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
const isMobile = isTouchDevice || innerWidth < 768;

// ── Mobile immersive mode: a phone gets full screen, in landscape, before it gets a game ──
// Both halves of that can only be asked for from inside a touch gesture, so the attempt rides
// a capture-phase pointerdown (every tap re-tries until it sticks) plus the gate's own button.
// Android Chrome honours the fullscreen request and the orientation lock. iOS Safari honours
// neither — it has no element fullscreen API and no lock — so on that engine the gate degrades
// to a rotate prompt that clears itself the moment the device is physically sideways, with a
// note pointing at the one route that does give an iPhone a chromeless landscape frame.
// Keyed off the coarse-pointer media query rather than isMobile, which also catches a narrow
// desktop window and must never hijack that browser into fullscreen.
const isPhone = isTouchDevice && matchMedia('(hover: none) and (pointer: coarse)').matches;
const mobileGate = document.getElementById('mobileGate');
const gateNote = document.getElementById('gateNote');
const btnGateImmersive = document.getElementById('btnGateImmersive');

const settle = (p) => { if (p && typeof p.catch === 'function') p.catch(() => {}); };
const fullscreenOn = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
const standaloneOn = () => matchMedia('(display-mode: standalone)').matches
  || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
const canFullscreen = () => !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
// screen.orientation.type is the only reading that survives a locked orientation, where
// innerWidth/innerHeight can still report the old axis on some Android builds.
const inLandscape = () => {
  const t = (screen.orientation && screen.orientation.type) || '';
  return t ? t.indexOf('landscape') === 0 : innerWidth >= innerHeight;
};

function lockLandscape() {
  // Modern Android hangs the lock off screen.orientation; older WebKit put lockOrientation on
  // screen itself. Try whichever exists, in that order.
  const o = screen.orientation;
  const candidates = [[o, o && (o.lock || o.webkitLock)],
    [screen, screen.lockOrientation || screen.webkitLockOrientation || screen.mozLockOrientation]];
  for (const [target, lock] of candidates) {
    if (typeof lock !== 'function') continue;
    // Rejected unless the document is already fullscreen, and absent outright on iOS. Either
    // way the gate stays up and the athlete turns the phone, which is the fallback anyway.
    try { settle(lock.call(target, 'landscape')); } catch (_) {}
    return;
  }
}

function requestImmersive() {
  if (!isPhone || standaloneOn()) return;
  if (!fullscreenOn()) {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) { try { settle(req.call(el, { navigationUI: 'hide' })); } catch (_) {} }
  }
  lockLandscape();
}

let gateShown = null;
function syncMobileGate() {
  if (!mobileGate) return;
  const want = isPhone && !inLandscape();
  if (want === gateShown) return;
  gateShown = want;
  mobileGate.hidden = !want;
  if (!want) return;
  // Which half of the card gets to speak depends on the engine. Where there is no element
  // fullscreen API — every iPhone browser — the button could only ever lie, so it is removed
  // and the install note takes over; where the API exists the note would send people hunting
  // through a Share sheet for nothing, so it goes the other way.
  const can = canFullscreen();
  if (gateNote) gateNote.hidden = can;
  if (btnGateImmersive) btnGateImmersive.hidden = !can;
}

if (isPhone) {
  document.addEventListener('pointerdown', () => {
    // A live round is not interrupted: the tap that deployed already did this work, so
    // re-entering fullscreen after an athlete deliberately left it would be a hijack.
    if (game.state === 'playing' && inLandscape()) return;
    requestImmersive();
  }, { capture: true });
  ['fullscreenchange', 'webkitfullscreenchange'].forEach((ev) => document.addEventListener(ev, () => {
    if (fullscreenOn()) lockLandscape(); // the lock only takes once we are actually in there
    syncMobileGate();
  }));
  // Sync at once so the card disappears the moment the phone turns, and again after the
  // viewport settles, because screen.orientation.type can land one tick behind the resize.
  addEventListener('orientationchange', () => { lockLandscape(); syncMobileGate(); setTimeout(syncMobileGate, 260); });
  addEventListener('resize', () => syncMobileGate());
  if (btnGateImmersive) btnGateImmersive.addEventListener('click', () => {
    audio().resume();
    requestImmersive();
    syncMobileGate();
  });

  syncMobileGate();
}

// ── Renderer / scene ──
const renderer = new THREE.WebGLRenderer({ antialias: !isMobile });
renderer.setPixelRatio(isMobile ? Math.min(devicePixelRatio, 1.5) : Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = isMobile ? THREE.BasicShadowMap : THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false; // throttle: manually flag every N frames below
let _shadowFrame = 0;
let _radarFrame = 0;
renderer.autoClear = false;
renderer.domElement.id = 'game';
gameScreen.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a2a2e); // lighter monochrome gray
scene.fog = new THREE.Fog(0x2a2a2e, 50, 160);

// Fast-path traversal: after the static freeze (matrixAutoUpdate=false on all
// worldMeshes), skip the recursive matrix update for frozen nodes. This saves
// ~1,000 function-call/branch evaluations per frame — the main source of jank
// when rotating the view or moving fast through the map.
scene.updateMatrixWorld = function (force) {
  if (!force && !this.matrixWorldNeedsUpdate) {
    // Static meshes are already finalized; only visit dynamic children.
    for (let i = 0; i < this.children.length; i++) {
      const c = this.children[i];
      if (c.matrixAutoUpdate) c.updateMatrixWorld(true);
    }
    return;
  }
  // Full path (rare: first frame or forced update)
  if (this.matrixAutoUpdate) this.updateMatrix();
  if (this.matrixWorldNeedsUpdate || force) {
    if (this.parent === null) this.matrixWorld.copy(this.matrix);
    this.matrixWorldNeedsUpdate = false;
    force = true;
  }
  for (let i = 0; i < this.children.length; i++) {
    this.children[i].updateMatrixWorld(force);
  }
};

const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.03, 300);
camera.rotation.order = 'YXZ';
scene.add(camera);

const weaponScene = new THREE.Scene();
const weaponCam = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 10);

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = weaponCam.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  weaponCam.updateProjectionMatrix();
});

// Monochrome dramatic lighting
scene.add(new THREE.HemisphereLight(0xffffff, 0x1a1a1e, 1.8));
const sun = new THREE.DirectionalLight(0xffffff, 3.2);
sun.position.set(30, 55, 18);
sun.castShadow = true;
sun.shadow.mapSize.set(isMobile ? 1024 : 2048, isMobile ? 1024 : 2048);
Object.assign(sun.shadow.camera, { left: -48, right: 68, top: 58, bottom: -58, near: 1, far: 180 });
sun.shadow.bias = -0.0006;
scene.add(sun);

// Weapon scene lighting (monochrome)
weaponScene.add(new THREE.HemisphereLight(0xffffff, 0x2a2a32, 2.5));
const wLight = new THREE.DirectionalLight(0xffffff, 1.8);
wLight.position.set(1, 2, 1);
weaponScene.add(wLight);

// Muzzle flash (white instead of orange)
const muzzleLight = new THREE.PointLight(0xffffff, 0, 9, 2);
scene.add(muzzleLight);

// ── Procedural textures ──
function makeTexture(draw, size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  draw(g, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

function speckle(g, s, base, amount, count, size = 2) {
  g.fillStyle = base;
  g.fillRect(0, 0, s, s);
  for (let i = 0; i < count; i++) {
    const v = (Math.random() - 0.5) * amount;
    g.fillStyle = v > 0 ? `rgba(255,255,255,${v})` : `rgba(0,0,0,${-v})`;
    g.fillRect(Math.random() * s, Math.random() * s, size, size);
  }
}

// ── OFFCOMFRT Branded Procedural Textures (Monochrome) ──
// OFFCOMFRT branded wall texture with text
function brandedWallTexture(text = 'OFFCOMFRT') {
  return makeTexture((g, s) => {
    // Dark concrete base
    speckle(g, s, '#1a1a1e', 0.15, 8000);
    // Horizontal lines
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.lineWidth = 1;
    for (let y = 0; y < s; y += s / 12) {
      g.beginPath(); g.moveTo(0, y); g.lineTo(s, y); g.stroke();
    }
    // Brand text stencil
    g.save();
    g.translate(s / 2, s / 2);
    g.fillStyle = 'rgba(240,240,242,0.15)';
    g.font = `bold ${s / 8}px -apple-system, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 0, 0);
    g.restore();
  }, 512);
}

// OFFCOMFRT branded floor texture (lighter)
const floorTex = makeTexture((g, s) => {
  // Lighter concrete base
  speckle(g, s, '#3a3a3e', 0.12, 6000);
  // Grid lines
  g.strokeStyle = 'rgba(255,255,255,0.12)';
  g.lineWidth = 2;
  const grid = 8;
  for (let i = 0; i <= grid; i++) {
    const p = (i / grid) * s;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, s); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(s, p); g.stroke();
  }
  // Center OFFCOMFRT logo (horizontal)
  g.save();
  g.translate(s / 2, s / 2);
  g.fillStyle = 'rgba(240,240,242,0.18)';
  g.font = `900 ${s / 8}px -apple-system, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('OFFCOMFRT', 0, 0);
  g.restore();
}, 512);
floorTex.repeat.set(4, 4);

// Branded wall textures
const wallTex = brandedWallTexture('OFFCOMFRT');
wallTex.repeat.set(2, 1);
const wallTex2 = brandedWallTexture('OC');
wallTex2.repeat.set(1, 1);

// Monochrome crate texture
const crateTex = makeTexture((g, s) => {
  speckle(g, s, '#141418', 0.18, 5000);
  // Dark edges
  g.strokeStyle = 'rgba(0,0,0,0.6)';
  g.lineWidth = 8;
  g.strokeRect(4, 4, s - 8, s - 8);
  // X pattern
  g.strokeStyle = 'rgba(255,255,255,0.15)';
  g.lineWidth = 6;
  g.beginPath(); g.moveTo(20, 20); g.lineTo(s - 20, s - 20); g.stroke();
  g.beginPath(); g.moveTo(s - 20, 20); g.lineTo(20, s - 20); g.stroke();
  // Brand mark
  g.fillStyle = 'rgba(240,240,242,0.2)';
  g.font = `bold ${s / 6}px -apple-system, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('OC', s / 2, s / 2);
});

// Metal texture (monochrome)
const metalTex = makeTexture((g, s) => {
  speckle(g, s, '#2a2a32', 0.12, 4000);
  // Vertical lines
  g.fillStyle = 'rgba(0,0,0,0.3)';
  for (let x = 0; x < s; x += s / 10) g.fillRect(x, 0, 2, s);
  // Rivets
  g.fillStyle = 'rgba(255,255,255,0.15)';
  for (let y = s / 8; y < s; y += s / 4) {
    for (let x = s / 8; x < s; x += s / 4) {
      g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill();
    }
  }
});

// Monochrome marsh/water textures (Mission-02 eastern expansion)
const waterTex = makeTexture((g, s) => {
  speckle(g, s, '#232327', 0.07, 3000);
  g.strokeStyle = 'rgba(255,255,255,0.10)';
  g.lineWidth = 2;
  for (let i = 0; i < 16; i++) {
    const y = Math.random() * s, w = 20 + Math.random() * 90;
    g.beginPath();
    g.moveTo(Math.random() * s, y);
    g.quadraticCurveTo(Math.random() * s, y + 5, Math.random() * s + w, y);
    g.stroke();
  }
}, 512);
waterTex.repeat.set(5, 5);
// The continuous flood sheet tiles the same caustic far denser than the small ponds do
const floodTex = waterTex.clone();
floodTex.repeat.set(16, 16);

const mats = {
  ground: new THREE.MeshStandardMaterial({ map: floorTex, roughness: 1 }),
  wall: new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.95 }),
  wall2: new THREE.MeshStandardMaterial({ map: wallTex2, roughness: 0.95 }),
  crate: new THREE.MeshStandardMaterial({ map: crateTex, roughness: 0.85 }),
  metal: new THREE.MeshStandardMaterial({ map: metalTex, roughness: 0.6, metalness: 0.4 }),
  concrete: new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.98, color: 0xbdbdbd }),
  leaf: new THREE.MeshStandardMaterial({ color: 0x55595a, roughness: 1, flatShading: true }),
  // Cannabis leaves are alpha-textured quads, so the material needs the leaf map + alphaTest and
  // must be double-sided. instanceColor supplies per-leaf tint variation on top of the map.
  // roughness 1 matches mats.leaf so the foliage lights identically to the trees and bushes.
  cannabis: new THREE.MeshStandardMaterial({ map: makeCannabisLeafTexture(), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 1 }),
  cannabisStem: new THREE.MeshStandardMaterial({ color: 0x4a4a4a, roughness: 1 }),
  cannabisBud: new THREE.MeshStandardMaterial({ color: 0x8a8a8a, roughness: 1, flatShading: true }),
  // Marsh palette — all greyscale, brand rule: no hue anywhere in the cabinet
  water: new THREE.MeshStandardMaterial({ map: waterTex, color: 0x909095, roughness: 0.18, metalness: 0.45, transparent: true, opacity: 0.55 }),
  mud: new THREE.MeshStandardMaterial({ color: 0x3f3f42, roughness: 1 }),
  glass: new THREE.MeshStandardMaterial({ color: 0xa8b0b4, roughness: 0.12, metalness: 0.25, transparent: true, opacity: 0.24, side: THREE.DoubleSide }),
  // Reed blades and grass tufts share ONE flat, double-sided quad geometry (one draw call each)
  reed: new THREE.MeshStandardMaterial({ color: 0x5e625f, roughness: 1, side: THREE.DoubleSide }),
  marshGrass: new THREE.MeshStandardMaterial({ color: 0x4f5250, roughness: 1, side: THREE.DoubleSide }),
  fogBank: new THREE.MeshBasicMaterial({ color: 0x9a9a9e, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false }),
  // Bog flood + mirror streaks: the sheet is the bayou surface, the reflection quads are the
  // dark smears trees draw on it. Both greyscale — the cabinet has no hue anywhere.
  flood: new THREE.MeshStandardMaterial({ map: floodTex, color: 0x8c8c91, roughness: 0.16, metalness: 0.5, transparent: true, opacity: 0.42, depthWrite: false }),
  reflection: new THREE.MeshBasicMaterial({ color: 0x141417, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide }),
};

// ── Map ──
const colliders = [];
const worldMeshes = [];

// Geometry cache: identical box dims+texScale share ONE BufferGeometry instead of allocating
// a fresh GPU buffer per mesh. The map has hundreds of repeated boxes (walls, stairs, slabs),
// so this collapses VRAM to a handful of geometries. Entries persist across clearMap on purpose.
const _boxGeoCache = new Map();
function scaledBox(w, h, d, scale) {
  const key = `${w}|${h}|${d}|${scale}`;
  const hit = _boxGeoCache.get(key);
  if (hit) return hit;
  const geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, uv.getX(k) * dims[f][0] / scale, uv.getY(k) * dims[f][1] / scale);
    }
  }
  _boxGeoCache.set(key, geo);
  return geo;
}

// Cylinder geometry cache (tanks, towers, silos) keyed by radius+height.
const _cylGeoCache = new Map();
function getCylGeo(radius, height) {
  const key = `${radius}|${height}`;
  const hit = _cylGeoCache.get(key);
  if (hit) return hit;
  const geo = new THREE.CylinderGeometry(radius, radius, height, 16);
  _cylGeoCache.set(key, geo);
  return geo;
}

function addBox(x, z, w, d, h, mat, texScale = 2.5, y = 0) {
  const mesh = new THREE.Mesh(scaledBox(w, h, d, texScale), mat);
  mesh.position.set(x, y + h / 2, z);
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
  worldMeshes.push(mesh);
  colliders.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, minY: y, maxY: y + h });
  return mesh;
}

// Add cylinder helper for industrial structures (tanks, towers, pipes)
function addCylinder(x, z, radius, height, mat, y = 0, rotation = 0) {
  const mesh = new THREE.Mesh(getCylGeo(radius, height), mat);
  mesh.position.set(x, y + height / 2, z);
  if (rotation) mesh.rotation.y = rotation;
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
  worldMeshes.push(mesh);
  // Approximate cylinder as box collider for simplicity
  colliders.push({ minX: x - radius, maxX: x + radius, minZ: z - radius, maxZ: z + radius, minY: y, maxY: y + height });
  return mesh;
}

const crate = (x, z, s = 1.2, y = 0) => addBox(x, z, s, s, s, mats.crate, s, y);

// Deco primitives: identical to addBox/addCylinder but register NO collider. Use them for
// surface detail (corrugation ribs, door rails, antennas, vent stacks) that lives inside or above
// a volume the shared table already carries — otherwise installSharedColliders() reads them as
// drift against cs-map.js, and cs-map.js would grow colliders the bots never need.
function addDecoBox(x, z, w, d, h, mat, texScale = 2.5, y = 0) {
  const mesh = new THREE.Mesh(scaledBox(w, h, d, texScale), mat);
  mesh.position.set(x, y + h / 2, z);
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
  worldMeshes.push(mesh);
  return mesh;
}
function addDecoCylinder(x, z, radius, height, mat, y = 0) {
  const mesh = new THREE.Mesh(getCylGeo(radius, height), mat);
  mesh.position.set(x, y + height / 2, z);
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
  worldMeshes.push(mesh);
  return mesh;
}

// No-shadow deco variants: identical geometry/placement but castShadow = false. Use for interior
// warehouse pieces (under a roof slab, invisible to the directional light), flat horizontal planes
// (mud rings, fog banks — their shadow is sub-pixel at 2048² over 136 m), and other detail whose
// shadow contribution is physically zero. Saves ~400 shadow-pass draw calls with no visual change.
function addDecoBoxNS(x, z, w, d, h, mat, texScale = 2.5, y = 0) {
  const mesh = new THREE.Mesh(scaledBox(w, h, d, texScale), mat);
  mesh.position.set(x, y + h / 2, z);
  mesh.receiveShadow = true;
  scene.add(mesh); worldMeshes.push(mesh);
  return mesh;
}

// Build the floor plane for a given map size (must be called inside each map builder after clearMap)
function buildGround(size) {
  const g = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mats.ground);
  g.rotation.x = -Math.PI / 2;
  g.receiveShadow = true;
  scene.add(g);
  worldMeshes.push(g);
  return g;
}

// Climbable staircase: emits stacked step boxes each ≤ STEP (0.4) tall so players can walk up
// dir: 'N' ascends toward -z, 'S' toward +z, 'E' toward +x, 'W' toward -x
function addStairs(x, z, totalH, steps, width, dir, mat = mats.concrete) {
  const stepH = totalH / steps;
  const stepD = 0.55;
  for (let i = 0; i < steps; i++) {
    const y = (i + 1) * stepH;
    const off = i * stepD;
    if (dir === 'N') addBox(x, z - off, width, stepD, y, mat, 2);
    else if (dir === 'S') addBox(x, z + off, width, stepD, y, mat, 2);
    else if (dir === 'E') addBox(x + off, z, stepD, width, y, mat, 2);
    else if (dir === 'W') addBox(x - off, z, stepD, width, y, mat, 2);
  }
}

// Shipping container: long steel box. axis 'x' or 'z', len defaults to 6 (standard 20ft)
function addContainer(x, z, len, axis, y = 0) {
  const w = axis === 'x' ? len : 2.4;
  const d = axis === 'x' ? 2.4 : len;
  return addBox(x, z, w, d, 2.6, mats.metal, 3, y);
}

// Elevate a flat roof/platform on top of pillars (walkable with matching addStairs)
function addPlatform(x, z, w, d, y, mat = mats.metal) {
  // Deck slab (thin)
  return addBox(x, z, w, d, 0.3, mat, 2.5, y);
}

// Vertical support pillars under a platform
function addPillars(x, z, w, d, h, count = 4) {
  const pts = count === 4
    ? [[-w/2+0.4, -d/2+0.4], [w/2-0.4, -d/2+0.4], [-w/2+0.4, d/2-0.4], [w/2-0.4, d/2-0.4]]
    : [[0, 0]];
  for (const [ox, oz] of pts) addBox(x + ox, z + oz, 0.5, 0.5, h - 0.3, mats.wall, 1.5);
}

// A wall run along `axis` ('x' = spans width along x, 'z' = spans depth along z)
// with a centered full-height DOORWAY opening of width gapW.
function addDoorWall(cx, cz, len, axis, baseY, h, gapW, mat) {
  const wt = 0.6;
  const side = (len - gapW) / 2;
  if (axis === 'x') {
    addBox(cx - (gapW / 2 + side / 2), cz, side, wt, h, mat, 2, baseY);
    addBox(cx + (gapW / 2 + side / 2), cz, side, wt, h, mat, 2, baseY);
    // lintel above the doorway (top 0.9m of the opening filled)
    addBox(cx, cz, gapW, wt, 0.9, mat, 2, baseY + h - 0.9);
  } else {
    addBox(cx, cz - (gapW / 2 + side / 2), wt, side, h, mat, 2, baseY);
    addBox(cx, cz + (gapW / 2 + side / 2), wt, side, h, mat, 2, baseY);
    addBox(cx, cz, wt, gapW, 0.9, mat, 2, baseY + h - 0.9);
  }
}

// A wall run with a centered WINDOW opening (sill below, header above, clear view through).
function addWinWall(cx, cz, len, axis, baseY, h, winW, sillH, headH, mat) {
  const wt = 0.6;
  const side = (len - winW) / 2;
  const openH = h - sillH - headH;
  if (axis === 'x') {
    addBox(cx - (winW / 2 + side / 2), cz, side, wt, h, mat, 2, baseY);
    addBox(cx + (winW / 2 + side / 2), cz, side, wt, h, mat, 2, baseY);
    addBox(cx, cz, winW, wt, sillH, mat, 2, baseY);                 // sill
    addBox(cx, cz, winW, wt, headH, mat, 2, baseY + h - headH);     // header
  } else {
    addBox(cx, cz - (winW / 2 + side / 2), wt, side, h, mat, 2, baseY);
    addBox(cx, cz + (winW / 2 + side / 2), wt, side, h, mat, 2, baseY);
    addBox(cx, cz, wt, winW, sillH, mat, 2, baseY);
    addBox(cx, cz, wt, winW, headH, mat, 2, baseY + h - headH);
  }
}

// ══ Duplex building: two walkable floors, defined interior, internal stairs, windows, roof ══
// Footprint centered at (bx,bz), width w along x, depth d along z. Axis-aligned (colliders are AABB).
// Entry door on the south face; internal straight staircase up the east shaft to the second floor.
function addDuplexBuilding(bx, bz, w, d) {
  const wt = 0.6;
  const gfH = 3.5;                 // ground-floor clear height
  const slabT = 0.3;              // floor/roof slab thickness
  const ufH = 2.8;               // upper-floor wall height
  const midY = gfH;              // second-floor slab bottom
  const upY = gfH + slabT;        // upper-floor walking level (3.8)
  const roofY = upY + ufH;        // roof slab bottom (6.6)
  const hw = w / 2, hd = d / 2;

  // ── Ground floor: exterior walls, south face has the entry doorway ──
  addWinWall(bx, bz - hd, w, 'x', 0, gfH, 2.4, 1.1, 1.1, mats.wall2);   // north (window)
  addDoorWall(bx, bz + hd, w, 'x', 0, gfH, 2.6, mats.wall2);            // south (entry)
  addWinWall(bx - hw, bz, d, 'z', 0, gfH, 2.2, 1.1, 1.1, mats.wall2);   // west (window)
  addBox(bx + hw, bz, wt, d, gfH, mats.wall2);                          // east (solid, stair shaft behind it)

  // ── Ground-floor interior: partition with a doorway so rooms connect ──
  addDoorWall(bx - 1, bz, d - 2, 'z', 0, gfH, 2.2, mats.wall);
  crate(bx - hw + 2, bz + hd - 2, 1.4);                                // furniture/cover inside
  crate(bx - hw + 2, bz - hd + 2, 1.2);

  // ── Second-floor slab: solid west/center; a 3.5 m open stair shaft runs along the east wall ──
  const shaft = 3.5;
  const slabEast = bx + hw - shaft;                 // east edge of the walkable slab
  const slabW = slabEast - (bx - hw);
  addBox(bx - hw + slabW / 2, bz, slabW, d - wt, slabT, mats.concrete, 2.5, midY);

  // ── Internal staircase up the east shaft; player steps WEST off the top onto the slab (no rail) ──
  addStairs(slabEast + shaft / 2, bz + hd - 0.8, upY, 11, 3.0, 'N', mats.metal);

  // ── Upper-floor walls (on top of the slab) with windows ──
  addWinWall(bx, bz - hd, w, 'x', upY, ufH, 2.6, 0.9, 0.9, mats.wall);   // north
  addWinWall(bx, bz + hd, w, 'x', upY, ufH, 2.6, 0.9, 0.9, mats.wall);   // south
  addWinWall(bx - hw, bz, d, 'z', upY, ufH, 2.2, 0.9, 0.9, mats.wall);   // west
  addBox(bx + hw, bz, wt, d, ufH, mats.wall);                           // east (solid)
  // upstairs partition WITH a doorway (this is what lets you cross to the other side)
  addDoorWall(bx - 1, bz, d - 2, 'z', upY, ufH, 2.2, mats.wall2);

  // ── Roof slab (capped, slight overhang) ──
  addBox(bx, bz, w + 0.6, d + 0.6, slabT, mats.metal, 2.5, roofY);
  // parapet so the roof reads as a defined building top
  addBox(bx, bz - hd - 0.2, w + 0.6, 0.3, 0.7, mats.concrete, 1.5, roofY + slabT);
  addBox(bx, bz + hd + 0.2, w + 0.6, 0.3, 0.7, mats.concrete, 1.5, roofY + slabT);
}

// ══ Rounded duplex: octagonal (chamfered) two-floor building with a cylindrical roof ══
// Same proven interior as the square duplex (rectangular slab + east stair shaft) but the
// exterior is an octagon (cardinal walls + corner blocks) capped by a round roof for a rounded look.
function addRoundDuplex(bx, bz, w, d) {
  const wt = 0.6;
  const gfH = 3.5, slabT = 0.3, ufH = 2.8;
  const midY = gfH, upY = gfH + slabT, roofY = upY + ufH;
  const hw = w / 2, hd = d / 2;
  const c = 2;                              // corner chamfer block size
  const flatX = w - 2 * c, flatZ = d - 2 * c;
  const co = hw - c / 2, czo = hd - c / 2;

  // ── Ground floor: octagon ring (cardinal walls shorter, corners filled by blocks) ──
  addWinWall(bx, bz - hd, flatX, 'x', 0, gfH, 2.2, 1.1, 1.1, mats.wall2);   // north
  addDoorWall(bx, bz + hd, flatX, 'x', 0, gfH, 2.6, mats.wall2);            // south (entry)
  addWinWall(bx - hw, bz, flatZ, 'z', 0, gfH, 2.2, 1.1, 1.1, mats.wall2);   // west
  addBox(bx + hw, bz, wt, d, gfH, mats.wall2);                              // east (solid, stair shaft behind)
  addBox(bx - co, bz - czo, c, c, gfH, mats.wall2, 2);                       // NW chamfer
  addBox(bx - co, bz + czo, c, c, gfH, mats.wall2, 2);                       // SW chamfer
  addBox(bx + co, bz - czo, c, c, gfH, mats.wall2, 2);                       // NE chamfer
  // (SE corner left open — the internal stair shaft runs up the east/south-east)

  // interior partition with doorway + cover
  addDoorWall(bx - 1, bz, d - 2, 'z', 0, gfH, 2.2, mats.wall);
  crate(bx - hw + 2, bz + hd - 2, 1.4);

  // ── Second-floor slab (rectangular, open east shaft) + internal stairs ──
  const shaft = 3.5;
  const slabEast = bx + hw - shaft;
  const slabW = slabEast - (bx - hw);
  addBox(bx - hw + slabW / 2, bz, slabW, d - wt, slabT, mats.concrete, 2.5, midY);
  addStairs(slabEast + shaft / 2, bz + hd - 0.8, upY, 11, 3.0, 'N', mats.metal);

  // ── Upper floor: matching octagon ring ──
  addWinWall(bx, bz - hd, flatX, 'x', upY, ufH, 2.4, 0.9, 0.9, mats.wall);
  addWinWall(bx, bz + hd, flatX, 'x', upY, ufH, 2.4, 0.9, 0.9, mats.wall);
  addWinWall(bx - hw, bz, flatZ, 'z', upY, ufH, 2.2, 0.9, 0.9, mats.wall);
  addBox(bx + hw, bz, wt, d, ufH, mats.wall);
  addBox(bx - co, bz - czo, c, c, ufH, mats.wall, 2, upY);
  addBox(bx - co, bz + czo, c, c, ufH, mats.wall, 2, upY);
  addBox(bx + co, bz - czo, c, c, ufH, mats.wall, 2, upY);
  addDoorWall(bx - 1, bz, d - 2, 'z', upY, ufH, 2.2, mats.wall2);

  // ── Rounded roof: cylinder cap + parapet ring + finial ──
  const rr = Math.max(hw, hd) + 0.3;
  addCylinder(bx, bz, rr, slabT, mats.metal, roofY);
  addCylinder(bx, bz, rr, 0.6, mats.concrete, roofY + slabT);
  addCylinder(bx, bz, 0.5, 1.6, mats.metal, roofY + slabT + 0.6);
}

// ══ Round walkable lookout tower (lighthouse-style): cylindrical body + top gallery + stairs ══
// Solid tapered body as the landmark; a round deck at `h` on the shaft is reachable by a straight
// external staircase from the south, ringed by railings. Players can climb to the deck.
function addRoundTower(x, z, radius = 3, h = 4.5) {
  // support column (solid cylinder up to the deck)
  addCylinder(x, z, radius - 1.1, h, mats.wall2);
  // round walkable deck
  addCylinder(x, z, radius, 0.35, mats.metal, h);
  // lamp room on top (small cylinder) — landmark cap
  addCylinder(x, z, radius * 0.55, 1.6, mats.wall, h + 0.35);
  // railings around the deck edge
  const rn = 10;
  for (let i = 0; i < rn; i++) {
    const a = (i / rn) * Math.PI * 2;
    addBox(x + Math.cos(a) * (radius - 0.2), z + Math.sin(a) * (radius - 0.2), 0.2, 0.2, 1, mats.metal, 1, h + 0.35);
  }
  // straight external staircase from the south, ascending north onto the deck
  const steps = Math.round(h / 0.35);
  const run = (steps - 1) * 0.55;
  addStairs(x, z + radius + run, h + 0.35, steps, 2.4, 'N', mats.metal);
}

// ══ Vehicle: 'truck' (long box + cab, climbable bed) or 'car' (low, jumpable roof) ══
// axis 'x' or 'z'. Body sits on the ground; a small step block lets players hop onto a truck bed.
function addVehicle(x, z, axis, type = 'truck') {
  const m = type === 'truck' ? mats.metal : mats.wall2;
  if (type === 'truck') {
    const L = axis === 'x' ? [5, 2.4] : [2.4, 5];   // cargo box w,d
    const C = axis === 'x' ? [2.2, 2.4] : [2.4, 2.2]; // cab w,d
    const off = axis === 'x' ? [3.6, 0] : [0, 3.6];
    addBox(x, z, L[0], L[1], 2.6, m, 2.5);                       // cargo bed
    addBox(x + off[0], z + off[1], C[0], C[1], 2.2, mats.wall, 2); // cab
    // step block to climb onto the 2.6 m bed
    addBox(x - (axis === 'x' ? 3.2 : 0), z - (axis === 'x' ? 0 : 3.2), 1.2, 1.2, 0.8, mats.concrete, 2);
  } else {
    const B = axis === 'x' ? [4, 2] : [2, 4];
    addBox(x, z, B[0], B[1], 1.1, m, 2.5);                     // lower body (jumpable ~1.1 m)
    const c = axis === 'x' ? [2, 1.7] : [1.7, 2];
    addBox(x, z, c[0], c[1], 0.7, mats.wall, 2, 1.1);          // cabin on top
  }
}

// ══ Pavement: a thin raised walkway/curb (≤ STEP tall so it is walkable), forms paths/sidewalks ══
function addPavement(x, z, w, d) {
  return addBox(x, z, w, d, 0.18, mats.concrete, 3);
}

// ════════════════════════════════════════════════════════════
//  EASTERN MARSHLAND HELPERS (Mission-02 expansion, x ≥ 50)
//  Water/mud/fog carry NO colliders and NO meshes that feed isFree() — the marsh stays fully
//  walkable so the hub's waypoint sampling never gridlocks against a flooded floor.
// ════════════════════════════════════════════════════════════
function addFlat(x, z, w, d, y, mat, rotY = 0) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
  m.rotation.x = -Math.PI / 2; m.rotation.z = rotY;
  m.position.set(x, y, z);
  m.receiveShadow = true;
  scene.add(m); worldMeshes.push(m);
  return m;
}

// Elliptical pool built from one rotated circle, so pools read organic instead of axial
function addWaterPool(x, z, r, squash = 0.7, rotY = 0) {
  const m = addFlat(x, z, r * 2, r * 2 * squash, 0.05, mats.water, rotY);
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = 2;   // deeper patches paint above the continuous flood sheet, never sort under it
  return m;
}

// Reed blade: instanced quad, 1.1-2.2 m tall, leaning outward from its root. `col` stays
// strictly greyscale (r==g==b) — instanceColor multiplies the material, hue would leak.
function addReed(x, z, s = 1) {
  const g = 0.34 + Math.random() * 0.34;
  _reedInst.push({
    p: [x, 0.02, z], s: [0.1 * s, 1.5 * s * rand(0.8, 1.5), 0.1],
    yaw: Math.random() * Math.PI * 2, tilt: rand(0.04, 0.30), roll: rand(-0.12, 0.12),
    col: Math.round(g * 255) * 0x010101,
  });
  // darker mid-blade paired with each reed thickens the stand for free (same draw call)
  _reedInst.push({
    p: [x + rand(-0.2, 0.2), 0.02, z + rand(-0.2, 0.2)], s: [0.07 * s, 1.1 * s * rand(0.7, 1.3), 0.07],
    yaw: Math.random() * Math.PI * 2, tilt: rand(0.1, 0.4), roll: rand(-0.2, 0.2),
    col: Math.round((g - 0.12) * 255) * 0x010101,
  });
}

function addGrassTuft(x, z, s = 1) {
  _grassInst.push({
    p: [x, 0.01, z], s: [0.32 * s, 0.42 * s * rand(0.7, 1.4), 0.32],
    yaw: Math.random() * Math.PI * 2, tilt: rand(0.05, 0.25), roll: rand(-0.3, 0.3),
  });
}

function addFogBank(x, z, w, y = 1.6) {
  const m = addFlat(x, z, w, w * 0.35, y, mats.fogBank, rand(-0.6, 0.6));
  m.castShadow = false; m.receiveShadow = false;
  return m;
}

// ══ CYPRESS SWAMP LAYER ══
// The reference read: one continuous sheet of standing water, tall straight trees rising out of
// it, dark mirror smears under every trunk, and low grass mounds breaking the surface. The old
// pond-and-shore detail stays (it gives depth variation on top of the sheet) but the sheet is now
// the floor of the whole band — floodRect also drives wadeDepth, so water drag covers the marsh.
function addFloodSheet() {
  const cx = (floodRect.x0 + floodRect.x1) / 2, cz = (floodRect.z0 + floodRect.z1) / 2;
  const m = addFlat(cx, cz, floodRect.x1 - floodRect.x0, floodRect.z1 - floodRect.z0, 0.035, mats.flood);
  // The sheet sits just above the mud shelf (0.02) — a thin water film at the player's feet.
  // Force the paint order so the transparent layers never z-sort against each other.
  m.renderOrder = 1;
  return m;
}

// Cypress: a tall tapered trunk + a flared buttress at the waterline + a high sparse canopy, all
// instanced/reused, plus a dark reflection smear drawn on the flood sheet. The trunk registers the
// same client-only `veg` collider addTree uses — bots walk around it, cs-map.js never sees it.
function addCypress(x, z, s = 1) {
  const h = 9 * s;
  _cypressTrunkInst.push({ p: [x, 0.35 * s, z], s: [s, h, s] });
  _cypressBaseInst.push({ p: [x, 0.04, z], s: [s, s, s], yaw: rand(0, Math.PI * 2) });
  // knee-like buttress root leaning off one side — the silhouette detail that sells a cypress
  if (Math.random() < 0.7) {
    _cypressBaseInst.push({
      p: [x + rand(-0.5, 0.5) * s, 0.12, z + rand(-0.5, 0.5) * s],
      s: [s * rand(0.5, 0.9), s * rand(0.4, 0.8), s * rand(0.5, 0.9)],
      yaw: rand(0, Math.PI * 2), tilt: rand(0.15, 0.5),
    });
  }
  // high, thin canopy — cypress over water grows straight up with little foliage low down
  _leafInst.push({ p: [x, h * 0.92, z], s: [1.5 * s, 2.1 * s, 1.5 * s] });
  if (Math.random() < 0.6) _leafInst.push({ p: [x + rand(-0.8, 0.8) * s, h * rand(0.72, 0.85), z + rand(-0.8, 0.8) * s], s: [0.9 * s, 1.2 * s, 0.9 * s] });
  // mirror smear on the flood: a flat quad running N-S (the band is viewed from the west, so a
  // length along z reads as a reflection from almost every angle you'd actually stand at
  if (!reflectGeo) reflectGeo = new THREE.PlaneGeometry(1, 1);
  const len = h * rand(0.5, 0.75);
  _reflectInst.push({
    p: [x + rand(-0.2, 0.2), 0.04, z + len * 0.28],
    s: [0.55 * s, len, 1], yaw: 0, tilt: -Math.PI / 2, roll: rand(-0.12, 0.12),
  });
  colliders.push({ minX: x - 0.4 * s, maxX: x + 0.4 * s, minZ: z - 0.4 * s, maxZ: z + 0.4 * s, minY: 0, maxY: 2.4 * s, veg: true });
}

// Cypress instance collectors + shared geometries. Trunk is a tapered column normalised to height
// 1 (instance scale.y IS tree height); the buttress is a flared cone with its origin at the mud.
const _cypressTrunkInst = [];
const _cypressBaseInst = [];
const cypressTrunkGeo = (() => { const g = new THREE.CylinderGeometry(0.11, 0.34, 1, 7); g.translate(0, 0.5, 0); return g; })();
const cypressBaseGeo = (() => { const g = new THREE.CylinderGeometry(0.16, 0.85, 1.05, 8); g.translate(0, 0.5, 0); return g; })();

// Low grass hummock poking out of the bayou: a mud mound with a dense tuft cap, exactly the little
// islands the reference scatters across open water. Decorative only — zero colliders.
function addHummock(x, z, r = 1) {
  const m = addFlat(x, z, r * 2.2, r * 2.2 * rand(0.6, 0.9), 0.055, mats.mud, rand(0, Math.PI));
  m.renderOrder = 2;   // rides above the transparent flood sheet
  for (let i = 0; i < Math.round(r * 7); i++) {
    addGrassTuft(x + rand(-1, 1) * r, z + rand(-0.8, 0.8) * r, rand(0.8, 1.5));
  }
  for (let i = 0; i < Math.round(r * 2.5); i++) {
    addReed(x + rand(-0.9, 0.9) * r, z + rand(-0.7, 0.7) * r, rand(0.7, 1.2));
  }
  return m;
}

// Fill the band with trees: dense but laned — a min-gap keeps bot lanes open through the trunks,
// and isFree() (which now sees every structure, boardwalk AND the earlier veg colliders) guarantees
// no trunk ever spawns inside a building or on a walkway.
function scatterCypress(count = 85, minGap = 3.1) {
  const placed = [];
  let guard = 0;
  while (placed.length < count && guard++ < count * 60) {
    const x = rand(floodRect.x0 + 1.2, floodRect.x1 - 1.2);
    const z = rand(floodRect.z0 + 1.5, floodRect.z1 - 1.5);
    if (!isFree(x, z, 1.0)) continue;
    if (placed.some(p => (p.x - x) ** 2 + (p.y - z) ** 2 < minGap * minGap)) continue;
    placed.push({ x, z });
    addCypress(x, z, rand(0.8, 1.5));
  }
  return placed.length;
}

function scatterHummocks(count = 40) {
  let placed = 0, guard = 0;
  while (placed < count && guard++ < count * 60) {
    const x = rand(floodRect.x0 + 1.5, floodRect.x1 - 1.5);
    const z = rand(floodRect.z0 + 2, floodRect.z1 - 2);
    if (!isFree(x, z, 1.2)) continue;
    addHummock(x, z, rand(0.6, 1.6));
    placed++;
  }
  return placed;
}

// Ponds actually built by the last scatter — the wading physics reads this list every frame.
// Mission-02 only: it stays empty on the plain 99x99 arena, so water drag can never leak
// into rounds/co-op even if the collider table somehow did.
let marshPools = [];
// The continuous bayou surface (Mission-02 east band). Null everywhere else — every flood/wade
// branch keys off this, so dry maps skip the new code paths entirely.
let floodRect = null;
let padGeo = null;
let pebbleGeo = null;
let reflectGeo = null;
const _padInst = [];
const _pebbleInst = [];
const _reflectInst = [];
// Instanced marsh mud rings and driftwood (filled by finalizeVegetation)
let mudRingGeo = null;  // 1×1 PlaneGeometry, scaled per-instance
const _mudRingInst = [];
const _driftLogInst = [];
const _driftBranchInst = [];

// 0 = dry ground, 1 = ankle-deep margin, 2 = proper water. One cheap ellipse pass (~30 pools),
// deliberately axis-aligned against the drawn squash axis — a few degrees of error at the shore
// line is unnoticeable when the payoff is a per-frame call with zero allocations.
function wadeDepth(x, z) {
  // Continuous flood: the whole east band is wadeable, with a shallows gradient at the west
  // edge where the bayou seeps under the old wall line. Boardwalks, slabs and building
  // footprints sit on hardcoded dry rects — standing on pavement must never feel like wading.
  if (floodRect && x > floodRect.x0 && x < floodRect.x1 && z > floodRect.z0 && z < floodRect.z1) {
    for (const r of floodDry) {
      if (x > r[0] && x < r[1] && z > r[2] && z < r[3]) return 0;
    }
    // Below-waist flood: the whole band is shallow (knee/ankle) — drag ×0.78, not the heavy ×0.5.
    // Ponds still return 2 at their centres for deeper pockets within the shallow bayou.
    return 1;
  }
  let d = 0;
  for (const p of marshPools) {
    const dx = (x - p.x) / (p.r * 1.06), dz = (z - p.z) / (p.r * p.squash * 1.06);
    const e = dx * dx + dz * dz;
    if (e < 0.55) return 2;
    if (e < 1) d = 1;
  }
  return d;
}

// Dry pads inside the flood band: every east structure footprint + boardwalk, [minX,maxX,minZ,maxZ].
// Deliberately a small hardcoded list — the rects are stable (they mirror cs-map.js), and a
// per-frame loop over 13 tuples is cheaper than any isFree()-style lookup.
const floodDry = [
  [61.5, 78.5, -24.5, -11.5],   // warehouse
  [42.5, 53.5, 6, 14],          // greenhouse
  [67.5, 76.5, 4.5, 11.5],      // maintenance shed
  [70.5, 85.5, 20.5, 31.5],     // admin wing
  [51.5, 64.5, 35, 45],         // service complex
  [54, 58, -18, 34],            // N-S boardwalk spine
  [57, 69, -19.5, -16.5],       // warehouse connector
  [53, 63, 38.5, 41.5],         // south arm
  [65, 77, 1.5, 4.5],           // maintenance link
  [74.5, 77.5, 10, 24],         // admin link
  [57, 63, -31.25, -28.75],     // dock
  [61.5, 66.5, 18.75, 21.25],   // jetty
  [50.75, 53.25, -9.5, -2.5],   // side boardwalk
];

// Per-pond micro-detail: lily pads drifting on the surface (one instanced draw call), a wet mud
// fringe around the shoreline, and occasionally a fallen log laid across the bank. All of it
// collider-free — and pads/logs skip straight past isFree because they float or lie on top.
function addMarshDetail(p) {
  if (!padGeo) padGeo = new THREE.CircleGeometry(0.36, 7);
  const n = 2 + Math.round(p.r * 1.6);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, rr = p.r * Math.sqrt(Math.random()) * 0.78;
    _padInst.push({
      p: [p.x + Math.cos(a) * rr, 0.055, p.z + Math.sin(a) * rr * p.squash],
      s: rand(0.5, 1.2), yaw: 0, tilt: -Math.PI / 2, roll: rand(0, Math.PI * 2),
    });
  }
  // darker saturated ring hugging the pool — instanced (1 plane geo, scaled per-pond)
  if (!mudRingGeo) mudRingGeo = new THREE.PlaneGeometry(1, 1);
  _mudRingInst.push({
    p: [p.x, 0.03, p.z], s: [p.r * 2 * 1.32, p.r * 2 * p.squash * 1.32, 1],
    yaw: rand(0, Math.PI), tilt: -Math.PI / 2,
  });
  // driftwood: roughly every other pond gets a log slumped over its bank
  if (Math.random() < 0.55) {
    const a = rand(0, Math.PI * 2);
    const lx = p.x + Math.cos(a) * p.r * 1.15, lz = p.z + Math.sin(a) * p.r * p.squash * 1.15;
    if (isFree(lx, lz, 0.9)) {
      _driftLogInst.push({
        p: [lx, 0.16, lz], s: [rand(0.7, 1.15), rand(1.8, 3.4), rand(0.7, 1.15)],
        yaw: rand(0, Math.PI * 2), tilt: 0, roll: Math.PI / 2,
      });
      _driftBranchInst.push({
        p: [lx + rand(-0.5, 0.5), 0.35, lz + rand(-0.5, 0.5)], s: [1, 1, 1],
        yaw: rand(0, Math.PI), tilt: rand(-0.5, 0.5), roll: 0,
      });
    }
  }
  // bank pebbles: instanced squashed spheres around the shore — dense detail, one draw call,
  // zero physics cost (they never register colliders)
  if (!pebbleGeo) pebbleGeo = new THREE.SphereGeometry(0.14, 6, 5);
  for (let i = 0; i < Math.round(p.r * 2.4); i++) {
    const a = Math.random() * Math.PI * 2, rr = p.r * rand(1.05, 1.5);
    const px = p.x + Math.cos(a) * rr, pz = p.z + Math.sin(a) * rr * p.squash;
    if (!isFree(px, pz, 0.5)) continue;
    const s = rand(0.5, 1.5);
    _pebbleInst.push({ p: [px, 0.02, pz], s: [s, s * rand(0.35, 0.6), s], yaw: rand(0, Math.PI * 2) });
  }
}

// ══ Marsh scatter: ponds, reed stands, grass hummocks and fog across the eastern band. ══
// Pure decoration — none of it registers colliders, so the flooded floor stays walkable and the
// hub's waypoint sampling never sees the marsh at all. Rejection tests run through isFree() so a
// pond never overlaps a structure or boardwalk, and blades never sprout on a walkway or a crate.
// Density target: ~50 ponds in a continuous flooded band, every shore triple-banded with reeds,
// ~6000 background blades, 140 cypress, 70 hummocks, lily pads, mud fringes, driftwood and
// pebbles — reeds/grass/pads/pebbles all land in instanced draw calls, so "dense and detailed"
// still costs almost no frame time.
function scatterMarsh() {
  // The bayou first: one continuous flood across the whole east band, then the ponds get drawn on
  // top of it as darker/deeper patches. wadeDepth keys off floodRect, so the entire band is water.
  floodRect = { x0: 49.6, x1: 85.9, z0: -48.9, z1: 48.9 };
  addFloodSheet();
  const pools = [];
  let guard = 0;
  while (pools.length < 50 && guard++ < 9000) {
    const x = rand(45.5, 84), z = rand(-47, 47);
    const r = rand(1.4, 4.4);
    const squash = rand(0.55, 0.85);
    if (!isFree(x, z, r + 0.8)) continue;
    if (pools.some(p => Math.hypot(p.x - x, p.z - z) < (p.r + r) * 1.12)) continue;
    pools.push({ x, z, r, squash });
    addWaterPool(x, z, r, squash, rand(0, Math.PI));
  }
  // Reed lines on every shore: bright tall blades at the waterline, a mid band behind them and a
  // darker short backing row — three staggered rings read as thick layered growth, not a picket fence
  for (const p of pools) {
    for (let i = 0, n = Math.round(p.r * 16); i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const rr = p.r * rand(0.9, 1.12);
      addReed(p.x + Math.cos(a) * rr, p.z + Math.sin(a) * rr * p.squash, rand(0.9, 1.5));
    }
    for (let i = 0, n = Math.round(p.r * 9); i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const rr = p.r * rand(1.16, 1.38);
      addReed(p.x + Math.cos(a) * rr, p.z + Math.sin(a) * rr * p.squash, rand(0.55, 1.05));
    }
    for (let i = 0, n = Math.round(p.r * 7); i < n; i++) {
      addGrassTuft(p.x + rand(-1.6, 1.6) * p.r, p.z + rand(-1.3, 1.3) * p.r * p.squash, rand(0.7, 1.4));
    }
    addMarshDetail(p);
  }
  // Background fill across the flooded strip — the ground between ponds should look like swamp
  guard = 0;
  let fill = 0;
  while (fill < 6000 && guard++ < 36000) {
    const x = rand(45.5, 85), z = rand(-48.8, 48.8);
    if (pools.some(p => ((x - p.x) / p.r) ** 2 + ((z - p.z) / (p.r * p.squash)) ** 2 < 0.92)) continue;
    if (!isFree(x, z, 0.5)) continue;
    if (Math.random() < 0.62) addReed(x, z, rand(0.5, 1.3)); else addGrassTuft(x, z, rand(0.6, 1.3));
    fill++;
  }
  // Cattail islands: small dry hummocks poking out of the bigger ponds — layered silhouette on open water
  for (const p of pools) {
    if (p.r < 2.6 || Math.random() < 0.35) continue;
    const a = rand(0, Math.PI * 2), rr = p.r * rand(0.25, 0.55);
    const ix = p.x + Math.cos(a) * rr, iz = p.z + Math.sin(a) * rr * p.squash;
    const isl = addFlat(ix, iz, rand(0.8, 1.4), rand(0.6, 1.0), 0.055, mats.mud, rand(0, Math.PI));
    isl.renderOrder = 2;   // island must paint above the flood sheet
    for (let i = 0; i < 7; i++) addReed(ix + rand(-0.5, 0.5), iz + rand(-0.4, 0.4), rand(1.1, 1.6));
  }
  // Cypress stand: the trees ARE the swamp — tall straight trunks rising out of the flood with
  // buttressed bases and mirror smears, then grass hummocks to break the open surface.
  const trees = scatterCypress(140);
  const mounds = scatterHummocks(70);
  // Fog: a low bank over nearly every pond plus broad drifters along the boardwalk lanes
  for (const p of pools) {
    if (Math.random() < 0.8) addFogBank(p.x, p.z, Math.max(6, p.r * 3.0), rand(1.0, 1.7));
  }
  addFogBank(55, -6, 20, 1.8);
  addFogBank(59, 31, 22, 1.5);
  addFogBank(53, -41, 17, 1.4);
  addFogBank(72, 12, 24, 1.6);
  addFogBank(78, -20, 20, 1.5);
  addFogBank(65, -35, 18, 1.3);
  addFogBank(80, 30, 22, 1.4);
  console.log(`[CS] Cypress swamp: flood sheet + ${trees} trees, ${mounds} hummocks`);
  return pools;
}

// ════════════════════════════════════════════════════════════
//  MISSION-02 EASTERN STRUCTURES — colliders mirrored in cs-map.js buildIndustrial()
// ════════════════════════════════════════════════════════════
function addWarehouse(bx, bz, w, d, h) {
  const hw = w / 2, hd = d / 2, wt = 0.6;
  addBox(bx, bz, w, d, 0.3, mats.concrete, 4);                       // floor slab
  addWinWall(bx, bz - hd, w, 'x', 0.3, h, 2.4, 1.6, 1.2, mats.wall2); // north
  addWinWall(bx, bz + hd, w, 'x', 0.3, h, 2.4, 1.6, 1.2, mats.wall2); // south
  addBox(bx + hw, bz, wt, d, h, mats.wall2, 2.5, 0.3);                // east (solid)
  addDoorWall(bx - hw, bz, d, 'z', 0.3, h, 5.0, mats.metal);          // west roll-up door
  addDoorWall(bx, bz - hd + 3.2, 6, 'x', 0.3, 3.2, 2.4, mats.wall);   // interior N-bay partition
  // Corrugation ribs: instanced — 18 identical boxes (same geo + material, only position varies)
  {
    const ribGeo = scaledBox(0.14, h - 0.4, 0.1, 1.2);
    const ribIM = new THREE.InstancedMesh(ribGeo, mats.metal, 18);
    const _m4 = new THREE.Matrix4(); let ri = 0;
    for (let i = 0; i <= 8; i++) {
      const rx = bx - hw + 1.6 + i * (w - 3.2) / 8;
      _m4.setPosition(rx, (h - 0.4) / 2 + 0.3, bz - hd - 0.02); ribIM.setMatrixAt(ri++, _m4);
      _m4.setPosition(rx, (h - 0.4) / 2 + 0.3, bz + hd + 0.02); ribIM.setMatrixAt(ri++, _m4);
    }
    ribIM.instanceMatrix.needsUpdate = true; ribIM.receiveShadow = true;
    scene.add(ribIM); worldMeshes.push(ribIM);
  }
  // Cargo door rails + a half-raised shutter panel over the opening
  addDecoBoxNS(bx - hw - 0.1, bz - 2.4, 0.2, 0.3, h, mats.metal, 1.2, 0.3);
  addDecoBoxNS(bx - hw - 0.1, bz + 2.4, 0.2, 0.3, h, mats.metal, 1.2, 0.3);
  addDecoBoxNS(bx - hw, bz, wt, 5.0, 1.1, mats.metal, 1.5, h - 1.4);

  // ── Support columns: the demolition targets (charges get planted here) ──
  // Nine I-beam pillars on a 3×3 grid, instanced per sub-part (5 InstancedMeshes instead of 45).
  const colX = [bx - hw + 3.5, bx - hw + 8.5, bx + hw - 3.5];
  const colZ = [bz - hd + 3.5, bz, bz + hd - 3.5];
  {
    const _m4 = new THREE.Matrix4(); let ci;
    // Web (thin vertical plate)
    const webGeo = scaledBox(0.18, h - 0.3, 0.6, 1);
    const webIM = new THREE.InstancedMesh(webGeo, mats.metal, 9); ci = 0;
    for (const cx2 of colX) for (const cz2 of colZ) { _m4.setPosition(cx2, (h - 0.3) / 2 + 0.3, cz2); webIM.setMatrixAt(ci++, _m4); }
    webIM.instanceMatrix.needsUpdate = true; webIM.receiveShadow = true; scene.add(webIM); worldMeshes.push(webIM);
    // Flanges (two per column — 18 instances in one mesh)
    const flGeo = scaledBox(0.6, h - 0.3, 0.12, 1);
    const flIM = new THREE.InstancedMesh(flGeo, mats.metal, 18); ci = 0;
    for (const cx2 of colX) for (const cz2 of colZ) {
      _m4.setPosition(cx2, (h - 0.3) / 2 + 0.3, cz2 - 0.22); flIM.setMatrixAt(ci++, _m4);
      _m4.setPosition(cx2, (h - 0.3) / 2 + 0.3, cz2 + 0.22); flIM.setMatrixAt(ci++, _m4);
    }
    flIM.instanceMatrix.needsUpdate = true; flIM.receiveShadow = true; scene.add(flIM); worldMeshes.push(flIM);
    // Base plates
    const bpGeo = scaledBox(0.9, 0.12, 0.9, 1);
    const bpIM = new THREE.InstancedMesh(bpGeo, mats.concrete, 9); ci = 0;
    for (const cx2 of colX) for (const cz2 of colZ) { _m4.setPosition(cx2, 0.06 + 0.3, cz2); bpIM.setMatrixAt(ci++, _m4); }
    bpIM.instanceMatrix.needsUpdate = true; bpIM.receiveShadow = true; scene.add(bpIM); worldMeshes.push(bpIM);
    // Capital brackets
    const cbGeo = scaledBox(0.8, 0.15, 0.8, 1);
    const cbIM = new THREE.InstancedMesh(cbGeo, mats.metal, 9); ci = 0;
    for (const cx2 of colX) for (const cz2 of colZ) { _m4.setPosition(cx2, h - 0.5 + 0.075, cz2); cbIM.setMatrixAt(ci++, _m4); }
    cbIM.instanceMatrix.needsUpdate = true; cbIM.receiveShadow = true; scene.add(cbIM); worldMeshes.push(cbIM);
  }

  // ── Overhead crane rail + trolley + hanging chains ──
  // Two parallel I-beam rails spanning the length at y=h-1, with a trolley box and chains.
  const railY = h - 0.8;
  addDecoBoxNS(bx, bz - hd + 2.5, w - 1.5, 0.25, 0.3, mats.metal, 2, railY);
  addDecoBoxNS(bx, bz + hd - 2.5, w - 1.5, 0.25, 0.3, mats.metal, 2, railY);
  // Trolley body
  addDecoBoxNS(bx + 1, bz, 1.2, 1.8, 0.5, mats.metal, 1.2, railY + 0.15);
  // Hanging chains (thin cylinders dangling from the trolley and from ceiling points)
  const chainPts = [[bx + 1, bz], [bx - 3, bz - hd + 2.5], [bx + 4, bz + hd - 2.5], [bx - hw + 2, bz]];
  for (const [chx, chz] of chainPts) {
    const chLen = rand(1.2, 2.8);
    const chain = new THREE.Mesh(getCylGeo(0.03, chLen), mats.metal);
    chain.position.set(chx, railY - chLen / 2, chz);
    scene.add(chain); worldMeshes.push(chain);
    // Small hook at the bottom
    const hook = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.025, 6, 8, Math.PI * 1.4), mats.metal);
    hook.position.set(chx, railY - chLen - 0.05, chz);
    hook.rotation.x = Math.PI / 2;
    scene.add(hook); worldMeshes.push(hook);
  }

  // ── Roof trusses: diagonal cross-bracing between columns ──
  for (let i = 0; i < colX.length - 1; i++) {
    const x1 = colX[i], x2 = colX[i + 1];
    const span = x2 - x1;
    addDecoBoxNS((x1 + x2) / 2, bz - hd + 2.5, span, 0.12, 0.2, mats.metal, 1.5, h - 0.4);
    addDecoBoxNS((x1 + x2) / 2, bz + hd - 2.5, span, 0.12, 0.2, mats.metal, 1.5, h - 0.4);
    // Diagonal brace
    addDecoBoxNS((x1 + x2) / 2, bz, span * 0.7, 0.08, 0.15, mats.metal, 1, h - 1.2);
  }

  // ── Interior shelving racks (heavy-duty pallet racking) ──
  // Three rows along the east half. Uprights and shelf beams are instanced (identical dims).
  {
    const _m4 = new THREE.Matrix4(); let ri;
    // Uprights: 12 (3 rows × 4 per row)
    const upGeo = scaledBox(0.1, 2.8, 0.1, 1);
    const upIM = new THREE.InstancedMesh(upGeo, mats.metal, 12); ri = 0;
    for (let row = 0; row < 3; row++) {
      const rz = bz - hd + 4 + row * 3.5;
      for (let u = 0; u < 4; u++) { _m4.setPosition(bx + 1.5 + u * 1.8, 1.4 + 0.3, rz); upIM.setMatrixAt(ri++, _m4); }
    }
    upIM.instanceMatrix.needsUpdate = true; upIM.receiveShadow = true; scene.add(upIM); worldMeshes.push(upIM);
    // Shelf beams: 9 (3 rows × 3 levels)
    const sbGeo = scaledBox(5.6, 0.12, 0.08, 1.5);
    const sbIM = new THREE.InstancedMesh(sbGeo, mats.metal, 9); ri = 0;
    for (let row = 0; row < 3; row++) {
      const rz = bz - hd + 4 + row * 3.5;
      for (let lv = 0; lv < 3; lv++) { _m4.setPosition(bx + 4.2, 0.9 + lv * 0.9 + 0.06, rz); sbIM.setMatrixAt(ri++, _m4); }
    }
    sbIM.instanceMatrix.needsUpdate = true; sbIM.receiveShadow = true; scene.add(sbIM); worldMeshes.push(sbIM);
    // Cargo boxes: random dims so stay individual (but only 27 total, no shadow)
    for (let row = 0; row < 3; row++) {
      const rz = bz - hd + 4 + row * 3.5;
      for (let lv = 0; lv < 3; lv++) {
        for (let b = 0; b < 3; b++) {
          const bxx = bx + 2 + b * 1.8;
          addDecoBoxNS(bxx, rz + rand(-0.2, 0.2), rand(0.5, 0.9), rand(0.4, 0.7), rand(0.3, 0.6), mats.crate, 1, 0.95 + lv * 0.9);
        }
      }
    }
  }

  // ── Oil drums and barrels scattered inside ──
  const drumPositions = [[bx - hw + 2, bz + hd - 2], [bx - hw + 3.5, bz + hd - 3], [bx - 1, bz - hd + 2]];
  for (const [dx, dz] of drumPositions) {
    const drum = new THREE.Mesh(getCylGeo(0.35, 0.9), mats.metal);
    drum.position.set(dx + rand(-0.3, 0.3), 0.75, dz + rand(-0.3, 0.3));
    drum.receiveShadow = true;
    scene.add(drum); worldMeshes.push(drum);
  }

  // ── Wall-mounted cable trays (perforated channel along upper walls) ──
  for (const sgn of [-1, 1]) {
    addDecoBoxNS(bx, bz + sgn * (hd - 0.4), w - 2, 0.3, 0.1, mats.metal, 2, h - 1.5);
  }
  // Tray supports: instanced — 14 identical small brackets
  {
    const nSup = Math.floor((w - 2) / 2);
    const supGeo = scaledBox(0.06, 0.5, 0.06, 1);
    const supIM = new THREE.InstancedMesh(supGeo, mats.metal, nSup * 2); let si = 0;
    const _m4 = new THREE.Matrix4();
    for (const sgn of [-1, 1]) for (let s = 0; s < nSup; s++) {
      _m4.setPosition(bx - hw + 1.5 + s * 2, h - 1.8 + 0.25, bz + sgn * (hd - 0.4)); supIM.setMatrixAt(si++, _m4);
    }
    supIM.instanceMatrix.needsUpdate = true; supIM.receiveShadow = true; scene.add(supIM); worldMeshes.push(supIM);
  }

  // ── Loading dock bumpers + wheel chocks on the west face ──
  addDecoBoxNS(bx - hw - 0.15, bz - 1.8, 0.3, 0.6, 0.5, mats.cannabisStem, 1, 0.55);
  addDecoBoxNS(bx - hw - 0.15, bz + 1.8, 0.3, 0.6, 0.5, mats.cannabisStem, 1, 0.55);
  // Dock ramp (angled plate from ground to floor slab height)
  const ramp = addDecoBoxNS(bx - hw - 1.2, bz, 2.4, 4.5, 0.1, mats.concrete, 1.5, 0.15);
  ramp.rotation.z = 0.06;

  // ── Floor markings: painted safety lines (thin bright strips on the slab) ──
  const lineMat = new THREE.MeshBasicMaterial({ color: 0x7a7a7a });
  for (const lz of [bz - hd + 1.5, bz + hd - 1.5]) {
    addDecoBoxNS(bx, lz, w - 2, 0.12, 0.01, lineMat, 1, 0.31);
  }
  addDecoBoxNS(bx - hw + 4, bz, 0.12, d - 3, 0.01, lineMat, 1, 0.31);

  // ── Exterior vents + conduit pipes on east wall ──
  for (let v = 0; v < 3; v++) {
    const vz = bz - hd + 3 + v * 4;
    addDecoBoxNS(bx + hw + 0.2, vz, 0.4, 0.8, 0.6, mats.metal, 1, h - 1.5);
    // Conduit running down
    addDecoBoxNS(bx + hw + 0.15, vz, 0.1, 0.1, h - 2, mats.metal, 1, 0.3);
  }

  // Interior: crate stacks (the "weapons stockpile" that is really archive shelving)
  crate(bx - hw + 2.5, bz - hd + 2.5, 2.0, 0.3); crate(bx - hw + 2.5, bz - hd + 2.5, 1.4, 2.3);
  crate(bx - hw + 5.0, bz + hd - 2.5, 2.2, 0.3);
  crate(bx + hw - 2.4, bz + hd - 2.6, 2.0, 0.3); crate(bx + hw - 2.4, bz + hd - 4.6, 1.6, 0.3);
  addBox(bx + hw - 1.6, bz - 1.0, 1.4, 4.0, 2.4, mats.metal, 1.5, 0.3);  // shelving run
  addBox(bx - 2.5, bz + 1.5, 2.6, 1.1, 0.9, mats.crate, 1.2, 0.3);       // filing table
  // Roof + stair shaft (mirrors cs-map.js: 13 steps, east gallery)
  const shaft = 3.4, slabEast = bx + hw - shaft, slabW = slabEast - (bx - hw);
  addBox(bx - hw + slabW / 2, bz, slabW, d - wt, 0.3, mats.wall, 3, h);   // walkable roof slab
  addStairs(slabEast + shaft / 2, bz + hd - 1.2, h + 0.3, 13, 2.8, 'N', mats.concrete);
  addBox(bx, bz - hd - 0.2, w + 0.6, 0.3, 0.7, mats.wall, 2, h + 0.3);
  addBox(bx, bz + hd + 0.2, w + 0.6, 0.3, 0.7, mats.wall, 2, h + 0.3);
}

function addGreenhouse(bx, bz, w, d) {
  const hw = w / 2, hd = d / 2, h = 3.2;
  addPavement(bx, bz, w, d);                                          // kerb/slab
  // Glazing first: 16 panes total, drawn as ONE cached geometry type, and deliberately
  // collider-free (cs-map.js registers frames only) so the marsh stays navigable.
  const paneN = new THREE.PlaneGeometry(w - 0.7, h - 0.9);
  for (const sgn of [-1, 1]) {
    const m = new THREE.Mesh(paneN, mats.glass);
    m.position.set(bx, 0.2 + (h - 0.9) / 2, bz + sgn * hd);
    scene.add(m); worldMeshes.push(m);
  }
  const paneZ = new THREE.PlaneGeometry(d - 0.7, h - 0.9);
  for (const sgn of [-1, 1]) {
    const m = new THREE.Mesh(paneZ, mats.glass);
    m.rotation.y = Math.PI / 2;
    m.position.set(bx + sgn * hw, 0.2 + (h - 0.9) / 2, bz);
    scene.add(m); worldMeshes.push(m);
  }
  // Sloped roof glazing (two planes meeting at the ridge)
  const roofPane = new THREE.PlaneGeometry(w - 0.5, (hd + 0.4) * 1.15);
  for (const sgn of [-1, 1]) {
    const m = new THREE.Mesh(roofPane, mats.glass);
    m.rotation.x = -Math.PI / 2 + sgn * 0.62;
    m.position.set(bx, h + 0.55, bz + sgn * (hd / 2));
    scene.add(m); worldMeshes.push(m);
  }
  // Frame: corner posts, base + top rails, ridge beam, gable ends
  for (const [sx, sz] of [[-hw, -hd], [hw, -hd], [-hw, hd], [hw, hd]]) {
    addBox(bx + sx, bz + sz, 0.35, 0.35, h, mats.metal, 1.2);
  }
  addBox(bx, bz - hd, w, 0.2, 0.3, mats.metal, 1.2, 0.2); addBox(bx, bz + hd, w, 0.2, 0.3, mats.metal, 1.2, 0.2);
  addBox(bx - hw, bz, 0.2, d, 0.3, mats.metal, 1.2, 0.2); addBox(bx + hw, bz, 0.2, d, 0.3, mats.metal, 1.2, 0.2);
  addBox(bx, bz - hd, w, 0.2, 0.3, mats.metal, 1.2, h - 0.5); addBox(bx, bz + hd, w, 0.2, 0.3, mats.metal, 1.2, h - 0.5);
  addBox(bx - hw, bz, 0.2, d, 0.3, mats.metal, 1.2, h - 0.5); addBox(bx + hw, bz, 0.2, d, 0.3, mats.metal, 1.2, h - 0.5);
  addBox(bx, bz, w, 0.3, 1.7, mats.metal, 1.5, h - 0.3);           // ridge beam
  addBox(bx, bz + 0.4, w - 1.2, 1.4, 1.0, mats.wall, 2, 0.4);      // collapsed potting bench
  addDoorWall(bx - hw, bz, 4, 'z', 0, h, 2.4, mats.metal);         // west door
  crate(bx + 1.5, bz - 1.8, 1.6, 0.6);                              // potting bench
  crate(bx - 1.0, bz + 2.0, 1.4, 0.6);                              // planter bed
  // Broken panes: shards leaning on the frame (visual only)
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.7), mats.glass);
    m.position.set(bx + rand(-hw + 1, hw - 1), 0.4, bz + (i % 2 ? hd - 0.3 : -hd + 0.3));
    m.rotation.set(-Math.PI / 2 + rand(-0.5, 0.5), 0, rand(-0.4, 0.4));
    scene.add(m); worldMeshes.push(m);
  }
}

function addMaintenanceRoom(bx, bz, w, d) {
  const hw = w / 2, hd = d / 2, h = 3.2, wt = 0.6;
  addPavement(bx, bz, w, d);
  addBox(bx, bz - hd, w, wt, h, mats.wall2, 2, 0.2);
  addBox(bx, bz + hd, w, wt, h, mats.wall2, 2, 0.2);
  addBox(bx + hw, bz, wt, d, h, mats.wall2, 2, 0.2);
  addDoorWall(bx - hw, bz, d, 'z', 0.2, h, 2.6, mats.metal);        // west door
  addBox(bx + 2, bz - 1.2, wt, 4.2, h, mats.wall, 2, 0.2);          // interior partition
  crate(bx + hw - 1.4, bz - 1.6, 1.2, 0.2);                         // locker bank
  crate(bx + hw - 1.4, bz + 1.6, 1.2, 0.2);
  // Supply detail (visual only, no colliders): wall pipes + a generator block outside
  addDecoBox(bx + hw + 0.15, bz - 1.0, 0.12, 0.12, 2.4, mats.metal, 1, 0.4);
  addDecoBox(bx + hw + 0.15, bz + 0.6, 0.12, 0.12, 1.8, mats.metal, 1, 0.4);
  addBox(bx - 2.2, bz + hd + 2.2, 1.6, 1.1, 0.9, mats.metal, 1.2);
  addBox(bx, bz + hd + 0.4, w + 1.2, 2.4, 0.3, mats.metal, 2, h);   // awning
}

function addAdminWing(bx, bz, w, d) {
  const wt = 0.6, gfH = 3.5, slabT = 0.3, ufH = 2.8;
  const upY = gfH + slabT, roofY = upY + ufH, hw = w / 2, hd = d / 2;
  addWinWall(bx, bz - hd, w, 'x', 0, gfH, 2.4, 1.1, 1.1, mats.wall2);   // north GF
  addDoorWall(bx, bz + hd, w, 'x', 0, gfH, 2.6, mats.wall);              // south entry
  addBox(bx - hw, bz, wt, d, gfH, mats.wall2, 2.5);                      // west (solid)
  addWinWall(bx + hw, bz, d, 'z', 0, gfH, 2.2, 1.1, 1.1, mats.wall2);    // east
  addDoorWall(bx - 2, bz, d - 2, 'z', 0, gfH, 2.2, mats.wall);           // ground partition
  crate(bx - hw + 2.2, bz - hd + 2.2, 1.6);
  crate(bx - hw + 2.2, bz + hd - 2.2, 1.4);
  addBox(bx - hw + 1.8, bz + 1.4, 2.4, 1.0, 0.8, mats.crate, 1.2);       // reception counter
  const shaft = 3.5, slabEast = bx + hw - shaft, slabW = slabEast - (bx - hw);
  addBox(bx - hw + slabW / 2, bz, slabW, d - wt, slabT, mats.concrete, 3, gfH);
  addStairs(slabEast + shaft / 2, bz + hd - 0.8, upY, 11, 3.0, 'N', mats.concrete);
  addWinWall(bx, bz - hd, w, 'x', upY, ufH, 2.6, 0.9, 0.9, mats.wall2);
  addWinWall(bx, bz + hd, w, 'x', upY, ufH, 2.6, 0.9, 0.9, mats.wall2);
  addBox(bx - hw, bz, wt, d, ufH, mats.wall2, 2.5, upY);
  addWinWall(bx + hw, bz, d, 'z', upY, ufH, 2.2, 0.9, 0.9, mats.wall2);
  addDoorWall(bx - 2, bz, d - 2, 'z', upY, ufH, 2.2, mats.wall);         // office doorway
  crate(bx + 3.0, bz - 2.0, 1.8, upY);                                   // Kessler's desk
  addBox(bx + 4.5, bz + 2.4, 2.2, 0.9, 0.8, mats.crate, 1.5, upY);       // filing cabinet
  addBox(bx, bz, w + 0.6, d + 0.6, slabT, mats.wall, 3, roofY);          // roof
  addBox(bx, bz - hd - 0.2, w + 0.6, 0.3, 0.7, mats.wall, 2, roofY + slabT);
  addBox(bx, bz + hd + 0.2, w + 0.6, 0.3, 0.7, mats.wall, 2, roofY + slabT);
}

function addServiceComplex(bx, bz, w, d) {
  const hw = w / 2, hd = d / 2, h = 3.8, wt = 0.6;
  addPavement(bx, bz, w, d);
  addBox(bx, bz - hd, w, wt, h, mats.wall2, 2.5, 0.2);
  addDoorWall(bx, bz + hd, w, 'x', 0.2, h, 2.8, mats.metal);      // south door (entry)
  addBox(bx - hw, bz, wt, d, h, mats.wall2, 2.5, 0.2);
  addWinWall(bx + hw, bz, d, 'z', 0.2, h, 2.4, 1.2, 1.0, mats.wall2);
  addDoorWall(bx + 2, bz, d - 3, 'z', 0.2, h, 2.2, mats.wall);    // back-room partition
  crate(bx - hw + 2.0, bz - hd + 2.0, 1.5, 0.2);
  addBox(bx, bz, w + 0.6, d + 0.6, 0.3, mats.wall, 3, h);         // roof
  addStairs(bx + hw - 1.8, bz + hd + 1.6, h + 0.3, 10, 2.4, 'N', mats.concrete);
  // Antenna mast + vent stacks for the extraction-point read (visual only)
  addDecoCylinder(bx - hw + 1.2, bz + hd - 1.2, 0.08, 2.6, mats.metal, h + 0.3);
  addDecoBox(bx + 2.0, bz - hd + 1.5, 0.7, 0.7, 0.8, mats.metal, 1.2, h + 0.3);
  addDecoBox(bx - 1.0, bz - hd + 2.6, 0.5, 0.5, 0.6, mats.metal, 1.2, h + 0.3);
}

// ── Vegetation (INSTANCED: all foliage in one draw call, all trunks in one) ──
// Shared low-poly geometry + InstancedMesh keeps GPU buffers/draw-calls flat no matter
// how many trees/bushes scatter() places, so render RAM stays low.
const foliageGeo = new THREE.SphereGeometry(1, 8, 6);
const trunkGeo = new THREE.CylinderGeometry(0.3, 0.42, 2.2, 7);
// Marsh blade: one vertical 1x1 double-sided quad with its base at y=0. Reeds and grass tufts
// share this geometry (and the _fillOriented yaw/tilt/roll path used by cannabis leaves), so the
// whole dense marsh costs two instanced draw calls, never a mesh per blade.
const bladeGeo = (() => { const g = new THREE.PlaneGeometry(1, 1); g.translate(0, 0.5, 0); return g; })();
const _leafInst = [];    // { p:[x,y,z], s:[sx,sy,sz] }
const _trunkInst = [];   // { p:[x,y,z], s:[sx,sy,sz] }
const _cannabisInst = []; // { p, s, yaw, tilt, roll, col } — one textured fan leaf per instance
const _stemInst = [];     // { p, s } cannabis stalks (own list: different material from tree trunks)
const _budInst = [];      // { p, s } terminal cola / bud clusters
const _reedInst = [];     // { p, s, yaw, tilt, roll, col } marsh reed blades (instanced quads)
const _grassInst = [];    // { p, s, yaw, tilt, roll } marsh grass tufts (instanced quads)
// instanceColor MULTIPLIES the leaf map, so these must stay near-white or they would crush the
// blade to black — and strictly greyscale (r==g==b) so a tinted leaf can never leak hue into the
// monochrome arena. The variation they add is luminance only: some fans read dusty-pale, others shadowed.
const CANNABIS_TINTS = [0xffffff, 0xe8e8e8, 0xd0d0d0, 0xf4f4f4, 0xc2c2c2];

// ══ Cannabis leaf: drawn ONCE onto an alpha canvas, then mapped onto a single subdivided quad ══
// Hand-building a serrated fan costs ~300 triangles per leaf; a textured quad costs 20 and draws
// the silhouette far more accurately (real serrations, midrib, lateral veins). Whole field stays
// one geometry + one texture + one draw call, so VRAM and frame cost stay flat.
// Anatomy followed: palmately compound leaf, 7 narrow lanceolate leaflets converging on the top of
// a petiole, centre leaflet longest, each with deep asymmetric teeth pointing toward the tip.
// Rendered in the arena's monochrome palette — see the greyscale note inside the function.
function makeCannabisLeafTexture(size = 512) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const S = size / 512;
  const ox = 256 * S, oy = 366 * S;                    // top of the petiole
  // The petiole is ~29% of the quad, matching a real fan leaf (30cm leaf = 10cm stalk + 20cm blade).
  // Shortening it was what turned the plant into a solid core: every blade pivoted exactly on the
  // stem axis and they stacked. A long petiole holds each fan clear of the wood, so the structure
  // reads as separate hands and the branches stay visible between them.
  // [angle from vertical, length, half-width, pair rank] — 7 lanceolate leaflets (~6.5:1), centre
  // longest; the pair rank staggers each leaflet's attach point down the petiole, which is what
  // opens the fan into the recognisable cannabis silhouette instead of a fused star. Leaflets sit at
  // the broad end of the range on purpose: a true 10:1 sativa blade is only ~4cm wide at game scale
  // and collapses into a stick, which is what made the first version read as a conifer.
  const LEAFLETS = [
    [0, 336, 31, 0], [0.52, 296, 29, 1], [-0.52, 296, 29, 1],
    [1.02, 242, 25, 2], [-1.02, 242, 25, 2], [1.46, 172, 18, 3], [-1.46, 172, 18, 3],
  ];
  const outline = (ang, len, hw, rank) => {
    const dx = Math.sin(ang), dy = -Math.cos(ang);     // canvas Y grows downward
    const px = Math.cos(ang), py = Math.sin(ang);      // unit perpendicular
    const ax = ox, ay = oy + rank * 16 * S;
    const steps = 120, teeth = 13, L = [], R = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const prof = Math.pow(t, 0.75) * Math.pow(1 - t, 0.9) * 3.12;   // narrow base, widest ~45%
      const ph = (t * teeth) % 1;                                      // quick rise to the tooth,
      const serr = ph < 0.28 ? 0.5 + 0.5 * (ph / 0.28) : 1 - 0.5 * ((ph - 0.28) / 0.72);  // slow fall
      const w = hw * prof * serr;
      const bx = ax + dx * len * t, by = ay + dy * len * t;
      L.push([bx + px * w, by + py * w]);
      R.push([bx - px * w, by - py * w]);
    }
    return { L, R, dx, dy, len, ax, ay, steps };
  };
  // ── Strict greyscale, like every other surface in the arena (concrete #3a3a3e, crate #141418,
  // foliage #55595a, metal #2a2a32). Monochrome is the house rule, so the leaf has to carry its
  // readability on detail rather than hue: a machined pale edge along every serration, a dark
  // midrib, a lateral vein into each tooth, and concrete-style speckle grime clipped to the blade.
  const tracePath = (L, R) => {
    g.beginPath();
    g.moveTo(L[0][0], L[0][1]);
    for (const p of L) g.lineTo(p[0], p[1]);
    for (let i = R.length - 1; i >= 0; i--) g.lineTo(R[i][0], R[i][1]);
    g.closePath();
  };
  // petiole: runs from the bottom edge of the quad up to the convergence point
  g.beginPath();
  g.moveTo(ox - 6 * S, size); g.lineTo(ox + 6 * S, size);
  g.lineTo(ox + 3.2 * S, oy); g.lineTo(ox - 3.2 * S, oy);
  g.closePath();
  g.fillStyle = '#3a3a3a'; g.fill();
  g.strokeStyle = 'rgba(216,216,216,0.2)'; g.lineWidth = 1.1 * S; g.stroke();
  for (const [ang, len, hw, rank] of LEAFLETS) {
    const { L, R, dx, dy, ax, ay, steps } = outline(ang, len, hw, rank);
    const grd = g.createLinearGradient(ax, ay, ax + dx * len, ay + dy * len);
    grd.addColorStop(0, '#232323'); grd.addColorStop(0.5, '#494949'); grd.addColorStop(1, '#6d6d6d');
    tracePath(L, R);
    g.fillStyle = grd; g.fill();
    // Bounding box of this leaflet, so the grime pass can scatter over it without spilling off the
    // blade (everything below is clipped to the leaf path anyway).
    let bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9;
    for (const p of L.concat(R)) {
      if (p[0] < bx0) bx0 = p[0]; if (p[0] > bx1) bx1 = p[0];
      if (p[1] < by0) by0 = p[1]; if (p[1] > by1) by1 = p[1];
    }
    g.save();
    g.clip();
    // Same speckle routine the concrete and crate textures use, so the blades sit in the world's
    // material language instead of looking like flat vector shapes pasted over it.
    for (let i = 0; i < 300; i++) {
      const v = Math.random() - 0.5;
      g.fillStyle = v > 0 ? `rgba(255,255,255,${v * 0.22})` : `rgba(0,0,0,${-v * 0.34})`;
      g.fillRect(bx0 + Math.random() * (bx1 - bx0), by0 + Math.random() * (by1 - by0), 2 * S, 2 * S);
    }
    // Faint cross-hatch, echoing the machined hatch on the metal props.
    g.strokeStyle = 'rgba(255,255,255,0.045)'; g.lineWidth = 1 * S;
    for (let x = bx0 - (by1 - by0); x < bx1; x += 7 * S) {
      g.beginPath(); g.moveTo(x, by1); g.lineTo(x + (by1 - by0), by0); g.stroke();
    }
    // midrib plus one lateral vein running into every serration tooth — the detail that makes the
    // blade read as cannabis at distance instead of a generic spiky leaf.
    g.strokeStyle = 'rgba(10,10,10,0.72)'; g.lineWidth = 1.8 * S;
    g.beginPath(); g.moveTo(ax, ay); g.lineTo(ax + dx * len * 0.95, ay + dy * len * 0.95); g.stroke();
    g.lineWidth = 0.85 * S; g.strokeStyle = 'rgba(12,12,12,0.5)';
    for (let j = 1; j < 13; j++) {
      const i = Math.round(((j + 0.28) / 13) * steps);
      if (i >= steps) continue;
      const t = i / steps;
      const vx = ax + dx * len * t, vy = ay + dy * len * t;
      g.beginPath(); g.moveTo(vx, vy); g.lineTo(L[i][0], L[i][1]); g.stroke();
      g.beginPath(); g.moveTo(vx, vy); g.lineTo(R[i][0], R[i][1]); g.stroke();
    }
    g.restore();
    // Bright cut edge on the silhouette. Against a dark industrial backdrop this is what lets the
    // serration read at range — with hue removed from the palette, edge contrast is the only cue left.
    tracePath(L, R);
    g.strokeStyle = 'rgba(228,228,228,0.42)'; g.lineWidth = 1.7 * S; g.stroke();
    g.strokeStyle = 'rgba(8,8,8,0.5)'; g.lineWidth = 0.7 * S; g.stroke();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;                 // thin blades seen obliquely; 4x is enough and keeps VRAM low
  return t;
}

// One leaf = a quad pivoted at the petiole base (so tilt swings the whole blade out from the
// stalk), gently folded into a V along the midrib and drooping toward the tip like a real fan leaf.
function makeCannabisLeafGeo() {
  const geo = new THREE.PlaneGeometry(1, 1, 2, 4);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i) + 0.5;          // 0 = petiole base, 1 = leaflet tips
    p.setY(i, y);
    p.setZ(i, -0.075 * Math.abs(x) * 2 + 0.055 * y * y);
  }
  geo.computeVertexNormals();
  return geo;
}
const cannabisLeafGeo = makeCannabisLeafGeo();

// ── The Mission-02 hero specimen's own surface maps ──
// Deliberately NOT applied to mats.cannabisStem / mats.cannabisBud: those two are shared with the
// instanced field crop, the marsh driftwood and two deco boxes, so texturing them would repaint
// unrelated props. These are used by spawnPurpleBud alone.

// Trichomes: a dense pale grain over the calyx surface. This is what makes a cola read as a resinous
// bud rather than a smooth bead, and it is the only channel through which "purple" can be expressed
// here at all — brand rule forbids hue anywhere in the cabinet, so the frost is carried by
// luminance and roughness. Flat 0xFF would blow out under the sun, so the highlights stay mid-high.
function makeCannabisFrostTexture(size = 256) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  speckle(g, size, '#8f8f8f', 0.10, 900);
  for (let i = 0; i < 2600; i++) {                      // glandular heads, most barely visible
    const r = Math.random() < 0.06 ? 1.7 : 0.65;
    g.fillStyle = `rgba(255,255,255,${0.05 + Math.random() * 0.22})`;
    g.beginPath(); g.arc(Math.random() * size, Math.random() * size, r, 0, Math.PI * 2); g.fill();
  }
  for (let i = 0; i < 700; i++) {                       // shadowed crevices between calyxes
    g.fillStyle = `rgba(0,0,0,${0.04 + Math.random() * 0.13})`;
    g.beginPath(); g.arc(Math.random() * size, Math.random() * size, 1.1 + Math.random() * 2.4, 0, Math.PI * 2); g.fill();
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Bark: the stalk is not a smooth pipe. Vertical fibres, node swellings and a few bright resin
// streaks are what let a 12-triangle cylinder pass as woody at close range.
function makeCannabisBarkTexture(size = 256) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  speckle(g, size, '#4e4e4e', 0.07, 900);
  for (let i = 0; i < 46; i++) {                        // fibre striations, uneven weight
    const x = Math.random() * size;
    g.strokeStyle = `rgba(0,0,0,${0.06 + Math.random() * 0.15})`;
    g.lineWidth = 1 + Math.random() * 2.2;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x + (Math.random() - 0.5) * 9, size); g.stroke();
    g.strokeStyle = `rgba(255,255,255,${0.03 + Math.random() * 0.08})`;
    g.beginPath(); g.moveTo(x + 2.5, 0); g.lineTo(x + 2.5 + (Math.random() - 0.5) * 9, size); g.stroke();
  }
  for (let i = 0; i < 5; i++) {                         // node bands where the branch pair emerged
    const y = (i + 0.5) * size / 5 + (Math.random() - 0.5) * 8;
    g.fillStyle = 'rgba(232,232,232,0.13)'; g.fillRect(0, y - 2, size, 4);
    g.fillStyle = 'rgba(0,0,0,0.17)'; g.fillRect(0, y + 2, size, 2);
  }
  for (let i = 0; i < 26; i++) {                        // resin droplets
    g.fillStyle = `rgba(255,255,255,${0.07 + Math.random() * 0.13})`;
    g.beginPath(); g.arc(Math.random() * size, Math.random() * size, 1 + Math.random() * 2.6, 0, Math.PI * 2); g.fill();
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Open 5-sided cylinder, height 1, so an instance's scale.y IS the segment length. Used for the
// main stalk and every branch. Low-poly sphere for the buds — both shared by the whole field.
const stalkGeo = new THREE.CylinderGeometry(0.62, 1, 1, 5, 1, true);
const budGeo = new THREE.SphereGeometry(1, 5, 3);
// The faceted 5x3 sphere is what makes every bud read as a bright crystal stud, and at full size
// they were the loudest thing on the plant — louder than the blades that are supposed to carry the
// silhouette. One multiplier over both bud placements (branch colas and the terminal stack) keeps
// them proportional to each other and to the stalk, so this is the only knob to turn.
const BUD_SCALE = 0.72;
// Built once for the Mission-02 hero specimen (see makeCannabisFrostTexture above) — 256px canvases,
// so 512 KB of GPU between the two of them, created at init and never regenerated per frame.
const cannabisFrostTex = makeCannabisFrostTexture(256);
const cannabisBarkTex = makeCannabisBarkTexture(256);
// Only the top COLA_NODES branch nodes finish in a cola, and the terminal stack is 3 buds, so a
// plant carries 2 nodes x 2 branches + 3 = 7. Lower branches still end in an upward tip leaf but no
// bud, which is how a real canopy reads: the growth that reaches the light is what buds out, and the
// shaded bottom stays wood and leaf. Ten evenly spaced crystals per shrub was the other half of why
// the plants looked manufactured rather than grown.
const COLA_NODES = 2;

// Tree: thin trunk collider (easy to walk around) + non-colliding foliage recorded as instances.
function addTree(x, z, s = 1) {
  _trunkInst.push({ p: [x, 1.1 * s, z], s: [s, s, s] });
  _leafInst.push({ p: [x, 2.7 * s, z], s: [1.25 * s, 1.15 * s, 1.25 * s] });
  _leafInst.push({ p: [x + 0.55 * s, 3.3 * s, z - 0.35 * s], s: [0.85 * s, 0.85 * s, 0.85 * s] });
  colliders.push({ minX: x - 0.42 * s, maxX: x + 0.42 * s, minZ: z - 0.42 * s, maxZ: z + 0.42 * s, minY: 0, maxY: 2.2 * s, veg: true });
}

// Bush: purely decorative low foliage, NO collider, so it never blocks player or bot movement.
function addBush(x, z, s = 1) {
  _leafInst.push({ p: [x, 0.5 * s, z], s: [0.9 * s, 0.7 * s, 0.9 * s] });
}

// Build the two InstancedMeshes from the collected transforms (called once after the map is placed).
function _fillInstances(geo, mat, list) {
  if (!list.length) return;
  const im = new THREE.InstancedMesh(geo, mat, list.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
  for (let i = 0; i < list.length; i++) {
    pos.set(list[i].p[0], list[i].p[1], list[i].p[2]);
    scl.set(list[i].s[0], list[i].s[1], list[i].s[2]);
    m.compose(pos, q, scl);
    im.setMatrixAt(i, m);
  }
  im.instanceMatrix.needsUpdate = true;
  im.castShadow = true; im.receiveShadow = true;    // keep the same lit/shadowed look as before
  im.frustumCulled = true;
  scene.add(im); worldMeshes.push(im);
}
function finalizeVegetation() {
  _fillInstances(trunkGeo, mats.wall, _trunkInst);
  _fillInstances(foliageGeo, mats.leaf, _leafInst);
  _fillInstances(budGeo, mats.cannabisBud, _budInst);
  _fillOriented(stalkGeo, mats.cannabisStem, _stemInst, false);
  _fillOriented(cannabisLeafGeo, mats.cannabis, _cannabisInst, true);
  _fillOriented(bladeGeo, mats.reed, _reedInst, true);
  _fillOriented(bladeGeo, mats.marshGrass, _grassInst, false);
  _fillOriented(padGeo || bladeGeo, mats.mud, _padInst, false);          // lily pads (marsh only)
  _fillOriented(pebbleGeo || bladeGeo, mats.concrete, _pebbleInst, false); // shore pebbles
  _fillInstances(cypressTrunkGeo, mats.wall, _cypressTrunkInst);          // swamp trunks
  _fillOriented(cypressBaseGeo, mats.mud, _cypressBaseInst, false);       // buttresses + knees
  // Mirror smears must NOT cast/receive shadows — _fillOriented force-enables both, so flip them
  // off on the returned mesh or every reflection quad would darken the flood from the sun.
  const refl = _fillOriented(reflectGeo || bladeGeo, mats.reflection, _reflectInst, false);
  if (refl) { refl.castShadow = false; refl.receiveShadow = false; }
  // Marsh mud rings: one InstancedMesh replaces ~50 individual addFlat planes
  const mudR = _fillOriented(mudRingGeo || new THREE.PlaneGeometry(1, 1), mats.mud, _mudRingInst, false);
  if (mudR) { mudR.castShadow = false; mudR.receiveShadow = false; mudR.renderOrder = 2; }
  // Driftwood: 2 InstancedMeshes replace ~55 individual log+branch meshes
  const driftLogs = _fillOriented(getCylGeo(0.2, 1), mats.cannabisStem, _driftLogInst, false);
  if (driftLogs) { driftLogs.castShadow = false; driftLogs.receiveShadow = true; }
  _fillOriented(getCylGeo(0.07, 0.5), mats.cannabisStem, _driftBranchInst, false);
  _trunkInst.length = 0; _leafInst.length = 0; _cannabisInst.length = 0;
  _stemInst.length = 0; _budInst.length = 0; _reedInst.length = 0; _grassInst.length = 0;
  _padInst.length = 0; _pebbleInst.length = 0;
  _cypressTrunkInst.length = 0; _cypressBaseInst.length = 0; _reflectInst.length = 0;
  _mudRingInst.length = 0; _driftLogInst.length = 0; _driftBranchInst.length = 0;
}

// Oriented instancing for anything that carries a yaw/tilt/roll: cannabis leaves (with a per-leaf
// tint) and the stalk + branches. `s` may be a scalar (uniform) or a [x,y,z] triple.
function _fillOriented(geo, mat, list, colored) {
  if (!list.length) return;
  const im = new THREE.InstancedMesh(geo, mat, list.length);
  const m = new THREE.Matrix4(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
  const q = new THREE.Quaternion(), qy = new THREE.Quaternion(), qx = new THREE.Quaternion(), qz = new THREE.Quaternion();
  const Y = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0), Z = new THREE.Vector3(0, 0, 1);
  const c = new THREE.Color();
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    pos.set(it.p[0], it.p[1], it.p[2]);
    const sv = Array.isArray(it.s) ? it.s : [it.s, it.s, it.s];
    scl.set(sv[0], sv[1], sv[2]);
    qy.setFromAxisAngle(Y, it.yaw || 0);       // spin around the stalk
    qx.setFromAxisAngle(X, it.tilt || 0);      // swing out from vertical
    qz.setFromAxisAngle(Z, it.roll || 0);      // twist within the blade plane
    q.copy(qy).multiply(qx).multiply(qz);
    m.compose(pos, q, scl);
    im.setMatrixAt(i, m);
    if (colored) im.setColorAt(i, c.setHex(it.col));   // multiplies the leaf map -> natural variation
  }
  im.instanceMatrix.needsUpdate = true;
  if (colored && im.instanceColor) im.instanceColor.needsUpdate = true;
  im.castShadow = true; im.receiveShadow = true;
  im.frustumCulled = true;
  scene.add(im); worldMeshes.push(im);
  return im;   // callers may opt out of shadows (translucent reflection quads)
}

// Dense-but-passable grove: trees kept ≥ minGap apart so lanes stay walkable, and only placed
// on free ground (never on pavements/structures/spawns). Bushes fill the gaps decoratively.
function addForest(cx, cz, radius, count, minGap = 3.0) {
  const placed = [];
  let guard = 0;
  while (placed.length < count && guard++ < count * 40) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * radius;
    const x = cx + Math.cos(a) * r;
    const z = cz + Math.sin(a) * r;
    // keep clear of structures, pavements and existing trunks
    if (!isFree(x, z, 0.9)) continue;
    if (placed.some(p => (p.x - x) ** 2 + (p.y - z) ** 2 < minGap * minGap)) continue;
    placed.push({ x, z });
    addTree(x, z, 0.85 + Math.random() * 0.6);
    if (Math.random() < 0.7) addBush(x + rand(-1.6, 1.6), z + rand(-1.6, 1.6), 0.8 + Math.random() * 0.6);
  }
  return placed.length;
}

// Even map-wide scatter (NOT clustered): rejection-samples across the whole arena with a large
// min-gap so trees distribute evenly through the open ground, keeping spawn bands clear.
function inSpawnBand(x, z) {
  return (z <= -40 && z >= -45 && Math.abs(x) <= 8) || (z >= 35 && z <= 45 && Math.abs(x) <= 20);
}
function scatterTrees(count, minGap = 5.5) {
  const placed = [];
  let guard = 0;
  while (placed.length < count && guard++ < count * 60) {
    const x = rand(-46, 46), z = rand(-46, 46);
    if (inSpawnBand(x, z)) continue;
    if (!isFree(x, z, 1.0)) continue;
    if (placed.some(p => (p.x - x) ** 2 + (p.y - z) ** 2 < minGap * minGap)) continue;
    placed.push({ x, z });
    addTree(x, z, 0.85 + Math.random() * 0.7);
    if (Math.random() < 0.5) addBush(x + rand(-2.5, 2.5), z + rand(-2.5, 2.5), 0.8 + Math.random() * 0.7);
  }
  return placed.length;
}
function scatterBushes(count, minGap = 4.5) {
  const placed = [];
  let guard = 0;
  while (placed.length < count && guard++ < count * 60) {
    const x = rand(-46, 46), z = rand(-46, 46);
    if (inSpawnBand(x, z)) continue;
    if (!isFree(x, z, 0.8)) continue;
    if (placed.some(p => (p.x - x) ** 2 + (p.y - z) ** 2 < minGap * minGap)) continue;
    placed.push({ x, z });
    addBush(x, z, 0.8 + Math.random() * 0.8);
  }
  return placed.length;
}

// ── Cannabis plant: a branched, decussate shrub — which is the actual growth habit of Cannabis ──
// and the reason the earlier single-stick version looked sparse. Structure, bottom up:
//   • main stalk; the lowest node carries only the big heavy "skirt" pair every real plant
//     self-prunes, and every node above it throws a PAIR of opposite branches, each pair rotated 90°
//   • a couple of leaves sit at the fork itself, filling the gap between stalk and branch
//   • branches carry their own leaves, alternating 90° along the branch exactly like the stalk does
//     (decussate), so a branch fills space in 3D rather than staying a flat feather
//   • every fan is held well above horizontal. That is the natural leaf angle, and it matters: a fan
//     lying flat is edge-on to a standing player and the plant reads sparse, while presenting the
//     blade is what makes the canopy look dense.
//   • branches end in their own cola, and the stalk finishes in a terminal cola ringed by sugar leaves
// ~72 blades per plant, all one instanced draw call. NO colliders: player and bots walk straight
// through a field, and nothing here feeds isFree()/waypoint generation.
function addCannabisPlant(x, z, s = 1) {
  const H = 1.55 * s;
  const tint = () => CANNABIS_TINTS[(Math.random() * CANNABIS_TINTS.length) | 0];
  // A woody segment rising from (px,py,pz) for `len` at `tilt` from vertical, around `yaw`.
  // Returns its unit direction so leaves can be hung along it.
  const seg = (px, py, pz, len, yaw, tilt, r) => {
    const st = Math.sin(tilt), d = [st * Math.sin(yaw), Math.cos(tilt), st * Math.cos(yaw)];
    _stemInst.push({ p: [px + d[0] * len / 2, py + d[1] * len / 2, pz + d[2] * len / 2], s: [r, len, r], yaw, tilt });
    return d;
  };
  const leaf = (px, py, pz, ls, yaw, tilt) => _cannabisInst.push({
    p: [px, py, pz], s: ls, yaw, tilt: tilt + rand(-0.09, 0.09), roll: rand(-0.16, 0.16), col: tint(),
  });

  // Radii are deliberately tiny. A real Cannabis stem is 3-5cm across and its branches 1-2cm; the
  // previous 5cm/3cm radii made a 10cm trunk on a 1.5m plant, which is why the skeleton read as
  // branches rather than as a leafy shrub. The blades carry the silhouette, not the wood.
  seg(x, 0, z, H, 0, 0, 0.026 * s);                         // main stalk
  const phase = Math.random() * Math.PI * 2;
  const nodes = 6;
  for (let i = 0; i < nodes; i++) {
    const f = 0.08 + (i / (nodes - 1)) * 0.86;              // 8% → 94% up the stalk
    const y = f * H, pair = phase + i * Math.PI / 2;        // each pair rotated 90° from the last
    const fn = (f - 0.24) / 0.70;                           // 0 at the first branch node → 1 at top
    if (fn < 0) {                                           // skirt: the big lowest pair
      leaf(x, y, z, 0.74 * s, pair, 1.12);
      leaf(x, y, z, 0.74 * s, pair + Math.PI, 1.12);
      continue;
    }
    if (fn < 0.5) {                                         // fork leaves, tapering off as branches take over
      const ls = 0.60 * s * (1 - fn * 0.6);
      leaf(x, y, z, ls, pair + Math.PI / 2, 1.14);
      leaf(x, y, z, ls, pair - Math.PI / 2, 1.14);
    }
    for (let k = 0; k < 2; k++) {
      const yaw = pair + k * Math.PI;
      const bTilt = 1.06 - fn * 0.54;                       // 61° out low, 30° near the apex
      const bLen = H * (0.28 + 0.22 * Math.sin(Math.PI * (0.22 + fn * 0.62)));
      const d = seg(x, y, z, bLen, yaw, bTilt, 0.013 * s);
      // 2-3 leaf nodes spread evenly down the whole branch rather than bunched on the outer half, so
      // the wood stays visible between fans instead of being swallowed by them.
      const pairs = (fn > 0.10 && fn < 0.80) ? 3 : 2;
      for (let j = 0; j < pairs; j++) {
        const t = 0.16 + (pairs > 1 ? j * (0.68 / (pairs - 1)) : 0.4);
        const ls = 0.62 * s * (1 - (j / pairs) * 0.26);
        const bx = x + d[0] * bLen * t, by = y + d[1] * bLen * t, bz = z + d[2] * bLen * t;
        const ly = (j % 2 ? yaw : yaw + Math.PI / 2);        // alternate 90° along the branch
        const spread = 1.05 + bTilt * 0.20 - (j / pairs) * 0.18;   // face out, flattening to the tip
        leaf(bx, by, bz, ls, ly, spread);
        leaf(bx, by, bz, ls, ly + Math.PI, spread);
      }
      const tx = x + d[0] * bLen, ty = y + d[1] * bLen, tz = z + d[2] * bLen;
      leaf(tx, ty, tz, 0.34 * s, yaw, bTilt - 0.30);         // tip leaf rising to the branch end
      if (i >= nodes - COLA_NODES) {
        _budInst.push({ p: [tx, ty + 0.07 * s, tz], s: [0.08 * s * BUD_SCALE, 0.14 * s * BUD_SCALE, 0.08 * s * BUD_SCALE] });
      }
    }
  }
  // Terminal cola: stacked upright sugar leaves around the main bud
  for (let k = 0; k < 4; k++) leaf(x, H * (0.89 + k * 0.05), z, 0.36 * s * (1 - k * 0.12), phase + k * 1.57, 0.50);
  for (let b = 0; b < 3; b++) {
    const r = 0.11 * s * BUD_SCALE * (1 - b * 0.22);
    _budInst.push({ p: [x, H + 0.02 + b * 0.09 * s, z], s: [r, r * 1.35, r] });
  }
}

// Cannabis grows as a scattered fringe along the base of all four perimeter walls, not in corner
// plots. The previous addCannabisField() laid a jitter grid inside a 10x10 patch and drew a raised
// soil slab per row, and both habits read wrong: a ±0.26 m jitter on a 2 m pitch is not enough to
// break a row, so the plants still stood shoulder to shoulder in lines on a dark mat, and the whole
// crop disappeared the moment you faced a wall. Each plant is now its own rejection sample — a random
// point along one wall and a random distance off it — so the fringe thickens and thins on its own the
// way volunteer growth does, and the plants root in the same ground as everything else (no slabs).
// minGap only keeps two shrubs from occupying one spot; it is deliberately far below the old 2 m pitch
// so clustering survives. The inset range is wide because the walls are not bare: at x=±45 sit two
// silos and a shipping container each side, so a fixed 1.6-5.8 m offset left the middle of the east
// and west walls genuinely unplantable. Rooting up to 8 m off the wall gets the fringe past that gear
// and stops the whole crop reading as one hedge line. No colliders, so the fringe is walk-through
// decoration and never enters isFree()/waypoint generation for the hub.
function scatterCannabis(count, minGap = 1.4) {
  const WALL = 49;                             // inner face of the perimeter wall
  const STRETCH = 12;                          // each wall divided into 12 stretches of 7.5 m
  const slots = [];
  for (let side = 0; side < 4; side++) for (let b = 0; b < STRETCH; b++) slots.push([side, b]);
  for (let i = slots.length - 1; i > 0; i--) {  // shuffle, so nothing about the order is rhythmic
    const j = (Math.random() * (i + 1)) | 0;
    const t = slots[i]; slots[i] = slots[j]; slots[j] = t;
  }
  // Walking shuffled stretches, one plant per stretch per pass, is what makes this even. Sampling a
  // uniform coordinate instead left the middle third of the east wall with 3 plants in one run out of
  // three, because the silos and containers at x=±45 reject most of that band - which is the corner
  // clumping the crop is supposed to have outgrown, arriving by luck rather than by grid.
  const placed = [];
  for (let pass = 0; placed.length < count && pass < 8; pass++) {
    for (const slot of slots) {
      if (placed.length >= count) break;
      const [side, b] = slot;
      for (let att = 0; att < 14; att++) {
        const along = -45 + (b + Math.random()) * (90 / STRETCH);
        const inset = rand(1.6, 8.2);              // how far off the wall it rootes
        const sgn = side % 2 ? 1 : -1;
        const runsX = side < 2;                    // the S/N walls run along X, the W/E walls along Z
        const x = runsX ? along : sgn * (WALL - inset);
        const z = runsX ? sgn * (WALL - inset) : along;
        if (inSpawnBand(x, z)) continue;           // keep both spawn lanes clear
        if (!isFree(x, z, 0.6)) continue;
        if (placed.some((p) => (p.x - x) ** 2 + (p.y - z) ** 2 < minGap * minGap)) continue;
        placed.push({ x, z });
        addCannabisPlant(x, z, 0.9 + Math.random() * 0.55);
        break;                                     // this stretch is filled for this pass
      }
    }
  }
  return placed.length;
}


const ground = new THREE.Mesh(new THREE.PlaneGeometry(66, 66), mats.ground);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
worldMeshes.push(ground);

// ── OFFCOMFRT Branded Floor Decals ──
function createTextDecal(text, size, x, z, rotation = 0) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.height = 512;
  ctx.fillStyle = 'rgba(0,0,0,0)';
  ctx.fillRect(0, 0, 512, 512);
  ctx.fillStyle = 'rgba(240,240,242,0.25)';
  ctx.font = `900 ${size}px -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, 256);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ 
    map: tex, 
    transparent: true, 
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.rotation.z = rotation;
  mesh.position.set(x, 0.02, z);
  scene.add(mesh);
}

// Large OFFCOMFRT text at center (horizontal)
createTextDecal('OFFCOMFRT', 64, 0, 0, 0);
// Brand name along walls (horizontal)
createTextDecal('OFFCOMFRT', 48, 0, -28, 0);
createTextDecal('OFFCOMFRT', 48, 0, 28, 0);
createTextDecal('OFFCOMFRT', 48, -28, 0, Math.PI / 2);
createTextDecal('OFFCOMFRT', 48, 28, 0, Math.PI / 2);

// ── Wall Branding (OFFCOMFRT horizontal text) ──
function createWallLogo(x, y, z, rotY = 0) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = 512;
  canvas.height = 128;
  ctx.fillStyle = 'rgba(0,0,0,0)';
  ctx.fillRect(0, 0, 512, 128);
  ctx.fillStyle = 'rgba(240,240,242,0.25)';
  ctx.font = '900 80px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('OFFCOMFRT', 256, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ 
    map: tex, 
    transparent: true, 
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(8, 2), mat);
  mesh.position.set(x, y, z);
  mesh.rotation.y = rotY;
  scene.add(mesh);
}

// ════════════════════════════════════════════════════════════
//  MAP BUILDING FUNCTIONS
// ════════════════════════════════════════════════════════════

function clearMap() {
  // Remove all world meshes and colliders. InstancedMeshes own a per-map instanceMatrix buffer
  // that must be freed on rebuild (otherwise switching maps leaks VRAM). Their shared base
  // geometry (foliage/trunk) and the cached box/cylinder geometries are reused, so we only
  // release the instance buffer here — never the geometry.
  for (const mesh of worldMeshes) {
    scene.remove(mesh);
    if (mesh.isInstancedMesh) mesh.dispose();
  }
  worldMeshes.length = 0;
  colliders.length = 0;
  marshPools = [];   // wading physics must go dry until the next marsh actually gets built
  floodRect = null;  // so must the continuous bayou surface
}

function buildIndustrialMap() {
  // ════════════════════════════════════════════════════════════
  //  ABANDONED INDUSTRIAL COMPLEX. Two footprints share one core builder:
  //   • industrial      — 99x99 (rounds, co-op, free play, Mission 01)
  //   • industrial_east — 136x99: the same arena PLUS a 36 m eastern marshland
  //     (five mission structures over dense flooded wetland). Mission 02
  //     "Ashes of Evidence" is the ONLY consumer — the expansion, its water
  //     physics and its scatter never load in any other mode.
  //  Six duplex buildings (2 walkable floors, interiors, internal stairs,
  //  windows, roofs) around a central street, containers, tanks, silos and
  //  barriers for cover. CT spawn band x[-8,8] z[-45,-40] and T spawn band
  //  x[-20,20] z[35,45] are kept clear.
  // ════════════════════════════════════════════════════════════

  const EAST = selectedMap === 'industrial_east';

  buildGround(99);

  // OFFCOMFRT wordmarks flush on the inner face of each perimeter wall
  createWallLogo(0, 3, -48.4, 0);
  createWallLogo(0, 3, 48.4, Math.PI);
  createWallLogo(-48.4, 3, 0, Math.PI / 2);

  if (EAST) {
    // Eastern mud shelf: the branded floor plane stops at x=49.5 — the marsh strip gets its own
    // darker, matte sheet so the expansion reads as different ground all the way to the east wall.
    addFlat(67.75, 0, 36.5, 99, 0.02, mats.mud);
    createWallLogo(85, 3, 0, -Math.PI / 2);          // east face inner wall at x=86
    // ── Perimeter Walls ── (136x99 after the Mission-02 east expansion; the west wall never moved)
    addBox(18.25, -49.5, 135.5, 1, 8, mats.wall);
    addBox(18.25, 49.5, 135.5, 1, 8, mats.wall);
    addBox(-49.5, 0, 1, 99, 8, mats.wall);
    addBox(86, 0, 1, 99, 8, mats.wall);
  } else {
    // Original symmetric arena: 99x99 with the east wall standing back at x=49.5
    createWallLogo(48.4, 3, 0, -Math.PI / 2);
    addBox(0, -49.5, 99, 1, 8, mats.wall);
    addBox(0, 49.5, 99, 1, 8, mats.wall);
    addBox(-49.5, 0, 1, 99, 8, mats.wall);
    addBox(49.5, 0, 1, 99, 8, mats.wall);
  }

  // ════════════════════════════════════════════════════
  //  DUPLEX BUILDINGS (entry door faces south; internal stairs up east gallery)
  // ════════════════════════════════════════════════════
  addDuplexBuilding(-33, -33, 12, 9);   // NW block
  addDuplexBuilding(33, -33, 12, 9);    // NE block
  addDuplexBuilding(-16, 3, 11, 8);     // central-west block
  addDuplexBuilding(16, 3, 11, 8);      // central-east block
  addDuplexBuilding(-33, 29, 12, 9);    // SW block
  addDuplexBuilding(33, 29, 12, 9);     // SE block
  // Two rounded (octagonal) duplexes flanking the central plaza on the west/east avenues
  addRoundDuplex(-36, 0, 12, 12);       // west rounded duplex
  addRoundDuplex(36, 0, 12, 12);        // east rounded duplex

  // ════════════════════════════════════════════════════
  //  INDUSTRIAL FILLER (tanks, silos, containers, barriers)
  // ════════════════════════════════════════════════════
  // Central street: two tanks + a container as mid cover (spawns stay clear)
  addCylinder(0, -30, 3.0, 3.4, mats.metal);
  addCylinder(0, -22, 2.4, 3.0, mats.metal);
  addContainer(0, 20, 6, 'x');
  addStairs(6.5, 20, 2.6, 8, 2.4, 'W');          // climb onto the mid container

  // Tall silos marking the outer corners
  addCylinder(-45, -12, 2.8, 9, mats.wall2);
  addCylinder(-45, 12, 2.6, 8, mats.wall2);
  addCylinder(45, -12, 2.6, 8, mats.wall2);
  addCylinder(45, 12, 2.8, 10, mats.wall2);

  // Container clusters in the side yards (climbable via stairs)
  addContainer(-45, 0, 6, 'z');
  addContainer(45, 0, 6, 'z');
  addContainer(-45, 0, 6, 'z', 2.6);             // double-stack (west)
  addStairs(-40, -24, 2.6, 8, 2.4, 'W');         // to a lone container top
  addContainer(-45, -24, 6, 'x');

  // Low concrete barriers forming lanes between the buildings
  addBox(0, -14, 8, 1.2, 2.6, mats.concrete);
  addBox(-24, -14, 1.2, 8, 2.4, mats.wall);
  addBox(24, -14, 1.2, 8, 2.4, mats.wall);
  addBox(-24, 16, 1.2, 8, 2.6, mats.wall);
  addBox(24, 16, 1.2, 8, 2.6, mats.wall);
  addBox(0, 12, 6, 1.2, 2.2, mats.concrete);

  // Overhead pipe rack across the central street (walk under)
  addBox(0, -6, 20, 0.4, 0.4, mats.metal, 2, 4.8);
  addBox(-9, -6, 0.4, 0.4, 4.8, mats.wall, 1);
  addBox(9, -6, 0.4, 0.4, 4.8, mats.wall, 1);

  // Sniper perch: 3x3 deck at y=3 on pillars near the north edge, stairs from south
  addPillars(0, -40, 3, 3, 3);
  addPlatform(0, -40, 3.4, 3.4, 3, mats.metal);
  addStairs(0, -35, 3, 8, 2, 'N');

  // Barrels scattered for detail
  addCylinder(-20, -30, 0.6, 1.2, mats.metal);
  addCylinder(20, -30, 0.6, 1.2, mats.metal);
  addCylinder(-8, 28, 0.6, 1.3, mats.metal);
  addCylinder(8, 28, 0.5, 1.1, mats.metal);

  // ════════════════════════════════════════════════════
  //  PAVEMENT STREETS (thin raised walkways connecting the blocks)
  // ════════════════════════════════════════════════════
  // Avenues run N-S along x=±28 and E-W along z=±20, plus a central plaza.
  addPavement(0, 0, 8, 70);          // central N-S avenue
  addPavement(-28, 0, 5, 70);        // west avenue
  addPavement(28, 0, 5, 70);         // east avenue
  addPavement(0, -20, 70, 5);        // north cross street
  addPavement(0, 20, 70, 5);         // south cross street
  addPavement(0, 0, 16, 16);         // central plaza
  addPavement(0, -32, 44, 4);        // far-north cross walk
  addPavement(0, 32, 44, 4);         // far-south cross walk
  addPavement(-38, 0, 4, 44);        // outer-west sidewalk
  addPavement(38, 0, 4, 44);         // outer-east sidewalk
  addPavement(-14, 0, 3, 40);        // inner-west walk
  addPavement(14, 0, 3, 40);         // inner-east walk

  // ════════════════════════════════════════════════════
  //  ROUND WALKABLE TOWERS (lighthouse-style lookouts)
  // ════════════════════════════════════════════════════
  addRoundTower(-28, -2, 3.2, 5);    // west lighthouse (stairs run south onto the avenue)
  addRoundTower(28, 2, 3.2, 5);      // east lighthouse
  addRoundTower(0, -34, 2.8, 4);     // north lookout near CT lane

  // ════════════════════════════════════════════════════
  //  VEHICLES (trucks with climbable beds + low cars) parked on the streets
  // ════════════════════════════════════════════════════
  addVehicle(-28, -18, 'x', 'truck');
  addVehicle(28, 18, 'x', 'truck');
  addVehicle(-4, 30, 'z', 'truck');
  addVehicle(6, -28, 'z', 'car');
  addVehicle(-14, 12, 'x', 'car');
  addVehicle(14, -12, 'x', 'car');
  addVehicle(30, -30, 'z', 'car');

  // ════════════════════════════════════════════════════
  //  EASTERN MARSHLAND EXPANSION — OPERATION BLACKOUT 02 (x ≥ 43)
  //  Five mission structures + boardwalk lanes, mirrored collider-for-collider in
  //  cs-map.js buildIndustrialEast(). Water/reeds/grass/fog carry NO colliders at all:
  //  the flooded floor stays fully walkable so bots never gridlock on decoration.
  // ══════════════════════════════════════════════════════════
  if (EAST) {
  addWarehouse(70, -18, 16, 12, 5.0);        // eastern weapons warehouse / archive
  addGreenhouse(48, 10, 10, 7);              // abandoned workers' greenhouse (Purple Bud)
  addMaintenanceRoom(72, 8, 8, 6);           // emergency resupply shed
  addAdminWing(78, 26, 14, 10);              // administrative wing — Kessler's office
  addServiceComplex(58, 40, 12, 9);          // NE service complex — extraction point

  // Boardwalk spine + arms. The ~2 m gaps beside every run stay free so bots keep lanes.
  addPavement(56, 8, 4, 52);                 // N-S spine through the marsh
  addPavement(63, -18, 12, 3);               // W connector to the warehouse door
  addPavement(58, 40, 10, 3);                // S arm to the service complex
  addPavement(71, 3, 12, 3);                 // warehouse <-> maintenance link
  addPavement(76, 17, 3, 14);                // maintenance <-> admin wing
  addPavement(60, -30, 6, 2.5);              // dock
  addPavement(64, 20, 5, 2.5);               // jetty
  addPavement(52, -6, 2.5, 7);               // side boardwalk

  // Decaying industrial leftovers in the marsh (low, climbable cover)
  addContainer(62, -38, 6, 'x');
  addContainer(52, 34, 6, 'z');
  addCylinder(56, -42, 2.2, 2.4, mats.metal);        // collapsed tank
  addCylinder(50, 40, 1.8, 1.8, mats.metal);         // half-buried tank
  crate(58, -24, 1.4); crate(66, 30, 1.6);
  crate(54, 20, 1.2); crate(62, 44, 1.3);
  }

  // ════════════════════════════════════════════════════
  //  VEGETATION — fills open ground; trunks are thin & trees spaced so player/bots move easily
  //  (placed last so isFree() sees every structure/pavement already added)
  // ════════════════════════════════════════════════════
  // One compact forest for flavour, then even map-wide scatter (spread, NOT clustered).
  // Placed last so isFree() sees every structure/pavement already added.
  addForest(-40, 4, 6, 18, 3.4);
  scatterTrees(95, 5.5);
  scatterBushes(75, 4.5);

  // Cannabis: a scattered fringe along the base of all four perimeter walls, so the crop reads from
  // anywhere in the arena instead of only in the corners. Spawn lanes stay clear via inSpawnBand().
  scatterCannabis(140);

  // The marsh itself: ponds, dense reed stands, grass hummocks and drifting fog across x ≥ 45.
  // Placed after every structure so isFree() keeps water off buildings and boardwalks.
  // Mission-02 only — the plain 99x99 arena has no wetland at all.
  marshPools = EAST ? scatterMarsh() : [];

  finalizeVegetation();   // build the InstancedMeshes (trunks, foliage, cannabis, reeds, grass)

  // Scattered crates for cover along the lanes
  crate(-8, -18, 1.4); crate(8, -18, 1.4);
  crate(-20, 8, 1.5); crate(20, 8, 1.5);
  crate(-8, 30, 1.2); crate(8, 30, 1.2);

  // Freeze per-frame world-matrix computation on every static world mesh. The scene graph
  // traverses 1,200+ children calling updateMatrixWorld() each frame; since none of them move
  // after build (only player/bots are dynamic and aren't in worldMeshes), baking the final matrix
  // and disabling autoUpdate saves ~1,200 matrix multiplications per frame — the main reason
  // rotation/movement felt laggy.
  for (const m of worldMeshes) { m.updateMatrix(); m.updateMatrixWorld(true); m.matrixAutoUpdate = false; }
  renderer.shadowMap.needsUpdate = true; // ensure shadow map populates on first frame after build

  console.log(`[CS] Industrial Complex: 6 duplexes + round towers, vehicles, pavement streets${EAST ? ` + eastern marshland (${marshPools.length} pools, 136x99)` : ' (99x99, no marsh)'}`);
}

function buildClassicMap() {
  // ════════════════════════════════════════════════════════════
  //  CLASSIC ARENA — 66x66 Arena (Original)
  // ════════════════════════════════════════════════════════════

  buildGround(66);

  // Wall logos on inner walls (horizontal OFFCOMFRT text)
  createWallLogo(-18, 3, 6, Math.PI / 2);
  createWallLogo(18, 3, -6, -Math.PI / 2);
  createWallLogo(0, 3, -32, 0);
  createWallLogo(0, 3, 32, Math.PI);

  addBox(0, -32.5, 66, 1, 7, mats.wall);
  addBox(0, 32.5, 66, 1, 7, mats.wall);
  addBox(-32.5, 0, 1, 66, 7, mats.wall);
  addBox(32.5, 0, 1, 66, 7, mats.wall);
  addBox(-18, 0, 20, 1.2, 5, mats.wall);
  addBox(18, 0, 20, 1.2, 5, mats.wall);
  addBox(0, 0, 6, 6, 4.2, mats.wall2);
  addBox(-22, -14, 8, 10, 5.5, mats.wall2);
  addBox(22, 16, 10, 8, 5.5, mats.wall2);
  addBox(-4, 15, 6, 4, 3.5, mats.wall2);
  addBox(5, -14, 4, 6, 3.5, mats.wall2);
  addBox(-10, 19, 1.2, 12, 4.5, mats.wall);
  addBox(11, -20, 1.2, 12, 4.5, mats.wall);
  addBox(-26, 10, 8, 1.2, 4, mats.wall);
  addBox(26, -8, 8, 1.2, 4, mats.wall);
  addBox(16, 6, 6, 2.4, 2.6, mats.metal, 3);
  addBox(-15, -6, 2.4, 6, 2.6, mats.metal, 3);
  crate(-21, 21, 2); crate(-19, 21, 2); crate(-21, 21, 1.3, 2);
  crate(-16, 25, 1.2); crate(-25, 17, 1.4);
  crate(21, -16, 2); crate(21, -18, 2); crate(21, -16, 1.3, 2);
  crate(16, -12, 1.2); crate(25, -22, 1.4); crate(26, -24, 1.1);
  crate(-6, -6, 1.3); crate(6, 6, 1.3); crate(-3, 7, 1.1); crate(3, -8, 1.1);
  crate(-12, -24, 1.4); crate(12, 25, 1.4); crate(-28, -28, 1.6); crate(28, 28, 1.6);
  crate(-28, 2.5, 1.2); crate(28, -2.5, 1.2); crate(0, 22, 1.2); crate(0, -22, 1.2);
  for (const m of worldMeshes) { m.updateMatrix(); m.updateMatrixWorld(true); m.matrixAutoUpdate = false; }
  renderer.shadowMap.needsUpdate = true;
}

// ── Waypoints ──
const waypoints = [];
function generateWaypoints() {
  waypoints.length = 0;
  const b = mapBounds();
  const count = selectedMap === 'classic' ? 60 : selectedMap === 'industrial_east' ? 260 : 140;
  const xLo = b.xMin + 3, xHi = b.xMax - 3, zLo = -b.halfD + 3, zHi = b.halfD - 3;
  // Guarded: if a map edit ever makes free space scarce this must degrade to fewer waypoints rather
  // than spin the browser forever inside a while loop.
  let guard = 0;
  while (waypoints.length < count && guard++ < count * 300) {
    const x = rand(xLo, xHi), z = rand(zLo, zHi);
    if (isFree(x, z, 0.9)) waypoints.push(new THREE.Vector2(x, z));
  }
}

// ── Physics tables come from cs-map.js, the same module the hub loads for co-op ──
// The visual builders push their own colliders while the map is drawn (so vegetation placement
// still sees the structures), then this replaces the whole array with the shared table, keeping
// only the randomly-scattered tree trunks, which exist client-side only. It also diffs the two
// lists and shouts in the console if they disagree — that drift is exactly what used to make bots
// take cover behind walls the player could walk through.
function installSharedColliders() {
  if (typeof CSMap === 'undefined' || !CSMap.collidersFor) {
    console.warn('[CS] cs-map.js not loaded — keeping the collider list built by the visual builders');
    return;
  }
  const key = (c) => `${c.minX.toFixed(2)}|${c.maxX.toFixed(2)}|${c.minZ.toFixed(2)}|${c.maxZ.toFixed(2)}|${c.minY.toFixed(2)}|${c.maxY.toFixed(2)}`;
  const visual = colliders.filter((c) => !c.veg);
  const shared = CSMap.collidersFor(selectedMap);
  const vKeys = new Set(visual.map(key)), sKeys = new Set(shared.map(key));
  const onlyVisual = visual.filter((c) => !sKeys.has(key(c))).length;
  const onlyShared = shared.filter((c) => !vKeys.has(key(c))).length;
  if (onlyVisual || onlyShared) {
    console.warn(`[CS] cs-map.js layout is out of step with the drawn map: ${onlyVisual} collider(s) only in the map, ${onlyShared} only in cs-map.js`);
  } else {
    console.log(`[CS] Colliders locked to cs-map.js (${shared.length} volumes, matches drawn map)`);
  }
  const veg = colliders.filter((c) => c.veg);
  colliders.length = 0;
  for (const c of shared) colliders.push(c);
  for (const c of veg) colliders.push(c);
}

function buildMap() {
  clearMap();
  if (selectedMap === 'classic') {
    buildClassicMap();
    console.log('[CS] Classic map loaded (66x66)');
  } else {
    buildIndustrialMap();
    console.log(selectedMap === 'industrial_east'
      ? '[CS] Industrial Complex map loaded (136x99, marsh east)'
      : '[CS] Industrial Complex map loaded (99x99)');
  }
  installSharedColliders();
  generateWaypoints();
}

// ── Physics helpers ──
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);

// Physics helpers. Each one is a thin wrapper over cs-map.js so the player, the local bots and the
// co-op hub all resolve the same arithmetic — the previous local copies were how the two sides
// drifted apart in the first place.
function circleHitsBox(x, z, r, c) {
  return CSMap.circleHitsBox(x, z, r, c);
}

function collide(pos, r, h, step) {
  CSMap.collide(colliders, pos, r, h, step);
}

const STEP = CSMap.STEP;
function groundHeight(pos, r) {
  return CSMap.groundHeight(colliders, pos, r, STEP);
}

function mapHalf() { return CSMap.info(selectedMap).half; }

// Rectangular bounds accessor: industrial_east (Mission-02 marsh arena) runs x[-49.5, 64.5], so any
// confinement clamp has to take xMin/xMax per axis instead of a symmetric half — same rule that
// keeps spawn bands honest: derive from the shared table, never from a literal.
function mapBounds() { return CSMap.info(selectedMap); }

function isFree(x, z, r) {
  return CSMap.isFree(colliders, mapBounds(), x, z, r);
}

// Nudge a desired spawn point to nearby open ground (footprint test), or null if nothing frees up
// within 10 tries. Dynamic wave spawns use this so a tree trunk or boardwalk edge near the chosen
// story beat never silently cancels the enemy.
function findFreeNear(x, z, r) {
  if (isFree(x, z, r)) return { x, z };
  for (let i = 0; i < 10; i++) {
    const nx = x + (Math.random() - 0.5) * 4, nz = z + (Math.random() - 0.5) * 4;
    if (isFree(nx, nz, r)) return { x: nx, z: nz };
  }
  return null;
}

// Build initial map (industrial by default)
buildMap();

const rayLOS = new THREE.Raycaster();
const _tmpDir = new THREE.Vector3();
// Fast LOS: ray-vs-AABB slab test against the collider table (727 boxes).
// 6 float ops per box vs ~200+ per mesh triangle intersection — critical because
// 8 bots call this every frame (480×/sec × 1026 mesh tests was the worst CPU cost).
function hasLOS(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 0.001) return true;
  const invDx = 1 / dx, invDy = 1 / dy, invDz = 1 / dz;
  for (let i = 0, n = colliders.length; i < n; i++) {
    const c = colliders[i];
    if (c.veg) continue; // vegetation doesn't block sight
    // Slab method: compute entry/exit t values for each axis
    let t1 = (c.minX - from.x) * invDx, t2 = (c.maxX - from.x) * invDx;
    let tmin = Math.min(t1, t2), tmax = Math.max(t1, t2);
    t1 = (c.minY - from.y) * invDy; t2 = (c.maxY - from.y) * invDy;
    tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
    if (tmin > tmax) continue;
    t1 = (c.minZ - from.z) * invDz; t2 = (c.maxZ - from.z) * invDz;
    tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
    if (tmin <= tmax && tmax > 0 && tmin < 1) return false; // ray hits this collider
  }
  return true;
}

// ── Audio (synthesised) ──
let actx = null, noiseBuf = null;
function audio() {
  if (!actx) {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    noiseBuf = actx.createBuffer(1, actx.sampleRate, actx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return actx;
}

// ── Shot voice cap: prevents rapid-fire from stacking dozens of live nodes ──
const shotVoices = [];
const SHOT_VOICE_CAP = 4;
function playShot(vol = 1, tone = 1) {
  const a = audio(), t = a.currentTime;
  // Cull expired voices
  const now = t;
  for (let i = shotVoices.length - 1; i >= 0; i--) { if (shotVoices[i] <= now) shotVoices.splice(i, 1); }
  if (shotVoices.length >= SHOT_VOICE_CAP) return; // drop this shot
  shotVoices.push(t + 0.3);
  const src = a.createBufferSource();
  src.buffer = noiseBuf;
  const f = a.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(3200 * tone, t);
  f.frequency.exponentialRampToValueAtTime(400, t + 0.2);
  const g = a.createGain();
  g.gain.setValueAtTime(0.5 * vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
  src.connect(f).connect(g).connect(a.destination);
  src.start(t, Math.random() * 0.5);
  src.stop(t + 0.3);
  const o = a.createOscillator(), og = a.createGain();
  o.frequency.setValueAtTime(160 * tone, t);
  o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
  og.gain.setValueAtTime(0.6 * vol, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
  o.connect(og).connect(a.destination);
  o.start(t);
  o.stop(t + 0.15);
}

// ── Footsteps (synthesised, distance-aware) ──
// One shared master gain + a StereoPannerNode for left/right self-step alternation +
// a per-step HRTF PannerNode for enemy spatialisation.
// Voice cap stops a 13-bot lobby from stacking 40 live nodes in one second.
const FOOTSTEP_RANGE = 24;          // enemy steps beyond this are culled entirely
const footstepBus = { panner: null, gain: null, voices: [] };
let stepFlip = 1;                   // alternates L/R so gait reads as walking

// The frame loop calls footsteps hundreds of times a second; a suspended context
// freezes currentTime at 0, so every step would schedule at the same instant and
// dump its whole backlog the moment the context resumed. Only speak when running.
let stepDiag = {};
function audioLive() {
  if (actx && actx.state === 'suspended') actx.resume().catch(() => {});
  return actx && actx.state === 'running' ? actx : null;
}

// Autoplay unlock that does not depend on any one button remembering to call
// resume(): the first pointer/touch gesture anywhere creates the context and
// kicks it running, so footsteps and gunfire work on iOS from that frame on.
function unlockAudioOnGesture() {
  const a = audio();
  if (a.state === 'suspended') a.resume().catch(() => {});
}
addEventListener('pointerdown', unlockAudioOnGesture, { capture: true, passive: true });
addEventListener('touchstart', unlockAudioOnGesture, { capture: true, passive: true });

function footstepNode(a, pos, dist) {
  if (!footstepBus.gain) {
    footstepBus.gain = a.createGain();
    footstepBus.gain.gain.value = 1;
    footstepBus.gain.connect(a.destination);
  }
  if (!footstepBus.panner) {
    // StereoPannerNode (not PannerNode) — the shared bus only swings self steps L/R;
    // enemy spatialisation uses a separate HRTF PannerNode per step below.
    footstepBus.panner = a.createStereoPanner();
    footstepBus.panner.connect(footstepBus.gain);
  }
  footstepBus.panner.pan.value = clamp(stepFlip * 0.4, -0.4, 0.4);
  stepFlip = -stepFlip;
  let src = footstepBus.panner;
  if (dist > 0.1) {
    // Spatialise enemy steps; the player's own steps bypass the panner at unity gain.
    // iOS Safari has no positionX/Y/Z AudioParams on PannerNode — writing them threw
    // inside Bot.update and killed the whole frame, so fall back to setPosition.
    const p = a.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'linear';
    p.refDistance = 1; p.maxDistance = FOOTSTEP_RANGE;
    if (p.positionX) {
      p.positionX.value = pos.x; p.positionZ.value = pos.z; p.positionY.value = (pos.y || 0) + 0.1;
    } else {
      p.setPosition(pos.x, (pos.y || 0) + 0.1, pos.z);
    }
    p.connect(footstepBus.gain);
    src = p;
  }
  // Voice cap: if too many steps are live, kill the oldest
  const now = a.currentTime;
  footstepBus.voices = footstepBus.voices.filter(v => v.end > now);
  if (footstepBus.voices.length >= 6) { try { footstepBus.voices.shift().src.stop(); } catch (_) {} }
  return src;
}

// profile: 'self' = crisp boot scuff right under the camera (your own steps)
//          'enemy' = heavier, duller, lowpassed — instantly distinguishable
// Real footstep = three layered components: impact transient (heel strike), body
// resonance (low thud), and surface contact (scuff tail). Each gets its own
// oscillator/noise source with natural envelopes for a convincing footstep.
function playFootstep(profile, pos, dist, volScale = 1) {
  const a = audioLive();
  const self = profile === 'self';
  const vol = (self ? 0.30 : 0.65 * (1 - dist / FOOTSTEP_RANGE)) * volScale;
  // One-shot diagnostics: the first step of each profile announces why it played
  // or why it was culled, so a "no footsteps" report pinpoints its own branch.
  if (!stepDiag[profile]) {
    stepDiag[profile] = true;
    console.log('[CS][steps]', profile, !a ? 'BLOCKED ctx=' + (actx ? actx.state : 'none') : 'OK dist=' + dist.toFixed(1) + ' vol=' + vol.toFixed(3));
  }
  if (!a) return;
  const t = a.currentTime;
  const dest = footstepNode(a, pos, dist);
  if (!self && vol <= 0.004) return;

  // 1. Impact transient: dull heel strike, low-frequency thud (not a sharp click)
  const impact = a.createBufferSource();
  impact.buffer = noiseBuf;
  impact.playbackRate.value = self ? rand(0.6, 0.8) : rand(0.4, 0.6);
  const impactFilt = a.createBiquadFilter();
  impactFilt.type = 'lowpass';
  impactFilt.frequency.value = self ? rand(400, 700) : rand(250, 500);
  impactFilt.Q.value = 0.5;
  const impactGain = a.createGain();
  impactGain.gain.setValueAtTime(0, t);
  impactGain.gain.linearRampToValueAtTime(vol * (self ? 0.45 : 0.6), t + 0.015);
  impactGain.gain.exponentialRampToValueAtTime(0.001, t + (self ? 0.05 : 0.07));
  impact.connect(impactFilt).connect(impactGain).connect(dest);
  impact.start(t, Math.random() * 0.3);
  impact.stop(t + 0.08);

  // 2. Body resonance: dominant low thud, the weight of the footstep
  const bodyOsc = a.createOscillator();
  bodyOsc.type = 'sine';
  bodyOsc.frequency.setValueAtTime(self ? rand(80, 120) : rand(55, 85), t);
  bodyOsc.frequency.exponentialRampToValueAtTime(self ? rand(45, 65) : rand(35, 50), t + 0.12);
  const bodyGain = a.createGain();
  bodyGain.gain.setValueAtTime(0, t);
  bodyGain.gain.linearRampToValueAtTime(vol * (self ? 0.9 : 1.2), t + 0.012);
  bodyGain.gain.exponentialRampToValueAtTime(0.001, t + (self ? 0.15 : 0.2));
  bodyOsc.connect(bodyGain).connect(dest);
  bodyOsc.start(t);
  bodyOsc.stop(t + 0.22);

  // 3. Surface contact: subtle low scuff, not a bright scrape
  const scuff = a.createBufferSource();
  scuff.buffer = noiseBuf;
  scuff.playbackRate.value = self ? rand(0.5, 0.7) : rand(0.3, 0.5);
  const scuffFilt = a.createBiquadFilter();
  scuffFilt.type = 'lowpass';
  scuffFilt.frequency.value = self ? rand(900, 1400) : rand(500, 900);
  scuffFilt.Q.value = 0.8;
  const scuffGain = a.createGain();
  scuffGain.gain.setValueAtTime(0, t + 0.015);
  scuffGain.gain.linearRampToValueAtTime(vol * (self ? 0.2 : 0.3), t + 0.035);
  scuffGain.gain.exponentialRampToValueAtTime(0.001, t + (self ? 0.14 : 0.2));
  scuff.connect(scuffFilt).connect(scuffGain).connect(dest);
  scuff.start(t + 0.015, Math.random() * 0.5);
  scuff.stop(t + 0.22);

  footstepBus.voices.push({ src: impact, end: t + 0.2 });
}

// ══ Wading audio: a soft filtered-noise plip with a falling droplet tail — clearly water, ══
// never a boot scuff. Same bus/voice-cap as footsteps so 30 ripples can never stack oscillators.
function playSplash(pos, deep) {
  const a = audioLive();
  if (!a) return;
  const t = a.currentTime;
  const dest = footstepNode(a, pos, 0);
  const src = a.createBufferSource();
  src.buffer = noiseBuf;
  src.playbackRate.value = rand(0.45, 0.8);
  const f = a.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(deep ? 2600 : 1800, t);
  f.frequency.exponentialRampToValueAtTime(300, t + 0.2);
  const g = a.createGain();
  g.gain.setValueAtTime(deep ? 0.2 : 0.13, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
  src.connect(f).connect(g).connect(dest);
  src.start(t, Math.random() * 0.5);
  src.stop(t + 0.26);
  footstepBus.voices.push({ src, end: t + 0.26 });
  // droplet tail: a short falling sine tick the ear reads as water dripping off a boot
  const o = a.createOscillator(), og = a.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(deep ? 620 : 480, t);
  o.frequency.exponentialRampToValueAtTime(160, t + 0.14);
  og.gain.setValueAtTime(0.05, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
  o.connect(og).connect(dest);
  o.start(t);
  o.stop(t + 0.17);
}

// Expanding surface ring where a boot breaks the water. Geometry+material are per-ripple and
// released by updateEffects on fade (it disposes both when `fade` is set — never share them here).
function spawnWaterRipple(x, z, big) {
  const m = new THREE.Mesh(
    new THREE.RingGeometry(0.24, 0.32, 20),
    new THREE.MeshBasicMaterial({ color: 0xd6d6da, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide })
  );
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, 0.055, z);   // just above the flood sheet (0.035) and pond patches (0.05)
  m.renderOrder = 3;
  scene.add(m);
  effects.push({
    obj: m, life: big ? 1.4 : 1.0, max: big ? 1.4 : 1.0, fade: 0.55,
    grow: (e, k) => { const s = 0.3 + (1 - k) * (big ? 3.4 : 2.2); e.obj.scale.set(s, s, 1); },
  });
}

// A few weightless grey droplets kicked up at the boot — same particle pool as impact sparks
function spawnWadeSplash(pos, deep) {
  spawnParticles(new THREE.Vector3(pos.x + rand(-0.25, 0.25), 0.06, pos.z + rand(-0.25, 0.25)),
    null, mats.water, deep ? 5 : 3, deep ? 2.2 : 1.4);
}

function playBeep(freq, dur = 0.05, vol = 0.15, type = 'square') {
  const a = audio(), t = a.currentTime;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur);
}

// ── Effects ──
const effects = [];
// Monochrome particle effects
const sparkGeo = new THREE.BoxGeometry(0.05, 0.05, 0.05);
const sparkMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
const dustMat = new THREE.MeshBasicMaterial({ color: 0x888888 });
// Monochrome hit effect (dark sparks instead of blood)
const bloodMat = new THREE.MeshBasicMaterial({ color: 0x2a2a2a });
const holeGeo = new THREE.CircleGeometry(0.06, 8);
const holeMat = new THREE.MeshBasicMaterial({ color: 0x0a0a0a, polygonOffset: true, polygonOffsetFactor: -4 });
const decals = [];

// ── Particle / tracer object pools (avoid per-frame GC) ──
const PARTICLE_POOL_SIZE = 200;
const TRACER_POOL_SIZE = 50;
const particlePool = [];
const tracerPool = [];
for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
  const p = new THREE.Mesh(sparkGeo, sparkMat);
  p.visible = false;
  scene.add(p);
  particlePool.push(p);
}
for (let i = 0; i < TRACER_POOL_SIZE; i++) {
  const geo = new THREE.BufferGeometry();
  const mat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 });
  const line = new THREE.Line(geo, mat);
  line.visible = false;
  scene.add(line);
  tracerPool.push(line);
}
function getParticle(mat) {
  for (const p of particlePool) { if (!p.visible) { p.material = mat; p.visible = true; return p; } }
  return null; // pool exhausted
}
function getTracer(color) {
  for (const l of tracerPool) { if (!l.visible) { l.material.color.setHex(color); l.visible = true; return l; } }
  return null; // pool exhausted
}

function spawnTracer(from, to, color = 0xffffff) {
  const line = getTracer(color);
  if (!line) return;
  line.geometry.setFromPoints([from, to]);
  effects.push({ obj: line, life: 0.06, max: 0.06, fade: true, pooled: true });
}

function spawnParticles(point, normal, mat, count, speed) {
  for (let i = 0; i < count; i++) {
    const p = getParticle(mat);
    if (!p) break; // pool exhausted, skip remaining
    p.position.copy(point);
    const v = new THREE.Vector3(rand(-1, 1), rand(-0.2, 1), rand(-1, 1)).multiplyScalar(speed);
    if (normal) v.addScaledVector(normal, speed);
    effects.push({ obj: p, vel: v, life: rand(0.2, 0.45), pooled: true });
  }
}

function spawnHole(point, normal) {
  const m = new THREE.Mesh(holeGeo, holeMat);
  m.position.copy(point).addScaledVector(normal, 0.01);
  m.lookAt(point.clone().add(normal));
  scene.add(m);
  decals.push(m);
  if (decals.length > 80) scene.remove(decals.shift());
}

function updateEffects(dt) {
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i];
    e.life -= dt;
    if (e.vel) { e.vel.y -= 12 * dt; e.obj.position.addScaledVector(e.vel, dt); }
    if (e.grow) e.grow(e, Math.max(0, e.life / e.max));
    if (e.fade) e.obj.material.opacity = Math.max(0, e.life / e.max) * 0.8;
    if (e.life <= 0) {
      if (e.pooled) {
        // Return to pool: hide but keep in scene for reuse
        e.obj.visible = false;
      } else {
        scene.remove(e.obj);
        if (e.fade) { e.obj.geometry.dispose(); e.obj.material.dispose(); }
      }
      effects.splice(i, 1);
    }
  }
}

// ── HUD ──
const $ = id => document.getElementById(id);
const hud = {
  health: $('health'), healthBox: $('health-box'), ammo: $('ammo'), reserve: $('reserve'),
  weapon: $('weapon-name'), timer: $('timer'), round: $('round'), enemies: $('enemies'),
  scoreCT: $('scoreCT'), scoreT: $('scoreT'), kills: $('kills'), killfeed: $('killfeed'),
  center: $('center-msg'), hit: $('hitmarker'), damage: $('damage'), crosshair: $('crosshair'),
  radar: $('radar'), coopBoard: $('goCoop'),
};
const radarCtx = hud.radar.getContext('2d');
let centerTimer = 0, hitTimer = 0, damageFlash = 0;
let lastTimerText = '', lastDamageOpacity = -1;

function centerMsg(text, sub = '', time = 2.5) {
  hud.center.innerHTML = text + (sub ? `<small>${sub}</small>` : '');
  hud.center.classList.add('show');
  centerTimer = time;
}

function killFeed(killer, victim, headshot, playerKilled) {
  const d = document.createElement('div');
  d.innerHTML = `<span class="${playerKilled ? 'bot' : 'you'}">${killer}</span> ➜ ` +
    `<span class="${playerKilled ? 'you' : 'bot'}">${victim}</span>` + (headshot ? ' <span class="hs">HS</span>' : '');
  hud.killfeed.prepend(d);
  setTimeout(() => d.remove(), 5000);
  while (hud.killfeed.children.length > 5) hud.killfeed.lastChild.remove();
}

function showHit(kill) {
  hud.hit.classList.toggle('kill', kill);
  hud.hit.style.opacity = 1;
  hitTimer = 0.18;
}

// ── Weapons + view-model ──
const WEAPONS = {
  rifle: { name: 'RIFLE', mag: 30, reserve: 90, rate: 0.1, auto: true, dmg: 34, reload: 2.3, spread: 0.004, recoil: 0.011, kick: 0.016, speed: 6.0, adsFov: 45, adsY: -0.044 },
  pistol: { name: 'PISTOL', mag: 12, reserve: 48, rate: 0.17, auto: false, dmg: 27, reload: 1.6, spread: 0.006, recoil: 0.02, kick: 0.022, speed: 6.5, adsFov: 58, adsY: -0.03 },
};
const PART_MULT = { head: 4, body: 1, legs: 0.75 };

function buildViewModel(type) {
  const g = new THREE.Group();
  // Monochrome weapon materials
  const dark = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.4, metalness: 0.7 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x1a1a1e, roughness: 0.7 });
  const skin = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.8 });
  const glove = new THREE.MeshStandardMaterial({ color: 0x141418, roughness: 0.8 });
  const box = (w, h, d, m, x, y, z, rx = 0) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z); mesh.rotation.x = rx; g.add(mesh); return mesh;
  };
  if (type === 'rifle') {
    box(0.07, 0.09, 0.55, dark, 0, 0, -0.1);
    box(0.06, 0.07, 0.22, wood, 0, -0.01, -0.42);
    box(0.065, 0.11, 0.24, wood, 0, -0.03, 0.27);
    box(0.05, 0.18, 0.08, dark, 0, -0.12, -0.12, 0.35);
    box(0.045, 0.12, 0.05, wood, 0, -0.09, 0.06, -0.3);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.3, 8), dark);
    barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.015, -0.62); g.add(barrel);
    box(0.012, 0.04, 0.012, dark, 0, 0.06, -0.66);
    box(0.08, 0.08, 0.2, glove, -0.03, -0.06, -0.38);
    box(0.08, 0.08, 0.14, skin, 0.02, -0.11, 0.08);
    g.userData.muzzle = new THREE.Vector3(0, 0.015, -0.78);
  } else {
    box(0.05, 0.06, 0.24, dark, 0, 0, -0.08);
    box(0.045, 0.14, 0.06, dark, 0, -0.08, 0.0, -0.25);
    box(0.09, 0.09, 0.12, glove, 0, -0.1, 0.03);
    g.userData.muzzle = new THREE.Vector3(0, 0.01, -0.21);
  }
  const flash = new THREE.Mesh(
    new THREE.PlaneGeometry(0.22, 0.22),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
  );
  flash.position.copy(g.userData.muzzle); flash.visible = false; g.add(flash);
  g.userData.flash = flash;
  g.scale.setScalar(0.7); g.visible = false;
  weaponScene.add(g);
  return g;
}

const inventory = {
  rifle: { def: WEAPONS.rifle, ammo: 30, reserve: 90, model: buildViewModel('rifle') },
  pistol: { def: WEAPONS.pistol, ammo: 12, reserve: 48, model: buildViewModel('pistol') },
};
let current = inventory.rifle;
const VM_BASE = new THREE.Vector3(0.19, -0.2, -0.56);
const weaponState = { cooldown: 0, reloading: 0, switching: 0, recoil: 0, kickAnim: 0, flashTime: 0, bob: 0, ads: 0 };
let aiming = false;

// The weapon rail lights from the weapon actually held, not from the pad that was last tapped —
// the mouse wheel on a desktop and the rail on a phone then cannot disagree.
function syncWeaponRail() {
  const pistol = current === inventory.pistol;
  document.querySelectorAll('.weapon-btn').forEach((b, i) => b.classList.toggle('active', i === (pistol ? 1 : 0)));
}

function setWeapon(key) {
  const next = inventory[key];
  if (!next || next === current) return;
  current.model.visible = false;
  current = next; current.model.visible = true;
  weaponState.reloading = 0; weaponState.switching = 0.45;
  playBeep(220, 0.04, 0.08); updateAmmoHud(); syncWeaponRail();
}

function updateAmmoHud() {
  hud.weapon.textContent = current.def.name;
  hud.ammo.textContent = current.ammo;
  hud.reserve.textContent = current.reserve;
}

function reload() {
  const w = current;
  if (weaponState.reloading > 0 || w.ammo >= w.def.mag || w.reserve <= 0 || !player.alive) return;
  weaponState.reloading = w.def.reload; playBeep(320, 0.05, 0.1);
}

function finishReload() {
  const w = current;
  const need = w.def.mag - w.ammo, take = Math.min(need, w.reserve);
  w.ammo += take; w.reserve -= take;
  playBeep(520, 0.05, 0.1); updateAmmoHud();
}

// ── Player ──
// Bumped from the original 100 — read this constant for the player's full health
const PLAYER_MAX_HEALTH = 200;
const player = {
  pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: Math.PI, pitch: 0,
  onGround: true, health: PLAYER_MAX_HEALTH, alive: true, eye: 1.65, speed: 0,
};
const P_RADIUS = 0.35, P_HEIGHT = 1.8;

function damagePlayer(amount, attacker) {
  if (!player.alive || game.state !== 'playing') return;
  player.health = Math.max(0, player.health - amount);
  damageFlash = Math.min(1, damageFlash + 0.45);
  hud.health.textContent = Math.ceil(player.health);
  hud.healthBox.classList.toggle('low', player.health <= 25);
  playBeep(90, 0.08, 0.2, 'sawtooth');
  // Escort mode — the escorted NPC takes splash damage during firefight
  if (missionState.escortActive && missionState.escortNPC) {
    missionState.escortHealth = Math.max(0, missionState.escortHealth - amount * 0.3);
    if (missionState.escortHealth <= 0) {
      showMissionNotification(`${missionState.escortName} DOWN — MISSION FAILED`);
      missionState.escortActive = false;
      setTimeout(() => triggerGameOver(), 1500);
    }
  }
  if (player.health <= 0) {
    player.alive = false;
    killFeed(attacker.name, 'You', false, true);
    // ── Portal integration: player death = game over ──
    triggerGameOver();
  }
}


// ── Bots ──
const BOT_NAMES = ['Viper', 'Jackal', 'Cobra', 'Raven', 'Ghost', 'Hyena', 'Scorpion', 'Wolf', 'Falcon', 'Mamba', 'Rook', 'Shadow'];
// Lighter bot materials for visibility (white/light gray)
const botMats = {
  skin: new THREE.MeshStandardMaterial({ color: 0xd0d0d0, roughness: 0.9 }),
  mask: new THREE.MeshStandardMaterial({ color: 0x4a4a4a, roughness: 0.9 }),
  shirt: new THREE.MeshStandardMaterial({ color: 0xe0e0e0, roughness: 0.9 }),
  vest: new THREE.MeshStandardMaterial({ color: 0x6a6a6e, roughness: 0.8 }),
  pants: new THREE.MeshStandardMaterial({ color: 0x8a8a8e, roughness: 0.9 }),
  gun: new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.4, metalness: 0.6 }),
};
const bots = [];

class Bot {
  constructor(x, z, name) {
    this.name = name;
    this.pos = new THREE.Vector3(x, 0, z);
    this.health = 100; this.dead = false; this.deathT = 0; this.yaw = 0;
    this.alert = false; this.lastSeen = new THREE.Vector3();
    this.lostTimer = 0; this.reaction = 0; this.shootCD = 0;
    this.strafeDir = 0; this.strafeTimer = 0; this.target = null;
    this.stuckTimer = 0; this.stuckRef = this.pos.clone();
    this.walkPhase = Math.random() * 10; this.spotted = 0; this.parts = [];
    this.stepDist = 0; this.lastStepPos = this.pos.clone();
    this._losCounter = bots.length % 3; // stagger LOS checks across bots

    const g = this.group = new THREE.Group();
    const part = (geo, mat, x, y, z, partName, parent = g) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z); m.castShadow = true;
      m.userData = { bot: this, part: partName };
      parent.add(m); if (partName) this.parts.push(m); return m;
    };
    this.legL = new THREE.Group(); this.legL.position.set(-0.14, 0.85, 0); g.add(this.legL);
    this.legR = new THREE.Group(); this.legR.position.set(0.14, 0.85, 0); g.add(this.legR);
    part(new THREE.BoxGeometry(0.22, 0.85, 0.24), botMats.pants, 0, -0.425, 0, 'legs', this.legL);
    part(new THREE.BoxGeometry(0.22, 0.85, 0.24), botMats.pants, 0, -0.425, 0, 'legs', this.legR);
    part(new THREE.BoxGeometry(0.58, 0.68, 0.32), botMats.shirt, 0, 1.2, 0, 'body');
    part(new THREE.BoxGeometry(0.6, 0.45, 0.36), botMats.vest, 0, 1.25, 0, 'body');
    part(new THREE.BoxGeometry(0.3, 0.32, 0.3), botMats.mask, 0, 1.74, 0, 'head');
    part(new THREE.BoxGeometry(0.2, 0.06, 0.02), botMats.skin, 0, 1.77, 0.16, 'head');
    part(new THREE.BoxGeometry(0.16, 0.16, 0.5), botMats.shirt, -0.22, 1.32, 0.22, 'body');
    part(new THREE.BoxGeometry(0.16, 0.16, 0.5), botMats.shirt, 0.22, 1.32, 0.22, 'body');
    part(new THREE.BoxGeometry(0.08, 0.1, 0.75), botMats.gun, 0.05, 1.36, 0.55, null);
    g.position.copy(this.pos);
    scene.add(g);
  }

  eye(out = new THREE.Vector3()) { return out.set(this.pos.x, this.pos.y + 1.65, this.pos.z); }

  damage(amount, part) {
    if (this.dead) return false;
    this.health -= amount;
    spawnParticles(this.eye().setY(this.pos.y + (part === 'head' ? 1.74 : part === 'legs' ? 0.5 : 1.2)), null, bloodMat, 8, 2);
    if (!this.alert) this.reaction = rand(0.15, 0.3);
    this.alert = true; this.lastSeen.copy(player.pos);
    if (this.health <= 0) { this.die(); return true; }
    return false;
  }

  die() { this.dead = true; this.parts.forEach(p => (p.userData.part = null)); }

  hear(pos) {
    if (this.dead || this.alert) return;
    this.alert = true; this.reaction = rand(0.3, 0.6);
    this.lastSeen.copy(pos); this.lostTimer = 0;
  }

  pickWaypoint() {
    const from = new THREE.Vector3(this.pos.x, 0.9, this.pos.z);
    for (let i = 0; i < 20; i++) {
      const w = waypoints[(Math.random() * waypoints.length) | 0];
      const to = new THREE.Vector3(w.x, 0.9, w.y);
      if (from.distanceTo(to) > 5 && hasLOS(from, to)) { this.target = w; return; }
    }
    this.target = waypoints[(Math.random() * waypoints.length) | 0];
  }

  moveToward(tx, tz, speed, dt) {
    const dx = tx - this.pos.x, dz = tz - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) return d;
    const s = Math.min(speed * dt, d);
    this.pos.x += (dx / d) * s; this.pos.z += (dz / d) * s;
    return d;
  }

  faceToward(tx, tz, dt, rate = 8) {
    const want = Math.atan2(tx - this.pos.x, tz - this.pos.z);
    let diff = want - this.yaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    this.yaw += diff * Math.min(1, rate * dt);
    return Math.abs(diff);
  }

  shoot(dist) {
    const playerEye = camera.position.clone();
    const muzzle = this.eye().setY(this.pos.y + 1.4);
    const moving = player.speed > 3.2 ? 0.18 : 0;
    const airborne = player.onGround ? 0 : 0.12;
    const crouchBonus = player.eye < 1.4 ? 0.06 : 0;
    // Accuracy eased a notch: base 0.35 -> 0.30 and the round-scaling ceiling 0.65 -> 0.55, so
    // even late rounds cap lower. ~15% fewer landed shots; combined with the softer per-hit
    // damage this is the second dial toward "less lethal" without making bots feel passive.
    const chance = clamp(0.30 + game.round * 0.02 - dist * 0.009 - moving - airborne - crouchBonus, 0.06, 0.55);
    const hit = Math.random() < chance;
    const aim = playerEye.clone().add(new THREE.Vector3(0, -0.35, 0));
    if (!hit) aim.add(new THREE.Vector3(rand(-1, 1), rand(-0.6, 0.8), rand(-1, 1)).multiplyScalar(0.6 + dist * 0.02));
    spawnTracer(muzzle, aim, 0xcccccc);
    playShot(clamp(1.2 - dist / 40, 0.12, 0.8), 0.85);
    // Bot lethality tuned down a notch: base 5–10 → 4–8 and the headshot-style crit 6%/×1.8 →
    // 5%/×1.6. Avg per hit ≈7.9 → ≈6.2 (~22% softer). Hit chance is left untouched so bots still
    // land shots with the same frequency — each one just stings less.
    if (hit) damagePlayer(Math.round(rand(4, 8) * (Math.random() < 0.05 ? 1.6 : 1)), this);
  }

  update(dt) {
    if (this.dead) {
      this.deathT += dt;
      this.group.rotation.x = -Math.min(1, this.deathT * 3.5) * Math.PI / 2;
      this.group.position.y = Math.min(1, this.deathT * 3.5) * 0.18;
      return;
    }
    
    const eye = this.eye();
    const playerChest = camera.position.clone().add(new THREE.Vector3(0, -0.3, 0));
    const dx = player.pos.x - this.pos.x, dz = player.pos.z - this.pos.z;
    const dist = Math.hypot(dx, dz);

    let sees = false;
    if (player.alive && dist < 30) {
      let ang = Math.atan2(dx, dz) - this.yaw;
      ang = Math.abs(Math.atan2(Math.sin(ang), Math.cos(ang)));
      // Throttle expensive LOS ray-march: each bot checks every 3rd frame, staggered
      this._losCounter = (this._losCounter + 1) % 3;
      const losDue = this._losCounter === 0;
      if (losDue && (this.alert || ang < 1.25 || dist < 3)) sees = hasLOS(eye, playerChest);
      else if (!losDue) sees = this._lastSees || false;
      if (losDue) this._lastSees = sees;
    }

    const before = this.pos.clone();
    let moveSpeed = 0;

    if (sees) {
      if (!this.alert) this.reaction = rand(0.7, 1.2) / (1 + game.round * 0.04);
      this.alert = true; this.spotted = 2;
      this.lastSeen.copy(player.pos); this.lostTimer = 0;
      this.faceToward(player.pos.x, player.pos.z, dt, 10);
      this.reaction -= dt;

      this.strafeTimer -= dt;
      if (this.strafeTimer <= 0) { this.strafeDir = [-1, 0, 1][(Math.random() * 3) | 0]; this.strafeTimer = rand(0.5, 1.4); }
      if (this.strafeDir) {
        const sx = (dz / dist) * this.strafeDir, sz = (-dx / dist) * this.strafeDir;
        this.pos.x += sx * 1.6 * dt; this.pos.z += sz * 1.6 * dt;
        moveSpeed = 1.6;
      }
      if (dist > 22) { this.moveToward(player.pos.x, player.pos.z, 2.0, dt); moveSpeed = 2.0; }

      if (this.reaction <= 0) {
        this.shootCD -= dt;
        if (this.shootCD <= 0) {
          this.shoot(dist);
          this.shootCD = Math.random() < 0.4 ? rand(0.1, 0.16) : rand(0.35, 0.8);
        }
      }
    } else if (this.alert) {
      this.lostTimer += dt;
      this.faceToward(this.lastSeen.x, this.lastSeen.z, dt);
      const d = this.moveToward(this.lastSeen.x, this.lastSeen.z, 3.6, dt);
      moveSpeed = 3.6;
      if (d < 1.2 || this.lostTimer > 7) { this.alert = false; this.target = null; }
    } else if (this.patrolCenter) {
      // Circular patrol behavior for mission enemies
      this.patrolAngle += this.patrolSpeed * dt * 0.3;
      const targetX = this.patrolCenter.x + Math.cos(this.patrolAngle) * this.patrolRadius;
      const targetZ = this.patrolCenter.y + Math.sin(this.patrolAngle) * this.patrolRadius;
      this.faceToward(targetX, targetZ, dt, 5);
      const d = this.moveToward(targetX, targetZ, 2.4, dt);
      moveSpeed = 2.4;
    } else {
      if (!this.target) this.pickWaypoint();
      this.faceToward(this.target.x, this.target.y, dt, 5);
      const d = this.moveToward(this.target.x, this.target.y, 2.4, dt);
      moveSpeed = 2.4;
      if (d < 0.8) this.pickWaypoint();
    }

    collide(this.pos, 0.4, 1.8, STEP);
    this.pos.y = groundHeight(this.pos, 0.4);

    // Footsteps: distance-triggered gait (same per-bot, no global rate limiter),
    // culled completely beyond the audible range so idle bots cost nothing.
    if (moveSpeed > 0.4) {
      this.stepDist = Math.hypot(this.pos.x - this.lastStepPos.x, this.pos.z - this.lastStepPos.z);
      if (this.stepDist > (moveSpeed > 3 ? 1.5 : 2.1)) {
        const sd = Math.hypot(this.pos.x - player.pos.x, this.pos.z - player.pos.z);
        if (sd < FOOTSTEP_RANGE) { try { playFootstep('enemy', this.pos, sd); } catch (_) {} }
        this.lastStepPos.copy(this.pos);
      }
    } else {
      this.lastStepPos.copy(this.pos);
    }
    // Confinement has to come from the arena actually drawn — the old ±31.5 literal was written
    // for Classic and pushed the whole terrorist team back inside the walls of the 99m Industrial
    // Complex, so bots could never reach the buildings they were patrolling toward. After the
    // marsh expansion x is asymmetric, so clamp per xMin/xMax rather than ±half.
    const b = mapBounds();
    this.pos.x = clamp(this.pos.x, b.xMin + 1.5, b.xMax - 1.5);
    this.pos.z = clamp(this.pos.z, -(b.halfD) + 1.5, b.halfD - 1.5);

    this.stuckTimer += dt;
    if (this.stuckTimer > 1.2) {
      if (moveSpeed > 0 && this.pos.distanceTo(this.stuckRef) < 0.4) {
        if (!sees) { this.alert = false; this.pickWaypoint(); }
      }
      this.stuckRef.copy(this.pos);
      this.stuckTimer = 0;
    }

    const actual = before.distanceTo(this.pos) / Math.max(dt, 1e-4);
    this.walkPhase += dt * actual * 3.2;
    const swing = Math.sin(this.walkPhase) * Math.min(1, actual / 2) * 0.6;
    this.legL.rotation.x = swing; this.legR.rotation.x = -swing;
    this.spotted = Math.max(0, this.spotted - dt);

    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
  }
}

function clearBots() { for (const b of bots) scene.remove(b.group); bots.length = 0; }

function spawnBots(n) {
  const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
  for (let i = 0; i < n; i++) {
    let x, z, tries = 0;
    const tZMin = selectedMap === 'classic' ? 20 : 35;
    const tZMax = selectedMap === 'classic' ? 25 : 45;
    do { x = rand(-20, 20); z = rand(tZMin, tZMax); tries++; } while ((!isFree(x, z, 0.6) || bots.some(b => Math.hypot(b.pos.x - x, b.pos.z - z) < 1.5)) && tries < 200);
    const b = new Bot(x, z, names[i % names.length]);
    b.yaw = Math.PI; bots.push(b);
  }
}

const aliveBots = () => bots.filter(b => !b.dead);

// ── Shooting ──
const shootRay = new THREE.Raycaster();
let mouseDown = false;

function fire() {
  const w = current, ws = weaponState;
  if (game.state !== 'playing' || !player.alive || ws.cooldown > 0 || ws.reloading > 0 || ws.switching > 0) return;
  if (w.ammo <= 0) {
    playBeep(900, 0.02, 0.08); ws.cooldown = 0.25;
    if (w.reserve > 0) reload(); return;
  }
  w.ammo--; ws.cooldown = w.def.rate; updateAmmoHud();

  const spread = currentSpread();
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const a = Math.random() * Math.PI * 2, r = Math.random() * spread;
  const dir = fwd.addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();

  shootRay.set(camera.position, dir); shootRay.far = 200;
  const targets = worldMeshes.concat(...aliveBots().map(b => b.parts));
  const hit = shootRay.intersectObjects(targets, false)[0];
  const end = hit ? hit.point : camera.position.clone().addScaledVector(dir, 200);

  // In co-op the hub decides what a bullet does, so the fired ray is queued for the next state
  // packet. It is kept as a plain array because it is handed straight onto the wire.
  if (isOnline) {
    pendingRay = {
      o: [camera.position.x, camera.position.y, camera.position.z],
      d: [dir.x, dir.y, dir.z],
      dist: Math.min(200, end.distanceTo(camera.position)),
    };
  }

  const muzzleWorld = camera.position.clone()
    .addScaledVector(new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion), 0.22)
    .addScaledVector(new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion), -0.16)
    .addScaledVector(new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion), 0.7);
  spawnTracer(muzzleWorld, end);

  if (hit) {
    const ud = hit.object.userData;
    if (ud.bot && ud.part) {
      const bot = ud.bot, part = ud.part;
      const killed = bot.damage(w.def.dmg * PART_MULT[part], part);
      showHit(killed); playBeep(killed ? 1400 : 1100, 0.04, 0.12);
      if (killed) {
        game.kills++; hud.kills.textContent = game.kills;
        killFeed('You', bot.name, part === 'head', false);
        hud.enemies.textContent = aliveBots().length;
        if (aliveBots().length === 0) endRound('CT');
      }
    } else if (hit.face) {
      const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      spawnHole(hit.point, n);
      spawnParticles(hit.point, n, Math.random() < 0.5 ? sparkMat : dustMat, 5, 2.5);
    }
  }

  for (const b of aliveBots()) if (b.pos.distanceTo(player.pos) < 28) b.hear(player.pos);

  ws.recoil = Math.min(ws.recoil + w.def.recoil, 0.09);
  player.pitch = clamp(player.pitch + w.def.kick * rand(0.6, 1), -1.5, 1.5);
  player.yaw += rand(-0.5, 0.5) * w.def.kick * 0.6;
  ws.kickAnim = 1; ws.flashTime = 0.05;
  w.model.userData.flash.rotation.z = Math.random() * Math.PI;
  muzzleLight.position.copy(muzzleWorld); muzzleLight.intensity = 6;
  playShot(1, current === inventory.rifle ? 1 : 1.3);
}

function currentSpread() {
  let s = current.def.spread + weaponState.recoil;
  if (player.speed > 3.4) s += 0.035;
  else if (player.speed > 0.5) s += 0.008;
  if (!player.onGround) s += 0.09;
  if (player.eye < 1.4) s *= 0.65;
  return s * (1 - 0.6 * weaponState.ads);
}


// ── Input ──
const keys = {};
let locked = false;
const SENS = 0.0022;

addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.code === 'KeyR') reload();
  if (e.code === 'Digit1') setWeapon('rifle');
  if (e.code === 'Digit2') setWeapon('pistol');
  if (e.code === 'KeyQ') setWeapon(current === inventory.rifle ? 'pistol' : 'rifle');
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
});
addEventListener('keyup', e => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; mouseDown = false; });

document.addEventListener('mousemove', e => {
  if (!locked) return;
  const sens = SENS * camera.fov / 75;
  player.yaw -= e.movementX * sens;
  player.pitch = clamp(player.pitch - e.movementY * sens, -1.5, 1.5);
});

document.addEventListener('mousedown', e => {
  if (!locked) return;
  if (e.button === 2) { aiming = true; return; }
  if (e.button !== 0) return;
  mouseDown = true; fire();
});

document.addEventListener('mouseup', e => {
  if (e.button === 0) mouseDown = false;
  if (e.button === 2) aiming = false;
});

document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('wheel', () => { if (locked) setWeapon(current === inventory.rifle ? 'pistol' : 'rifle'); });

// ── Mobile Touch Controls ──
// Two thumb zones, a fire pad on each side, and a stick that appears where the thumb lands
// rather than where a stylesheet parked it. Every pad writes into the same flags the keyboard
// and mouse write into, so no input path is special-cased inside the simulation.
const touchControls = document.getElementById('touchControls');
const moveZone = document.getElementById('moveZone');
const joystickZone = document.getElementById('joystickZone');
const joystickStick = document.getElementById('joystickStick');
const lookZone = document.getElementById('lookZone');
const btnFire = document.getElementById('btnFire');
const btnFireLeft = document.getElementById('btnFireLeft');
const btnReload = document.getElementById('btnReload');
const btnAds = document.getElementById('btnAds');
const btnJump = document.getElementById('btnJump');
const btnCrouch = document.getElementById('btnCrouch');
const btnPause = document.getElementById('btnPause');
const btnResume = document.getElementById('btnResume');
const btnQuitRound = document.getElementById('btnQuitRound');
const weaponBtns = document.querySelectorAll('.weapon-btn');

// Touch state
const touch = {
  moveX: 0, moveY: 0, // joystick normalized -1 to 1
  lookDX: 0, lookDY: 0, // look delta
  fire: false,
  jump: false,
  crouch: false,
  joystickActive: false,
  lookActive: false,
  lastLookX: 0, lastLookY: 0
};
// Both fire pads drive the one `fire` flag, and each remembers who is still holding it — lifting
// the thumb that is NOT shooting must not cancel a burst the other one is still pressing.
const firePads = { right: false, left: false };
let touchPaused = false;

// Joystick handling. The listeners live on the whole left zone, not on the pad, which is what
// lets the pad be summoned under the finger instead of being aimed at.
let joystickTouch = null;
const joystickBase = joystickZone.querySelector('.joystick-base');

// .move-zone is pinned to the viewport's left edge and full height, so a clientX/clientY is
// already a local offset and the pad can be re-pinned in plain px.
function placeStick(t) {
  const r = joystickZone.offsetWidth / 2;
  joystickZone.style.left = `${t.clientX - r}px`;
  joystickZone.style.top = `${t.clientY - r}px`;
  joystickZone.style.bottom = 'auto';
}
function parkStick() {
  joystickZone.style.left = joystickZone.style.top = joystickZone.style.bottom = '';
}

moveZone.addEventListener('touchstart', e => {
  e.preventDefault();
  if (joystickTouch !== null) return;
  const t = e.changedTouches[0];
  joystickTouch = t.identifier;
  touch.joystickActive = true;
  joystickZone.classList.add('grabbed');
  joystickStick.classList.add('active');
  placeStick(t);
  updateJoystick(t);
}, { passive: false });

moveZone.addEventListener('touchmove', e => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (t.identifier === joystickTouch) updateJoystick(t);
  }
}, { passive: false });

moveZone.addEventListener('touchend', e => {
  for (const t of e.changedTouches) {
    if (t.identifier === joystickTouch) {
      joystickTouch = null;
      touch.joystickActive = false;
      touch.moveX = 0;
      touch.moveY = 0;
      joystickZone.classList.remove('grabbed');
      joystickStick.classList.remove('active');
      joystickStick.style.transform = 'translate(-50%, -50%)';
      parkStick();
    }
  }
});

moveZone.addEventListener('touchcancel', e => {
  joystickTouch = null;
  touch.joystickActive = false;
  touch.moveX = 0;
  touch.moveY = 0;
  joystickZone.classList.remove('grabbed');
  joystickStick.classList.remove('active');
  joystickStick.style.transform = 'translate(-50%, -50%)';
  parkStick();
});

function updateJoystick(t) {
  const rect = joystickBase.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = t.clientX - cx;
  const dy = t.clientY - cy;
  const maxR = rect.width / 2 - 25;
  const dist = Math.min(Math.sqrt(dx * dx + dy * dy), maxR);
  const angle = Math.atan2(dy, dx);
  const nx = Math.cos(angle) * dist;
  const ny = Math.sin(angle) * dist;
  joystickStick.style.transform = `translate(calc(-50% + ${nx}px), calc(-50% + ${ny}px))`;
  touch.moveX = nx / maxR;
  touch.moveY = ny / maxR;
}

// Look zone handling
let lookTouch = null;

lookZone.addEventListener('touchstart', e => {
  e.preventDefault();
  if (lookTouch !== null) return;
  const t = e.changedTouches[0];
  lookTouch = t.identifier;
  touch.lookActive = true;
  touch.lastLookX = t.clientX;
  touch.lastLookY = t.clientY;
}, { passive: false });

lookZone.addEventListener('touchmove', e => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (t.identifier === lookTouch) {
      touch.lookDX += t.clientX - touch.lastLookX;
      touch.lookDY += t.clientY - touch.lastLookY;
      touch.lastLookX = t.clientX;
      touch.lastLookY = t.clientY;
    }
  }
}, { passive: false });

lookZone.addEventListener('touchend', e => {
  for (const t of e.changedTouches) {
    if (t.identifier === lookTouch) {
      lookTouch = null;
      touch.lookActive = false;
    }
  }
});

lookZone.addEventListener('touchcancel', e => {
  lookTouch = null;
  touch.lookActive = false;
});

// Small helper so a pad can own its press and its release without six near-identical listeners.
function bindPad(btn, down, up) {
  if (!btn) return;
  btn.addEventListener('touchstart', (e) => { e.preventDefault(); down(); }, { passive: false });
  if (up) ['touchend', 'touchcancel'].forEach((ev) => btn.addEventListener(ev, up));
}

// Fire pads. The press also shoots once here, which is what a single-shot pistol tap needs; the
// rifle's sustained burst comes from updateWeapon reading touch.fire, exactly as it reads
// mouseDown on a desktop.
function bindFirePad(btn, key) {
  bindPad(btn, () => {
    firePads[key] = true;
    touch.fire = true;
    if (game.state === 'playing' && !touchPaused) fire();
  }, () => {
    firePads[key] = false;
    if (!firePads.right && !firePads.left) touch.fire = false;
  });
}
bindFirePad(btnFire, 'right');
bindFirePad(btnFireLeft, 'left');

// Reload button
bindPad(btnReload, () => { if (game.state === 'playing' && !touchPaused) reload(); });

// Aim down sights — on a desktop this is the right mouse button, a control a phone does not have,
// so the whole accuracy/FOV mechanic was unreachable from the touch layer until this pad existed.
bindPad(btnAds,
  () => { aiming = true; if (btnAds) btnAds.classList.add('on'); },
  () => { aiming = false; if (btnAds) btnAds.classList.remove('on'); });

// Jump / crouch
bindPad(btnJump, () => { touch.jump = true; }, () => { touch.jump = false; });
bindPad(btnCrouch, () => { touch.crouch = true; }, () => { touch.crouch = false; });

// Weapon rail. Which slot is lit comes from the weapon actually held (syncWeaponRail), not from
// the last pad tapped, so the mouse wheel and these buttons can never disagree.
weaponBtns.forEach((btn, i) => bindPad(btn, () => setWeapon(i === 0 ? 'rifle' : 'pistol')));

// Apply touch look to player
function applyTouchLook(dt) {
  if (!touch.lookActive && touch.lookDX === 0 && touch.lookDY === 0) return;
  const sens = SENS * camera.fov / 75 * 1.5; // slightly higher sensitivity for touch
  player.yaw -= touch.lookDX * sens;
  player.pitch = clamp(player.pitch - touch.lookDY * sens, -1.5, 1.5);
  touch.lookDX = 0;
  touch.lookDY = 0;
}

// Override locked check for mobile
function isGameActive() {
  // A touch session has no capture state to hold it open, so the game state alone decides —
  // minus the pause pad, which is the phone's only substitute for losing pointer lock.
  if (isTouchDevice) return game.state === 'playing' && !touchPaused;
  return game.state === 'playing' && locked;
}

// ── Pause on touch ──
// The overlay used to be driven entirely by pointerlockchange, an event a phone never fires, so
// on a phone it could neither be opened nor escaped and there was no way back to the menu from
// inside a round. This flag is the touch half of that same state.
function releaseHeldPads() {
  firePads.right = firePads.left = false;
  touch.fire = touch.jump = touch.crouch = false;
  touch.joystickActive = false;
  touch.moveX = touch.moveY = 0;
  joystickTouch = null;
  aiming = false;
  if (btnAds) btnAds.classList.remove('on');
  joystickZone.classList.remove('grabbed');
  joystickStick.classList.remove('active');
  joystickStick.style.transform = 'translate(-50%, -50%)';
  parkStick();
}

function setTouchPaused(on) {
  if (touchPaused === on) return;
  touchPaused = on;
  pauseOverlay.classList.toggle('hidden', !on);
  if (on) releaseHeldPads();
}

if (btnPause) btnPause.addEventListener('click', () => { if (game.state === 'playing') setTouchPaused(true); });
if (btnResume) btnResume.addEventListener('click', (e) => { e.stopPropagation(); setTouchPaused(false); });
if (btnQuitRound) btnQuitRound.addEventListener('click', (e) => {
  e.stopPropagation();
  setTouchPaused(false);
  quitToMenu();
});
pauseOverlay.addEventListener('click', () => { if (isTouchDevice) setTouchPaused(false); });

// Pointer lock: request when clicking the game screen during play
// This is the primary way to engage pointer lock on desktop
gameScreen.addEventListener('click', (e) => {
  // Don't re-engage if already locked or not in playing state
  if (game.state === 'playing' && !locked && !isTouchDevice) {
    e.preventDefault();
    e.stopPropagation();
    audio().resume();
    renderer.domElement.requestPointerLock();
  }
});

// Also allow clicking directly on the canvas
renderer.domElement.addEventListener('click', (e) => {
  if (game.state === 'playing' && !locked && !isTouchDevice) {
    e.preventDefault();
    audio().resume();
    renderer.domElement.requestPointerLock();
  }
});

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === renderer.domElement;
  pauseOverlay.classList.toggle('hidden', locked || game.state !== 'playing');
  syncMouseHint();
  if (!locked && game.state === 'playing') {
    mouseDown = false; aiming = false;
  }
});

// A refused requestPointerLock() reports itself here and nowhere else — pointerlockchange does not
// fire, so before this listener a co-op match that could not capture the mouse failed silently and
// looked like a broken game rather than an uncaptured mouse.
document.addEventListener('pointerlockerror', () => {
  console.warn('[CS] Pointer lock refused — click the arena to capture the mouse');
});

// ── Game flow ──
const ROUND_TIME = 130;
const game = { state: 'menu', round: 0, ct: 0, t: 0, kills: 0, timeLeft: ROUND_TIME, endTimer: 0 };

// ════════════════════════════════════════════════════════════
//  MISSION SYSTEM — BLACKOUT Campaign
//  Narrative-driven objectives with dialogue, triggers, and persistence
// ════════════════════════════════════════════════════════════

// ── Mission Data Structure ──
const MISSIONS = [
  {
    id: 'mission_1',
    codeName: 'BLACKOUT',
    title: 'Hostage Rescue: The Man Who Stayed',
    briefing: 'A dark command room. A satellite view of Greyhaven appears on a screen. SABLE briefs ROOK on the situation.',
    map: 'industrial',
    objectives: [
      {
        id: 'obj_1_1',
        type: 'enter_zone',
        title: 'Infiltrate the SE Duplex',
        description: 'Breach the southeast duplex to begin the operation',
        zone: { x: 33, z: -33, radius: 6 },
        triggerDistance: 5,
        completed: false
      },
      {
        id: 'obj_1_2',
        type: 'collect_evidence',
        title: 'Search the SW Duplex',
        description: 'Find 3 pieces of evidence scattered inside the southwest duplex',
        location: { x: -33, z: -30, radius: 8 },
        evidenceCount: 3,
        triggerDistance: 2.0,
        completed: false
      },
      {
        id: 'obj_1_3',
        type: 'find_clue',
        title: 'Locate Damaged Radio',
        description: 'Track RAVEN\'s communication from the east bunker',
        location: { x: 36, z: 0, radius: 3 },
        clueType: 'radio',
        triggerDistance: 2.5,
        completed: false
      },
      {
        id: 'obj_1_4',
        type: 'find_npc',
        title: 'Find RAVEN',
        description: 'Locate RAVEN on the upper floor of the northwest duplex',
        location: { x: -33, z: 29, radius: 4 },
        npcName: 'RAVEN',
        triggerDistance: 3,
        completed: false,
        triggersDialogue: true
      },
      {
        id: 'obj_1_5',
        type: 'dialogue_sequence',
        title: 'Extract Intelligence',
        description: 'Learn what RAVEN discovered',
        dialogueId: 'raven_extraction',
        completed: false
      },
      {
        id: 'obj_1_6',
        type: 'escape_zone',
        title: 'Escape via NE Duplex Rooftop',
        description: 'Get RAVEN to the extraction point — 60 seconds!',
        zone: { x: 33, z: 29, radius: 6 },
        triggerDistance: 5,
        requiresNPC: true,
        escort: true,
        timeLimit: 60,
        completed: false
      }
    ],
    dialogues: {
      'opening': [
        { speaker: 'SABLE', text: 'Your man went dark twelve hours ago.', portrait: 'sable' },
        { speaker: 'ROOK', text: 'He isn\'t my man.', portrait: 'rook' },
        { speaker: 'SABLE', text: 'You two still doing that?', portrait: 'sable' },
        { speaker: 'ROOK', text: 'Apparently.', portrait: 'rook' },
        { speaker: 'SABLE', text: 'Intelligence suggests an armed terrorist cell has occupied Greyhaven Industrial Complex. Former Veyra Defence Systems facility. Four years ago there was an incident — chemical leak, official story.', portrait: 'sable' },
        { speaker: 'SABLE', text: 'Your mission: infiltrate the complex, locate RAVEN, extract him and any intelligence he\'s gathered. Be advised, Greyline operatives are on-site. Expect resistance.', portrait: 'sable' },
        { speaker: 'ROOK', text: 'Copy. Moving to target.', portrait: 'rook' }
      ],
      'clue_1': [
        { speaker: 'ROOK', text: 'Spent ammunition. Recent. He was here.', portrait: 'rook' },
        { speaker: 'ROOK', text: 'Trail leads toward the duplex buildings.', portrait: 'rook' }
      ],
      'clue_2': [
        { speaker: 'ROOK', text: 'Damaged radio. He tried to call for extraction.', portrait: 'rook' },
        { speaker: 'ROOK', text: 'Must have been overwhelmed.', portrait: 'rook' }
      ],
      'raven_contact': [
        { speaker: 'ROOK', text: 'RAVEN? You were supposed to stay alive.', portrait: 'rook' },
        { speaker: 'RAVEN', text: 'I was getting around to it.', portrait: 'raven' },
        { speaker: 'ROOK', text: 'You look like hell.', portrait: 'rook' },
        { speaker: 'RAVEN', text: 'And you look expensive. Did they finally promote you?', portrait: 'raven' },
        { speaker: 'ROOK', text: 'No. They just ran out of people.', portrait: 'rook' },
        { speaker: 'ROOK', text: 'Why didn\'t you escape? The restraints were already broken.', portrait: 'rook' },
        { speaker: 'RAVEN', text: 'Because I wasn\'t finished.', portrait: 'raven' },
        { speaker: 'ROOK', text: 'With what?', portrait: 'rook' },
        { speaker: 'RAVEN', text: 'Finding out what they\'re hiding. This facility wasn\'t just storing weapons, ROOK. It was manufacturing military guidance components. The "accident" four years ago — it was a cover-up.', portrait: 'raven' },
        { speaker: 'ROOK', text: 'What kind of cover-up?', portrait: 'rook' },
        { speaker: 'RAVEN', text: 'Unauthorized shipment. 40 missile guidance systems diverted through here. Someone disabled the safety systems to conceal the movement. People died. Innocent workers.', portrait: 'raven' },
        { speaker: 'RAVEN', text: 'Greyline isn\'t just extracting weapons. They\'re destroying the evidence. All of it — records, witnesses, the facility itself.', portrait: 'raven' },
        { speaker: 'ROOK', text: 'Then we need to move. Now.', portrait: 'rook' },
        { speaker: 'RAVEN', text: 'One more thing.', portrait: 'raven' },
        { speaker: 'ROOK', text: 'I hate those words.', portrait: 'rook' },
        { speaker: 'RAVEN', text: 'They\'re not planning to leave this place standing. There\'s a charge planted in the main facility building. We have minutes.', portrait: 'raven' }
      ],
      'raven_extraction': [
        { speaker: 'ROOK', text: 'Move to the NE duplex. Extraction point is on the roof.', portrait: 'rook' },
        { speaker: 'RAVEN', text: 'After you.', portrait: 'raven' },
        { speaker: 'ROOK', text: 'Stay close. We have 60 seconds before this place becomes a crater.', portrait: 'rook' }
      ],
      'mission_complete': [
        { speaker: 'SABLE', text: 'ROOK, status report.', portrait: 'sable' },
        { speaker: 'ROOK', text: 'RAVEN extracted. We have intelligence on Greyline operations. Recommend immediate follow-up.', portrait: 'rook' },
        { speaker: 'SABLE', text: 'Understood. Extraction team inbound. Good work.', portrait: 'sable' },
        { speaker: 'RAVEN', text: 'This isn\'t over, ROOK. What happened here... it goes higher than Greyline.', portrait: 'raven' },
        { speaker: 'ROOK', text: 'I know.', portrait: 'rook' }
      ]
    },
    rewards: {
      xp: 10,
      coins: 10,
      unlockNext: 'mission_2'
    }
  },
  {
    id: 'mission_2',
    codeName: 'BLACKOUT 02',
    title: 'Ashes of Evidence: Warehouse Demolition',
    briefing: 'The eastern sector of Greyhaven — marshland the original surveys never mapped. RAVEN is stable but weak. A weapons warehouse burns tonight; Dr. Elias Kessler is held somewhere inside the complex, away from the water.',
    map: 'industrial_east',
    requires: 'mission_1',
    objectives: [
      {
        id: 'obj_2_1',
        type: 'collect_item',
        title: 'Retrieve the Purple Bud',
        description: 'RAVEN needs a bud from the rare cannabis specimen growing wild in the tanker lay-by at the far NE corner of the compound, clear across the map from the marsh',
        location: { x: 42, z: -44, radius: 4 },
        itemType: 'purple_bud',
        triggerDistance: 2.0,
        dialogueAfter: 'raven_recovered',
        completed: false
      },
      {
        id: 'obj_2_2',
        type: 'enter_zone',
        title: 'Reach the Eastern Warehouse',
        description: 'Cross the marsh boardwalks to the weapons warehouse in the east sector',
        zone: { x: 62, z: -18, radius: 6 },
        triggerDistance: 5,
        dialogueAfter: 'wrong_warehouse',
        completed: false
      },
      {
        id: 'obj_2_3',
        type: 'eliminate_guards',
        title: 'Eliminate the Warehouse Guards',
        description: 'Clear the guards holding the warehouse before planting charges',
        guardCount: 4,
        completed: false
      },
      {
        id: 'obj_2_4',
        type: 'plant_charges',
        title: 'Set the Demolition Charges',
        description: 'Place 3 charges on the warehouse support columns',
        chargeCount: 3,
        triggerDistance: 2.2,
        dialogueAfter: 'fuse_lit',
        completed: false
      },
      {
        id: 'obj_2_5',
        type: 'escape_zone',
        title: 'Escape the Blast Radius',
        description: 'The fuse is lit — get clear of the warehouse!',
        zone: { x: 44, z: -18, radius: 8 },
        triggerDistance: 7,
        fuse: true,
        timeLimit: 24,
        dialogueAfter: 'suspicion',
        completed: false
      },
      {
        id: 'obj_2_6',
        type: 'resupply',
        title: 'Emergency Resupply',
        description: 'Kessler is heavily guarded — a support cache is stashed inside the old loading block at the NE compound. Collect ammunition and medical supplies',
        location: { x: 33, z: -33, radius: 6 },
        supplyCount: 4,
        triggerDistance: 2.0,
        completed: false
      },
      {
        id: 'obj_2_7',
        type: 'escort_npc',
        title: 'Rescue Dr. Kessler',
        description: 'Find Kessler held in the block west of the central plaza, then get him to the northern extraction lane',
        npcName: 'KESSLER',
        location: { x: -16, z: 3, radius: 4 },
        triggerDistance: 3,
        findDialogue: 'kessler_contact',
        zone: { x: 0, z: -42, radius: 6 },
        escort: true,
        timeLimit: 75,
        completed: false
      }
    ],
    dialogues: {
      'opening': [
        { speaker: 'ROOK', text: 'You look worse than when I found you.', portrait: 'rook' },
        { speaker: 'RAVEN', text: 'There\'s a purple plant gone wild up in the tanker lay-by, the far north-east corner. Bring me a bud.', portrait: 'raven' },
        { speaker: 'ROOK', text: 'First a rescue, now gardening?', portrait: 'rook' },
        { speaker: 'RAVEN', text: 'Just get it, smartass.', portrait: 'raven' }
      ],
      'raven_recovered': [
        { speaker: 'ROOK', text: 'Better?', portrait: 'rook' },
        { speaker: 'RAVEN', text: 'Enough to remember what I was going to tell you.', portrait: 'raven' },
        { speaker: 'RAVEN', text: 'Find Dr. Elias Kessler. He\'s somewhere inside this complex. He knows what happened here.', portrait: 'raven' },
        { speaker: 'SABLE', text: 'Rook, new assignment. We\'ve identified a weapons warehouse in the eastern sector. Destroy everything inside before the enemy relocates it.', portrait: 'sable' },
        { speaker: 'ROOK', text: 'What about Kessler?', portrait: 'rook' },
        { speaker: 'SABLE', text: 'He can wait. The weapons cannot.', portrait: 'sable' },
        { speaker: 'ROOK', text: 'Understood.', portrait: 'rook' }
      ],
      'wrong_warehouse': [
        { speaker: 'ROOK', text: 'Command, something\'s wrong. There\'s no weapons stockpile here.', portrait: 'rook' },
        { speaker: 'SABLE', text: 'Explain.', portrait: 'sable' },
        { speaker: 'ROOK', text: 'The building is full of old records and documents.', portrait: 'rook' },
        { speaker: 'SABLE', text: 'Intelligence may be outdated. Complete the demolition.', portrait: 'sable' },
        { speaker: 'ROOK', text: 'You want me to destroy an archive?', portrait: 'rook' },
        { speaker: 'SABLE', text: 'That\'s an order, Rook.', portrait: 'sable' }
      ],
      'fuse_lit': [
        { speaker: 'ROOK', text: 'Charges set. Time to be somewhere else.', portrait: 'rook' }
      ],
      'suspicion': [
        { speaker: 'ROOK', text: 'Warehouse destroyed. Whatever was inside isn\'t going anywhere now.', portrait: 'rook' },
        { speaker: 'ROOK', text: 'You were right about something being wrong. The warehouse wasn\'t holding weapons. It was an archive.', portrait: 'rook' },
        { speaker: 'RAVEN', text: 'What was in it?', portrait: 'raven' },
        { speaker: 'ROOK', text: 'Old incident reports. Kessler\'s name. Someone called Marek Voss.', portrait: 'rook' },
        { speaker: 'RAVEN', text: 'Then Kessler is even more important than I thought. Find him. They\'re holding him in a block somewhere west of the marsh.', portrait: 'raven' },
        { speaker: 'PATCH', text: 'Rook, I\'ve located Kessler. The block just west of the central plaza — they moved him out of the east wing. He\'s got quite a few guards around him.', portrait: 'patch' },
        { speaker: 'ROOK', text: 'How many?', portrait: 'rook' },
        { speaker: 'PATCH', text: 'Enough to ruin your evening.', portrait: 'patch' },
        { speaker: 'ROOK', text: 'It\'s already ruined.', portrait: 'rook' }
      ],
      'kessler_contact': [
        { speaker: 'KESSLER', text: 'Did you destroy the eastern warehouse?', portrait: 'kessler' },
        { speaker: 'ROOK', text: 'Yes. Why?', portrait: 'rook' },
        { speaker: 'KESSLER', text: 'That wasn\'t a weapons warehouse. It was an archive.', portrait: 'kessler' },
        { speaker: 'ROOK', text: 'I noticed. What was so important?', portrait: 'rook' },
        { speaker: 'KESSLER', text: 'Four years ago, something happened at Greyhaven. The emergency systems were deliberately disabled. People died, and the investigation was buried.', portrait: 'kessler' },
        { speaker: 'ROOK', text: 'Who was responsible?', portrait: 'rook' },
        { speaker: 'KESSLER', text: 'I don\'t know everyone involved. But Marek Voss knows more than anyone.', portrait: 'kessler' },
        { speaker: 'ROOK', text: 'Then you\'re coming with me.', portrait: 'rook' }
      ],
      'mission_complete': [
        { speaker: 'RAVEN', text: 'You found him.', portrait: 'raven' },
        { speaker: 'ROOK', text: 'Apparently, everyone here knows something I don\'t.', portrait: 'rook' },
        { speaker: 'KESSLER', text: 'They destroyed the archive. Now they\'ll come after anyone who remembers what happened.', portrait: 'kessler' },
        { speaker: 'ROOK', text: 'Kessler is secured. But I have a question. Why was an archive classified as a weapons warehouse?', portrait: 'rook' },
        { speaker: 'SABLE', text: 'We\'ll discuss that later. Maintain your position.', portrait: 'sable' },
        { speaker: 'ROOK', text: 'Right. Later.', portrait: 'rook' },
        { speaker: 'RAVEN', text: 'You don\'t trust them anymore, do you?', portrait: 'raven' },
        { speaker: 'ROOK', text: 'I\'m starting to wonder who I\'m actually working for.', portrait: 'rook' },
        { speaker: 'ROOK', text: 'The warehouse is gone. The evidence is buried. But the questions have only just begun.', portrait: 'rook' }
      ]
    },
    rewards: {
      xp: 15,
      coins: 15
    }
  }
];

// ── Mission State ──
let currentMission = null;
let missionState = {
  active: false,
  currentObjective: 0,
  startTime: 0,
  elapsedTime: 0,
  dialogueActive: false,
  dialogueQueue: [],
  npcs: [],
  clues: [],
  evidence: [],
  evidenceCollected: 0,
  items: [],                       // collect_item models (Mission 02 purple bud)
  charges: [],                     // plant_charges anchors + planted charges (Mission 02)
  chargesPlanted: 0,
  supplies: [],                    // resupply pickups (Mission 02)
  suppliesCollected: 0,
  guardsKilled: 0,
  fuseActive: false,
  fuseTimeLeft: 0,
  explosionDone: false,
  escortName: 'RAVEN',
  missionComplete: false,
  escortActive: false,
  escortNPC: null,
  escortHealth: 100,
  extractionTimer: 0,
  extractionStartTime: 0
};

// Evidence spawn positions — scattered inside SW duplex (-33, -30) on both floors
const EVIDENCE_POSITIONS = [
  { x: -35.5, z: -32.5, y: 0,   type: 'shell_casings', label: 'Shell Casings' },    // SW corner, ground floor
  { x: -30.5, z: -27.5, y: 3.8, type: 'bloody_cloth',  label: 'Torn Fabric' },      // NE corner, upper floor
  { x: -34.0, z: -29.0, y: 3.8, type: 'broken_radio',  label: 'Broken Radio' }      // NW area, upper floor
];

// Mission 02 — the Purple Bud gone wild sits on open ground in the far NE tanker lay-by,
// ~80 m on the diagonal from the SW spawn band, the opposite side of the compound from the
// marsh. Relocated again because the NW tank yard sat only ~20 m from where the player drops in.
// Ground level, push-probe clear of every collider; nothing above it blocks the pickup.
const BUD_POSITION = { x: 42, z: -44, y: 0 };

// Mission 02 — demolition charge anchors on the warehouse (70,-18) interior columns/walls.
// Every spot is clear of the crate stacks, shelving run, filing table and N partition.
// y=0.3 rests them on the warehouse floor slab (platform h 0.3).
const CHARGE_POSITIONS = [
  { x: 73.5, z: -22.8, y: 0.3, label: 'N Support Column' },
  { x: 73.5, z: -13.2, y: 0.3, label: 'SE Support Column' },
  { x: 69.5, z: -20.8, y: 0.3, label: 'W Support Column' }
];

// Mission 02 — resupply cache stashed inside the old loading block of the NE duplex (33,-33):
// two drops on the ground floor either side of the partition, one up the east stair on the second-
// floor slab (y=3.8), one by the loading doorway. Ammo crates top the rifle reserve, medkits heal
// +40. Two of each.
const RESUPPLY_POSITIONS = [
  { x: 35,   z: -33,   type: 'ammo',   y: 0 },
  { x: 32.8, z: -35.6, type: 'medkit', y: 0 },
  { x: 30,   z: -33,   type: 'ammo',   y: 3.8 },
  { x: 34.6, z: -30.4, type: 'medkit', y: 0 }
];

// Mission 02 — blast radius around the warehouse centre; standing inside it when the fuse ends is fatal
const BLAST_CENTER = { x: 70, z: -18 };
const BLAST_RADIUS = 18;

// ── Mission Progress Persistence ──
const MISSION_STORAGE_KEY = 'cs_mission_progress';

function loadMissionProgress() {
  try {
    const saved = localStorage.getItem(MISSION_STORAGE_KEY);
    return saved ? JSON.parse(saved) : { completed: [], bestTimes: {}, scores: {} };
  } catch (e) {
    console.warn('[CS] Failed to load mission progress:', e);
    return { completed: [], bestTimes: {}, scores: {} };
  }
}

function saveMissionProgress(progress) {
  try {
    localStorage.setItem(MISSION_STORAGE_KEY, JSON.stringify(progress));
    // Sync to cloud if athlete token available
    syncMissionProgressToCloud(progress);
  } catch (e) {
    console.warn('[CS] Failed to save mission progress:', e);
  }
}

async function syncMissionProgressToCloud(progress) {
  if (typeof AthleteXP === 'undefined' || !AthleteXP.getToken) return;
  const token = AthleteXP.getToken();
  if (!token) return;
  
  try {
    const res = await fetch(`/api/athlete/${token}/missions/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(progress)
    });
    if (res.ok) console.log('[CS] Mission progress synced to cloud');
  } catch (e) {
    console.warn('[CS] Failed to sync mission progress:', e);
  }
}

async function loadMissionProgressFromCloud() {
  if (typeof AthleteXP === 'undefined' || !AthleteXP.getToken) return null;
  const token = AthleteXP.getToken();
  if (!token) return null;
  
  try {
    const res = await fetch(`/api/athlete/${token}/missions/progress`);
    if (res.ok) {
      const data = await res.json();
      if (data.progress) {
        saveMissionProgress(data.progress);
        return data.progress;
      }
    }
  } catch (e) {
    console.warn('[CS] Failed to load cloud progress:', e);
  }
  return null;
}

// ── Mission UI Elements ──
const missionBriefingScreen = document.getElementById('missionBriefingScreen');
const missionHud = document.getElementById('missionHud');
const missionObjective = document.getElementById('missionObjective');
const missionTimer = document.getElementById('missionTimer');
const dialogueOverlay = document.getElementById('dialogueOverlay');
const dialogueText = document.getElementById('dialogueText');
const dialogueSpeaker = document.getElementById('dialogueSpeaker');
const dialoguePortrait = document.getElementById('dialoguePortrait');
const missionCompleteScreen = document.getElementById('missionCompleteScreen');

// ── Mission System Functions ──
function startMission(missionId) {
  const mission = MISSIONS.find(m => m.id === missionId);
  if (!mission) {
    console.error('[CS] Mission not found:', missionId);
    return;
  }
  
  currentMission = mission;
  missionState = {
    active: true,
    currentObjective: 0,
    startTime: Date.now(),
    elapsedTime: 0,
    dialogueActive: false,
    dialogueQueue: [],
    npcs: [],
    clues: [],
    evidence: [],
    evidenceCollected: 0,
    items: [],
    charges: [],
    chargesPlanted: 0,
    supplies: [],
    suppliesCollected: 0,
    guardsKilled: 0,
    fuseActive: false,
    fuseTimeLeft: 0,
    explosionDone: false,
    escortName: 'RAVEN',
    missionComplete: false,
    escortActive: false,
    escortNPC: null,
    escortHealth: 100,
    extractionTimer: 0,
    extractionStartTime: 0,
    _findScenePlayed: false,
    escNag: false
  };
  
  // Reset objectives
  mission.objectives.forEach(obj => obj.completed = false);
  
  // Set map
  selectedMap = mission.map;
  buildMap();
  
  // Show briefing
  showMissionBriefing(mission);
}

function showMissionBriefing(mission) {
  const titleEl = document.getElementById('briefingTitle');
  const descEl = document.getElementById('briefingDesc');
  const objListEl = document.getElementById('briefingObjectives');
  
  if (titleEl) titleEl.textContent = mission.title;
  if (descEl) descEl.textContent = mission.briefing;
  
  if (objListEl) {
    objListEl.innerHTML = mission.objectives.map((obj, i) => 
      `<div class="briefing-obj">${i + 1}. ${obj.title}</div>`
    ).join('');
  }
  
  showScreen(missionBriefingScreen);
}

function beginMissionGameplay() {
  try {
    console.log('[CS] Beginning mission gameplay');
    showScreen(gameScreen);
    resetPlayer();
    clearBots();
    
    // Hide round-based HUD elements during mission
    const roundInfo = document.getElementById('round-info');
    const killsBox = document.getElementById('kills-box');
    // The element is #topbar; the old id here matched nothing, so the CT/T scorebar stayed on
    // screen and the mission panel drew itself straight over the round timer.
    const scoreboard = document.getElementById('topbar');
    const centerMsg = document.getElementById('center-msg');
    if (roundInfo) roundInfo.style.display = 'none';
    if (killsBox) killsBox.style.display = 'none';
    if (scoreboard) scoreboard.style.display = 'none';
    if (centerMsg) centerMsg.style.display = 'none';
    if (isTouchDevice) setTouchPaused(false);
    
    // Spawn mission-specific NPCs and clues
    spawnMissionEntities();
    
    // Spawn enemies along the mission path
    spawnMissionEnemies();
    
    // Update HUD
    if (missionHud) {
      updateMissionHud();
      missionHud.style.display = 'block';
    }
    
    game.state = 'playing';
    
    // Start with opening dialogue
    playDialogue('opening');
    
    if (!isTouchDevice) renderer.domElement.requestPointerLock();
    console.log('[CS] Mission gameplay started successfully');
  } catch (err) {
    console.error('[CS] Error starting mission gameplay:', err);
  }
}

function spawnMissionEntities() {
  if (!currentMission) return;
  
  // Spawn clues (single-item objectives like obj_1_3 radio)
  currentMission.objectives.forEach(obj => {
    if (obj.type === 'find_clue') {
      spawnClue(obj.location.x, obj.location.z, obj.clueType, obj.id);
    }
  });
  
  // Spawn evidence collection items (obj_1_2 — 3 items in SW duplex)
  currentMission.objectives.forEach(obj => {
    if (obj.type === 'collect_evidence') {
      EVIDENCE_POSITIONS.forEach((ep, i) => {
        spawnEvidence(ep.x, ep.z, ep.y || 0, ep.type, obj.id + '_' + i, ep.label);
      });
    }
  });
  
  // Spawn NPCs
  currentMission.objectives.forEach(obj => {
    if (obj.type === 'find_npc') {
      spawnNPC(obj.location.x, obj.location.z, obj.npcName, obj.id);
    }
    // Mission 02: Kessler is held on the upper floor of the central-west block (y=3.8, matches
    // the duplex slab level — same convention as the EVIDENCE upper-floor props)
    if (obj.type === 'escort_npc') {
      spawnNPC(obj.location.x, obj.location.z, obj.npcName, obj.id, 3.8);
    }
  });

  // Mission 02 — the Purple Bud gone wild sits on open ground in the far NE tanker lay-by
  currentMission.objectives.forEach(obj => {
    if (obj.type === 'collect_item') {
      spawnPurpleBud(BUD_POSITION.x, BUD_POSITION.z, BUD_POSITION.y, obj.id);
    }
  });

  // Mission 02 — plant_charges: three anchor brackets on the warehouse support columns
  currentMission.objectives.forEach(obj => {
    if (obj.type === 'plant_charges') {
      CHARGE_POSITIONS.forEach((cp, i) => spawnChargeAnchor(cp.x, cp.z, cp.label, obj.id + '_' + i, cp.y));
    }
  });

  // Mission 02 — resupply: ammo crates and medkits inside the NE loading block
  currentMission.objectives.forEach(obj => {
    if (obj.type === 'resupply') {
      RESUPPLY_POSITIONS.forEach((sp, i) => spawnResupplyItem(sp.x, sp.z, sp.y || 0, sp.type, obj.id + '_' + i));
    }
  });
}

function spawnClue(x, z, type, id) {
  const group = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x444444, roughness: 0.9 });
  const mid = new THREE.MeshStandardMaterial({ color: 0x666666, roughness: 0.85 });
  const light = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.8 });
  const brass = new THREE.MeshStandardMaterial({ color: 0x999999, roughness: 0.5, metalness: 0.6 });
  const glow = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, emissive: 0x555555, emissiveIntensity: 0.4 });

  const part = (geo, mat, px, py, pz, rx, ry, rz) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(px, py, pz);
    if (rx) m.rotation.x = rx; if (ry) m.rotation.y = ry; if (rz) m.rotation.z = rz;
    m.castShadow = true;
    group.add(m); return m;
  };

  if (type === 'spent_ammo') {
    // Shell casings cluster scattered on ground
    for (let i = 0; i < 7; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * 0.6;
      const cx = Math.cos(angle) * dist;
      const cz = Math.sin(angle) * dist;
      part(new THREE.CylinderGeometry(0.03, 0.025, 0.12, 6), brass,
        cx, 0.06, cz, Math.random() * 0.4 - 0.2, Math.random() * Math.PI, Math.random() * 0.6 - 0.3);
    }
    // Impact stain on ground (dark circle)
    part(new THREE.CircleGeometry(0.35, 12), dark, 0, 0.01, 0, -Math.PI / 2, 0, 0);
    // Bullet holes on nearby wall (small dark cylinders)
    for (let i = 0; i < 3; i++) {
      part(new THREE.CylinderGeometry(0.02, 0.02, 0.06, 6), dark,
        -0.3 + i * 0.3, 0.8 + Math.random() * 0.4, -0.5, Math.PI / 2, 0, 0);
    }
    // Faint glow marker above to attract attention
    part(new THREE.SphereGeometry(0.08, 8, 8), glow, 0, 0.6, 0);
  } else if (type === 'radio') {
    // Damaged radio body
    part(new THREE.BoxGeometry(0.35, 0.22, 0.15), mid, 0, 0.11, 0);
    // Antenna (bent/broken)
    const antenna = part(new THREE.CylinderGeometry(0.012, 0.008, 0.4, 6), dark, 0.1, 0.35, -0.04);
    antenna.rotation.z = 0.4; antenna.rotation.x = -0.2;
    // Antenna tip (broken, glowing faintly)
    part(new THREE.SphereGeometry(0.025, 6, 6), glow, 0.22, 0.5, -0.06);
    // Speaker grille lines
    for (let i = 0; i < 3; i++) {
      part(new THREE.BoxGeometry(0.18, 0.01, 0.005), dark, 0, 0.08 + i * 0.04, 0.078);
    }
    // Frequency dial (small cylinder on front)
    part(new THREE.CylinderGeometry(0.025, 0.025, 0.02, 8), brass, -0.1, 0.16, 0.08, Math.PI / 2, 0, 0);
    // Damage crack (thin dark line across body)
    part(new THREE.BoxGeometry(0.3, 0.008, 0.005), dark, 0.02, 0.18, 0.078, 0, 0, 0.3);
    // Sparks indicator (small glowing sphere)
    part(new THREE.SphereGeometry(0.04, 6, 6), glow, 0.15, 0.22, 0.05);
  } else {
    // Generic fallback clue
    part(new THREE.BoxGeometry(0.3, 0.3, 0.3), glow, 0, 0.3, 0);
  }

  // Floating interaction indicator above all clues
  const indicator = part(new THREE.OctahedronGeometry(0.1, 0), glow, 0, 1.0, 0);
  indicator.userData.isIndicator = true;

  group.position.set(x, 0, z);
  group.userData = { type: 'clue', clueType: type, id: id };
  scene.add(group);
  missionState.clues.push(group);
}

function spawnEvidence(x, z, y, type, id, label) {
  const group = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x444444, roughness: 0.9 });
  const mid = new THREE.MeshStandardMaterial({ color: 0x666666, roughness: 0.85 });
  const light = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.8 });
  const brass = new THREE.MeshStandardMaterial({ color: 0x999999, roughness: 0.5, metalness: 0.6 });
  const glow = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, emissive: 0x555555, emissiveIntensity: 0.4 });
  const stain = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.95 });

  const part = (geo, mat, px, py, pz, rx, ry, rz) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(px, py, pz);
    if (rx) m.rotation.x = rx; if (ry) m.rotation.y = ry; if (rz) m.rotation.z = rz;
    m.castShadow = true;
    group.add(m); return m;
  };

  if (type === 'shell_casings') {
    // Scattered shell casings cluster — 12 individual brass cylinders
    for (let i = 0; i < 12; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * 0.8;
      const cx = Math.cos(angle) * dist;
      const cz = Math.sin(angle) * dist;
      part(new THREE.CylinderGeometry(0.025, 0.02, 0.1, 6), brass,
        cx, 0.05, cz,
        Math.random() * 0.5 - 0.25, Math.random() * Math.PI, Math.random() * 0.8 - 0.4);
    }
    // Primer marks on spent casings (tiny dark discs)
    for (let i = 0; i < 5; i++) {
      part(new THREE.CylinderGeometry(0.012, 0.012, 0.004, 6), dark,
        (Math.random() - 0.5) * 0.6, 0.005, (Math.random() - 0.5) * 0.6);
    }
    // Gunpowder residue stain on ground (dark irregular circle)
    part(new THREE.CircleGeometry(0.5, 16), stain, 0, 0.005, 0, -Math.PI / 2, 0, 0);
    // Impact crater (small depression)
    part(new THREE.SphereGeometry(0.15, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), dark,
      0.1, -0.02, -0.1);
    // Spent bullet deformed tip
    part(new THREE.ConeGeometry(0.02, 0.06, 6), brass,
      -0.3, 0.03, 0.2, 0, 0, Math.PI / 2);
    // Link fragment (belt piece)
    part(new THREE.TorusGeometry(0.03, 0.008, 4, 6), brass,
      0.25, 0.02, -0.15, Math.PI / 2, 0, 0);
    // Floating glow marker
    const g1 = part(new THREE.OctahedronGeometry(0.08, 0), glow, 0, 0.9, 0);
    g1.userData.isIndicator = true;

  } else if (type === 'bloody_cloth') {
    // Torn fabric base — irregular flat shape
    part(new THREE.BoxGeometry(0.5, 0.02, 0.35), light, 0, 0.01, 0);
    // Folded creases (3 ridges)
    for (let i = 0; i < 3; i++) {
      part(new THREE.BoxGeometry(0.45, 0.025, 0.04), mid,
        0, 0.025, -0.12 + i * 0.12);
    }
    // Torn edge strips (irregular boundary)
    part(new THREE.BoxGeometry(0.08, 0.015, 0.3), mid, 0.25, 0.015, 0.02);
    part(new THREE.BoxGeometry(0.06, 0.015, 0.25), mid, -0.24, 0.015, -0.03);
    // Dark stain patches (blood/evidence marks)
    part(new THREE.CircleGeometry(0.08, 8), stain, 0.05, 0.025, 0.05, -Math.PI / 2, 0, 0.3);
    part(new THREE.CircleGeometry(0.06, 8), stain, -0.1, 0.025, -0.08, -Math.PI / 2, 0, 0);
    part(new THREE.CircleGeometry(0.04, 6), dark, 0.15, 0.025, -0.05, -Math.PI / 2, 0, 0);
    // Folded corner
    const fold = part(new THREE.BoxGeometry(0.12, 0.03, 0.1), mid, 0.2, 0.04, 0.12);
    fold.rotation.z = 0.4; fold.rotation.y = 0.3;
    // Thread frays at torn edges
    for (let i = 0; i < 4; i++) {
      part(new THREE.CylinderGeometry(0.003, 0.003, 0.08, 4), light,
        -0.25 + Math.random() * 0.05, 0.01, -0.12 + i * 0.08,
        0, 0, Math.random() * 0.5 - 0.25);
    }
    // Small evidence tag (upright rectangle)
    const tag = part(new THREE.BoxGeometry(0.08, 0.12, 0.005), glow, -0.15, 0.1, 0);
    tag.userData.isIndicator = true;

  } else if (type === 'broken_radio') {
    // Radio body (cracked housing)
    part(new THREE.BoxGeometry(0.3, 0.2, 0.14), mid, 0, 0.1, 0);
    // Top panel (slightly offset — damage)
    const topPanel = part(new THREE.BoxGeometry(0.28, 0.02, 0.13), dark, 0.02, 0.21, 0);
    topPanel.rotation.z = 0.05;
    // Bent broken antenna (two segments at different angles)
    const ant1 = part(new THREE.CylinderGeometry(0.01, 0.008, 0.25, 6), dark, 0.1, 0.32, -0.03);
    ant1.rotation.z = 0.5; ant1.rotation.x = -0.15;
    const ant2 = part(new THREE.CylinderGeometry(0.008, 0.005, 0.15, 6), dark, 0.2, 0.42, -0.05);
    ant2.rotation.z = 0.9; ant2.rotation.x = -0.3;
    // Antenna tip (sparking)
    part(new THREE.SphereGeometry(0.02, 6, 6), glow, 0.26, 0.48, -0.06);
    // Speaker grille (5 horizontal lines)
    for (let i = 0; i < 5; i++) {
      part(new THREE.BoxGeometry(0.16, 0.008, 0.005), dark, 0, 0.06 + i * 0.03, 0.073);
    }
    // Frequency dial (cylindrical knob)
    part(new THREE.CylinderGeometry(0.022, 0.022, 0.025, 8), brass, -0.09, 0.15, 0.075, Math.PI / 2, 0, 0);
    // Channel selector switch
    part(new THREE.BoxGeometry(0.04, 0.025, 0.015), dark, 0.06, 0.15, 0.075);
    // Crack damage line (diagonal across body)
    part(new THREE.BoxGeometry(0.25, 0.006, 0.005), dark, 0.01, 0.16, 0.073, 0, 0, 0.35);
    // Second crack (perpendicular)
    part(new THREE.BoxGeometry(0.006, 0.12, 0.005), dark, -0.05, 0.12, 0.073, 0, 0, -0.15);
    // Missing panel chunk (dark void)
    part(new THREE.BoxGeometry(0.06, 0.06, 0.04), dark, 0.1, 0.08, 0.05);
    // Internal circuit board visible through damage
    part(new THREE.BoxGeometry(0.05, 0.05, 0.003), stain, 0.1, 0.08, 0.03);
    // Tiny components on circuit (resistors/capacitors)
    for (let i = 0; i < 3; i++) {
      part(new THREE.BoxGeometry(0.008, 0.005, 0.003), brass,
        0.085 + i * 0.012, 0.075 + i * 0.008, 0.032);
    }
    // Sparking damage indicator
    const spk = part(new THREE.SphereGeometry(0.035, 6, 6), glow, 0.1, 0.14, 0.06);
    spk.userData.isIndicator = true;
  }

  group.position.set(x, y || 0, z);
  group.userData = { type: 'evidence', evidenceType: type, id: id, label: label };
  scene.add(group);
  missionState.evidence.push(group);
}

function spawnNPC(x, z, name, id, y = 0) {
  const group = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.85 });
  const mid = new THREE.MeshStandardMaterial({ color: 0x777777, roughness: 0.9 });
  const light = new THREE.MeshStandardMaterial({ color: 0x999999, roughness: 0.9 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, roughness: 0.95 });
  const accent = new THREE.MeshStandardMaterial({ color: 0x444444, roughness: 0.7 });

  const part = (geo, mat, px, py, pz, parent = group) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(px, py, pz); m.castShadow = true;
    parent.add(m); return m;
  };

  // ── Legs (articulated, separate groups for future animation) ──
  const legL = new THREE.Group(); legL.position.set(-0.12, 0.85, 0); group.add(legL);
  const legR = new THREE.Group(); legR.position.set(0.12, 0.85, 0); group.add(legR);
  part(new THREE.BoxGeometry(0.2, 0.85, 0.22), dark, 0, -0.425, 0, legL);
  part(new THREE.BoxGeometry(0.2, 0.85, 0.22), dark, 0, -0.425, 0, legR);
  // Boots
  part(new THREE.BoxGeometry(0.22, 0.18, 0.3), accent, 0, -0.88, 0.02, legL);
  part(new THREE.BoxGeometry(0.22, 0.18, 0.3), accent, 0, -0.88, 0.02, legR);

  // ── Torso ──
  part(new THREE.BoxGeometry(0.55, 0.65, 0.3), mid, 0, 1.2, 0);         // shirt
  part(new THREE.BoxGeometry(0.58, 0.42, 0.34), accent, 0, 1.22, 0);    // tactical vest
  // Vest pouches
  part(new THREE.BoxGeometry(0.12, 0.1, 0.06), dark, -0.15, 1.1, 0.18);
  part(new THREE.BoxGeometry(0.12, 0.1, 0.06), dark, 0.15, 1.1, 0.18);
  part(new THREE.BoxGeometry(0.12, 0.1, 0.06), dark, 0, 1.1, 0.18);
  // Chest rig strap
  part(new THREE.BoxGeometry(0.5, 0.04, 0.36), dark, 0, 1.42, 0);

  // ── Arms ──
  const armL = new THREE.Group(); armL.position.set(-0.34, 1.35, 0); group.add(armL);
  const armR = new THREE.Group(); armR.position.set(0.34, 1.35, 0); group.add(armR);
  part(new THREE.BoxGeometry(0.14, 0.5, 0.16), mid, 0, -0.25, 0, armL);
  part(new THREE.BoxGeometry(0.14, 0.5, 0.16), mid, 0, -0.25, 0, armR);
  // Gloves
  part(new THREE.BoxGeometry(0.14, 0.12, 0.16), dark, 0, -0.52, 0, armL);
  part(new THREE.BoxGeometry(0.14, 0.12, 0.16), dark, 0, -0.52, 0, armR);
  // Left arm slightly forward (injured/holding side)
  armL.rotation.x = 0.15;
  armR.rotation.x = -0.1;

  // ── Head with hood/balaclava ──
  const headGroup = new THREE.Group(); headGroup.position.set(0, 1.72, 0); group.add(headGroup);
  part(new THREE.BoxGeometry(0.28, 0.3, 0.28), skin, 0, 0, 0, headGroup);   // face
  part(new THREE.BoxGeometry(0.32, 0.18, 0.32), dark, 0, 0.12, 0, headGroup); // hood top
  part(new THREE.BoxGeometry(0.32, 0.12, 0.08), dark, 0, 0.04, 0.14, headGroup); // hood brow
  part(new THREE.BoxGeometry(0.28, 0.1, 0.04), accent, 0, -0.06, 0.15, headGroup); // mouth guard
  // Eyes (small dark slits)
  part(new THREE.BoxGeometry(0.06, 0.03, 0.02), accent, -0.07, 0.02, 0.15, headGroup);
  part(new THREE.BoxGeometry(0.06, 0.03, 0.02), accent, 0.07, 0.02, 0.15, headGroup);

  // ── Backpack / radio equipment ──
  part(new THREE.BoxGeometry(0.35, 0.4, 0.15), dark, 0, 1.25, -0.22);     // pack body
  part(new THREE.BoxGeometry(0.08, 0.2, 0.06), accent, 0.12, 1.35, -0.3);  // radio unit
  part(new THREE.BoxGeometry(0.02, 0.25, 0.02), dark, 0.12, 1.55, -0.3);   // antenna
  part(new THREE.BoxGeometry(0.04, 0.04, 0.04), light, 0.12, 1.68, -0.3);  // antenna tip

  // ── Name tag floating above head ──
  const tagCanvas = document.createElement('canvas');
  tagCanvas.width = 256; tagCanvas.height = 64;
  const tc = tagCanvas.getContext('2d');
  tc.fillStyle = 'rgba(20,20,24,0.85)';
  tc.fillRect(0, 0, 256, 64);
  tc.strokeStyle = 'rgba(255,255,255,0.3)';
  tc.lineWidth = 2;
  tc.strokeRect(2, 2, 252, 60);
  tc.fillStyle = '#ffffff';
  tc.font = 'bold 28px system-ui, sans-serif';
  tc.textAlign = 'center';
  tc.textBaseline = 'middle';
  tc.fillText(name, 128, 32);
  const tagTex = new THREE.CanvasTexture(tagCanvas);
  const tagMat = new THREE.SpriteMaterial({ map: tagTex, transparent: true, depthTest: true });
  const tag = new THREE.Sprite(tagMat);
  tag.scale.set(1.2, 0.3, 1);
  tag.position.set(0, 2.3, 0);
  group.add(tag);

  group.position.set(x, y, z);
  group.userData = { type: 'npc', name: name, id: id };
  scene.add(group);
  missionState.npcs.push(group);
}

// ── Mission 02 props ──
// The Purple Bud: a single rare Cannabis specimen grown out in the open. Built from the SAME
// shared geometry + anatomy as the field crop (addCannabisPlant): the serrated fan-leaf quad
// (mats.cannabis, textured alpha silhouette), the 5-sided stalk cylinder and the faceted bud
// crystal. Rebuilt here as individual meshes because it's a one-off collectible, so it reads as a
// real plant — decussate branch pairs, fan canopy, calyx colas — instead of the old flat-box sprig.
// A hero specimen: taller than a wild shrub, topped by a pale crystalline cola ("purple" = brightest
// greyscale tone; brand rule: no hue anywhere). Leaf quads don't cast shadows (thin alpha blades, ~76
// of them) — only the wood and the calyxes do — so this adds detail without a shadow-pass tax.
function spawnPurpleBud(x, z, y, id) {
  // The single-sphere bud is gone: a real cola is a cluster of teardrop calyxes wearing frost and
  // sprouting pistils. That detail means hundreds of tiny solids, and hundreds of Mesh objects is
  // hundreds of draw calls plus hundreds of shadow-pass slots — the exact cost that made the old
  // 93-part version worth complaining about. So every sub-part is pushed into shared vertex arrays
  // and emitted as ONE merged BufferGeometry per material: the whole specimen is 8 objects — canopy,
  // wood, ground litter, calyxes, the lit head, pistils, root ball, pickup marker — down from the 93
  // Meshes this prop used to cost, and each of the 8 is only separate because it owns a material.
  const group = new THREE.Group();
  const s = 1.30;                                    // hero scale → ~2.0 m tall, above the field shrubs
  const H = 1.55 * s;
  // The specimen's own surfaces. mats.cannabisStem / mats.cannabisBud stay untouched because the
  // instanced field crop, the marsh driftwood and two deco boxes all share them.
  const bark = new THREE.MeshStandardMaterial({ map: cannabisBarkTex, roughness: 0.92, flatShading: true });
  const frost = new THREE.MeshStandardMaterial({ map: cannabisFrostTex, roughness: 0.5, flatShading: true });
  const cream = new THREE.MeshStandardMaterial({ color: 0xa6a6a6, roughness: 0.72, side: THREE.DoubleSide });
  const glow = new THREE.MeshStandardMaterial({ color: 0xc2c2c2, map: cannabisFrostTex, emissive: 0x666666, emissiveIntensity: 0.55, flatShading: true });

  // Rotation by hand rather than through quaternions, because every part is now written into a
  // vertex stream instead of onto a Mesh. Order matches the qy*qx*qz the shared field crop uses —
  // tilt about X (leans +Z), then yaw about Y — so a batched blade and an instanced one agree.
  // The sine/cosine locals are named _cy/_sy on purpose: a bare `s` would collide with this
  // function's own scale constant and poison every `* s` expression below it.
  const rotX = (a, v) => { const _cy = Math.cos(a), _sy = Math.sin(a); return [v[0], v[1] * _cy - v[2] * _sy, v[1] * _sy + v[2] * _cy]; };
  const rotY = (a, v) => { const _cy = Math.cos(a), _sy = Math.sin(a); return [v[0] * _cy + v[2] * _sy, v[1], v[2] * _cy - v[0] * _sy]; };
  const rotZ = (a, v) => { const _cx = Math.cos(a), _cz = Math.sin(a); return [v[0] * _cx - v[1] * _cz, v[0] * _cz + v[1] * _cx, v[2]]; };
  // woody stalk/branch segment from the base point outward `len`; returns its tip position. Written
  // into the wood stream with stalkGeo's 5-sided taper instead of becoming a Mesh per segment.
  const stem = (px, py, pz, len, yaw, tilt, r) => {
    putTube(G.bark, [px, py, pz], len, yaw, tilt, r);
    const st = Math.sin(tilt), dx = st * Math.sin(yaw), dz = st * Math.cos(yaw);
    return [px + dx * len, py + Math.cos(tilt) * len, pz + dz * len];
  };
  // textured fan leaf, pivoted at the petiole base so `tilt` swings the whole blade out from the wood.
  // Same signature as the old Mesh version so all ~76 call sites below are untouched.
  const fan = (px, py, pz, ls, yaw, tilt, roll) => leafAt([px, py, pz], ls, yaw, tilt, roll);
  // The blade is regenerated here instead of instanced from cannabisLeafGeo: same 3x5 grid, same V
  // fold along the midrib, same tip droop — identical silhouette, one draw call for the whole canopy.
  const leafAt = (b, ls, yaw, tilt, roll) => {
    const g = G.leaf, base = g.p.length / 3;
    for (let gy = 0; gy <= 4; gy++) {
      for (let gx = 0; gx <= 2; gx++) {
        const u = gx / 2 - 0.5, v = gy / 4;
        let v3 = rotZ(roll, [u, v, -0.075 * Math.abs(u) * 2 + 0.055 * v * v]);
        v3 = rotX(tilt, v3); v3 = rotY(yaw, v3);
        g.p.push(b[0] + v3[0] * ls, b[1] + v3[1] * ls, b[2] + v3[2] * ls);
        g.u.push(gx / 2, gy / 4);            // the serrated silhouette is an alpha map: it needs UVs
      }
    }
    for (let k = 0; k < LEAF_IDX.length; k++) g.i.push(base + LEAF_IDX[k]);
  };
  // calyx/bud crystal is no longer a single sphere — see budCluster below; `cola` was retired with it.

  // ── batching collectors ──
  // Every sub-part below is appended to these vertex streams instead of becoming a Mesh, and the
  // streams are emitted as one merged BufferGeometry per material at the foot of this function.
  // Shapes are authored in local space along +Y and pushed through the same tilt-then-yaw the leaf
  // path uses, so a calyx leans off its branch exactly like a blade does. Each stream carries uv
  // too: bark, frost and the leaf silhouette are texture maps, and a merged geometry without UVs
  // would sample one texel and read as flat plastic.
  const G = {                       // group: material, castsShadow, then the streams
    leaf:    { p: [], u: [], i: [], m: mats.cannabis, cast: false },
    bark:    { p: [], u: [], i: [], m: bark,          cast: true  },
    soil:    { p: [], u: [], i: [], m: bark,          cast: false },  // pebbles share the bark map
    bud:     { p: [], u: [], i: [], m: frost,         cast: true  },  // ordinary calyxes
    budHero: { p: [], u: [], i: [], m: glow,          cast: true  },  // the lit terminal head
    pistil:  { p: [], u: [], i: [], m: cream,         cast: false },
  };
  const colae = [];                 // cola sites, queued while the plant grows, built once after
  // The blade template mirrors makeCannabisLeafGeo exactly — same 3x5 grid, same V fold along the
  // midrib and same tip droop — so the merged canopy is shaped identically to the instanced field
  // crop while costing one draw call instead of one Mesh per leaf.
  const LEAF_IDX = [];
  for (let _gy = 0; _gy < 4; _gy++) for (let _gx = 0; _gx < 2; _gx++) {
    const a = _gy * 3 + _gx, b = a + 1, d = a + 3, e = a + 4;
    LEAF_IDX.push(a, b, d); LEAF_IDX.push(b, e, d);
  }
  // Teardrop calyx — the actual bud unit: a four-corner mid ring with an apex below it (where it joins
  // the branch) and a pointed tip above. 6 verts / 8 tris, closed, and wound outward by construction:
  // (apexLo, next, cur) on the lower cone and (cur, next, apexHi) on the upper one both give normals
  // that point away from the axis, which the geometry audit verifies triangle by triangle rather than
  // trusting the derivation. The frost map plus flatShading is what makes it read as a crystal stud.
  const CALYX = [], CALYX_I = [];
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2 + Math.PI / 4;
    CALYX.push(Math.sin(a) * 0.28, -0.06, Math.cos(a) * 0.28);
  }
  CALYX.push(0, -0.52, 0, 0, 0.46, 0);                     // 4 = stalk-end apex, 5 = the tip
  for (let k = 0; k < 4; k++) { const n = (k + 1) % 4; CALYX_I.push(4, n, k, k, n, 5); }
  // Pistil: a curved 2-tri ribbon sprouting out of the calyx neck. The cream material is DoubleSide,
  // so a hair-thin strip still reads from every angle.
  const PISTIL = [0, 0, 0, 0.022, 0.4, 0.012, 0.012, 0.79, -0.018, -0.018, 0.8, -0.05];
  const PISTIL_I = [0, 1, 2, 0, 2, 3];
  // place one authored shape: local → tilt (lean toward +Z) → yaw → world, with a per-site UV offset
  // so a hundred repeated calyxes don't all sample the same patch of frost.
  const put = (g, tpl, idx, b, yaw, tilt, sc) => {
    const base = g.p.length / 3;
    const ju = (b[0] * 0.37 + b[2] * 0.61) % 1, jv = (b[1] * 0.53) % 1;
    for (let k = 0; k < tpl.length; k += 3) {
      const lx = tpl[k] * sc, ly = tpl[k + 1] * sc, lz = tpl[k + 2] * sc;
      const v = rotY(yaw, rotX(tilt, [lx, ly, lz]));
      g.p.push(b[0] + v[0], b[1] + v[1], b[2] + v[2]);
      g.u.push(0.5 + lx * 1.6 + ju, 0.5 + ly * 1.6 + jv);
    }
    for (let k = 0; k < idx.length; k++) g.i.push(base + idx[k]);
  };
  // 5-sided open tube with stalkGeo's taper (thick at the base, narrower at the top), 0..len along +Y.
  // Winding is bottom-ring → top-ring so faces point outward, matching CylinderGeometry.
  const putTube = (g, b, len, yaw, tilt, r) => {
    const base = g.p.length / 3;
    for (let ring = 0; ring < 2; ring++) {
      const rr = ring === 0 ? r : r * 0.62, yy = ring === 0 ? 0 : len;
      for (let k = 0; k < 5; k++) {
        const a = k * Math.PI * 2 / 5;
        const v = rotY(yaw, rotX(tilt, [Math.sin(a) * rr, yy, Math.cos(a) * rr]));
        g.p.push(b[0] + v[0], b[1] + v[1], b[2] + v[2]);
        g.u.push(a / (Math.PI * 2), yy / (len || 1));
      }
    }
    for (let k = 0; k < 5; k++) {
      const bo = base + k, to = base + 5 + k, bn = base + (k + 1) % 5, tn = base + 5 + (k + 1) % 5;
      g.i.push(to, bo, tn, tn, bo, bn);
    }
  };
  // Four-sided shard: pebbles and the squat resin nubs low on the stalk.
  const putCone = (g, b, yaw, tilt, rad, len) => {
    const base = g.p.length / 3;
    const tip = rotY(yaw, rotX(tilt, [0, len, 0]));
    g.p.push(b[0] + tip[0], b[1] + tip[1], b[2] + tip[2]); g.u.push(0.5, 1);
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2 + yaw * 0.25;
      const v = rotY(yaw, rotX(tilt, [Math.cos(a) * rad, 0, Math.sin(a) * rad]));
      g.p.push(b[0] + v[0], b[1] + v[1], b[2] + v[2]); g.u.push(k / 4, 0);
    }
    for (let k = 0; k < 4; k++) g.i.push(base, base + 1 + ((k + 1) % 4), base + 1 + k);
  };
  // A cola is a ring of calyxes around a stacked centre, each throwing pistils. `r` is the calyx
  // size, `n` how many surround the column, `hero` routes it onto the lit terminal-head material.
  const budCluster = (b, yaw, tilt, r, n, hero) => {
    const g = hero ? G.budHero : G.bud;
    for (let k = 0; k < n; k++) {
      const a = yaw + k * (Math.PI * 2 / n);
      const off = [Math.sin(a) * r * 1.25, 0, Math.cos(a) * r * 1.25];
      put(g, CALYX, CALYX_I, [b[0] + off[0], b[1] + off[1], b[2] + off[2]], a, tilt + 0.42, r * 1.9);
    }
    for (let j = 0; j < 2; j++) {
      const yy = b[1] + j * r * 1.55;
      put(g, CALYX, CALYX_I, [b[0], yy, b[2]], yaw + j * 1.1, tilt * 0.35, r * 2.15);
    }
    const pn = hero ? 10 : 7;
    for (let k = 0; k < pn; k++) {
      const a = yaw + k * (Math.PI * 2 / pn) + 0.4;
      const h = b[1] + (k % 3) * r * 1.1 + r * 0.4;
      put(G.pistil, PISTIL, PISTIL_I, [b[0] + Math.sin(a) * r * 0.9, h, b[2] + Math.cos(a) * r * 0.9],
          a, tilt + 0.30 + (k % 2) * 0.28, r * 2.4);
    }
  };

  // Root ball of dark soil so it reads as rooted in the open ground, not floating
  const soil = new THREE.Mesh(new THREE.CylinderGeometry(0.46 * s, 0.6 * s, 0.18 * s, 12), mats.mud);
  soil.position.set(0, 0.09 * s, 0); soil.receiveShadow = true; soil.castShadow = true; group.add(soil);

  const phase = 0.7;
  stem(0, 0.02 * s, 0, H, 0, 0, 0.032 * s);          // main stalk
  const nodes = 6;
  for (let i = 0; i < nodes; i++) {
    const f = 0.08 + (i / (nodes - 1)) * 0.86;       // 8% → 94% up the stalk
    const yy = f * H, pair = phase + i * Math.PI / 2;
    const fn = (f - 0.24) / 0.70;                    // 0 at first branch node → 1 at apex
    if (fn < 0) {                                    // skirt: the big lowest pair, no branches
      fan(0, yy, 0, 0.74 * s, pair, 1.12, 0.08);
      fan(0, yy, 0, 0.74 * s, pair + Math.PI, 1.12, -0.08);
      continue;
    }
    if (fn < 0.5) {                                  // fork leaves, tapering as branches take over
      const ls = 0.60 * s * (1 - fn * 0.6);
      fan(0, yy, 0, ls, pair + Math.PI / 2, 1.14, 0.06);
      fan(0, yy, 0, ls, pair - Math.PI / 2, 1.14, -0.06);
    }
    // the woody collar where a branch pair leaves the stalk: a short, thicker tube segment
    putTube(G.bark, [0, yy - 0.025 * s, 0], 0.05 * s, pair, 0, 0.043 * s);
    for (let k = 0; k < 2; k++) {                    // decussate branch pair, 90° from the last
      const yaw = pair + k * Math.PI;
      const bTilt = 1.06 - fn * 0.54;                // 61° out low, 30° near the apex
      const bLen = H * (0.28 + 0.22 * Math.sin(Math.PI * (0.22 + fn * 0.62)));
      const tip = stem(0, yy, 0, bLen, yaw, bTilt, 0.016 * s);
      const pairs = (fn > 0.10 && fn < 0.80) ? 3 : 2;
      for (let j = 0; j < pairs; j++) {
        const t = 0.16 + (pairs > 1 ? j * (0.68 / (pairs - 1)) : 0.4);
        const ls = 0.62 * s * (1 - (j / pairs) * 0.26);
        const lx = tip[0] * t, ly = yy + (tip[1] - yy) * t, lz = tip[2] * t;
        const lYaw = (j % 2 ? yaw : yaw + Math.PI / 2);
        const spread = 1.05 + bTilt * 0.20 - (j / pairs) * 0.18;
        fan(lx, ly, lz, ls, lYaw, spread, 0.05);
        fan(lx, ly, lz, ls, lYaw + Math.PI, spread, -0.05);
      }
      fan(tip[0], tip[1], tip[2], 0.34 * s, yaw, bTilt - 0.30, 0);   // tip leaf rising to the branch end
      // the two most terminal branch pairs set a real cola; the top pair gets the lit head material
      if (i >= nodes - 2) colae.push([[tip[0], tip[1] + 0.07 * s, tip[2]], yaw, bTilt - 0.30, 0.085 * s * BUD_SCALE, 6, i === nodes - 1]);
      // Lower canopy: a modest side cola where each mid branch forks off the stalk — what a real
      // specimen sets after the main colas, and the detail that makes the silhouette read dense.
      else if (fn > 0.18 && fn < 0.60) colae.push([[Math.sin(yaw) * 0.10 * s, yy + 0.05 * s, Math.cos(yaw) * 0.10 * s], yaw, 0.25, 0.055 * s * BUD_SCALE, 5, false]);
    }
  }
  // Terminal cola: two rings of upright sugar leaves around a stacked, frost-heavy crystal head —
  // four courses of calyxes shrinking up the axis, each throwing pistils, all in one merged mesh.
  for (let k = 0; k < 4; k++) fan(0, H * (0.89 + k * 0.05), 0, 0.36 * s * (1 - k * 0.12), phase + k * 1.57, 0.50, 0);
  for (let k = 0; k < 4; k++) fan(0, H * (0.82 + k * 0.05), 0, 0.28 * s * (1 - k * 0.12), phase + 0.79 + k * 1.57, 0.66, 0);
  for (let cIdx = 0; cIdx < 4; cIdx++) {
    const rr = 0.12 * s * BUD_SCALE * (1 - cIdx * 0.16);
    colae.push([[0, H - 0.04 + cIdx * 0.105 * s, 0], phase + cIdx * 0.8, -0.05, rr, cIdx === 0 ? 8 : 7, true]);
  }

  // Build every cola that was queued while the plant grew. Doing it here rather than inline keeps the
  // streams grouped, which costs nothing at render time and keeps the growth loop above readable.
  for (const c of colae) budCluster(c[0], c[1], c[2], c[3], c[4], c[5]);

  // Ground detail in the root zone: seeded pebbles and squat resin nubs, plus a scatter of fallen
  // blades. Purely visual — none of it adds a collider, so the walkability map stays exactly 564/727.
  for (let k = 0; k < 26; k++) {
    const a = rand(0, Math.PI * 2), d = rand(0.5, 1.45) * s;
    putCone(G.soil, [Math.sin(a) * d, 0.004, Math.cos(a) * d], a, rand(1.0, 1.5), rand(0.03, 0.07) * s, rand(0.04, 0.1) * s);
  }
  for (let k = 0; k < 9; k++) {
    const a = rand(0, Math.PI * 2), d = rand(0.6, 1.5) * s;
    putCone(G.soil, [Math.sin(a) * d, 0.002, Math.cos(a) * d], a, Math.PI / 2, 0.1 * s, 0.012 * s);
  }

  // ── merge ──
  // One BufferGeometry per material stream, so the whole specimen is a handful of objects instead of
  // a hundred. Normals are recomputed per vertex; the flatShading materials ignore them anyway, and
  // the leaf stream wants them smooth exactly like makeCannabisLeafGeo did.
  const mergeStream = (g, receive) => {
    if (!g.p.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(g.p, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.u, 2));
    geo.setIndex(g.i);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, g.m);
    m.castShadow = g.cast; m.receiveShadow = receive;
    group.add(m);
  };
  mergeStream(G.leaf, true);
  mergeStream(G.bark, true);
  mergeStream(G.soil, true);
  mergeStream(G.bud, true);
  mergeStream(G.budHero, true);
  mergeStream(G.pistil, false);

  // Floating pickup indicator (bob + spin driven in the frame loop via userData.isIndicator).
  // The frame loop FORCES this child's y, so the bob baseY in the loop must match H + 0.58 below.
  const ind = new THREE.Mesh(new THREE.OctahedronGeometry(0.11, 0), glow);
  ind.position.set(0, H + 0.58, 0); ind.userData.isIndicator = true; group.add(ind);

  group.position.set(x, y, z);
  group.userData = { type: 'item', itemType: 'purple_bud', id: id };
  scene.add(group);
  missionState.items.push(group);
}

// Charge anchor: a steel bracket + stencilled label plate waiting for a charge. Once planted the
// group gains the C4 block (handled in checkMissionObjectives) and the LED starts blinking in the
// frame loop via userData.isIndicator.
function spawnChargeAnchor(x, z, label, id, y = 0) {
  const group = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x3d3d3d, roughness: 0.85 });
  const mid = new THREE.MeshStandardMaterial({ color: 0x6a6a6a, roughness: 0.6, metalness: 0.5 });
  const pale = new THREE.MeshStandardMaterial({ color: 0xa8a8a8, roughness: 0.7 });
  const glow = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, emissive: 0x555555, emissiveIntensity: 0.4 });

  const part = (geo, mat, px, py, pz, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(px, py, pz); m.rotation.set(rx, ry, rz); m.castShadow = true;
    group.add(m); return m;
  };

  // Wall bracket: two straps and a nail plate
  part(new THREE.BoxGeometry(0.5, 0.06, 0.08), mid, 0, 0.55, 0);
  part(new THREE.BoxGeometry(0.5, 0.06, 0.08), mid, 0, 0.35, 0);
  part(new THREE.BoxGeometry(0.12, 0.12, 0.05), dark, 0, 0.45, -0.02);
  // Stencil plate
  part(new THREE.BoxGeometry(0.42, 0.16, 0.02), pale, 0, 0.75, -0.01);
  // Target marker hovering at chest height — the plant prompt
  part(new THREE.OctahedronGeometry(0.12, 0), glow, 0, 1.0, 0.15).userData.isIndicator = true;
  // Floor chalk ring
  part(new THREE.TorusGeometry(0.42, 0.015, 4, 14), dark, 0, 0.015, 0.1, Math.PI / 2, 0, 0);

  group.position.set(x, y, z);
  group.userData = { type: 'charge', id: id, label: label, planted: false };
  scene.add(group);
  missionState.charges.push(group);
}

// Planted C4 block added onto a charge anchor once the player walks up to it
function attachPlantedCharge(group) {
  const dark = new THREE.MeshStandardMaterial({ color: 0x353535, roughness: 0.8 });
  const mid = new THREE.MeshStandardMaterial({ color: 0x666666, roughness: 0.7 });
  const led = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1 });
  const block = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.16, 0.12), mid);
  block.position.set(0, 0.45, 0.1); block.castShadow = true;
  block.name = 'chargeBlock';
  group.add(block);
  // Keypad face + two wire leads + blinking detonator LED
  const pad = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.09, 0.02), dark);
  pad.position.set(0, 0.45, 0.17); group.add(pad);
  for (const side of [-1, 1]) {
    const wire = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.18, 4), dark);
    wire.position.set(side * 0.12, 0.5, 0.12); wire.rotation.z = Math.PI / 2.4 * side;
    group.add(wire);
  }
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.02, 6, 6), led);
  dot.position.set(0.1, 0.5, 0.17);
  dot.name = 'chargeLed';
  dot.userData.isIndicator = true;   // frame loop drives the blink while the fuse burns
  group.add(dot);
}

// Resupply pickup: ammo crate (banding + visible rounds) or field medkit (cross plate).
function spawnResupplyItem(x, z, y, type, id) {
  const group = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x3f3f3f, roughness: 0.85 });
  const mid = new THREE.MeshStandardMaterial({ color: 0x6d6d6d, roughness: 0.8 });
  const pale = new THREE.MeshStandardMaterial({ color: 0xb2b2b2, roughness: 0.6, metalness: 0.4 });
  const glow = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, emissive: 0x555555, emissiveIntensity: 0.4 });

  const part = (geo, mat, px, py, pz, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(px, py, pz); m.rotation.set(rx, ry, rz); m.castShadow = true;
    group.add(m); return m;
  };

  if (type === 'ammo') {
    // Crate body with lid seam and carry latch
    part(new THREE.BoxGeometry(0.46, 0.26, 0.3), mid, 0, 0.13, 0);
    part(new THREE.BoxGeometry(0.47, 0.02, 0.31), dark, 0, 0.24, 0);
    part(new THREE.BoxGeometry(0.1, 0.05, 0.02), pale, 0, 0.28, 0.15);
    // Two brass bands around the crate
    part(new THREE.BoxGeometry(0.47, 0.03, 0.31), pale, -0.12, 0.13, 0);
    part(new THREE.BoxGeometry(0.47, 0.03, 0.31), pale, 0.12, 0.13, 0);
    // A few rounds spilling across the lid
    for (let i = 0; i < 4; i++) {
      part(new THREE.CylinderGeometry(0.016, 0.016, 0.09, 6), pale,
        -0.12 + i * 0.08, 0.28, 0.05 + rand(-0.04, 0.04), Math.PI / 2, 0, rand(-0.3, 0.3));
    }
  } else {
    // Medkit: flat white case, cross plate, hinge and clasp
    part(new THREE.BoxGeometry(0.4, 0.22, 0.26), pale, 0, 0.11, 0);
    part(new THREE.BoxGeometry(0.41, 0.02, 0.27), dark, 0, 0.22, 0);
    part(new THREE.BoxGeometry(0.16, 0.02, 0.05), mid, 0, 0.24, 0.1);
    part(new THREE.BoxGeometry(0.12, 0.12, 0.015), dark, 0, 0.13, 0.136);   // cross base
    part(new THREE.BoxGeometry(0.04, 0.1, 0.02), pale, 0, 0.13, 0.142);     // cross V
    part(new THREE.BoxGeometry(0.1, 0.04, 0.02), pale, 0, 0.13, 0.142);     // cross H
    part(new THREE.CylinderGeometry(0.015, 0.015, 0.12, 6), mid, 0, 0.22, -0.13, 0, 0, Math.PI / 2); // hinge
  }
  // Floating indicator
  part(new THREE.OctahedronGeometry(0.09, 0), glow, 0, 0.75, 0).userData.isIndicator = true;

  group.position.set(x, y, z);
  group.userData = { type: 'supply', supplyType: type, id: id };
  scene.add(group);
  missionState.supplies.push(group);
}

function spawnMissionEnemies() {
  if (!currentMission) return;
  if (currentMission.id === 'mission_2') { spawnMission2Enemies(); return; }
  
  // Strategic enemy placements — mostly INSIDE buildings (both floors)
  // Player spawns in SW corner (-41, -41), route leads through buildings NE
  // 10 enemies INSIDE buildings, 3 OUTSIDE
  const enemyPlacements = [
    // === INSIDE BUILDINGS — Ground Floor (5) ===
    { x: 33, z: -33, patrol: false, inside: true },   // SE duplex (entry objective)
    { x: -33, z: -30, patrol: false, inside: true },  // SW duplex (clue 1)
    { x: 36, z: -2, patrol: true, inside: true },     // E round duplex (clue 2)
    { x: -33, z: 29, patrol: false, inside: true },   // NW duplex ground (near RAVEN)
    { x: 16, z: 3, patrol: false, inside: true },     // E center duplex
    
    // === INSIDE BUILDINGS — Upper Floor (5) ===
    { x: -33, z: -30, patrol: false, inside: true, upperFloor: true },  // SW duplex upper
    { x: 33, z: -33, patrol: true, inside: true, upperFloor: true },    // SE duplex upper
    { x: 33, z: 29, patrol: true, inside: true, upperFloor: true },     // NE duplex upper (escape route)
    { x: -16, z: 3, patrol: false, inside: true, upperFloor: true },    // W center duplex upper
    { x: -36, z: 0, patrol: true, inside: true, upperFloor: true },     // W round duplex upper
    
    // === OUTSIDE — Perimeter (3) ===
    { x: -8, z: -5, patrol: true },      // West perimeter patrol
    { x: 8, z: 18, patrol: true },       // Central avenue patrol
    { x: 3, z: -15, patrol: false }      // Static blocker
  ];
  
  const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
  
  enemyPlacements.forEach((placement, i) => {
    // Skip ground-level isFree for inside/upperFloor placements — positions are pre-verified
    if (!placement.inside) {
      if (!isFree(placement.x, placement.z, 0.6)) {
        for (let attempt = 0; attempt < 10; attempt++) {
          const offsetX = (Math.random() - 0.5) * 4;
          const offsetZ = (Math.random() - 0.5) * 4;
          if (isFree(placement.x + offsetX, placement.z + offsetZ, 0.6)) {
            placement.x += offsetX;
            placement.z += offsetZ;
            break;
          }
        }
      }
    }
    
    const spawnY = placement.upperFloor ? 3.8 : 0;
    const bot = new Bot(placement.x, placement.z, names[i % names.length]);
    bot.pos.y = spawnY;
    bot.yaw = Math.PI;
    
    // Set patrol behavior
    if (placement.patrol) {
      bot.patrolCenter = new THREE.Vector2(placement.x, placement.z);
      bot.patrolRadius = 5 + Math.random() * 3;
      bot.patrolAngle = Math.random() * Math.PI * 2;
      bot.patrolSpeed = 1.5 + Math.random() * 0.5;
    }
    
    bots.push(bot);
  });
  
  console.log('[CS] Spawned', enemyPlacements.length, 'mission enemies');
}

// Mission 02 — order of battle. The warehouse assault chain stays anchored in the eastern marsh
// (4 guards + the two boardwalk chips that watch the approach). The SIDE objectives were pulled
// out of the marsh, so their guards went with them: the NE tank yard, the loading block and
// Kessler's hold cell each get their own detail, and two roamers cover the avenues in between.
// Reinforcements still arrive later, on the fuse and escort beats.
function spawnMission2Enemies() {
  const enemyPlacements = [
    // === WAREHOUSE GUARDS — tagged, counted by eliminate_guards (70,-18). MAIN OBJECTIVE, marsh ===
    { x: 66.5, z: -19.5, inside: true, guard: true },   // W bay, by the crate stack
    { x: 72,    z: -21.6, inside: true, guard: true },  // centre floor, clear of the shelving run
    { x: 71,    z: -16,   inside: true, guard: true },  // behind the N partition
    { x: 76.8,  z: -23,   inside: true, guard: true },  // NE corner by the shelving run

    // === MARSH APPROACH — two chips on the walk to the warehouse ===
    { x: 56, z: 2, patrol: true },      // boardwalk spine
    { x: 60, z: -30 },                  // dock watcher

    // === PURPLE BUD SITE — far NE tanker lay-by (42,-44) ===
    { x: 41, z: -40, patrol: true },   // circles the lay-by right off the bud
    { x: 44, z: -38, patrol: true },   // works the N wall fence line by the bud

    // === RESUPPLY CACHE — inside/around the NE loading block (33,-33) ===
    { x: 35,    z: -30, inside: true },               // ground floor, by the doorway
    { x: 30,    z: -36, inside: true },               // west room, by the crate
    { x: 24,    z: -4,  patrol: true },               // NE avenue roamer, between sites

    // === KESSLER HOLD CELL — central-west block (-16,3) ===
    { x: -15.5, z: 4,    inside: true },              // ground floor, east side of the partition
    { x: -17,   z: 4,    inside: true },              // west room, by the crate stack
    { x: -14,   z: -0.3, inside: true, upperFloor: true }, // upstairs landing beside Kessler

    // === CENTRAL PATROLS — avenues the player must cross to reach the sites ===
    { x: -28, z: -8,  patrol: true },   // west lighthouse avenue
    { x: -33, z: 20,  patrol: true },   // SW avenue
    { x: 16,  z: 14,  patrol: true }    // SE lane, guards the long walk north
  ];

  const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);

  enemyPlacements.forEach((placement, i) => {
    if (!placement.inside) {
      if (!isFree(placement.x, placement.z, 0.6)) {
        for (let attempt = 0; attempt < 10; attempt++) {
          const offsetX = (Math.random() - 0.5) * 4;
          const offsetZ = (Math.random() - 0.5) * 4;
          if (isFree(placement.x + offsetX, placement.z + offsetZ, 0.6)) {
            placement.x += offsetX;
            placement.z += offsetZ;
            break;
          }
        }
      }
    }

    const spawnY = placement.upperFloor ? 3.8 : 0;
    const bot = new Bot(placement.x, placement.z, names[i % names.length]);
    bot.pos.y = spawnY;
    bot.yaw = Math.PI;
    if (placement.guard) bot.missionGuard = true;

    if (placement.patrol) {
      bot.patrolCenter = new THREE.Vector2(placement.x, placement.z);
      bot.patrolRadius = 5 + Math.random() * 3;
      bot.patrolAngle = Math.random() * Math.PI * 2;
      bot.patrolSpeed = 1.5 + Math.random() * 0.5;
    }

    bots.push(bot);
  });

  console.log('[CS] Spawned', enemyPlacements.length, 'Mission-02 east-sector enemies');
}

// ── Escort System — RAVEN follows player during extraction ──
function updateEscort(dt) {
  if (!missionState.escortActive || !missionState.escortNPC) return;

  const npc = missionState.escortNPC;
  const obj = currentMission.objectives[missionState.currentObjective];

  // Update extraction countdown timer
  if (obj && obj.escort) {
    const elapsed = (Date.now() - missionState.extractionStartTime) / 1000;
    missionState.extractionTimer = Math.max(0, obj.timeLimit - elapsed);
    if (missionState.extractionTimer <= 0) {
      showMissionNotification('TIME\'S UP — EXTRACTION FAILED');
      missionState.escortActive = false;
      triggerGameOver();
      return;
    }
  }

  // RAVEN follows player at walking speed, maintains ~3 unit distance
  const dx = player.pos.x - npc.position.x;
  const dz = player.pos.z - npc.position.z;
  const dist = Math.hypot(dx, dz);
  const followDist = 3;
  const speed = 4.5 * dt;

  // KESSLER starts on the hold cell's upper floor (y 3.8). The descent runs first and, while he is
  // airborne, ignores the follow branch: resolving collisions mid-drop would catch him on the
  // slab's 3.8 floor band and strand him upstairs, unable to reach the ground the player is on.
  if (npc.position.y > 0) {
    npc.position.y = Math.max(0, npc.position.y - dt * 4);
    if (npc.position.y < 0.02) npc.position.y = 0;
  } else if (dist > followDist) {
    // On his own feet he follows like a bot. The old code wrote x/z with no collision at all, so
    // Kessler could bury himself in a wall or a crate and never close the 8 m extraction window.
    const probe = { x: npc.position.x, y: npc.position.y, z: npc.position.z };
    collide(probe, P_RADIUS, P_HEIGHT, STEP);
    const blocked = Math.hypot(probe.x - npc.position.x, probe.z - npc.position.z) > 0.01;
    if (blocked) {
      let best = null, bestD = Infinity;
      for (const off of [0.9, -0.9, 1.7, -1.7]) {
        const a = Math.atan2(dx, dz) + off;
        const cand = { x: npc.position.x + Math.sin(a) * speed, y: npc.position.y, z: npc.position.z + Math.cos(a) * speed };
        collide(cand, P_RADIUS, P_HEIGHT, STEP);
        const d = Math.hypot(player.pos.x - cand.x, player.pos.z - cand.z);
        if (d < bestD) { bestD = d; best = cand; }
      }
      if (best) { npc.position.x = best.x; npc.position.z = best.z; }
    } else {
      npc.position.x += (dx / dist) * speed;
      npc.position.z += (dz / dist) * speed;
    }
    collide(npc.position, P_RADIUS, P_HEIGHT, STEP);
    npc.position.y = groundHeight(npc.position, 0.4);
    // Face toward the player
    npc.rotation.y = Math.atan2(dx, dz);

    // A follow speed of 4.5 m/s loses a race against a sprinting player, and a Kessler stranded on
    // the wrong side of a stairwell would mean an unwinnable escort. Past the soft-leash radius he
    // is lifted to the player's own floor level and set down 3 m clear of the player.
    if (dist > 12) {
      npc.position.set(player.pos.x + (dx / dist) * -3, groundHeight(player.pos, 0.4), player.pos.z + (dz / dist) * -3);
      collide(npc.position, P_RADIUS, P_HEIGHT, STEP);
    }
  }
}

// ── Mission 02 — demolition fuse ──
// Burns only while no dialogue is playing (the 'fuse_lit' scene lights it AFTER the cutscene ends).
// Reaching the escape zone detonates early and clean; expiry detonates with a lethal radius.
function updateFuse(dt) {
  if (!missionState.fuseActive || missionState.dialogueActive) return;
  missionState.fuseTimeLeft = Math.max(0, missionState.fuseTimeLeft - dt);
  if (missionState.fuseTimeLeft <= 0) detonateFuse(false);
}

function detonateFuse(early) {
  if (missionState.explosionDone) return;
  missionState.explosionDone = true;
  missionState.fuseActive = false;
  playExplosion();
  spawnWarehouseBlastFX();
  const dist = Math.hypot(player.pos.x - BLAST_CENTER.x, player.pos.z - BLAST_CENTER.z);
  if (!early && dist < BLAST_RADIUS) {
    showMissionNotification('TOO CLOSE TO THE BLAST');
    damagePlayer(200, { name: 'Demolition Charge' });
  } else {
    showMissionNotification('WAREHOUSE DESTROYED');
  }
}

// Deep two-layer rumble + crack — the cabinet only owns square/saw beeps, layered they read big
function playExplosion() {
  playBeep(38, 0.9, 0.3, 'sawtooth');
  playBeep(57, 0.6, 0.22, 'sawtooth');
  setTimeout(() => playBeep(120, 0.25, 0.18, 'square'), 90);
}

// One instanced-feel blast: debris cone, fireballs-as-white-fire, expanding shock ring, dust cloud.
// Everything lives in effects[] so updateEffects() recycles it with zero extra bookkeeping.
function spawnWarehouseBlastFX() {
  const center = new THREE.Vector3(BLAST_CENTER.x, 1.2, BLAST_CENTER.z);
  spawnParticles(center, null, sparkMat, 140, 16);          // white-hot core sparks
  spawnParticles(center, null, dustMat, 120, 9);             // thrown concrete dust
  spawnParticles(new THREE.Vector3(BLAST_CENTER.x, 0.4, BLAST_CENTER.z), null, bloodMat, 80, 6);  // dark debris
  // Fast white flash over the whole arena (fades with the standard effect life loop)
  const flashMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false });
  const flash = new THREE.Mesh(new THREE.SphereGeometry(6, 12, 8), flashMat);
  flash.position.copy(center).setY(2.5);
  scene.add(flash);
  effects.push({ obj: flash, life: 0.35, max: 0.35, fade: true });
  // Ground shock ring racing outward across the marsh
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xdddddd, transparent: true, opacity: 0.6, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(1, 1.5, 32), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(BLAST_CENTER.x, 0.25, BLAST_CENTER.z);
  scene.add(ring);
  effects.push({
    obj: ring, life: 0.8, max: 0.8, fade: true,
    grow: (e, k) => e.obj.scale.setScalar(1 + 26 * (1 - k))   // grows as life falls
  });
  // Slow dust column hanging over the site for a few seconds
  const cloudMat = new THREE.MeshBasicMaterial({ color: 0x777777, transparent: true, opacity: 0.35, depthWrite: false });
  const cloud = new THREE.Mesh(new THREE.SphereGeometry(7, 10, 7), cloudMat);
  cloud.position.set(BLAST_CENTER.x, 6, BLAST_CENTER.z);
  scene.add(cloud);
  effects.push({ obj: cloud, life: 4, max: 4, fade: true });
}

// Pushed while the fuse burns — pressure on the escape lane, not on the warehouse itself.
// Points sit off the boardwalk pavements so the isFree() gate never silently drops a spawn.
function spawnFuseReinforcements() {
  // Trimmed 5→3: the fuse is the frantic 24s sprint to the blast line, so the push has to stay
  // survivable. Kept the three that flank the escape corridor (44,-18) rather than clustering.
  const pts = [{ x: 51, z: -16 }, { x: 57, z: -24 }, { x: 48, z: -14 }];
  const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
  pts.forEach((ep, i) => {
    const spot = findFreeNear(ep.x, ep.z, 0.6);
    if (!spot) return;
    const b = new Bot(spot.x, spot.z, names[i % names.length]);
    b.patrolCenter = new THREE.Vector2(spot.x, spot.z);
    b.patrolRadius = 5;
    b.patrolAngle = Math.random() * Math.PI * 2;
    b.patrolSpeed = 2.2;
    bots.push(b);
  });
}

function updateMissionHud() {
  if (!currentMission || !missionState.active) return;
  
  const obj = currentMission.objectives[missionState.currentObjective];
  if (obj && !obj.completed) {
    missionObjective.textContent = obj.title;
  }
  
  const elapsed = Math.floor((Date.now() - missionState.startTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  missionTimer.textContent = `${mins}:${String(secs).padStart(2, '0')}`;

  // Evidence counter visibility
  const evidenceEl = document.getElementById('evidenceCounter');
  if (evidenceEl) {
    if (obj && obj.type === 'collect_evidence' && !obj.completed) {
      evidenceEl.style.display = 'block';
      evidenceEl.textContent = `EVIDENCE ${missionState.evidenceCollected}/${obj.evidenceCount}`;
    } else {
      evidenceEl.style.display = 'none';
    }
  }

  // ── Mission 02 counters ──
  const guardEl = document.getElementById('guardCounter');
  if (guardEl) {
    if (obj && obj.type === 'eliminate_guards' && !obj.completed) {
      const alive = bots.filter(b => b.missionGuard && !b.dead).length;
      guardEl.style.display = 'block';
      guardEl.textContent = `GUARDS ${alive} LEFT`;
    } else {
      guardEl.style.display = 'none';
    }
  }

  const chargeEl = document.getElementById('chargeCounter');
  if (chargeEl) {
    if (obj && obj.type === 'plant_charges' && !obj.completed) {
      chargeEl.style.display = 'block';
      chargeEl.textContent = `CHARGES ${missionState.chargesPlanted}/${obj.chargeCount}`;
    } else {
      chargeEl.style.display = 'none';
    }
  }

  const fuseEl = document.getElementById('fuseHud');
  if (fuseEl) {
    if (missionState.fuseActive) {
      fuseEl.style.display = 'flex';
      const fuseT = document.getElementById('fuseTimer');
      if (fuseT) {
        const fl = Math.max(0, Math.ceil(missionState.fuseTimeLeft));
        fuseT.textContent = `0:${String(fl).padStart(2, '0')}`;
        fuseT.classList.toggle('urgent', fl <= 8);
      }
    } else {
      fuseEl.style.display = 'none';
    }
  }

  const supplyEl = document.getElementById('resupplyCounter');
  if (supplyEl) {
    if (obj && obj.type === 'resupply' && !obj.completed) {
      supplyEl.style.display = 'block';
      supplyEl.textContent = `SUPPLIES ${missionState.suppliesCollected}/${obj.supplyCount}`;
    } else {
      supplyEl.style.display = 'none';
    }
  }

  // Escort HUD visibility
  const escortEl = document.getElementById('escortHud');
  if (escortEl) {
    if (missionState.escortActive) {
      escortEl.style.display = 'flex';
      const statusEl = document.getElementById('escortStatus');
      const timerEl = document.getElementById('extractionTimer');
      if (statusEl) {
        const eName = missionState.escortName || 'RAVEN';
        if (missionState.escortHealth <= 30) {
          statusEl.textContent = `${eName} STATUS: CRITICAL`;
          statusEl.classList.add('danger');
        } else if (missionState.escortHealth <= 60) {
          statusEl.textContent = `${eName} STATUS: INJURED`;
          statusEl.classList.remove('danger');
        } else {
          statusEl.textContent = `${eName} STATUS: OK`;
          statusEl.classList.remove('danger');
        }
      }
      if (timerEl && obj && obj.escort) {
        const tLeft = Math.max(0, Math.ceil(missionState.extractionTimer));
        const tm = Math.floor(tLeft / 60);
        const ts = tLeft % 60;
        timerEl.textContent = `${tm}:${String(ts).padStart(2, '0')}`;
        timerEl.classList.toggle('urgent', tLeft <= 30);
      }
    } else {
      escortEl.style.display = 'none';
    }
  }
}

function checkMissionObjectives() {
  if (!currentMission || !missionState.active || missionState.dialogueActive) return;
  
  const obj = currentMission.objectives[missionState.currentObjective];
  if (!obj || obj.completed) return;
  
  const playerPos = player.pos;
  
  switch (obj.type) {
    case 'enter_zone':
    case 'escape_zone':
      const dist = Math.hypot(playerPos.x - obj.zone.x, playerPos.z - obj.zone.z);
      if (dist < obj.triggerDistance) {
        if (obj.requiresNPC && !missionState.escortNPC) {
          showMissionNotification('Get RAVEN to safety!');
          return;
        }
        completeObjective(obj);
        // Fused escape: reaching the safe line detonates the charges early, cleanly, no damage
        if (obj.fuse && missionState.fuseActive) detonateFuse(true);
      }
      break;
      
    case 'find_clue':
      const clue = missionState.clues.find(c => c.userData.id === obj.id);
      if (clue) {
        const cdist = Math.hypot(playerPos.x - clue.position.x, playerPos.z - clue.position.z);
        if (cdist < obj.triggerDistance) {
          completeObjective(obj);
          const dialogueKey = `clue_${missionState.currentObjective}`;
          if (currentMission.dialogues[dialogueKey]) {
            playDialogue(dialogueKey);
          }
          scene.remove(clue);
          missionState.clues = missionState.clues.filter(c => c.userData.id !== obj.id);
        }
      }
      break;
      
    case 'find_npc':
      const npc = missionState.npcs.find(n => n.userData.id === obj.id);
      if (npc) {
        const ndist = Math.hypot(playerPos.x - npc.position.x, playerPos.z - npc.position.z);
        if (ndist < obj.triggerDistance) {
          completeObjective(obj);
          if (obj.triggersDialogue) {
            playDialogue('raven_contact');
          }
        }
      }
      break;
      
    case 'dialogue_sequence':
      if (!missionState.dialogueActive) {
        completeObjective(obj);
        // Track raven_extraction dialogue completion for escort activation
        if (obj.dialogueId === 'raven_extraction') {
          missionState._pendingEscortActivation = true;
        }
      }
      break;

    case 'collect_evidence':
      // Check proximity to each uncollected evidence item
      for (let ei = 0; ei < missionState.evidence.length; ei++) {
        const ev = missionState.evidence[ei];
        if (ev.userData.collected) continue;
        const edist = Math.hypot(playerPos.x - ev.position.x, playerPos.z - ev.position.z);
        if (edist < obj.triggerDistance) {
          ev.userData.collected = true;
          missionState.evidenceCollected++;
          scene.remove(ev);
          missionState.evidence.splice(ei, 1);
          showMissionNotification(`Evidence collected: ${obj.evidenceCount - missionState.evidenceCollected} remaining`);
          if (missionState.evidenceCollected >= obj.evidenceCount) {
            completeObjective(obj);
          }
          break;
        }
      }
      break;

    // ── Mission 02 objective types ──
    case 'collect_item': {
      const item = missionState.items.find(it => it.userData.id === obj.id);
      if (item) {
        const idist = Math.hypot(playerPos.x - item.position.x, playerPos.z - item.position.z);
        if (idist < obj.triggerDistance) {
          scene.remove(item);
          missionState.items = missionState.items.filter(it => it.userData.id !== obj.id);
          playBeep(880, 0.06, 0.12); playBeep(1320, 0.08, 0.1);
          showMissionNotification('PURPLE BUD RETRIEVED');
          completeObjective(obj);
        }
      }
      break;
    }

    case 'eliminate_guards':
      // Count tagged mission guards actually killed — recounted every frame so friendly-wave
      // deaths never under-count and stragglers revive the objective.
      missionState.guardsKilled = bots.filter(b => b.missionGuard && b.dead).length;
      if (missionState.guardsKilled >= obj.guardCount) {
        showMissionNotification('WAREHOUSE CLEARED');
        completeObjective(obj);
      }
      break;

    case 'plant_charges':
      for (const ch of missionState.charges) {
        if (ch.userData.planted) continue;
        const cdist = Math.hypot(playerPos.x - ch.position.x, playerPos.z - ch.position.z);
        if (cdist < obj.triggerDistance) {
          ch.userData.planted = true;
          attachPlantedCharge(ch);
          missionState.chargesPlanted++;
          playBeep(240, 0.08, 0.15, 'sawtooth');
          showMissionNotification(`Charge set on ${ch.userData.label} — ${obj.chargeCount - missionState.chargesPlanted} to go`);
          if (missionState.chargesPlanted >= obj.chargeCount) completeObjective(obj);
          break;
        }
      }
      break;

    case 'resupply':
      for (let si = 0; si < missionState.supplies.length; si++) {
        const sp = missionState.supplies[si];
        const sdist = Math.hypot(playerPos.x - sp.position.x, playerPos.z - sp.position.z);
        if (sdist < obj.triggerDistance) {
          if (sp.userData.supplyType === 'ammo') {
            // Every weapon topped back to a full reserve — this is the "get loaded for Kessler" beat
            for (const w of Object.values(inventory)) { w.reserve = w.def.reserve; }
            updateAmmoHud();
            showMissionNotification('AMMO RESTOCKED');
          } else {
            player.health = Math.min(PLAYER_MAX_HEALTH, player.health + 40);
            hud.health.textContent = Math.ceil(player.health);
            hud.healthBox.classList.toggle('low', player.health <= 25);
            showMissionNotification('HEALTH +40');
          }
          playBeep(660, 0.05, 0.12);
          scene.remove(sp);
          missionState.supplies.splice(si, 1);
          missionState.suppliesCollected++;
          if (missionState.suppliesCollected >= obj.supplyCount) completeObjective(obj);
          break;
        }
      }
      break;

    case 'escort_npc': {
      if (!missionState.escortActive) {
        // Find phase — walk up to Kessler, play his scene ONCE, then the escort begins. Without
        // the flag the scene would re-play every time the queue drains while the player loiters
        // inside triggerDistance; escortActive only flips after a scene finishes.
        const npc = missionState.npcs.find(n => n.userData.id === obj.id);
        if (npc && !missionState._findScenePlayed) {
          const kdist = Math.hypot(playerPos.x - npc.position.x, playerPos.z - npc.position.z);
          if (kdist < obj.triggerDistance) {
            missionState._findScenePlayed = true;
            playDialogue(obj.findDialogue, () => {
              missionState._pendingEscortName = obj.npcName;
              missionState._pendingEscortActivation = true;
            });
          }
        }
      } else {
        // Escort phase — extraction zone reached with the NPC nearby
        const edist = Math.hypot(playerPos.x - obj.zone.x, playerPos.z - obj.zone.z);
        if (edist < obj.triggerDistance) {
          const npcDist = missionState.escortNPC
            ? Math.hypot(playerPos.x - missionState.escortNPC.position.x, playerPos.z - missionState.escortNPC.position.z)
            : 999;
          if (npcDist > 8) {
            // Proximity ping, throttled — this branch is re-entered every frame the player loiters
            // in the zone with a lagging escort, so an unthrottled call repeated forever.
            if (!missionState.escNag) {
              missionState.escNag = true;
              showMissionNotification(`Stay close to ${missionState.escortName}!`);
              setTimeout(() => { missionState.escNag = false; }, 5000);
            }
            return;
          }
          completeObjective(obj);
        }
      }
      break;
    }
  }

  // Check if escort should activate (after raven_extraction / kessler_contact dialogue ends)
  if (missionState._pendingEscortActivation && !missionState.dialogueActive) {
    missionState._pendingEscortActivation = false;
    missionState.escortActive = true;
    const escortName = missionState._pendingEscortName || 'RAVEN';
    missionState._pendingEscortName = null;
    missionState.escortName = escortName;
    const escortNPC = missionState.npcs.find(n => n.userData.name === escortName);
    if (escortNPC) {
      missionState.escortNPC = escortNPC;
      missionState.escortHealth = 100;
      escortNPC.userData.followMode = true;
    }
    missionState.extractionStartTime = Date.now();
    missionState.extractionTimer = obj && obj.escort ? obj.timeLimit : 60;
    showMissionNotification(`ESCORT ${escortName} TO EXTRACTION — ${missionState.extractionTimer} SECONDS`);
    // Spawn extra enemies along the escape route. KESSLER's haul now runs from the central-west
    // block to the northern extraction lane, so the interdiction chips sit along that north push.
    // Trimmed 5→3 per escort so the extraction isn't a gauntlet on top of the field bots.
    const escapeEnemies = escortName === 'KESSLER'
      ? [{ x: -8, z: -14 }, { x: 8, z: -20 }, { x: 12, z: -30 }]
      : [{ x: -10, z: -5 }, { x: 15, z: 15 }, { x: 28, z: 25 }];
    const eNames = [...BOT_NAMES].sort(() => Math.random() - 0.5);
    escapeEnemies.forEach((ep, i) => {
      const spot = findFreeNear(ep.x, ep.z, 0.6);
      if (!spot) return;
      const b = new Bot(spot.x, spot.z, eNames[i % eNames.length]);
      b.patrolCenter = new THREE.Vector2(spot.x, spot.z);
      b.patrolRadius = 4;
      b.patrolAngle = Math.random() * Math.PI * 2;
      b.patrolSpeed = 2;
      bots.push(b);
    });
    console.log('[CS] Escort activated —', escortName, 'following,', missionState.extractionTimer + 's countdown');
  }
}

function completeObjective(obj) {
  obj.completed = true;
  missionState.currentObjective++;
  
  // Deactivate escort mode when escape zone completes
  if (obj.escort) {
    missionState.escortActive = false;
  }
  
  showMissionNotification(`Objective Complete: ${obj.title}`);
  
  // Mission 02: the third charge lights the 24s fuse — but only once the 'fuse_lit' scene ends,
  // so the timer never burns while the player is watching dialogue.
  if (obj.dialogueAfter) {
    if (obj.type === 'plant_charges') {
      playDialogue(obj.dialogueAfter, () => {
        missionState.fuseActive = true;
        missionState.fuseTimeLeft = obj.timeLimit ||
          (currentMission.objectives[missionState.currentObjective] || {}).timeLimit || 24;
        showMissionNotification('FUSE LIT — GET CLEAR OF THE WAREHOUSE!');
        // Greyline pushes reinforcements into the east sector while Rook runs for the blast line
        spawnFuseReinforcements();
      });
      return;
    }
    playDialogue(obj.dialogueAfter);
  }
  
  // Check if mission complete
  if (missionState.currentObjective >= currentMission.objectives.length) {
    completeMission();
  } else {
    updateMissionHud();
  }
}

function completeMission() {
  missionState.missionComplete = true;
  missionState.active = false;
  missionState.escortActive = false;
  missionState.fuseActive = false;
  missionState.elapsedTime = Date.now() - missionState.startTime;
  
  // Remove escort NPC from scene
  if (missionState.escortNPC) {
    scene.remove(missionState.escortNPC);
    missionState.escortNPC = null;
  }
  
  // Show final dialogue
  playDialogue('mission_complete', () => {
    showMissionCompleteScreen();
  });
}

function showMissionCompleteScreen() {
  const scoreEl = document.getElementById('missionScore');
  const timeEl = document.getElementById('missionTime');
  const xpEl = document.getElementById('missionXP');
  
  const score = calculateMissionScore();
  const time = Math.floor(missionState.elapsedTime / 1000);
  
  if (scoreEl) scoreEl.textContent = score;
  if (timeEl) timeEl.textContent = `${Math.floor(time / 60)}:${String(time % 60).padStart(2, '0')}`;
  if (xpEl) xpEl.textContent = `+${currentMission.rewards.xp} XP`;
  
  // Save progress
  const progress = loadMissionProgress();
  if (!progress.completed.includes(currentMission.id)) {
    progress.completed.push(currentMission.id);
  }
  progress.bestTimes[currentMission.id] = Math.min(
    progress.bestTimes[currentMission.id] || Infinity,
    time
  );
  progress.scores[currentMission.id] = Math.max(
    progress.scores[currentMission.id] || 0,
    score
  );
  saveMissionProgress(progress);
  
  // Award XP
  if (typeof AthleteXP !== 'undefined' && AthleteXP.report) {
    AthleteXP.report('counter-strike-mission', score);
  }
  
  // Restore round-based HUD elements
  const roundInfo = document.getElementById('round-info');
  const killsBox = document.getElementById('kills-box');
  const scoreboard = document.getElementById('topbar');
  const centerMsgEl = document.getElementById('center-msg');
  if (roundInfo) roundInfo.style.display = '';
  if (killsBox) killsBox.style.display = '';
  if (scoreboard) scoreboard.style.display = '';
  if (centerMsgEl) centerMsgEl.style.display = '';
  
  showScreen(missionCompleteScreen);
}

function calculateMissionScore() {
  const time = missionState.elapsedTime / 1000;
  const baseScore = 1000;
  const timeBonus = Math.max(0, 500 - Math.floor(time));
  const healthBonus = Math.floor(player.health * 2);
  return baseScore + timeBonus + healthBonus;
}

function playDialogue(dialogueKey, onComplete) {
  const dialogues = currentMission.dialogues[dialogueKey];
  if (!dialogues || dialogues.length === 0) {
    if (onComplete) onComplete();
    return;
  }

  // Re-entry guard. Proximity triggers fire from the objective check every frame — without this,
  // standing next to Kessler restarts his scene endlessly ("the conversation just repeats"), and
  // any completion dialogue could be chopped into by a wandering trigger.
  if (missionState.dialogueActive) return;

  missionState.dialogueQueue = [...dialogues];
  missionState.dialogueActive = true;
  if (dialogueOverlay) dialogueOverlay.style.display = 'flex';
  
  showNextDialogue(onComplete);
}

function showNextDialogue(onComplete) {
  if (missionState.dialogueQueue.length === 0) {
    if (dialogueOverlay) dialogueOverlay.style.display = 'none';
    missionState.dialogueActive = false;
    if (onComplete) onComplete();
    return;
  }
  
  const line = missionState.dialogueQueue.shift();
  if (dialogueSpeaker) dialogueSpeaker.textContent = line.speaker;
  if (dialogueText) dialogueText.textContent = line.text;
  
  // Set portrait (monochrome style)
  const portraitColors = { rook: '#666', raven: '#888', sable: '#555', kessler: '#999', patch: '#5a5a5a' };
  if (dialoguePortrait) dialoguePortrait.style.background = portraitColors[line.portrait] || '#777';
  
  // Auto-advance after delay or click
  setTimeout(() => {
    if (missionState.dialogueActive) {
      showNextDialogue(onComplete);
    }
  }, 4000);
}

function showMissionNotification(text) {
  let notif = document.getElementById('missionNotif');
  if (!notif) {
    notif = document.createElement('div');
    notif.id = 'missionNotif';
    notif.style.cssText = 'position:fixed;top:100px;left:50%;transform:translateX(-50%);' +
      'background:rgba(10,10,12,.95);color:#fff;padding:12px 24px;border-radius:8px;' +
      'border:1px solid rgba(255,255,255,.2);font:600 14px var(--f,system-ui);z-index:9999;' +
      'opacity:0;transition:opacity .3s;pointer-events:none;';
    document.body.appendChild(notif);
  }
  
  notif.textContent = text;
  notif.style.opacity = '1';
  setTimeout(() => { notif.style.opacity = '0'; }, 3000);
}

// ── Mission Select UI ──
function showMissionSelect() {
  const progress = loadMissionProgress();
  const missionList = document.getElementById('missionList');
  
  if (!missionList) return;
  
  missionList.innerHTML = MISSIONS.map(m => {
    const completed = progress.completed.includes(m.id);
    // A mission carrying `requires` unlocks only once the prerequisite is in the completed list
    const unlocked = !m.requires || progress.completed.includes(m.requires);
    const bestTime = progress.bestTimes[m.id];
    const score = progress.scores[m.id];
    
    return `
      <div class="mission-card ${completed ? 'completed' : ''} ${!unlocked ? 'locked' : ''}" data-mission="${m.id}" data-unlocked="${unlocked ? '1' : '0'}">
        <div class="mission-code">${m.codeName}</div>
        <div class="mission-title">${m.title}</div>
        ${completed ? `
          <div class="mission-stats">
            <span>Best: ${Math.floor(bestTime / 60)}:${String(bestTime % 60).padStart(2, '0')}</span>
            <span>Score: ${score}</span>
          </div>
        ` : unlocked ? `
          <div class="mission-stats"><span>${m.objectives.length} OBJECTIVES</span></div>
        ` : ''}
        <button class="mission-btn" ${unlocked ? '' : 'disabled'}>
          ${completed ? 'REPLAY' : unlocked ? 'START' : 'LOCKED'}
        </button>
      </div>
    `;
  }).join('');
  
  // Add click handlers
  missionList.querySelectorAll('.mission-card').forEach(card => {
    card.addEventListener('click', () => {
      if (card.dataset.unlocked !== '1') return;
      const missionId = card.dataset.mission;
      startMission(missionId);
    });
  });
  
  showScreen(document.getElementById('missionSelectScreen'));
}

// ── Mission Radar Markers ──
function updateMissionMarkers() {
  if (!currentMission || !missionState.active) return;
  
  // Clear the canvas and draw radar background (buildings, bots, player triangle)
  // — in mission mode updateHud() is skipped, so drawRadar() never runs otherwise
  drawRadar();
  
  const obj = currentMission.objectives[missionState.currentObjective];
  if (!obj || obj.completed) return;
  
  const c = radarCtx;
  const S = 170;
  const scale = 2.4;
  const radarRadius = S / 2 - 4; // usable radius inside the radar circle
  
  let targetX, targetZ;
  
  if (obj.type === 'enter_zone' || obj.type === 'escape_zone') {
    targetX = obj.zone.x;
    targetZ = obj.zone.z;
  } else if (obj.type === 'find_clue') {
    const clue = missionState.clues.find(cl => cl.userData.id === obj.id);
    if (clue) {
      targetX = clue.position.x;
      targetZ = clue.position.z;
    }
  } else if (obj.type === 'find_npc') {
    const npc = missionState.npcs.find(n => n.userData.id === obj.id);
    if (npc) {
      targetX = npc.position.x;
      targetZ = npc.position.z;
    }
  } else if (obj.type === 'collect_evidence') {
    // Show nearest uncollected evidence on radar
    let nearest = null, nearDist = Infinity;
    for (const ev of missionState.evidence) {
      if (ev.userData.collected) continue;
      const d = Math.hypot(ev.position.x - player.pos.x, ev.position.z - player.pos.z);
      if (d < nearDist) { nearDist = d; nearest = ev; }
    }
    if (nearest) { targetX = nearest.position.x; targetZ = nearest.position.z; }
  } else if (obj.type === 'collect_item') {
    const item = missionState.items.find(it => it.userData.id === obj.id);
    if (item) { targetX = item.position.x; targetZ = item.position.z; }
  } else if (obj.type === 'eliminate_guards') {
    // Nearest live tagged guard — the hunt marker follows the last man standing
    let nearest = null, nearDist = Infinity;
    for (const b of bots) {
      if (b.dead || !b.missionGuard) continue;
      const d = Math.hypot(b.pos.x - player.pos.x, b.pos.z - player.pos.z);
      if (d < nearDist) { nearDist = d; nearest = b; }
    }
    if (nearest) { targetX = nearest.pos.x; targetZ = nearest.pos.z; }
  } else if (obj.type === 'plant_charges') {
    let nearest = null, nearDist = Infinity;
    for (const ch of missionState.charges) {
      if (ch.userData.planted) continue;
      const d = Math.hypot(ch.position.x - player.pos.x, ch.position.z - player.pos.z);
      if (d < nearDist) { nearDist = d; nearest = ch; }
    }
    if (nearest) { targetX = nearest.position.x; targetZ = nearest.position.z; }
    else if (missionState.fuseActive) { targetX = obj.zone ? obj.zone.x : undefined; targetZ = obj.zone ? obj.zone.z : undefined; }
  } else if (obj.type === 'resupply') {
    let nearest = null, nearDist = Infinity;
    for (const sp of missionState.supplies) {
      const d = Math.hypot(sp.position.x - player.pos.x, sp.position.z - player.pos.z);
      if (d < nearDist) { nearDist = d; nearest = sp; }
    }
    if (nearest) { targetX = nearest.position.x; targetZ = nearest.position.z; }
  } else if (obj.type === 'escort_npc') {
    // Find phase marks Kessler; once he is moving, the extraction zone takes over
    if (missionState.escortActive) {
      targetX = obj.zone.x; targetZ = obj.zone.z;
    } else {
      const npc = missionState.npcs.find(n => n.userData.id === obj.id);
      if (npc) { targetX = npc.position.x; targetZ = npc.position.z; }
    }
  }
  
  if (targetX === undefined) return;
  
  // Waypoint position relative to player, in radar pixel coords
  const wx = (targetX - player.pos.x) * scale;
  const wz = (targetZ - player.pos.z) * scale;
  const dist = Math.sqrt(wx * wx + wz * wz);
  
  c.save();
  c.translate(S / 2, S / 2);
  c.rotate(player.yaw);
  
  const pulse = (Math.sin(performance.now() * 0.005) + 1) * 0.5;
  
  if (dist <= radarRadius) {
    // Objective is within minimap — draw waypoint marker directly
    c.shadowBlur = 10;
    c.shadowColor = '#ffffff';
    c.strokeStyle = `rgba(255, 255, 255, ${0.7 + pulse * 0.3})`;
    c.lineWidth = 2.5;
    c.beginPath();
    c.arc(wx, wz, 7 + pulse * 3, 0, Math.PI * 2);
    c.stroke();
    c.shadowBlur = 0;
    
    c.fillStyle = '#ffffff';
    c.beginPath();
    c.arc(wx, wz, 3.5, 0, Math.PI * 2);
    c.fill();
  } else {
    // Objective is off-minimap — draw a directional arrow at the edge
    const angle = Math.atan2(wz, wx);
    const arrowDist = radarRadius - 6; // sit just inside the circle edge
    const ax = Math.cos(angle) * arrowDist;
    const ay = Math.sin(angle) * arrowDist;
    
    // Pulsing arrowhead pointing toward objective
    c.save();
    c.translate(ax, ay);
    c.rotate(angle); // point the arrow along the direction
    
    c.shadowBlur = 8;
    c.shadowColor = '#ffffff';
    c.fillStyle = `rgba(255, 255, 255, ${0.75 + pulse * 0.25})`;
    c.strokeStyle = `rgba(255, 255, 255, ${0.75 + pulse * 0.25})`;
    c.lineWidth = 2;
    
    // Arrowhead triangle
    const sz = 7 + pulse * 2;
    c.beginPath();
    c.moveTo(sz, 0);           // tip
    c.lineTo(-sz * 0.6, -sz * 0.55);
    c.lineTo(-sz * 0.6,  sz * 0.55);
    c.closePath();
    c.fill();
    c.stroke();
    c.shadowBlur = 0;
    
    c.restore();
    
    // Small distance label near the arrow (in unrotated HUD space)
    c.save();
    // Undo the radar rotation for text so it stays upright
    c.rotate(-player.yaw);
    const labelX = ax * Math.cos(-player.yaw) - ay * Math.sin(-player.yaw);
    const labelY = ax * Math.sin(-player.yaw) + ay * Math.cos(-player.yaw);
    const worldDist = Math.round(dist / scale);
    c.fillStyle = `rgba(255, 255, 255, ${0.6 + pulse * 0.3})`;
    c.font = '600 9px system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(`${worldDist}m`, labelX, labelY + 14);
    c.restore();
  }
  
  c.restore();
}

function resetPlayer() {
  let x, z, tries = 0;
  const inMission = missionState.active && selectedMap !== 'classic';
  
  if (inMission) {
    // Mission: spawn in the southwest corner, far from enemies and objective
    do { x = rand(-44, -38); z = rand(-44, -38); tries++; } while (!isFree(x, z, 0.5) && tries < 200);
    player.pos.set(x, 0, z);
    player.vel.set(0, 0, 0);
    // Face northeast toward the map center / objective direction
    player.yaw = Math.PI * 1.25; player.pitch = 0;
  } else {
    const ctZMin = selectedMap === 'classic' ? -25 : -45;
    const ctZMax = selectedMap === 'classic' ? -20 : -40;
    // The try cap matters: a spawn band that a map edit has filled in would otherwise spin here
    // forever and take the whole page down with it.
    do { x = rand(-8, 8); z = rand(ctZMin, ctZMax); tries++; } while (!isFree(x, z, 0.5) && tries < 200);
    player.pos.set(x, 0, z);
    player.vel.set(0, 0, 0);
    player.yaw = Math.PI; player.pitch = 0;
  }
  player.health = PLAYER_MAX_HEALTH; player.alive = true;
  player.onGround = true; player.eye = 1.65;
  hud.health.textContent = PLAYER_MAX_HEALTH;
  hud.healthBox.classList.remove('low');
  for (const w of Object.values(inventory)) { w.ammo = w.def.mag; w.reserve = w.def.reserve; }
  Object.assign(weaponState, { cooldown: 0, reloading: 0, switching: 0.3, recoil: 0, ads: 0 });
  current.model.visible = false;
  current = inventory.rifle;
  current.model.visible = true;
  updateAmmoHud();
  // The rail is re-painted here rather than only in setWeapon: this path assigns the rifle
  // directly, so a round started with the pistol out would otherwise leave slot 2 lit.
  syncWeaponRail();
}

function startRound() {
  game.round++;
  game.state = 'playing';
  game.timeLeft = ROUND_TIME;
  clearBots();
  resetPlayer();
  spawnBots(Math.min(3 + Math.floor(game.round / 2), 8));
  hud.round.textContent = game.round;
  hud.enemies.textContent = aliveBots().length;
  centerMsg(`ROUND ${game.round}`, `${aliveBots().length} terrorists. Eliminate them all.`);
  // Request pointer lock for gameplay (desktop only)
  audio().resume();
  if (!isTouchDevice) renderer.domElement.requestPointerLock();
}

function endRound(winner) {
  if (game.state !== 'playing') return;
  game.state = 'roundEnd';
  game.endTimer = 4;
  if (winner === 'CT') {
    game.ct++;
    centerMsg('<span style="color:#f0f0f2">COUNTER-TERRORISTS WIN</span>', 'Next round starting…', 4);
  } else {
    game.t++;
    centerMsg('<span style="color:#8888a0">TERRORISTS WIN</span>', "Time's up", 4);
  }
  hud.scoreCT.textContent = game.ct;
  hud.scoreT.textContent = game.t;
}

// ── Portal integration: game over + XP reporting ──
const goScore = document.getElementById('goScore');
const goXP = document.getElementById('goXP');
const goRound = document.getElementById('goRound');
const btnRetry = document.getElementById('btnRetry');
const btnBackMenu = document.getElementById('btnBackMenu');
const btnPlay = document.getElementById('btnPlay');

function triggerGameOver() {
  game.state = 'gameOver';
  // Clean up mission escort/fuse state
  missionState.escortActive = false;
  missionState.escortNPC = null;
  missionState.fuseActive = false;
  // Release pointer lock
  if (document.pointerLockElement) document.exitPointerLock();
  // Show game over screen with stats
  goScore.textContent = game.kills;
  goRound.textContent = game.round;
  goXP.textContent = '--';
  showScreen(gameOverScreen);
  // Report XP to portal
  if (typeof AthleteXP !== 'undefined' && AthleteXP.report) {
    AthleteXP.report('counter-strike', game.kills).then(result => {
      if (result) goXP.textContent = '+' + (result.awarded || 0) + ' XP';
      else goXP.textContent = '--';
    });
  }
}

function startNewGame() {
  // The marsh expansion belongs to Mission 02 alone — never carry it into fresh rounds
  if (selectedMap === 'industrial_east') selectedMap = 'industrial';
  buildMap();
  if (hud.coopBoard) hud.coopBoard.innerHTML = '';
  game.round = 0; game.ct = 0; game.t = 0; game.kills = 0;
  game.timeLeft = ROUND_TIME; game.endTimer = 0;
  hud.scoreCT.textContent = '0'; hud.scoreT.textContent = '0';
  hud.kills.textContent = '0';
  hud.killfeed.innerHTML = '';
  clearBots();
  
  // Clean up mission entities and escort state
  missionState.evidence.forEach(ev => scene.remove(ev));
  missionState.evidence = [];
  missionState.evidenceCollected = 0;
  missionState.items.forEach(it => scene.remove(it));
  missionState.items = [];
  missionState.charges.forEach(ch => scene.remove(ch));
  missionState.charges = [];
  missionState.supplies.forEach(sp => scene.remove(sp));
  missionState.supplies = [];
  missionState.chargesPlanted = 0;
  missionState.suppliesCollected = 0;
  missionState.guardsKilled = 0;
  missionState.fuseActive = false;
  missionState.explosionDone = false;
  missionState.escortActive = false;
  missionState.escortNPC = null;
  missionState.escortName = 'RAVEN';
  missionState._pendingEscortActivation = false;
  missionState._pendingEscortName = null;
  
  // Hide mission HUD and restore round-based HUD
  if (missionHud) missionHud.style.display = 'none';
  const roundInfo = document.getElementById('round-info');
  const killsBox = document.getElementById('kills-box');
  const scoreboard = document.getElementById('topbar');
  const centerMsgEl = document.getElementById('center-msg');
  if (roundInfo) roundInfo.style.display = '';
  if (killsBox) killsBox.style.display = '';
  if (scoreboard) scoreboard.style.display = '';
  if (centerMsgEl) centerMsgEl.style.display = '';
  
  showScreen(gameScreen);
  startRound();
}

// Menu → Deploy button
btnPlay.addEventListener('click', () => {
  // Block game start until the phone is landscape — the gate is the only path to play.
  if (isPhone && !inLandscape()) { syncMobileGate(); return; }
  audio().resume();
  startNewGame();
});

// Menu → Multiplayer button
const btnMultiplayer = document.getElementById('btnMultiplayer');
const btnBackFromLobby = document.getElementById('btnBackFromLobby');

if (btnMultiplayer) {
  btnMultiplayer.addEventListener('click', () => {
    audio().resume();
    showScreen(lobbyScreen);
    // Connect to multiplayer if not already
    if (typeof CSNet !== 'undefined' && !CSNet.connected) {
      CSNet.connect();
    }
  });
}

if (btnBackFromLobby) {
  btnBackFromLobby.addEventListener('click', () => {
    if (typeof CSNet !== 'undefined') {
      CSNet.leaveRoom();
    }
    showScreen(menuScreen);
  });
}

// Menu → Missions button
const btnMissions = document.getElementById('btnMissions');
const btnBackFromMissions = document.getElementById('btnBackFromMissions');
const btnStartBriefing = document.getElementById('btnStartBriefing');

if (btnMissions) {
  btnMissions.addEventListener('click', () => {
    audio().resume();
    // Load cloud progress if available
    loadMissionProgressFromCloud().then(() => {
      showMissionSelect();
    }).catch(() => {
      showMissionSelect();
    });
  });
}

if (btnBackFromMissions) {
  btnBackFromMissions.addEventListener('click', () => {
    showScreen(menuScreen);
  });
}

if (btnStartBriefing) {
  btnStartBriefing.addEventListener('click', () => {
    // Block mission start until the phone is landscape.
    if (isPhone && !inLandscape()) { syncMobileGate(); return; }
    audio().resume();
    beginMissionGameplay();
  });
}

// Game over → Redeploy. After a co-op match the room is still open on the hub, so this goes back to
// the lobby instead of dropping the athlete into a private round they did not ask for.
btnRetry.addEventListener('click', () => {
  // Block retry until the phone is landscape.
  if (isPhone && !inLandscape()) { syncMobileGate(); return; }
  if (typeof CSNet !== 'undefined' && CSNet.room) {
    if (hud.coopBoard) hud.coopBoard.innerHTML = '';
    showScreen(lobbyScreen);
    return;
  }
  // If a mission was active, restart the mission instead of classic mode
  if (currentMission) {
    const missionId = currentMission.id;
    startMission(missionId);
  } else {
    startNewGame();
  }
});

// Back to menu — shared by the game-over panel and the pause panel's Quit, because a phone needs
// an exit from inside a round as well and both paths have to leave a co-op room the same way.
function quitToMenu() {
  game.state = 'menu';
  isOnline = false;
  clearOnlineFigures();
  if (hud.coopBoard) hud.coopBoard.innerHTML = '';
  if (typeof CSNet !== 'undefined' && CSNet.room) CSNet.leaveRoom();
  setTouchPaused(false);
  showScreen(menuScreen);
}
btnBackMenu.addEventListener('click', quitToMenu);

// ── Update loop ──
function updatePlayer(dt) {
  if (!player.alive) {
    player.eye = Math.max(0.3, player.eye - dt * 2.5);
    camera.position.set(player.pos.x, player.pos.y + player.eye, player.pos.z);
    camera.rotation.set(player.pitch, player.yaw, Math.min(0.5, (1.65 - player.eye)));
    return;
  }
  const fwd = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  const right = new THREE.Vector3(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
  const wish = new THREE.Vector3();
  
  // Desktop keyboard input
  if (keys.KeyW || keys.ArrowUp) wish.add(fwd);
  if (keys.KeyS || keys.ArrowDown) wish.sub(fwd);
  if (keys.KeyD || keys.ArrowRight) wish.add(right);
  if (keys.KeyA || keys.ArrowLeft) wish.sub(right);
  
  // Mobile joystick input
  if (isTouchDevice && touch.joystickActive) {
    wish.add(fwd.clone().multiplyScalar(-touch.moveY));
    wish.add(right.clone().multiplyScalar(touch.moveX));
  }
  
  if (wish.lengthSq() > 0) wish.normalize();

  const crouch = isTouchDevice ? touch.crouch : (keys.KeyC || keys.ControlLeft);
  const walk = isTouchDevice ? false : (keys.ShiftLeft || keys.ShiftRight);
  // Wading drag (Mission-02 marsh): ankle-deep shallows take the edge off, chest-deep water
  // nearly halves pace. Dry maps have an empty pool list, so this is a no-op there.
  const wade = marshPools.length ? wadeDepth(player.pos.x, player.pos.z) : 0;
  player.wade = wade;
  const drag = wade === 2 ? 0.5 : wade === 1 ? 0.78 : 1;
  const speed = (crouch ? 2.2 : walk ? 3 : current.def.speed) * (1 - 0.4 * weaponState.ads) * drag;
  const accel = player.onGround ? (wade ? 7 : 12) : 2.5;
  const k = Math.min(1, accel * dt);
  player.vel.x += (wish.x * speed - player.vel.x) * k;
  player.vel.z += (wish.z * speed - player.vel.z) * k;

  const jump = isTouchDevice ? touch.jump : keys.Space;
  if (jump && player.onGround) {
    // You can't leave the water the way you leave land — the jump is pulled down by the depth
    if (wade) { try { playSplash(player.pos, wade === 2); spawnWaterRipple(player.pos.x, player.pos.z, wade === 2); } catch (_) {} }
    player.vel.y = wade === 2 ? 4.4 : wade === 1 ? 5.8 : 7;
    player.onGround = false;
  }
  player.vel.y -= 20 * dt;

  player.pos.x += player.vel.x * dt;
  player.pos.z += player.vel.z * dt;
  collide(player.pos, P_RADIUS, P_HEIGHT, player.onGround ? STEP : 0.02);

  player.pos.y += player.vel.y * dt;
  const gh = groundHeight(player.pos, P_RADIUS);
  if (player.pos.y <= gh) {
    // splashing back in from a jump over the reeds deserves a proper belly-flop
    if (wade && player.vel.y < -3.5) {
      try { playSplash(player.pos, wade === 2); spawnWaterRipple(player.pos.x, player.pos.z, wade === 2); spawnWadeSplash(player.pos, true); } catch (_) {}
    }
    player.pos.y = gh; player.vel.y = 0; player.onGround = true;
  } else if (player.onGround && player.vel.y <= 0 && player.pos.y - gh < STEP) {
    player.pos.y = gh; player.vel.y = 0;
  } else {
    player.onGround = false;
  }

  player.speed = Math.hypot(player.vel.x, player.vel.z);

  // Own footsteps: fire per distance walked (1.7u/step), so the cadence stays
  // honest at any frame rate; crouch takes smaller quieter steps, airborne is silent.
  if (player.alive && player.onGround && player.speed > 0.6) {
    if (player._lastStepPos === undefined) player._lastStepPos = player.pos.clone();
    const walked = Math.hypot(player.pos.x - player._lastStepPos.x, player.pos.z - player._lastStepPos.z);
    const stride = player.eye < 1.4 ? 2.4 : player.speed > 3.4 ? 1.5 : 1.9;
    if (walked > stride) {
      try {
        if (wade) {
          // every wet step: plip + a spreading ring + a handful of kicked-up droplets
          playSplash(player.pos, wade === 2);
          spawnWaterRipple(player.pos.x, player.pos.z, wade === 2);
          spawnWadeSplash(player.pos, wade === 2);
        } else {
          playFootstep('self', player.pos, 0, player.eye < 1.4 ? 0.5 : 1);
        }
      } catch (_) {}
      player._lastStepPos.copy(player.pos);
    }
    // constant trail of small ripples while moving through deep water, between the big strides
    if (wade === 2) {
      player._rippleAt = player._rippleAt || 0;
      const now = performance.now() / 1000;
      if (now - player._rippleAt > 0.45) { player._rippleAt = now; spawnWaterRipple(player.pos.x + rand(-0.3, 0.3), player.pos.z + rand(-0.3, 0.3), false); }
    }
  } else if (player.alive) {
    if (player._lastStepPos) player._lastStepPos.copy(player.pos);
  }
  // Standing in water still disturbs it — slow breathing rings around the boots
  if (wade && player.onGround && player.speed <= 0.6) {
    player._rippleAt = player._rippleAt || 0;
    const now = performance.now() / 1000;
    if (now - player._rippleAt > 1.6) { player._rippleAt = now; spawnWaterRipple(player.pos.x, player.pos.z, false); }
  }
  // one notice per entry so the HUD doesn't chatter while you slosh around
  if (wade && !player._wadeNotice) {
    player._wadeNotice = true;
    try { showMissionNotification(wade === 2 ? 'DEEP WATER — MOVEMENT SLOWED' : 'SHALLOW WATER — MIND THE DRAG'); } catch (_) {}
  }
  if (!wade) player._wadeNotice = false;
  player.eye += ((crouch ? 1.15 : 1.65) - player.eye) * Math.min(1, dt * 12);
  // chest-deep wading: the horizon rocks with every careful step
  let camSway = 0;
  if (wade && player.onGround && player.speed > 0.4) {
    const now = performance.now() * 0.001;
    camSway = Math.sin(now * 4.2) * (wade === 2 ? 0.055 : 0.025);
  }
  camera.position.set(player.pos.x, player.pos.y + player.eye + camSway, player.pos.z);
  camera.rotation.set(player.pitch, player.yaw, 0);
}

function updateWeapon(dt) {
  const ws = weaponState, model = current.model;
  ws.cooldown = Math.max(0, ws.cooldown - dt);
  ws.switching = Math.max(0, ws.switching - dt);
  // `mouseDown` alone meant a held trigger only ever fired one round on a phone: the touch layer
  // sets touch.fire, and nothing read it. Desktop behaviour is unchanged.
  const firing = mouseDown || (isTouchDevice && touch.fire);
  ws.recoil = Math.max(0, ws.recoil - dt * (firing ? 0.05 : 0.18));
  ws.kickAnim = Math.max(0, ws.kickAnim - dt * 12);
  if (ws.reloading > 0) {
    ws.reloading -= dt;
    if (ws.reloading <= 0) { ws.reloading = 0; finishReload(); }
  }
  if (firing && current.def.auto) fire();

  ws.bob += dt * player.speed * (player.onGround ? 1.6 : 0);
  const bobX = Math.sin(ws.bob) * 0.012 * Math.min(1, player.speed / 3);
  const bobY = Math.abs(Math.cos(ws.bob)) * 0.012 * Math.min(1, player.speed / 3);
  let dip = 0, tilt = 0;
  if (ws.reloading > 0) {
    const p = 1 - ws.reloading / current.def.reload;
    dip = Math.sin(p * Math.PI) * 0.18;
    tilt = Math.sin(p * Math.PI) * 0.7;
  }
  if (ws.switching > 0) dip += ws.switching * 0.6;
  const canAim = aiming && player.alive && ws.reloading <= 0 && ws.switching <= 0;
  ws.ads += ((canAim ? 1 : 0) - ws.ads) * Math.min(1, dt * 12);
  const a = ws.ads, hip = 1 - a * 0.85;
  camera.fov = 75 + (current.def.adsFov - 75) * a;
  camera.updateProjectionMatrix();
  model.position.set(
    VM_BASE.x * (1 - a) + bobX * hip,
    VM_BASE.y + (current.def.adsY - VM_BASE.y) * a + bobY * hip - dip,
    VM_BASE.z - 0.16 * a + ws.kickAnim * 0.05 * hip);
  model.rotation.set(ws.kickAnim * 0.08 - tilt * 0.4, 0, tilt * 0.5);
  model.visible = player.alive;

  ws.flashTime -= dt;
  model.userData.flash.visible = ws.flashTime > 0;
  muzzleLight.intensity = Math.max(0, muzzleLight.intensity - dt * 120);

  const gap = 5 + currentSpread() * 260;
  hud.crosshair.style.setProperty('--gap', `${gap.toFixed(1)}px`);
  hud.crosshair.style.opacity = 1 - Math.min(1, ws.ads * 1.5);
}

function updateHud(dt) {
  syncMouseHint();   // every mode, every frame: the hint is derived from the flags, never owned
  const t = Math.max(0, Math.ceil(game.timeLeft));
  const timerText = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  if (timerText !== lastTimerText) { hud.timer.textContent = timerText; lastTimerText = timerText; }
  hud.timer.classList.toggle('low', t <= 15);

  if (centerTimer > 0) { centerTimer -= dt; if (centerTimer <= 0) hud.center.classList.remove('show'); }
  if (hitTimer > 0) { hitTimer -= dt; if (hitTimer <= 0) hud.hit.style.opacity = 0; }
  damageFlash = Math.max(0, damageFlash - dt * 1.5);
  if (damageFlash !== lastDamageOpacity) { hud.damage.style.opacity = damageFlash; lastDamageOpacity = damageFlash; }
  // Radar at 20 Hz: at 2.4× scale a bot moves ~3px between updates — imperceptible
  _radarFrame = (_radarFrame + 1) % 3;
  if (_radarFrame === 0) drawRadar();
}

function drawRadar() {
  const c = radarCtx, S = 170, scale = 2.4;
  c.clearRect(0, 0, S, S);
  c.save();
  c.beginPath(); c.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2); c.clip();
  c.translate(S / 2, S / 2); c.rotate(player.yaw);
  c.fillStyle = 'rgba(42,42,50,0.85)'; // monochrome dark
  const half = S / (2 * scale); // world-space radius of the visible radar
  for (const col of colliders) {
    // Cull colliders outside radar range before fillRect
    if (col.minX - player.pos.x > half || col.maxX - player.pos.x < -half ||
        col.minZ - player.pos.z > half || col.maxZ - player.pos.z < -half) continue;
    c.fillRect((col.minX - player.pos.x) * scale, (col.minZ - player.pos.z) * scale,
      (col.maxX - col.minX) * scale, (col.maxZ - col.minZ) * scale);
  }
  for (const b of bots) {
    if (!b.dead && b.spotted <= 0) continue;
    c.fillStyle = b.dead ? 'rgba(120,120,120,0.8)' : '#ff4a4a'; // red for alive enemies, grey for dead
    c.beginPath();
    c.arc((b.pos.x - player.pos.x) * scale, (b.pos.z - player.pos.z) * scale, b.dead ? 2.5 : 4, 0, Math.PI * 2);
    c.fill();
  }
  // In co-op the terrorist force and the squad live in the snapshot, not in the local arrays, so
  // the blip sweep has to read the same entities the 3D view is drawing.
  if (isOnline) {
    for (const rig of onlineBots.values()) {
      if (!rig.alive) continue;
      c.fillStyle = '#ff4a4a'; // red for online enemies
      c.beginPath();
      c.arc((rig.pos.x - player.pos.x) * scale, (rig.pos.z - player.pos.z) * scale, 4, 0, Math.PI * 2);
      c.fill();
    }
    for (const rig of onlinePlayers.values()) {
      if (!rig.alive) continue;
      c.fillStyle = 'rgba(240,240,242,0.9)';
      c.beginPath();
      c.arc((rig.pos.x - player.pos.x) * scale, (rig.pos.z - player.pos.z) * scale, 3, 0, Math.PI * 2);
      c.fill();
    }
  }
  c.restore();
  c.fillStyle = '#f0f0f2'; // white for player
  c.beginPath();
  c.moveTo(S / 2, S / 2 - 7);
  c.lineTo(S / 2 - 5, S / 2 + 5);
  c.lineTo(S / 2 + 5, S / 2 + 5);
  c.closePath(); c.fill();
}

// ── Online state ──
// Declared here, above the render loop, because frame() is invoked synchronously while this module
// is still evaluating: anything it touches further down would still be in its temporal dead zone on
// the very first call, and that throws straight through the loop into a black screen.
let isOnline = false;
let onlineRoster = [];
const onlinePlayers = new Map(); // id -> FigureRig (teammates)
const onlineBots = new Map();    // id -> FigureRig (terrorists, simulated by the hub)
let lastSnapshot = null;
let snapshotBuffer = [];         // {at, data} back-buffer, oldest first
const INTERP_DELAY = 110;        // ms of render delay — just over one 100ms hub tick
const BUFFER_CAP = 12;
let fxWatermark = 0;             // arrival time of the newest snapshot whose effects have played
let myRow = null;                // my own row as the hub reports it
let resetSeenRound = null;       // hub round we already took a spawn from, so a reset fires once per round
let countdownHandle = null;
let pendingRay = null;           // one fired shot waiting for the next state packet

// Co-op deploys from a hub message plus a 3500ms timer, so the mouse is typically NOT captured on
// the first frame and the cabinet cannot fix that itself — only a click can. Movement no longer
// waits for the capture, but looking and shooting still do, so the athlete has to be told.
// Recomputed from the live flags wherever they change instead of being shown and hidden by hand,
// which is how overlays like this usually end up stranded over a finished match.
let mouseHintOn = false;
function syncMouseHint() {
  const want = isOnline && !isTouchDevice && !locked && game.state === 'playing';
  if (want === mouseHintOn) return;
  mouseHintOn = want;
  let el = document.getElementById('csMouseHint');
  if (!el) {
    if (!want) return;
    el = document.createElement('div');
    el.id = 'csMouseHint';
    el.style.cssText = 'position:fixed;left:50%;bottom:104px;transform:translateX(-50%);z-index:61;'
      + 'padding:9px 18px;border:1px solid rgba(240,240,242,.24);border-radius:999px;'
      + 'background:rgba(10,10,12,.8);color:#f0f0f2;'
      + 'font:500 11px var(--f,system-ui,sans-serif);letter-spacing:.16em;text-transform:uppercase;'
      + 'pointer-events:none;box-shadow:0 10px 34px rgba(0,0,0,.5);';
    el.textContent = 'Click to capture the mouse \u00b7 WASD to move';
    document.body.appendChild(el);
  }
  el.style.display = want ? 'block' : 'none';
}

// ── Main render loop ──
const clock = new THREE.Clock();

// ── Adaptive quality: rolling FPS monitor that progressively reduces GPU load ──
const fpsHistory = [];
let qualityLevel = 0; // 0=full, 1=reduced shadows, 2=shorter fog, 3=fewer bots
let _shadowThrottle = 3; // frames between shadow updates
const FOG_FULL = 160, FOG_REDUCED = 100;
function applyQualityLevel() {
  if (qualityLevel >= 1) _shadowThrottle = 5; // shadows every 5th frame
  if (qualityLevel >= 2) scene.fog.far = FOG_REDUCED; // cull distant geometry
  console.log('[CS] Quality level', qualityLevel, '— shadow every', _shadowThrottle, 'frames, fog far', scene.fog.far);
}
function trackFPS(dt) {
  if (dt <= 0) return;
  fpsHistory.push(1 / dt);
  if (fpsHistory.length > 120) fpsHistory.shift();
  if (fpsHistory.length === 120) {
    const avg = fpsHistory.reduce((a, b) => a + b) / fpsHistory.length;
    if (avg < 30 && qualityLevel < 3) { qualityLevel++; applyQualityLevel(); }
  }
}

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);

  // On a phone there is no lost lock to clear the input flags, so a round that ends under a thumb
  // still pressing FIRE would carry the flag into the next one, and a pause would sit on top of
  // the game-over screen. Both let go the moment the state leaves 'playing'.
  if (isTouchDevice && game.state !== 'playing' &&
      (touchPaused || touch.fire || touch.jump || touch.crouch || touch.joystickActive)) {
    setTouchPaused(false);
    releaseHeldPads();
  }

  // Living water: the caustic texture creeps across every pond at once (one shared map) and the
  // sheen breathes — marsh only, costs nothing on the dry arena.
  if (marshPools.length) {
    const wt = clock.elapsedTime;
    waterTex.offset.x = Math.sin(wt * 0.11) * 0.015 + wt * 0.0035;
    waterTex.offset.y = Math.cos(wt * 0.08) * 0.012 + wt * 0.0026;
    mats.water.opacity = 0.52 + Math.sin(wt * 1.35) * 0.03;
    // the bayou sheet drifts on its own slower vector so pond patches and flood never pulse in lockstep
    floodTex.offset.x = Math.sin(wt * 0.07) * 0.01 - wt * 0.0021;
    floodTex.offset.y = Math.cos(wt * 0.05) * 0.008 + wt * 0.0017;
    mats.flood.opacity = 0.40 + Math.sin(wt * 0.9 + 1.7) * 0.025;
  }

  // Apply touch look on mobile
  if (isTouchDevice) applyTouchLook(dt);

  if (isOnline && game.state !== 'menu') {
    // Co-op. The hub owns the bots, so teammates and terrorists keep moving even while the local
    // player is dead or the round is between states — a frozen squad while you watch them die is
    // exactly what made this mode feel broken.
    //
    // Deliberately NOT gated on isGameActive(), i.e. not on pointer lock. A co-op match begins from
    // the hub's 'go' message and a 3500ms countdown, so the requestPointerLock() at the end of it
    // runs inside a timer and is not a user gesture: the browser refuses and fires
    // pointerlockerror, not pointerlockchange, so `locked` stays false and never changes again.
    // Gating on it skipped BOTH updatePlayer and sendPlayerState, which meant the hub went on
    // streaming a world in which that athlete stood perfectly still at spawn — the other player
    // watched their teammate freeze, and the teammate could not move either. Walking only needs
    // the keyboard, which window already listens for; the lock buys mouse-look alone, and the
    // hint below asks for the click that grants it.
    if (game.state === 'playing') {
      updatePlayer(dt);
      sendPlayerState();
    }
    updateOnlinePlayers(dt);
    updateWeapon(dt);
    updateEffects(dt);
    updateHud(dt);
  } else if (!isOnline && isGameActive()) {
    // Single-player: local simulation
    if (missionState.active) {
      // Mission mode — no round timer, objective-based progression
      updatePlayer(dt);
      for (const b of bots) b.update(dt);
      updateWeapon(dt);
      updateEffects(dt);
      updateMissionHud();
      checkMissionObjectives();
      updateMissionMarkers();
      updateEscort(dt);
      updateFuse(dt);
      // Animate evidence indicators (floating bob)
      const t = performance.now() * 0.001;
      for (const ev of missionState.evidence) {
        ev.children.forEach(ch => {
          if (ch.userData.isIndicator) {
            ch.position.y = 0.9 + Math.sin(t * 2 + ev.position.x) * 0.1;
            ch.rotation.y = t * 1.5;
          }
        });
      }
      // Mission 02 props: bud/supply markers bob, charge anchors bob until planted,
      // planted LEDs then blink fast while the fuse burns. The bud is a ~2.0 m hero cannabis
      // specimen, so its marker hovers above the cola head (baseY tracks H+0.58 of the plant).
      const bobList = [[missionState.items, 2.63], [missionState.supplies, 0.75]];
      for (const [list, baseY] of bobList) {
        for (const it of list) {
          it.children.forEach(ch => {
            if (ch.userData.isIndicator) {
              ch.position.y = baseY + Math.sin(t * 2 + it.position.x) * 0.1;
              ch.rotation.y = t * 1.5;
            }
          });
        }
      }
      for (const chG of missionState.charges) {
        chG.children.forEach(m => {
          if (!m.userData.isIndicator) return;
          if (m.name === 'chargeLed') {
            m.visible = missionState.fuseActive ? (t * 5) % 1 < 0.5 : true;
          } else if (!chG.userData.planted) {
            m.position.y = 1.0 + Math.sin(t * 2 + chG.position.x) * 0.1;
            m.rotation.y = t * 1.5;
          } else {
            m.visible = false;
          }
        });
      }
    } else {
      // Classic round-based mode
      game.timeLeft -= dt;
      if (game.timeLeft <= 0) endRound('T');
      updatePlayer(dt);
      for (const b of bots) b.update(dt);
      updateWeapon(dt);
      updateEffects(dt);
      updateHud(dt);
    }
  } else if (game.state === 'roundEnd' && (isTouchDevice || locked)) {
    game.endTimer -= dt;
    updateEffects(dt);
    updateHud(dt);
    if (game.endTimer <= 0 && !isOnline) startRound();
  } else if (game.state === 'menu') {
    // Slow fly-over behind the menu
    const t = performance.now() * 0.00005;
    camera.position.set(Math.sin(t) * 40, 20, Math.cos(t) * 40);
    camera.lookAt(0, 0, 0);
  }

  // Shadow map throttle: adaptive — every 3rd frame at full quality, every 5th when struggling.
  _shadowFrame = (_shadowFrame + 1) % _shadowThrottle;
  if (_shadowFrame === 0) renderer.shadowMap.needsUpdate = true;

  // Track FPS for adaptive quality scaling
  trackFPS(dt);

  renderer.clear();
  renderer.render(scene, camera);
  renderer.clearDepth();
  if (game.state !== 'menu') renderer.render(weaponScene, weaponCam);
}

frame();

// ════════════════════════════════════════════════════════════
//  ONLINE MULTIPLAYER MODE
//  Hub-authoritative co-op: RaceHub steps every terrorist and validates every bullet, and this
//  cabinet draws the world it streams. State declarations live above the render loop.
// ════════════════════════════════════════════════════════════

// ── Shared rig resources ──
// One geometry cache and two material sets serve every figure on screen. The previous class built
// fresh boxes per instance and then disposed the module-level materials when a player left, which
// stripped the skin off every figure still standing — so nothing below is owned by a single rig
// except its two label canvases and its flash quads.
const rigGeo = new Map();
function boxG(w, h, d) {
  const k = `b${w},${h},${d}`;
  let g = rigGeo.get(k);
  if (!g) rigGeo.set(k, (g = new THREE.BoxGeometry(w, h, d)));
  return g;
}
function cylG(r, h, seg) {
  const k = `c${r},${h},${seg}`;
  let g = rigGeo.get(k);
  if (!g) rigGeo.set(k, (g = new THREE.CylinderGeometry(r, r, h, seg)));
  return g;
}

const mkMat = (color, roughness = 0.9, metalness = 0) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness });

// Counter-Terrorist kit: pale fatigues, dark armour plate, helmet with a goggle band.
const ctMats = {
  skin: mkMat(0xd8d8d8),
  cloth: mkMat(0xe8e8e8),
  pants: mkMat(0x9a9a9e),
  armour: mkMat(0x5a5a5e, 0.8),
  head: mkMat(0x3a3a3e, 0.7),
  gear: mkMat(0x2a2a2e, 0.85),
  rubber: mkMat(0x191920, 0.6, 0.3),
  glove: mkMat(0x2a2a2e),
  gun: mkMat(0x1a1a1a, 0.4, 0.6),
  pale: mkMat(0xf2f2f2),
};
// Terrorist kit: the same greyscale a step darker, soft cap and a pale face wrap. The two teams
// read apart by tone and silhouette, never by hue — the house rule for this cabinet.
const tMats = {
  skin: mkMat(0xc2c2c2),
  cloth: mkMat(0x7e7e82),
  pants: mkMat(0x6c6c70),
  armour: mkMat(0x505054, 0.85),
  head: mkMat(0x3c3c40),
  gear: mkMat(0x4a4a4e),
  rubber: mkMat(0x1c1c22, 0.6, 0.3),
  glove: mkMat(0x8e8e92),
  gun: mkMat(0x242428, 0.45, 0.55),
  pale: mkMat(0xd6d6d6),
};

// ── Articulated figure ──
// Drives teammates and hub-owned terrorists from the same rig. Joints are real groups (hip → knee
// → ankle, shoulder → elbow → hand), so the walk cycle, the crouch, the aim pitch and the death
// fall are skeletal rather than a single box tipping over.
class FigureRig {
  constructor(id, name, team, heading = 0) {
    this.id = String(id);
    this.name = name || 'Operator';
    this.team = team === 'T' ? 'T' : 'CT';
    const M = this.M = this.team === 'T' ? tMats : ctMats;

    // Rendered state. Everything here is eased toward the interpolated snapshot target in drive().
    this.pos = new THREE.Vector3();
    this.prev = new THREE.Vector3();
    this.strafe = 0;      // body-space lateral velocity, used for lean
    this.heading = heading;
    this.pitch = 0;
    this.speed = 0;
    this.walk = Math.random() * 6.283;
    this.breath = Math.random() * 6.283;
    this.crouchAmt = 0;
    this.airAmt = 0;
    this.lean = 0;
    this.kick = 0;
    this.flash = 0;
    this.muzzle = 0;
    this.health = 100;
    this.alive = true;
    this.deathT = -1;
    this.alert = false;
    this.weaponKey = 'rifle';

    const root = this.root = new THREE.Group();
    const body = this.body = new THREE.Group(); // tips over as a whole on death
    root.add(body);

    const add = (parent, geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, shadow = true) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      m.castShadow = shadow;
      parent.add(m);
      return m;
    };
    const joint = (parent, x, y, z) => {
      const g = new THREE.Group();
      g.position.set(x, y, z);
      parent.add(g);
      return g;
    };

    // ── Pelvis and legs ──
    const pelvis = this.pelvis = joint(body, 0, 0.92, 0);
    add(pelvis, boxG(0.4, 0.22, 0.26), M.pants, 0, -0.02, 0);
    add(pelvis, boxG(0.44, 0.07, 0.3), M.rubber, 0, 0.09, 0);                 // belt
    add(pelvis, boxG(0.09, 0.06, 0.04), M.pale, 0, 0.09, 0.15, 0, 0, 0, false); // buckle

    this.hip = []; this.knee = []; this.ankle = [];
    for (const side of [-1, 1]) {
      const hip = joint(pelvis, 0.115 * side, -0.08, 0);
      add(hip, boxG(0.19, 0.42, 0.22), M.pants, 0, -0.21, 0);
      add(hip, boxG(0.06, 0.13, 0.1), M.gear, 0.085 * side, -0.2, 0.06, 0, 0, 0, false); // cargo pocket
      const knee = joint(hip, 0, -0.42, 0);
      add(knee, boxG(0.175, 0.4, 0.2), M.pants, 0, -0.2, 0);
      add(knee, boxG(0.15, 0.12, 0.06), M.rubber, 0, 0.02, 0.1, 0, 0, 0, false); // pad
      const ankle = joint(knee, 0, -0.4, 0);
      add(ankle, boxG(0.19, 0.14, 0.22), M.rubber, 0, -0.04, 0.02);
      add(ankle, boxG(0.2, 0.05, 0.3), M.gear, 0, -0.12, 0.05);               // sole
      add(ankle, boxG(0.15, 0.07, 0.06), M.rubber, 0, -0.07, 0.16, 0, 0, 0, false); // toe cap
      this.hip.push(hip); this.knee.push(knee); this.ankle.push(ankle);
    }

    // ── Upper body: carries the aim pitch ──
    const upper = this.upper = joint(body, 0, 0.92, 0);
    add(upper, boxG(0.46, 0.5, 0.28), M.cloth, 0, 0.26, 0);        // chest
    add(upper, boxG(0.36, 0.3, 0.24), M.cloth, 0, -0.05, 0);       // abdomen
    add(upper, boxG(0.5, 0.42, 0.09), M.armour, 0, 0.28, 0.16);    // plate carrier
    add(upper, boxG(0.5, 0.42, 0.09), M.armour, 0, 0.28, -0.16);   // back plate
    add(upper, boxG(0.1, 0.09, 0.3), M.armour, 0.17, 0.5, 0);      // straps
    add(upper, boxG(0.1, 0.09, 0.3), M.armour, -0.17, 0.5, 0);
    add(upper, boxG(0.34, 0.08, 0.2), M.gear, 0, 0.53, 0);         // collar
    add(upper, boxG(0.13, 0.14, 0.08), M.gear, 0.1, 0.15, 0.21, 0, 0, 0, false);
    add(upper, boxG(0.13, 0.14, 0.08), M.gear, -0.05, 0.15, 0.21, 0, 0, 0, false);
    add(upper, boxG(0.1, 0.16, 0.1), M.gear, 0.26, 0.3, 0.02);     // side pouch
    add(upper, boxG(0.11, 0.19, 0.07), M.rubber, -0.22, 0.34, -0.19, 0.1); // radio
    add(upper, boxG(0.02, 0.16, 0.02), M.rubber, -0.24, 0.5, -0.2, 0.15, 0, 0.1, false); // antenna
    add(upper, boxG(0.2, 0.05, 0.05), M.pale, 0, 0.46, 0.16, 0, 0, 0, false);  // ID tape

    // ── Head ──
    const neck = joint(upper, 0, 0.56, 0);
    add(neck, boxG(0.13, 0.1, 0.13), M.skin, 0, 0.02, 0);
    const head = this.head = joint(neck, 0, 0.07, 0);
    add(head, boxG(0.25, 0.29, 0.27), M.skin, 0, 0.15, 0);         // skull
    add(head, boxG(0.19, 0.1, 0.21), M.skin, 0, 0.02, 0.02);       // jaw
    add(head, boxG(0.05, 0.06, 0.05), M.skin, 0, 0.14, 0.15, 0, 0, 0, false);
    add(head, boxG(0.04, 0.07, 0.05), M.skin, 0.14, 0.15, -0.02, 0, 0, 0, false);
    add(head, boxG(0.04, 0.07, 0.05), M.skin, -0.14, 0.15, -0.02, 0, 0, 0, false);
    if (this.team === 'CT') {
      add(head, boxG(0.29, 0.15, 0.31), M.head, 0, 0.31, 0);           // helmet dome
      add(head, boxG(0.31, 0.04, 0.33), M.head, 0, 0.22, 0, 0, 0, 0, false); // rim
      add(head, boxG(0.2, 0.11, 0.09), M.head, 0, 0.24, -0.16);         // nape guard
      add(head, boxG(0.24, 0.05, 0.03), M.gear, 0, 0.34, 0.16, 0, 0, 0, false); // goggle band
      add(head, boxG(0.17, 0.12, 0.05), M.rubber, 0, 0.05, 0.14, 0, 0, 0, false); // half mask
      add(head, boxG(0.05, 0.09, 0.03), M.gear, 0.13, 0.12, 0.1, 0, 0, 0, false);  // strap
    } else {
      add(head, boxG(0.28, 0.12, 0.3), M.head, 0, 0.3, 0);              // soft cap
      add(head, boxG(0.29, 0.04, 0.11), M.head, 0, 0.25, 0.17, 0.2, 0, 0, false); // peak
      add(head, boxG(0.26, 0.19, 0.28), M.pale, 0, 0.1, 0.01, 0, 0, 0, false);    // face wrap
      add(head, boxG(0.24, 0.05, 0.03), M.rubber, 0, 0.2, 0.15, 0, 0, 0, false);  // goggles
      add(head, boxG(0.09, 0.16, 0.09), M.gear, 0.02, 0.16, -0.17);              // sling knot
    }

    // ── Arms ──
    this.shoulder = []; this.elbow = []; this.handL = null;
    for (const side of [-1, 1]) {
      const sh = joint(upper, 0.27 * side, 0.47, 0);
      add(sh, boxG(0.14, 0.3, 0.15), M.cloth, 0, -0.15, 0);
      add(sh, boxG(0.155, 0.09, 0.11), M.rubber, 0, -0.02, 0.06, 0, 0, 0, false);
      const el = joint(sh, 0, -0.3, 0);
      add(el, boxG(0.12, 0.28, 0.13), M.cloth, 0, -0.14, 0);
      add(el, boxG(0.13, 0.09, 0.07), M.rubber, 0, 0.01, 0.06, 0, 0, 0, false);
      const hd = joint(el, 0, -0.28, 0);
      add(hd, boxG(0.11, 0.12, 0.13), M.glove, 0, -0.05, 0.01);
      this.shoulder.push(sh); this.elbow.push(el);
      if (side < 0) this.handL = hd; else this.handR = hd;
    }
    // Fighting stance: both hands brought onto the weapon.
    this.baseArm = { shoulder: [-1.15, -0.95], elbow: [-0.75, -1.15] };
    this.shoulder[0].rotation.x = this.baseArm.shoulder[0];
    this.shoulder[1].rotation.x = this.baseArm.shoulder[1];
    this.elbow[0].rotation.x = this.baseArm.elbow[0];
    this.elbow[1].rotation.x = this.baseArm.elbow[1];
    this.shoulder[0].rotation.z = 0.18;
    this.shoulder[1].rotation.z = -0.18;

    // ── Weapon ──
    const gun = this.gun = joint(upper, 0.07, 0.29, 0.26);
    this.guns = { rifle: this.buildRifle(gun, M), pistol: this.buildPistol(gun, M) };
    this.guns.pistol.visible = false;
    this.muzzlePoint = new THREE.Vector3(0, 0.02, -0.86);

    // Muzzle flash — two crossed additive quads, owned by this figure.
    const flashMat = this.flashMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const mf = this.muzzleFlash = new THREE.Group();
    mf.add(new THREE.Mesh(boxG(0.26, 0.26, 0.001), flashMat));
    const mf2 = new THREE.Mesh(boxG(0.07, 0.34, 0.001), flashMat);
    mf2.rotation.z = Math.PI / 2; mf.add(mf2);
    mf.position.copy(this.muzzlePoint);
    mf.visible = false;
    gun.add(mf);

    // Hit feedback — a slightly oversized shell that glows, so no shared material is ever tinted.
    const glowMat = this.glowMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const shell = this.shell = new THREE.Group();
    shell.add(new THREE.Mesh(boxG(0.54, 0.9, 0.36), glowMat)).children.at(-1).position.y = 0.2;
    shell.add(new THREE.Mesh(boxG(0.33, 0.4, 0.35), glowMat)).children.at(-1).position.y = 1.72;
    shell.visible = false;
    body.add(shell);

    // Alert pip — terrorists get a marker the instant the hub flags them as engaged.
    if (this.team === 'T') {
      this.pip = new THREE.Mesh(boxG(0.06, 0.16, 0.02), glowMat);
      this.pip.position.set(0, 2.2, 0);
      this.pip.visible = false;
      root.add(this.pip);
    }

    // ── Labels ──
    this.nameTag = this.makeLabel(name || 'Operator', 'name');
    this.nameTag.position.set(0, 2.44, 0);
    root.add(this.nameTag);
    this.healthBar = this.makeLabel('', 'health');
    this.healthBar.position.set(0, 2.26, 0);
    root.add(this.healthBar);

    root.position.copy(this.pos);
    root.rotation.y = heading;
    scene.add(root);
  }

  buildRifle(parent, M) {
    const g = new THREE.Group();
    const put = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z); m.rotation.set(rx, ry, rz); m.castShadow = true; g.add(m); return m;
    };
    put(boxG(0.07, 0.11, 0.52), M.gun, 0, 0, -0.1);            // receiver
    put(boxG(0.075, 0.05, 0.2), M.gear, 0, 0.075, -0.14, 0, 0, 0); // rail
    put(boxG(0.06, 0.075, 0.24), M.gear, 0, -0.005, -0.42);    // handguard
    const barrel = put(cylG(0.014, 0.3, 8), M.gun, 0, 0.01, -0.66, Math.PI / 2);
    barrel.castShadow = false;
    put(boxG(0.04, 0.05, 0.05), M.gun, 0, 0.005, -0.83);       // muzzle brake
    put(boxG(0.02, 0.045, 0.02), M.gun, 0, 0.06, -0.55, 0, 0, 0, false); // front post
    put(boxG(0.02, 0.04, 0.02), M.gun, 0, 0.06, -0.05, 0, 0, 0, false);  // rear sight
    put(boxG(0.055, 0.2, 0.07), M.gear, 0, -0.14, 0.12, -0.2); // grip
    put(boxG(0.07, 0.24, 0.09), M.gear, 0, -0.15, -0.2, 0.35); // mag (raked)
    put(boxG(0.05, 0.09, 0.22), M.gear, 0, -0.01, 0.28);       // stock
    put(boxG(0.045, 0.13, 0.03), M.gun, 0, -0.06, -0.3, 0, 0, 0, false); // sling
    parent.add(g);
    return g;
  }

  buildPistol(parent, M) {
    const g = new THREE.Group();
    const put = (geo, mat, x, y, z, rx = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z); m.rotation.x = rx; m.castShadow = true; g.add(m); return m;
    };
    put(boxG(0.05, 0.06, 0.22), M.gun, 0, 0.01, -0.06);
    put(boxG(0.045, 0.15, 0.055), M.gear, 0, -0.07, 0.02, -0.22);
    put(boxG(0.04, 0.02, 0.14), M.gun, 0, -0.02, -0.08);
    put(boxG(0.015, 0.035, 0.015), M.gun, 0, 0.05, -0.15, 0);
    g.position.z += 0.1;
    parent.add(g);
    return g;
  }

  makeLabel(text, kind) {
    const canvas = document.createElement('canvas');
    canvas.width = kind === 'name' ? 256 : 128;
    canvas.height = kind === 'name' ? 64 : 16;
    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false,
    }));
    sprite.scale.set(kind === 'name' ? 1.9 : 1.15, kind === 'name' ? 0.44 : 0.14, 1);
    sprite.renderOrder = 4;
    sprite.userData = { canvas, tex, kind };
    if (kind === 'name') this.paintName(sprite, text);
    else this.paintHealth(sprite, this.health);
    return sprite;
  }

  paintName(sprite, text) {
    const c = sprite.userData.canvas, x = c.getContext('2d');
    x.clearRect(0, 0, c.width, c.height);
    x.fillStyle = 'rgba(14,14,16,0.72)';
    x.fillRect(0, 0, c.width, c.height);
    x.strokeStyle = 'rgba(240,240,242,0.22)';
    x.lineWidth = 3; x.strokeRect(2, 2, c.width - 4, c.height - 4);
    x.fillStyle = '#f0f0f2';
    x.font = 'bold 26px -apple-system, sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(String(text).slice(0, 16), c.width / 2, c.height / 2 + 1);
    sprite.userData.tex.needsUpdate = true;
  }

  // Greyscale health bar — brightness carries the state, never hue.
  paintHealth(sprite, hp) {
    const c = sprite.userData.canvas, x = c.getContext('2d');
    const pct = Math.max(0, Math.min(1, hp / 100));
    x.clearRect(0, 0, c.width, c.height);
    x.fillStyle = 'rgba(10,10,12,0.72)';
    x.fillRect(0, 0, c.width, c.height);
    const tone = Math.round(120 + 130 * pct);
    x.fillStyle = `rgb(${tone},${tone},${tone})`;
    x.fillRect(2, 2, (c.width - 4) * pct, c.height - 4);
    x.fillStyle = 'rgba(240,240,242,0.55)';
    for (let i = 1; i < 4; i++) x.fillRect((c.width / 4) * i, 0, 1, c.height);
    sprite.userData.tex.needsUpdate = true;
  }

  setWeapon(key) {
    if (key === this.weaponKey || !this.guns[key]) return;
    this.weaponKey = key;
    this.guns.rifle.visible = key === 'rifle';
    this.guns.pistol.visible = key === 'pistol';
    // The flash has to sit on the barrel that is actually in hand, not where the rifle ends.
    this.muzzleFlash.position.set(0, key === 'rifle' ? 0.02 : 0.05, key === 'rifle' ? -0.86 : -0.2);
  }

  // ── Per-frame pose. `t` is the interpolated hub state for this figure. ──
  drive(t, dt) {
    // Ground the figure on the interpolated position, then measure real velocity for lean.
    this.prev.copy(this.pos);
    this.pos.set(t.x, t.y, t.z);
    this.root.position.copy(this.pos);

    let diff = t.heading - this.heading;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    this.heading += diff * Math.min(1, dt * 16);
    this.body.rotation.y = 0;
    this.root.rotation.y = this.heading;
    if (this.prev.x === 0 && this.prev.z === 0 && t.x === 0 && t.z === 0) this.prev.copy(this.pos);

    this.speed = t.speed;
    this.pitch += (clamp(t.pitch || 0, -1.4, 1.4) - this.pitch) * Math.min(1, dt * 12);
    const wantCrouch = t.crouching ? 1 : 0;
    this.crouchAmt += (wantCrouch - this.crouchAmt) * Math.min(1, dt * 9);
    const wantAir = t.onGround === false ? 1 : 0;
    this.airAmt += (wantAir - this.airAmt) * Math.min(1, dt * 10);
    if (t.alert !== undefined) this.alert = t.alert;
    if (t.weapon) this.setWeapon(t.weapon);
    if (t.health !== undefined && Math.abs(t.health - this.health) > 0.5) {
      this.health = t.health;
      this.paintHealth(this.healthBar, this.health);
    }

    // Body-space lateral speed → bank into a strafe, so turning to run reads as weight shifting.
    const vx = (this.pos.x - this.prev.x) / Math.max(dt, 1e-3);
    const vz = (this.pos.z - this.prev.z) / Math.max(dt, 1e-3);
    const cos = Math.cos(this.heading), sin = Math.sin(this.heading);
    const side = vx * cos - vz * sin;   // +Z-facing model: right is +X after the yaw
    this.strafe += (side - this.strafe) * Math.min(1, dt * 8);
    this.lean += (clamp(-this.strafe * 0.02, -0.16, 0.16) - this.lean) * Math.min(1, dt * 8);

    this.breath += dt * 1.9;
    this.walk += dt * (this.speed * 3.2 + 0.6); // keeps a live idle cadence even when standing
    this.kick = Math.max(0, this.kick - dt * 5.5);
    this.flash = Math.max(0, this.flash - dt * 4.5);
    this.muzzle = Math.max(0, this.muzzle - dt * 14);

    // A falling figure poses itself and fades its own label; the distance-based label pass below
    // would otherwise stomp that fade back to invisible on the same frame.
    if (this.deathT >= 0) { this.poseDeath(dt); return; }

    const moving = clamp((this.speed - 0.4) / 5, 0, 1);
    const w = this.walk;
    const s = Math.sin(w), s2 = Math.sin(w * 2);
    const amp = 0.55 * moving;

    // Legs: thighs swing from the hip, shins only fold backwards, ankles keep the foot level.
    for (let i = 0; i < 2; i++) {
      const dir = i === 0 ? 1 : -1;
      const hipBend = dir * s * amp;
      const fold = Math.max(0, -dir * Math.cos(w)) * 1.15 * moving;
      this.hip[i].rotation.x = hipBend - this.crouchAmt * 0.85 + this.airAmt * -0.55;
      this.knee[i].rotation.x = fold + this.crouchAmt * 1.5 + this.airAmt * 0.95;
      this.ankle[i].rotation.x = -fold * 0.55 - hipBend * 0.3 - this.airAmt * 0.3;
      this.hip[i].rotation.z = dir * 0.03 * moving;
    }

    // Pelvis: stride lift, crouch drop, and the small counter-roll of a walking torso.
    this.pelvis.position.y = 0.92
      - this.crouchAmt * 0.26
      + Math.abs(Math.cos(w)) * 0.035 * moving
      + Math.sin(this.breath) * 0.008;
    this.body.rotation.z = this.lean + s * 0.022 * moving;
    this.upper.rotation.z = -this.lean * 0.55 - s * 0.03 * moving;
    this.upper.rotation.y = -s * 0.09 * moving;

    // Aim: the whole upper body pitches with the head taking half the angle, exactly like a
    // real rifle carriage — this is what makes a remote player "live" instead of a flat prop.
    this.upper.rotation.x = -this.pitch * 0.75 - this.crouchAmt * 0.22 + this.kick * 0.16;
    this.head.rotation.x = -this.pitch * 0.35 + Math.sin(this.breath * 0.7) * 0.02;
    this.head.rotation.y = Math.sin(this.breath * 0.45) * 0.05;

    // Arms: base stance plus stride counter-swing, recoil punch and a reload dip.
    const swing = s * 0.11 * moving;
    for (let i = 0; i < 2; i++) {
      const rel = i === 0 ? -1 : 1;
      this.shoulder[i].rotation.x = this.baseArm.shoulder[i] + rel * swing - this.pitch * 0.12 + this.kick * 0.28;
      this.elbow[i].rotation.x = this.baseArm.elbow[i] + this.kick * 0.5;
    }
    this.handR.rotation.x = -this.kick * 0.3;

    // Weapon: sinks with the stance, jerks back and up on every fired round.
    this.gun.position.set(0.07, 0.29 - this.crouchAmt * 0.04 + this.kick * 0.02, 0.26 + this.kick * 0.07);
    this.gun.rotation.x = -this.pitch * 0.22 + this.kick * 0.42;
    this.gun.rotation.z = Math.sin(this.breath) * 0.012 + this.lean * 0.3;

    // Muzzle flash and hit glow
    this.muzzleFlash.visible = this.muzzle > 0;
    if (this.muzzleFlash.visible) {
      this.flashMat.opacity = Math.min(1, this.muzzle * 1.4);
      const sc = 0.7 + Math.random() * 0.6;
      this.muzzleFlash.scale.set(sc, sc, 1);
      this.muzzleFlash.rotation.z = Math.random() * Math.PI;
    } else {
      this.flashMat.opacity = 0;
    }
    this.shell.visible = this.flash > 0 || !!this.alert;
    if (this.shell.visible) this.glowMat.opacity = Math.min(0.5, this.flash * 0.5 + (this.alert ? 0.06 : 0));
    if (this.pip) this.pip.visible = this.alert ? Math.sin(performance.now() * 0.012) > -0.3 : false;

    this.updateLabels(dt);
  }

  poseDeath(dt) {
    this.deathT += dt;
    const k = Math.min(1, this.deathT * 2.6);
    const eased = 1 - Math.pow(1 - k, 2);
    this.body.rotation.x = -eased * Math.PI / 2;
    this.body.position.y = eased * 0.16;
    this.root.position.y = this.pos.y + 0.02;
    for (let i = 0; i < 2; i++) {
      this.hip[i].rotation.x = (i === 0 ? 0.5 : -0.35) * eased;
      this.knee[i].rotation.x = (i === 0 ? 1.1 : 0.4) * eased;
      this.shoulder[i].rotation.x = this.baseArm.shoulder[i] * (1 - eased) - 0.5 * eased;
      this.elbow[i].rotation.x = this.baseArm.elbow[i] * (1 - eased);
    }
    this.upper.rotation.x = 0.2 * eased;
    this.gun.rotation.x = -0.9 * eased;
    this.muzzleFlash.visible = false;
    this.shell.visible = false;
    if (this.pip) this.pip.visible = false;
    // Face plant: fade the labels rather than yank the model out of the world.
    const o = 1 - Math.min(1, Math.max(0, (this.deathT - 1.6) / 1.2));
    this.nameTag.material.opacity = o * 0.55;
    this.healthBar.material.opacity = 0;
    this.root.rotation.y = this.heading;
  }

  updateLabels(dt) {
    // Sprites already face the camera; the only work left is scaling them down with distance so a
    // teammate 60 m away does not cover the screen, and hiding them once they are out of the fight.
    const d = camera.position.distanceTo(this.pos);
    const sc = clamp(d / 26, 0.7, 2.1);
    this.nameTag.scale.set(1.9 * sc, 0.44 * sc, 1);
    this.healthBar.scale.set(1.15 * sc, 0.14 * sc, 1);
    const show = this.alive && d < 130;
    this.nameTag.visible = show;
    this.healthBar.visible = show && this.health < 100;
    this.nameTag.material.opacity = show ? clamp(1.3 - d / 130, 0.25, 1) : 0;
    this.healthBar.material.opacity = this.healthBar.visible ? 1 : 0;
  }

  // One fired round as seen by everyone else: flash, recoil punch, and a report that fades with
  // distance so the arena has real directionality.
  shot() {
    this.kick = 1;
    this.muzzle = 1;
  }

  hit() { this.flash = 1; }

  kill() {
    if (this.deathT >= 0) return;
    this.alive = false;
    this.health = 0;
    this.paintHealth(this.healthBar, 0);
    this.deathT = 0;
  }

  // A hub round reset resurrects the same id in the same list, so the rig has to come back up
  // rather than be rebuilt — rebuilding would drop the shared materials and pop the camera.
  revive() {
    this.deathT = -1;
    this.alive = true;
    this.health = 100;
    this.paintHealth(this.healthBar, 100);
    this.body.rotation.set(0, 0, 0);
    this.body.position.set(0, 0, 0);
    this.nameTag.material.opacity = 1;
    this.healthBar.material.opacity = 0;
    this.healthBar.visible = false;
  }

  dispose() {
    scene.remove(this.root);
    // Only per-instance resources: the shared geometry and material sets belong to every figure.
    for (const sp of [this.nameTag, this.healthBar]) {
      if (!sp) continue;
      sp.userData.tex.dispose();
      sp.material.dispose();
    }
    this.flashMat.dispose();
    this.glowMat.dispose();
  }
}

// ── Online Snapshot Handling ──
//
// The hub streams one world every 100 ms. Snapshots go into a short back-buffer and the frame is
// drawn from a point about one tick behind "now", blending the two real states that straddle it.
// That is what turns a 10 Hz staircase into continuous motion: the old code chased a single target
// with an exponential filter, which smoothed the error but never knew how far behind it was — so
// figures crept after they had stopped and slid when they started.
function applySnapshot(snapshot) {
  if (!snapshot || !isOnline) return;
  lastSnapshot = snapshot;
  snapshotBuffer.push({ at: performance.now(), data: snapshot });
  while (snapshotBuffer.length > BUFFER_CAP) snapshotBuffer.shift();
  syncOnlineHud(snapshot);
}

function syncOnlineHud(snapshot) {
  const prevCT = game.ct, prevT = game.t;
  const roundChanged = snapshot.round !== game.round;
  const wasEnd = game.state === 'roundEnd';

  game.round = snapshot.round;
  game.timeLeft = snapshot.timeLeft;
  game.state = snapshot.state;
  game.ct = snapshot.scoreCT;
  game.t = snapshot.scoreT;

  hud.round.textContent = game.round;
  hud.scoreCT.textContent = game.ct;
  hud.scoreT.textContent = game.t;
  hud.enemies.textContent = (snapshot.bots || []).filter((b) => b.alive).length;
  const secs = Math.max(0, Math.ceil(game.timeLeft));
  hud.timer.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

  // Round narration is driven by the shared state, so all four cabinets hear it at once.
  if (snapshot.state === 'playing' && (roundChanged || wasEnd)) {
    const n = (snapshot.bots || []).filter((b) => b.alive).length;
    centerMsg(`ROUND ${game.round}`, `${n} terrorists. Eliminate them all.`);
  } else if (snapshot.state === 'roundEnd' && !wasEnd) {
    const ctWon = game.ct > prevCT;
    centerMsg(ctWon ? '<span style="color:#f0f0f2">COUNTER-TERRORISTS WIN</span>'
      : '<span style="color:#8888a0">TERRORISTS WIN</span>',
      ctWon ? 'Next round starting…' : "Time's up — next round starting…", 4);
  }
}

// The wire carries each sender's own heading convention: a cabinet reports its camera yaw (an
// angle for something facing -Z), the hub reports bot headings as atan2(dx, dz) (facing +Z). Our
// figures are built facing +Z, so a human yaw needs the half turn added.
function headingOf(row, isHuman) { return row.yaw + (isHuman ? Math.PI : 0); }

function blendAngle(a, b, u) {
  let d = b - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return a + d * u;
}

function blendRow(a, b, u, isHuman) {
  const pick = (x, y) => (u > 0.5 ? y : x); // discrete state flips at the midpoint of the blend
  return {
    x: a.pos.x + (b.pos.x - a.pos.x) * u,
    y: a.pos.y + (b.pos.y - a.pos.y) * u,
    z: a.pos.z + (b.pos.z - a.pos.z) * u,
    heading: blendAngle(headingOf(a, isHuman), headingOf(b, isHuman), u),
    pitch: a.pitch !== undefined && b.pitch !== undefined
      ? a.pitch + (b.pitch - a.pitch) * u
      : (b.pitch || 0),
    speed: b.speed || 0,
    crouching: pick(!!a.crouching, !!b.crouching),
    onGround: pick(a.onGround !== false, b.onGround !== false),
    health: b.health,
    weapon: pick(a.weapon, b.weapon),
    alert: pick(!!a.alert, !!b.alert),
    alive: !!b.alive,
  };
}

function indexRows(rows) {
  const m = new Map();
  for (const r of rows || []) m.set(String(r.id), r);
  return m;
}

function blendRigs(store, rowsA, rowsB, u, dt, team, isHuman) {
  const A = indexRows(rowsA), B = indexRows(rowsB);
  const mine = String((typeof CSNet !== 'undefined' && CSNet.myId) || '');
  const seen = new Set();
  for (const [id, rb] of B) {
    if (isHuman && id === mine) continue; // first person: your own body is not drawn
    seen.add(id);
    const ra = A.get(id) || rb;
    let rig = store.get(id);
    if (!rig) {
      rig = new FigureRig(id, rb.name || (team === 'T' ? 'Terrorist' : 'Operator'), team, headingOf(rb, isHuman));
      rig.pos.set(rb.pos.x, rb.pos.y || 0, rb.pos.z);
      rig.prev.copy(rig.pos);
      rig.walk = rb.walkPhase || 0;
      store.set(id, rig);
    }
    rig.drive(blendRow(ra, rb, u, isHuman), dt);
    if (!rb.alive && rig.deathT < 0) rig.kill();
    else if (rb.alive && rig.deathT >= 0) rig.revive();
  }
  for (const [id, rig] of store) {
    if (seen.has(id)) continue;
    rig.dispose();
    store.delete(id);
  }
}

// The hub's row for me is the authority on whether I am still standing — bot fire is validated
// server-side, so my local health has to follow it and never the other way round.
function driveOwn(snapshot) {
  const mine = String((typeof CSNet !== 'undefined' && CSNet.myId) || '');
  const rows = snapshot && snapshot.players;
  const me = (rows || []).find((r) => String(r.id) === mine);
  if (!me) return;
  myRow = me;

  game.kills = me.kills || 0;
  hud.kills.textContent = game.kills;

  const drop = player.health - (me.health === undefined ? player.health : me.health);
  if (drop > 0.5 && player.alive) {
    damageFlash = Math.min(1, damageFlash + 0.45);
    hud.healthBox.classList.toggle('low', me.health <= 25);
  }
  player.health = me.health === undefined ? player.health : me.health;
  hud.health.textContent = Math.ceil(Math.max(0, player.health));

  // Frame to frame the cabinet owns its own movement, so the echo is only used to correct a real
  // disagreement — snapping to every 10 Hz packet would rubber-band local movement.
  const b = mapBounds();
  if (player.alive && Math.hypot(player.pos.x - me.pos.x, player.pos.z - me.pos.z) > 3) {
    player.pos.x = clamp(me.pos.x, b.xMin + 1.2, b.xMax - 1.2);
    player.pos.z = clamp(me.pos.z, -(b.halfD) + 1.2, b.halfD - 1.2);
    player.pos.y = me.pos.y || 0;
    player.vel.set(0, 0, 0);
  }

  // The hub re-spawns every player at the top of a round, so the row suddenly carries a different
  // spot. A cabinet that only followed the alive flag — a teammate who survived the round never saw
  // one flip — would go on standing where the last round left them, and their next packet would
  // then push that stale position back over the hub's reset: everyone else watches a figure appear
  // at one spawn and hop to another. Tracking the round number takes the new spawn, full health and
  // fresh mags on the same beat as the hub, which is what solo startRound() does locally.
  const newRound = snapshot.round !== undefined && snapshot.round !== resetSeenRound;
  if (snapshot.round !== undefined) resetSeenRound = snapshot.round;

  if (!me.alive && player.alive) {
    player.alive = false;
    player.health = 0;
    centerMsg('YOU ARE DOWN', 'Spectating until the round ends', 4);
  } else if (me.alive && (newRound || !player.alive)) {
    // New round: take the hub's fresh spawn instead of standing on the last round's spot.
    resetPlayer();
    player.pos.set(clamp(me.pos.x, b.xMin + 1.2, b.xMax - 1.2), me.pos.y || 0, clamp(me.pos.z, -(b.halfD) + 1.2, b.halfD - 1.2));
    player.yaw = me.yaw || Math.PI;
    player.pitch = 0;
    camera.position.set(player.pos.x, player.pos.y + player.eye, player.pos.z);
  }
}

function updateOnlinePlayers(dt) {
  if (!snapshotBuffer.length) return;
  const rt = performance.now() - INTERP_DELAY;

  // Play the effects of every snapshot the render point has now passed, each exactly once, so
  // tracers and muzzle flashes land with the motion they belong to instead of a tick early.
  for (const s of snapshotBuffer) {
    if (s.at <= fxWatermark || s.at > rt) continue;
    emitFx(s.data.fx);
    fxWatermark = s.at;
  }

  let a = null, b = null;
  for (let i = 0; i < snapshotBuffer.length - 1; i++) {
    if (snapshotBuffer[i].at <= rt && snapshotBuffer[i + 1].at >= rt) {
      a = snapshotBuffer[i]; b = snapshotBuffer[i + 1]; break;
    }
  }
  if (!a) {
    // Starved (tab throttled, packet loss, first frames of the match): hold on the newest state
    // rather than extrapolating an invented one.
    b = snapshotBuffer[snapshotBuffer.length - 1];
    a = b;
  }
  // A round boundary is not a motion step: the frame before it holds last round's spawn points and
  // last round's bot ids. Interpolating across it draws a teammate gliding tens of metres through
  // the map to their new spawn, and a smooth glide from a place nobody is standing in is what reads
  // as heavy buffering. Snap onto the new round and ease normally from the next tick, inside it.
  if (a.data.round !== b.data.round) a = b;
  while (snapshotBuffer.length > 3 && snapshotBuffer[1].at < rt) snapshotBuffer.shift();

  const u = a === b ? 1 : clamp((rt - a.at) / Math.max(1, b.at - a.at), 0, 1);
  blendRigs(onlinePlayers, a.data.players, b.data.players, u, dt, 'CT', true);
  blendRigs(onlineBots, a.data.bots, b.data.bots, u, dt, 'T', false);
  driveOwn(b.data);
}

function figureFor(id) {
  const key = String(id);
  return onlinePlayers.get(key) || onlineBots.get(key) || null;
}

function nameFor(id) {
  if (!id) return 'Terrorist';
  const key = String(id);
  if (typeof CSNet !== 'undefined' && key === String(CSNet.myId)) return 'You';
  const rig = figureFor(key);
  if (rig) return rig.name;
  const row = (lastSnapshot && (lastSnapshot.players || []).concat(lastSnapshot.bots || []) || [])
    .find((r) => String(r.id) === key);
  return (row && row.name) || 'Operator';
}

// One-shot world events from the hub, replayed on every cabinet so the fight looks and sounds the
// same to all four players.
function emitFx(list) {
  if (!list || !list.length) return;
  const mine = String((typeof CSNet !== 'undefined' && CSNet.myId) || '');
  for (const ev of list) {
    if (ev.e === 'shot') {
      const byPlayer = ev.by === 'p';
      const rig = figureFor(ev.id);
      if (!rig) continue;
      const o = new THREE.Vector3(ev.o[0], ev.o[1], ev.o[2]);
      const d = new THREE.Vector3(ev.d[0], ev.d[1], ev.d[2]);
      rig.shot();
      const dist = o.distanceTo(camera.position);
      if (String(ev.id) !== mine) playShot(clamp(1.2 - dist / 55, 0.07, 0.75), byPlayer ? 1 : 0.88);
      // Bots get a dedicated tracer event; a player round is extended here to whatever the shared
      // geometry puts in the way, which is why it stops on the wall exactly where it should.
      if (byPlayer && String(ev.id) !== mine) {
        // Visual only, so it may march coarse: 1 m steps to the first volume in the way.
        const wall = CSMap.rayBlock(colliders, o.x, o.y, o.z, d.x, d.y, d.z, 60, 1);
        spawnTracer(o, o.clone().addScaledVector(d, wall ? wall.dist : 60));
      }
    } else if (ev.e === 'tracer') {
      const rig = onlineBots.get(String(ev.id));
      if (!rig) continue;
      const from = new THREE.Vector3(rig.pos.x, rig.pos.y + 1.45, rig.pos.z);
      const to = new THREE.Vector3(ev.to[0], ev.to[1], ev.to[2]);
      spawnTracer(from, to, 0xd0d0d0);
      if (!ev.hit) spawnParticles(to, null, dustMat, 3, 1.6);
    } else if (ev.e === 'hit') {
      if (ev.bot !== undefined) {
        // A player round that landed: ev.bot is the victim, so the spark belongs on its body.
        const rig = onlineBots.get(String(ev.bot));
        if (rig) {
          rig.hit();
          const at = new THREE.Vector3(rig.pos.x, rig.pos.y + (ev.part === 'head' ? 1.72 : ev.part === 'legs' ? 0.5 : 1.2), rig.pos.z);
          spawnParticles(at, null, bloodMat, 8, 2);
        }
        if (String(ev.id) === mine) { showHit(ev.killed); playBeep(ev.killed ? 1400 : 1100, 0.04, 0.12); }
      } else {
        const rig = onlinePlayers.get(String(ev.id));
        if (rig) rig.hit();
        if (String(ev.id) === mine) playBeep(120, 0.07, 0.18, 'sawtooth');
      }
    } else if (ev.e === 'kill') {
      const rig = onlineBots.get(String(ev.victim));
      if (rig) rig.kill();
      killFeed(nameFor(ev.by), ev.name || (rig && rig.name) || 'Terrorist', ev.part === 'head', false);
    } else if (ev.e === 'death') {
      const rig = onlinePlayers.get(String(ev.victim));
      if (rig) rig.kill();
      if (String(ev.victim) !== mine) killFeed(nameFor(ev.by), ev.name || 'Operator', false, true);
    }
  }
}

function sendPlayerState() {
  if (!isOnline || typeof CSNet === 'undefined' || !CSNet.connected) return;
  const shoot = mouseDown || (isTouchDevice && touch.fire);
  const reload = keys.KeyR || false;
  // Attach the fired shot's muzzle ray to this packet. The hub ray-marches it against the shared
  // geometry, so teammates' bullets actually hit bots. `shoot` is forced alongside it because the
  // hub only fires on the flag, and a tap released between packets would otherwise be a no-op.
  const ray = pendingRay;
  pendingRay = null;
  CSNet.sendState(
    player.pos,
    player.yaw,
    player.pitch,
    player.speed,
    player.eye < 1.4,
    player.onGround,
    current === inventory.rifle ? 'rifle' : 'pistol',
    reload,
    shoot || !!ray,
    ray
  );
}

// ── Online Mode Initialization ──
// counter-strike-net.js is a classic script that publishes window.CSNet from its own
// DOMContentLoaded handler. A deferred module runs while readyState is still "interactive" — after
// the markup is parsed but before that event — so CSNet genuinely is not there yet when this file
// finishes, and a single call at the bottom of it silently does nothing. Half the multiplayer code
// then lives: the lobby, the room list and the deploy countdown all run inside the net module and
// keep working, while the renderer is deaf because applySnapshot was never installed. The hub's
// shared world is the only source of terrorists and teammates in co-op, so the athlete gets a fully
// playable, completely empty arena and one console line nobody looks for.
function initOnlineMode() {
  if (typeof CSNet !== 'undefined' && CSNet) {
    if (CSNet.onSnapshot === applySnapshot) return; // already wired
    CSNet.onSnapshot = applySnapshot;
    CSNet.onMatchEnd = (rows) => window.endOnlineGame(rows);
    console.log('[CS] Online mode initialized');
    return;
  }
  // net.js queued its own DOMContentLoaded handler while the document was still parsing, so by the
  // time this event fires window.CSNet exists and the queue order is already correct.
  if (document.readyState !== 'complete') {
    document.addEventListener('DOMContentLoaded', initOnlineMode, { once: true });
    return;
  }
  console.warn('[CS] counter-strike-net.js not loaded — multiplayer disabled');
}

// ── Match start ──
// The hub has already built the world on the host's map pick, so every cabinet has to draw that
// same layout before the first snapshot lands — otherwise the shared colliders belong to an arena
// nobody is looking at.
function ensureMap(mapName) {
  const wanted = mapName || (typeof CSNet !== 'undefined' && CSNet.map) || selectedMap;
  const map = wanted === 'classic' ? 'classic' : 'industrial';
  if (map !== selectedMap) {
    selectedMap = map;
    if (typeof CSNet !== 'undefined' && CSNet.setMap) CSNet.setMap(map);
    buildMap();
  } else if (!colliders.length) {
    buildMap();
  }
  return map;
}

function clearOnlineFigures() {
  for (const rig of onlinePlayers.values()) rig.dispose();
  for (const rig of onlineBots.values()) rig.dispose();
  onlinePlayers.clear();
  onlineBots.clear();
  snapshotBuffer.length = 0;
  fxWatermark = 0;
  myRow = null;
}

// Countdown overlay: the four athletes see who is deploying and a shared three-second count before
// the hub opens fire, so nobody is caught standing in the spawn with the round already running.
window.startCountdown = function (ms, roster, mapName) {
  const map = ensureMap(mapName);
  onlineRoster = roster || [];
  clearBots();
  clearOnlineFigures();
  showScreen(gameScreen);

  let el = document.getElementById('csCountdown');
  if (!el) {
    el = document.createElement('div');
    el.id = 'csCountdown';
    el.style.cssText = 'position:fixed;inset:0;z-index:60;display:flex;flex-direction:column;' +
      'align-items:center;justify-content:center;gap:18px;pointer-events:none;' +
      'background:radial-gradient(circle at 50% 45%,rgba(10,10,12,.25),rgba(8,8,10,.82));' +
      'color:#f0f0f2;font:500 14px var(--f,system-ui,sans-serif);letter-spacing:.14em;';
    document.body.appendChild(el);
  }
  el.style.display = 'flex';
  const names = onlineRoster.map((m) => escapeText(m.n || 'Athlete')).join(' · ');
  let left = Math.max(0, Math.round((ms || 3500) / 1000));
  const draw = () => {
    el.innerHTML =
      `<div style="font-size:12px;opacity:.55">DEPLOYING TO ${map.toUpperCase()}</div>` +
      `<div style="font-size:76px;font-weight:700;line-height:1">${left || 'GO'}</div>` +
      `<div style="font-size:13px;opacity:.75">${names || 'Solo run'}</div>` +
      `<div style="font-size:11px;opacity:.45">CO-OP · THE HUB RUNS EVERY BOT AND EVERY BULLET</div>`;
  };
  draw();

  clearInterval(countdownHandle);
  const start = performance.now();
  const span = Math.max(500, ms || 3500);
  countdownHandle = setInterval(() => {
    const next = Math.max(0, Math.ceil((span - (performance.now() - start)) / 1000));
    if (next !== left) { left = next; draw(); }
  }, 100);

  setTimeout(() => {
    clearInterval(countdownHandle);
    countdownHandle = null;
    const live = document.getElementById('csCountdown');
    if (live) live.style.display = 'none';
    window.startOnlineGame(onlineRoster, map);
  }, span);
};

window.startOnlineGame = function (roster, mapName) {
  const map = ensureMap(mapName || (typeof CSNet !== 'undefined' && CSNet.map));
  onlineRoster = roster || onlineRoster || [];
  isOnline = true;
  game.state = 'playing';
  game.round = 0;
  game.ct = 0;
  game.t = 0;
  game.kills = 0;
  game.timeLeft = 130;
  game.endTimer = 0;

  clearBots();          // the hub owns every terrorist from here on
  clearOnlineFigures();
  resetPlayer();
  hud.scoreCT.textContent = '0';
  hud.scoreT.textContent = '0';
  hud.kills.textContent = '0';
  hud.round.textContent = '—';
  hud.enemies.textContent = '0';
  hud.killfeed.innerHTML = '';

  // Nothing from the previous match may blend into this one: a buffer that still holds last game's
  // frames eases every teammate out of where they died rather than starting at the new spawn, and a
  // stale fxWatermark would swallow the first tick's tracers. resetSeenRound goes with them so the
  // first snapshot of this match anchors me to the hub's spawn for round one.
  snapshotBuffer.length = 0;
  fxWatermark = 0;
  resetSeenRound = null;

  showScreen(gameScreen);
  audio().resume();
  // Refused without complaint in every real co-op match: this runs from the countdown's setTimeout,
  // and a pointer-lock request that is not inside a user gesture is denied. Kept because the athlete
  // who clicked the arena moments before the host started does get the capture here; the hint in
  // updateHud covers everyone else.
  if (!isTouchDevice && renderer.domElement.requestPointerLock) {
    renderer.domElement.requestPointerLock();
  }
  syncMouseHint();
  console.log('[CS] Online match started —', map, (roster || []).length, 'players');
};

// Hub results. XP is awarded by the hub for co-op, so this must not report a run locally — that
// would pay the athlete twice.
window.endOnlineGame = function (rows) {
  isOnline = false;
  clearInterval(countdownHandle);
  countdownHandle = null;
  const live = document.getElementById('csCountdown');
  if (live) live.style.display = 'none';
  clearOnlineFigures();
  snapshotBuffer.length = 0;
  resetSeenRound = null;
  if (document.pointerLockElement) document.exitPointerLock();
  game.state = 'gameOver';
  syncMouseHint();   // no updateHud runs once the match is over, so the hint cannot retire itself

  const me = (rows || []).find((r) => String(r.id) === String(typeof CSNet !== 'undefined' ? CSNet.myId : ''));
  goScore.textContent = me ? (me.sc || 0) : game.kills;
  goRound.textContent = lastSnapshot ? (lastSnapshot.round || game.round) : game.round;
  goXP.textContent = me && me.xp ? `+${me.xp} XP` : '--';
  // Team board straight from the hub, escaped — names arrive off the wire.
  if (hud.coopBoard) {
    hud.coopBoard.innerHTML = (rows || []).map((r) =>
      `<div class="go-coop-row"><span>${escapeText(r.n || r.name || 'Athlete')}${String(r.id) === String(typeof CSNet !== 'undefined' ? CSNet.myId : '') ? ' (You)' : ''}</span><span>${r.sc || 0} kills</span></div>`).join('');
  }
  showScreen(gameOverScreen);
};

function escapeText(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Show invite notification
window.showInvite = function(fromName, roomCode, onAccept) {
  // Create toast notification
  let toast = document.getElementById('csInviteToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'csInviteToast';
    toast.style.cssText = 'position:fixed;left:50%;top:80px;transform:translateX(-50%);z-index:99999;' +
      'background:rgba(10,10,12,.95);color:#fff;border:1px solid rgba(255,255,255,.2);border-radius:12px;' +
      'padding:16px 20px;font:500 14px var(--f);letter-spacing:.02em;' +
      'box-shadow:0 8px 32px rgba(0,0,0,.4);min-width:280px;text-align:center;' +
      'transition:opacity .3s, transform .3s;opacity:0;pointer-events:none;';
    document.body.appendChild(toast);
  }
  
  toast.innerHTML = `
    <div style="margin-bottom:12px;font-size:13px;color:rgba(255,255,255,.7)">Game Invite</div>
    <div style="margin-bottom:16px;font-size:15px;font-weight:600">${fromName} invited you to play</div>
    <div style="display:flex;gap:8px;justify-content:center">
      <button id="csInviteAccept" style="padding:8px 20px;background:#fff;color:#000;border:none;border-radius:8px;font:600 13px var(--f);cursor:pointer">Accept</button>
      <button id="csInviteDecline" style="padding:8px 20px;background:transparent;color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:8px;font:600 13px var(--f);cursor:pointer">Decline</button>
    </div>
  `;
  
  toast.style.opacity = '1';
  toast.style.pointerEvents = 'auto';
  
  const acceptBtn = document.getElementById('csInviteAccept');
  const declineBtn = document.getElementById('csInviteDecline');
  
  acceptBtn.onclick = () => {
    toast.style.opacity = '0';
    toast.style.pointerEvents = 'none';
    if (onAccept) onAccept();
  };
  
  declineBtn.onclick = () => {
    toast.style.opacity = '0';
    toast.style.pointerEvents = 'none';
  };
  
  // Auto-hide after 10 seconds
  setTimeout(() => {
    if (toast.style.opacity === '1') {
      toast.style.opacity = '0';
      toast.style.pointerEvents = 'none';
    }
  }, 10000);
};

// Hub problems are terse ("Room not found", "Only the host can start") — put them where the
// athlete looking at the lobby will actually see them.
window.showLobbyError = function (message) {
  let el = document.getElementById('csLobbyError');
  if (!el) {
    el = document.createElement('div');
    el.id = 'csLobbyError';
    el.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:99999;'
      + 'background:rgba(10,10,12,.95);color:#f0f0f2;border:1px solid rgba(255,255,255,.24);'
      + 'border-radius:10px;padding:10px 18px;font:500 13px var(--f);letter-spacing:.03em;'
      + 'transition:opacity .3s;opacity:0;pointer-events:none;';
    document.body.appendChild(el);
  }
  el.textContent = message || 'Something went wrong';
  el.style.opacity = '1';
  clearTimeout(el._hide);
  el._hide = setTimeout(() => { el.style.opacity = '0'; }, 4000);
};

// Initialize online mode if net module is loaded
initOnlineMode();
