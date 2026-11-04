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

// ── Renderer / scene ──
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.autoClear = false;
renderer.domElement.id = 'game';
gameScreen.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a2a2e); // lighter monochrome gray
scene.fog = new THREE.Fog(0x2a2a2e, 50, 160);

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
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 160 });
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

// ── Vegetation (INSTANCED: all foliage in one draw call, all trunks in one) ──
// Shared low-poly geometry + InstancedMesh keeps GPU buffers/draw-calls flat no matter
// how many trees/bushes scatter() places, so render RAM stays low.
const foliageGeo = new THREE.SphereGeometry(1, 8, 6);
const trunkGeo = new THREE.CylinderGeometry(0.3, 0.42, 2.2, 7);
const _leafInst = [];    // { p:[x,y,z], s:[sx,sy,sz] }
const _trunkInst = [];   // { p:[x,y,z], s:[sx,sy,sz] }
const _cannabisInst = []; // { p, s, yaw, tilt, roll, col } — one textured fan leaf per instance
const _stemInst = [];     // { p, s } cannabis stalks (own list: different material from tree trunks)
const _budInst = [];      // { p, s } terminal cola / bud clusters
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
// Open 5-sided cylinder, height 1, so an instance's scale.y IS the segment length. Used for the
// main stalk and every branch. Low-poly sphere for the buds — both shared by the whole field.
const stalkGeo = new THREE.CylinderGeometry(0.62, 1, 1, 5, 1, true);
const budGeo = new THREE.SphereGeometry(1, 5, 3);
// The faceted 5x3 sphere is what makes every bud read as a bright crystal stud, and at full size
// they were the loudest thing on the plant — louder than the blades that are supposed to carry the
// silhouette. One multiplier over both bud placements (branch colas and the terminal stack) keeps
// them proportional to each other and to the stalk, so this is the only knob to turn.
const BUD_SCALE = 0.72;
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
  _trunkInst.length = 0; _leafInst.length = 0; _cannabisInst.length = 0;
  _stemInst.length = 0; _budInst.length = 0;
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
}

function buildIndustrialMap() {
  // ════════════════════════════════════════════════════════════
  //  ABANDONED INDUSTRIAL COMPLEX — 99x99 Arena (1.5x)
  //  Six duplex buildings (2 walkable floors, interiors, internal
  //  stairs, windows, roofs) around a central street, with
  //  containers, tanks, silos and barriers for cover.
  //  CT spawn band x[-8,8] z[-45,-40] and T spawn band x[-20,20]
  //  z[35,45] are kept clear.
  // ════════════════════════════════════════════════════════════

  buildGround(99);

  // OFFCOMFRT wordmarks flush on the inner face of each perimeter wall
  createWallLogo(0, 3, -48.4, 0);
  createWallLogo(0, 3, 48.4, Math.PI);
  createWallLogo(-48.4, 3, 0, Math.PI / 2);
  createWallLogo(48.4, 3, 0, -Math.PI / 2);

  // ── Perimeter Walls ──
  addBox(0, -49.5, 99, 1, 8, mats.wall);
  addBox(0, 49.5, 99, 1, 8, mats.wall);
  addBox(-49.5, 0, 1, 99, 8, mats.wall);
  addBox(49.5, 0, 1, 99, 8, mats.wall);

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

  finalizeVegetation();   // build the InstancedMeshes (trunks, foliage, cannabis leaves)

  // Scattered crates for cover along the lanes
  crate(-8, -18, 1.4); crate(8, -18, 1.4);
  crate(-20, 8, 1.5); crate(20, 8, 1.5);
  crate(-8, 30, 1.2); crate(8, 30, 1.2);

  console.log('[CS] Industrial Complex: 6 duplexes + round towers, vehicles, pavement streets (99x99)');
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
}

// ── Waypoints ──
const waypoints = [];
function generateWaypoints() {
  waypoints.length = 0;
  const count = selectedMap === 'classic' ? 60 : 100;
  const range = selectedMap === 'classic' ? 30 : 45;
  // Guarded: if a map edit ever makes free space scarce this must degrade to fewer waypoints rather
  // than spin the browser forever inside a while loop.
  let guard = 0;
  while (waypoints.length < count && guard++ < count * 300) {
    const x = rand(-range, range), z = rand(-range, range);
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
    console.log('[CS] Industrial Complex map loaded (99x99)');
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

function isFree(x, z, r) {
  return CSMap.isFree(colliders, mapHalf(), x, z, r);
}

// Build initial map (industrial by default)
buildMap();

const rayLOS = new THREE.Raycaster();
const _tmpDir = new THREE.Vector3();
function hasLOS(from, to) {
  _tmpDir.subVectors(to, from);
  const dist = _tmpDir.length();
  rayLOS.set(from, _tmpDir.normalize());
  rayLOS.far = dist;
  return rayLOS.intersectObjects(worldMeshes, false).length === 0;
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

function playShot(vol = 1, tone = 1) {
  const a = audio(), t = a.currentTime;
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

function spawnTracer(from, to, color = 0xffffff) {
  const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 });
  const line = new THREE.Line(geo, mat);
  scene.add(line);
  effects.push({ obj: line, life: 0.06, max: 0.06, fade: true });
}

function spawnParticles(point, normal, mat, count, speed) {
  for (let i = 0; i < count; i++) {
    const p = new THREE.Mesh(sparkGeo, mat);
    p.position.copy(point);
    const v = new THREE.Vector3(rand(-1, 1), rand(-0.2, 1), rand(-1, 1)).multiplyScalar(speed);
    if (normal) v.addScaledVector(normal, speed);
    scene.add(p);
    effects.push({ obj: p, vel: v, life: rand(0.2, 0.45) });
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
    if (e.fade) e.obj.material.opacity = Math.max(0, e.life / e.max) * 0.8;
    if (e.life <= 0) {
      scene.remove(e.obj);
      if (e.fade) { e.obj.geometry.dispose(); e.obj.material.dispose(); }
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

function setWeapon(key) {
  const next = inventory[key];
  if (!next || next === current) return;
  current.model.visible = false;
  current = next; current.model.visible = true;
  weaponState.reloading = 0; weaponState.switching = 0.45;
  playBeep(220, 0.04, 0.08); updateAmmoHud();
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
const player = {
  pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: Math.PI, pitch: 0,
  onGround: true, health: 150, alive: true, eye: 1.65, speed: 0,
};
const P_RADIUS = 0.35, P_HEIGHT = 1.8;

function damagePlayer(amount, attacker) {
  if (!player.alive || game.state !== 'playing') return;
  player.health = Math.max(0, player.health - amount);
  damageFlash = Math.min(1, damageFlash + 0.45);
  hud.health.textContent = Math.ceil(player.health);
  hud.healthBox.classList.toggle('low', player.health <= 25);
  playBeep(90, 0.08, 0.2, 'sawtooth');
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
    const chance = clamp(0.35 + game.round * 0.02 - dist * 0.009 - moving - airborne - crouchBonus, 0.08, 0.65);
    const hit = Math.random() < chance;
    const aim = playerEye.clone().add(new THREE.Vector3(0, -0.35, 0));
    if (!hit) aim.add(new THREE.Vector3(rand(-1, 1), rand(-0.6, 0.8), rand(-1, 1)).multiplyScalar(0.6 + dist * 0.02));
    spawnTracer(muzzle, aim, 0xffc870);
    playShot(clamp(1.2 - dist / 40, 0.12, 0.8), 0.85);
    if (hit) damagePlayer(Math.round(rand(5, 10) * (Math.random() < 0.06 ? 1.8 : 1)), this);
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
    if (player.alive && dist < 55) {
      let ang = Math.atan2(dx, dz) - this.yaw;
      ang = Math.abs(Math.atan2(Math.sin(ang), Math.cos(ang)));
      if (this.alert || ang < 1.25 || dist < 3) sees = hasLOS(eye, playerChest);
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
    // Confinement has to come from the arena actually drawn — the old ±31.5 literal was written
    // for Classic and pushed the whole terrorist team back inside the walls of the 99m Industrial
    // Complex, so bots could never reach the buildings they were patrolling toward.
    const edge = mapHalf() - 1.5;
    this.pos.x = clamp(this.pos.x, -edge, edge);
    this.pos.z = clamp(this.pos.z, -edge, edge);

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
const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
const touchControls = document.getElementById('touchControls');
const joystickZone = document.getElementById('joystickZone');
const joystickStick = document.getElementById('joystickStick');
const lookZone = document.getElementById('lookZone');
const btnFire = document.getElementById('btnFire');
const btnReload = document.getElementById('btnReload');
const btnJump = document.getElementById('btnJump');
const btnCrouch = document.getElementById('btnCrouch');
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

// Joystick handling
let joystickTouch = null;
const joystickBase = joystickZone.querySelector('.joystick-base');

joystickZone.addEventListener('touchstart', e => {
  e.preventDefault();
  if (joystickTouch !== null) return;
  const t = e.changedTouches[0];
  joystickTouch = t.identifier;
  touch.joystickActive = true;
  joystickStick.classList.add('active');
  updateJoystick(t);
}, { passive: false });

joystickZone.addEventListener('touchmove', e => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (t.identifier === joystickTouch) updateJoystick(t);
  }
}, { passive: false });

joystickZone.addEventListener('touchend', e => {
  for (const t of e.changedTouches) {
    if (t.identifier === joystickTouch) {
      joystickTouch = null;
      touch.joystickActive = false;
      touch.moveX = 0;
      touch.moveY = 0;
      joystickStick.classList.remove('active');
      joystickStick.style.transform = 'translate(-50%, -50%)';
    }
  }
});

joystickZone.addEventListener('touchcancel', e => {
  joystickTouch = null;
  touch.joystickActive = false;
  touch.moveX = 0;
  touch.moveY = 0;
  joystickStick.classList.remove('active');
  joystickStick.style.transform = 'translate(-50%, -50%)';
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

// Fire button
btnFire.addEventListener('touchstart', e => {
  e.preventDefault();
  touch.fire = true;
  if (game.state === 'playing') fire();
}, { passive: false });

btnFire.addEventListener('touchend', e => {
  touch.fire = false;
});

// Reload button
btnReload.addEventListener('touchstart', e => {
  e.preventDefault();
  if (game.state === 'playing') reload();
}, { passive: false });

// Jump button
btnJump.addEventListener('touchstart', e => {
  e.preventDefault();
  touch.jump = true;
}, { passive: false });

btnJump.addEventListener('touchend', e => {
  touch.jump = false;
});

// Crouch button
btnCrouch.addEventListener('touchstart', e => {
  e.preventDefault();
  touch.crouch = true;
}, { passive: false });

btnCrouch.addEventListener('touchend', e => {
  touch.crouch = false;
});

// Weapon switch buttons
weaponBtns.forEach(btn => {
  btn.addEventListener('touchstart', e => {
    e.preventDefault();
    const idx = parseInt(btn.dataset.weapon);
    if (idx === 0) setWeapon('rifle');
    else if (idx === 1) setWeapon('pistol');
    else if (idx === 2 && inventory.awp) setWeapon('awp');
    weaponBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }, { passive: false });
});

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
  if (isTouchDevice) return game.state === 'playing';
  return game.state === 'playing' && locked;
}

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
        title: 'Enter Greyhaven Complex',
        description: 'Infiltrate the industrial complex through the main gate',
        zone: { x: 0, z: -30, radius: 8 },
        triggerDistance: 5,
        completed: false
      },
      {
        id: 'obj_1_2',
        type: 'find_clue',
        title: 'Investigate Signs of Struggle',
        description: 'Find evidence of RAVEN\'s last stand',
        location: { x: -15, z: 10, radius: 3 },
        clueType: 'spent_ammo',
        triggerDistance: 2.5,
        completed: false
      },
      {
        id: 'obj_1_3',
        type: 'find_clue',
        title: 'Locate Damaged Radio',
        description: 'Track RAVEN\'s communication attempts',
        location: { x: 20, z: 25, radius: 3 },
        clueType: 'radio',
        triggerDistance: 2.5,
        completed: false
      },
      {
        id: 'obj_1_4',
        type: 'find_npc',
        title: 'Find RAVEN',
        description: 'Locate RAVEN in the duplex buildings',
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
        title: 'Escape the Complex',
        description: 'Get RAVEN to the extraction point',
        zone: { x: 0, z: -40, radius: 10 },
        triggerDistance: 8,
        requiresNPC: true,
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
  missionComplete: false
};

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
    missionComplete: false
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
    const scoreboard = document.getElementById('scoreboard');
    const centerMsg = document.getElementById('center-msg');
    if (roundInfo) roundInfo.style.display = 'none';
    if (killsBox) killsBox.style.display = 'none';
    if (scoreboard) scoreboard.style.display = 'none';
    if (centerMsg) centerMsg.style.display = 'none';
    
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
  
  // Spawn clues
  currentMission.objectives.forEach(obj => {
    if (obj.type === 'find_clue') {
      spawnClue(obj.location.x, obj.location.z, obj.clueType, obj.id);
    }
  });
  
  // Spawn NPCs
  currentMission.objectives.forEach(obj => {
    if (obj.type === 'find_npc') {
      spawnNPC(obj.location.x, obj.location.z, obj.npcName, obj.id);
    }
  });
}

function spawnClue(x, z, type, id) {
  const geo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  const mat = new THREE.MeshStandardMaterial({ 
    color: 0xffaa00, 
    emissive: 0xffaa00, 
    emissiveIntensity: 0.5 
  });
  const clue = new THREE.Mesh(geo, mat);
  clue.position.set(x, 1, z);
  clue.userData = { type: 'clue', clueType: type, id: id };
  scene.add(clue);
  missionState.clues.push(clue);
}

function spawnNPC(x, z, name, id) {
  const group = new THREE.Group();
  
  // Simple NPC representation (can be enhanced with full figure rig)
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 1.2, 0.4),
    new THREE.MeshStandardMaterial({ color: 0x4488ff })
  );
  body.position.y = 0.9;
  group.add(body);
  
  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 0.4, 0.4),
    new THREE.MeshStandardMaterial({ color: 0xdddddd })
  );
  head.position.y = 1.7;
  group.add(head);
  
  group.position.set(x, 0, z);
  group.userData = { type: 'npc', name: name, id: id };
  scene.add(group);
  missionState.npcs.push(group);
}

function spawnMissionEnemies() {
  if (!currentMission) return;
  
  // Strategic enemy placements along Mission 1 path
  // Player spawns at z: -45 to -40, so enemies start much further away
  const enemyPlacements = [
    // Far entrance guards (2 enemies)
    { x: 8, z: -15, patrol: true },
    { x: -8, z: -15, patrol: true },
    
    // Mid-range patrol (3 enemies)
    { x: -10, z: -5, patrol: true },
    { x: -12, z: 5, patrol: true },
    { x: -8, z: 10, patrol: true },
    
    // Guards around first clue location (2 enemies)
    { x: -18, z: 8, patrol: false },
    { x: -12, z: 12, patrol: true },
    
    // Patrol between clues (4 enemies)
    { x: 0, z: 15, patrol: true },
    { x: 8, z: 18, patrol: true },
    { x: 15, z: 22, patrol: true },
    { x: 18, z: 28, patrol: true },
    
    // Guards around second clue (2 enemies)
    { x: 22, z: 23, patrol: false },
    { x: 18, z: 27, patrol: true },
    
    // Heavy resistance near RAVEN's building (4 enemies)
    { x: -30, z: 26, patrol: true },
    { x: -36, z: 26, patrol: true },
    { x: -30, z: 32, patrol: false },
    { x: -36, z: 32, patrol: true },
    
    // Pursuit squad on escape route (3 enemies)
    { x: -15, z: 20, patrol: true },
    { x: -5, z: 5, patrol: true },
    { x: 5, z: -10, patrol: true },
    
    // Final blockers near extraction (2 enemies)
    { x: 3, z: -25, patrol: false },
    { x: -3, z: -30, patrol: false }
  ];
  
  const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
  
  enemyPlacements.forEach((placement, i) => {
    // Check if position is free (not inside walls)
    if (!isFree(placement.x, placement.z, 0.6)) {
      // Try nearby position
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
    
    const bot = new Bot(placement.x, placement.z, names[i % names.length]);
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
        if (obj.requiresNPC && missionState.npcs.length === 0) {
          // Need RAVEN to escape with
          showMissionNotification('Get RAVEN to safety!');
          return;
        }
        completeObjective(obj);
      }
      break;
      
    case 'find_clue':
      const clue = missionState.clues.find(c => c.userData.id === obj.id);
      if (clue) {
        const cdist = Math.hypot(playerPos.x - clue.position.x, playerPos.z - clue.position.z);
        if (cdist < obj.triggerDistance) {
          completeObjective(obj);
          // Show clue dialogue
          const dialogueKey = `clue_${missionState.currentObjective}`;
          if (currentMission.dialogues[dialogueKey]) {
            playDialogue(dialogueKey);
          }
          // Remove clue from scene
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
      // Auto-complete when dialogue finishes
      if (!missionState.dialogueActive) {
        completeObjective(obj);
      }
      break;
  }
}

function completeObjective(obj) {
  obj.completed = true;
  missionState.currentObjective++;
  
  showMissionNotification(`Objective Complete: ${obj.title}`);
  
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
  missionState.elapsedTime = Date.now() - missionState.startTime;
  
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
  const scoreboard = document.getElementById('scoreboard');
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
  
  // Set portrait (simple colored box for now)
  const colors = { rook: '#4488ff', raven: '#44ff88', sable: '#ff4488' };
  if (dialoguePortrait) dialoguePortrait.style.background = colors[line.portrait] || '#888';
  
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
    const bestTime = progress.bestTimes[m.id];
    const score = progress.scores[m.id];
    
    return `
      <div class="mission-card ${completed ? 'completed' : ''}" data-mission="${m.id}">
        <div class="mission-code">${m.codeName}</div>
        <div class="mission-title">${m.title}</div>
        ${completed ? `
          <div class="mission-stats">
            <span>Best: ${Math.floor(bestTime / 60)}:${String(bestTime % 60).padStart(2, '0')}</span>
            <span>Score: ${score}</span>
          </div>
        ` : ''}
        <button class="mission-btn" ${completed ? '' : 'disabled'}>
          ${completed ? 'REPLAY' : 'LOCKED'}
        </button>
      </div>
    `;
  }).join('');
  
  // Add click handlers
  missionList.querySelectorAll('.mission-card').forEach(card => {
    card.addEventListener('click', () => {
      const missionId = card.dataset.mission;
      startMission(missionId);
    });
  });
  
  showScreen(document.getElementById('missionSelectScreen'));
}

// ── Mission Radar Markers ──
function updateMissionMarkers() {
  if (!currentMission || !missionState.active) return;
  
  const obj = currentMission.objectives[missionState.currentObjective];
  if (!obj || obj.completed) return;
  
  // Draw waypoint on radar with enhanced visuals
  const c = radarCtx;
  const S = 170;
  const scale = 2.4;
  
  let targetX, targetZ;
  
  if (obj.type === 'enter_zone' || obj.type === 'escape_zone') {
    targetX = obj.zone.x;
    targetZ = obj.zone.z;
  } else if (obj.type === 'find_clue') {
    const clue = missionState.clues.find(c => c.userData.id === obj.id);
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
  }
  
  if (targetX !== undefined) {
    // Draw waypoint on radar
    const wx = (targetX - player.pos.x) * scale;
    const wz = (targetZ - player.pos.z) * scale;
    
    c.save();
    c.translate(S / 2, S / 2);
    c.rotate(player.yaw);
    
    // Draw pulsing waypoint marker
    const pulse = (Math.sin(performance.now() * 0.005) + 1) * 0.5;
    
    // Outer ring with glow
    c.shadowBlur = 10;
    c.shadowColor = '#ffaa00';
    c.strokeStyle = `rgba(255, 170, 0, ${0.7 + pulse * 0.3})`;
    c.lineWidth = 3;
    c.beginPath();
    c.arc(wx, wz, 8 + pulse * 3, 0, Math.PI * 2);
    c.stroke();
    c.shadowBlur = 0;
    
    // Inner dot
    c.fillStyle = '#ffaa00';
    c.beginPath();
    c.arc(wx, wz, 4, 0, Math.PI * 2);
    c.fill();
    
    c.restore();
  }
}

function resetPlayer() {
  let x, z, tries = 0;
  const ctZMin = selectedMap === 'classic' ? -25 : -45;
  const ctZMax = selectedMap === 'classic' ? -20 : -40;
  // The try cap matters: a spawn band that a map edit has filled in would otherwise spin here
  // forever and take the whole page down with it.
  do { x = rand(-8, 8); z = rand(ctZMin, ctZMax); tries++; } while (!isFree(x, z, 0.5) && tries < 200);
  player.pos.set(x, 0, z);
  player.vel.set(0, 0, 0);
  player.yaw = Math.PI; player.pitch = 0;
  player.health = 100; player.alive = true;
  player.onGround = true; player.eye = 1.65;
  hud.health.textContent = 100;
  hud.healthBox.classList.remove('low');
  for (const w of Object.values(inventory)) { w.ammo = w.def.mag; w.reserve = w.def.reserve; }
  Object.assign(weaponState, { cooldown: 0, reloading: 0, switching: 0.3, recoil: 0, ads: 0 });
  current.model.visible = false;
  current = inventory.rifle;
  current.model.visible = true;
  updateAmmoHud();
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
  buildMap();
  if (hud.coopBoard) hud.coopBoard.innerHTML = '';
  game.round = 0; game.ct = 0; game.t = 0; game.kills = 0;
  game.timeLeft = ROUND_TIME; game.endTimer = 0;
  hud.scoreCT.textContent = '0'; hud.scoreT.textContent = '0';
  hud.kills.textContent = '0';
  hud.killfeed.innerHTML = '';
  clearBots();
  
  // Hide mission HUD and restore round-based HUD
  if (missionHud) missionHud.style.display = 'none';
  const roundInfo = document.getElementById('round-info');
  const killsBox = document.getElementById('kills-box');
  const scoreboard = document.getElementById('scoreboard');
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
    beginMissionGameplay();
  });
}

// Game over → Redeploy. After a co-op match the room is still open on the hub, so this goes back to
// the lobby instead of dropping the athlete into a private round they did not ask for.
btnRetry.addEventListener('click', () => {
  if (typeof CSNet !== 'undefined' && CSNet.room) {
    if (hud.coopBoard) hud.coopBoard.innerHTML = '';
    showScreen(lobbyScreen);
    return;
  }
  startNewGame();
});

// Game over → Back to menu
btnBackMenu.addEventListener('click', () => {
  game.state = 'menu';
  isOnline = false;
  clearOnlineFigures();
  if (hud.coopBoard) hud.coopBoard.innerHTML = '';
  if (typeof CSNet !== 'undefined' && CSNet.room) CSNet.leaveRoom();
  showScreen(menuScreen);
});

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
  const speed = (crouch ? 2.2 : walk ? 3 : current.def.speed) * (1 - 0.4 * weaponState.ads);
  const accel = player.onGround ? 12 : 2.5;
  const k = Math.min(1, accel * dt);
  player.vel.x += (wish.x * speed - player.vel.x) * k;
  player.vel.z += (wish.z * speed - player.vel.z) * k;

  const jump = isTouchDevice ? touch.jump : keys.Space;
  if (jump && player.onGround) { player.vel.y = 7; player.onGround = false; }
  player.vel.y -= 20 * dt;

  player.pos.x += player.vel.x * dt;
  player.pos.z += player.vel.z * dt;
  collide(player.pos, P_RADIUS, P_HEIGHT, player.onGround ? STEP : 0.02);

  player.pos.y += player.vel.y * dt;
  const gh = groundHeight(player.pos, P_RADIUS);
  if (player.pos.y <= gh) {
    player.pos.y = gh; player.vel.y = 0; player.onGround = true;
  } else if (player.onGround && player.vel.y <= 0 && player.pos.y - gh < STEP) {
    player.pos.y = gh; player.vel.y = 0;
  } else {
    player.onGround = false;
  }

  player.speed = Math.hypot(player.vel.x, player.vel.z);
  player.eye += ((crouch ? 1.15 : 1.65) - player.eye) * Math.min(1, dt * 12);
  camera.position.set(player.pos.x, player.pos.y + player.eye, player.pos.z);
  camera.rotation.set(player.pitch, player.yaw, 0);
}

function updateWeapon(dt) {
  const ws = weaponState, model = current.model;
  ws.cooldown = Math.max(0, ws.cooldown - dt);
  ws.switching = Math.max(0, ws.switching - dt);
  ws.recoil = Math.max(0, ws.recoil - dt * (mouseDown ? 0.05 : 0.18));
  ws.kickAnim = Math.max(0, ws.kickAnim - dt * 12);
  if (ws.reloading > 0) {
    ws.reloading -= dt;
    if (ws.reloading <= 0) { ws.reloading = 0; finishReload(); }
  }
  if (mouseDown && current.def.auto) fire();

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
  hud.timer.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  hud.timer.classList.toggle('low', t <= 15);

  if (centerTimer > 0) { centerTimer -= dt; if (centerTimer <= 0) hud.center.classList.remove('show'); }
  if (hitTimer > 0) { hitTimer -= dt; if (hitTimer <= 0) hud.hit.style.opacity = 0; }
  damageFlash = Math.max(0, damageFlash - dt * 1.5);
  hud.damage.style.opacity = damageFlash;
  drawRadar();
}

function drawRadar() {
  const c = radarCtx, S = 170, scale = 2.4;
  c.clearRect(0, 0, S, S);
  c.save();
  c.beginPath(); c.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2); c.clip();
  c.translate(S / 2, S / 2); c.rotate(player.yaw);
  c.fillStyle = 'rgba(42,42,50,0.85)'; // monochrome dark
  for (const col of colliders) {
    c.fillRect((col.minX - player.pos.x) * scale, (col.minZ - player.pos.z) * scale,
      (col.maxX - col.minX) * scale, (col.maxZ - col.minZ) * scale);
  }
  for (const b of bots) {
    if (!b.dead && b.spotted <= 0) continue;
    c.fillStyle = b.dead ? 'rgba(120,120,120,0.8)' : '#ff4a4a'; // red for enemies
    c.beginPath();
    c.arc((b.pos.x - player.pos.x) * scale, (b.pos.z - player.pos.z) * scale, b.dead ? 2.5 : 4, 0, Math.PI * 2);
    c.fill();
  }
  // In co-op the terrorist force and the squad live in the snapshot, not in the local arrays, so
  // the blip sweep has to read the same entities the 3D view is drawing.
  if (isOnline) {
    for (const rig of onlineBots.values()) {
      if (!rig.alive) continue;
      c.fillStyle = '#ff4a4a';
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

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);

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
  const edge = mapHalf() - 1.2;
  if (player.alive && Math.hypot(player.pos.x - me.pos.x, player.pos.z - me.pos.z) > 3) {
    player.pos.x = clamp(me.pos.x, -edge, edge);
    player.pos.z = clamp(me.pos.z, -edge, edge);
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
    player.pos.set(clamp(me.pos.x, -edge, edge), me.pos.y || 0, clamp(me.pos.z, -edge, edge));
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
