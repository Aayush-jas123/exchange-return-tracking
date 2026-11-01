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
  [menuScreen, gameScreen, gameOverScreen, lobbyScreen].forEach(s => s.classList.remove('active'));
  if (el) el.classList.add('active');
}

// Instructions toggle
const instrToggle = document.getElementById('instrToggle');
const instrPanel = document.getElementById('instrPanel');
instrToggle.addEventListener('click', () => {
  const open = instrPanel.toggleAttribute('hidden') === false;
  instrToggle.classList.toggle('open', open);
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
scene.fog = new THREE.Fog(0x2a2a2e, 45, 120);

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
};

// ── Map ──
const colliders = [];
const worldMeshes = [];

function scaledBox(w, h, d, scale) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, uv.getX(k) * dims[f][0] / scale, uv.getY(k) * dims[f][1] / scale);
    }
  }
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
const crate = (x, z, s = 1.2, y = 0) => addBox(x, z, s, s, s, mats.crate, s, y);

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

// ── Physics helpers ──
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);

function circleHitsBox(x, z, r, c) {
  const dx = x - clamp(x, c.minX, c.maxX), dz = z - clamp(z, c.minZ, c.maxZ);
  return dx * dx + dz * dz < r * r;
}

function collide(pos, r, h, step) {
  for (const c of colliders) {
    if (c.maxY <= pos.y + step || c.minY >= pos.y + h) continue;
    const cx = clamp(pos.x, c.minX, c.maxX), cz = clamp(pos.z, c.minZ, c.maxZ);
    const dx = pos.x - cx, dz = pos.z - cz, d2 = dx * dx + dz * dz;
    if (d2 >= r * r) continue;
    if (d2 > 1e-8) {
      const d = Math.sqrt(d2);
      pos.x += (dx / d) * (r - d);
      pos.z += (dz / d) * (r - d);
    } else {
      const pl = pos.x - c.minX, pr = c.maxX - pos.x, pb = pos.z - c.minZ, pf = c.maxZ - pos.z;
      const m = Math.min(pl, pr, pb, pf);
      if (m === pl) pos.x = c.minX - r; else if (m === pr) pos.x = c.maxX + r;
      else if (m === pb) pos.z = c.minZ - r; else pos.z = c.maxZ + r;
    }
  }
}

const STEP = 0.4;
function groundHeight(pos, r) {
  let g = 0;
  for (const c of colliders) {
    if (c.maxY <= pos.y + STEP && c.maxY > g && circleHitsBox(pos.x, pos.z, r * 0.85, c)) g = c.maxY;
  }
  return g;
}

function isFree(x, z, r) {
  if (Math.abs(x) > 31 - r || Math.abs(z) > 31 - r) return false;
  return !colliders.some(c => circleHitsBox(x, z, r, c));
}

const rayLOS = new THREE.Raycaster();
const _tmpDir = new THREE.Vector3();
function hasLOS(from, to) {
  _tmpDir.subVectors(to, from);
  const dist = _tmpDir.length();
  rayLOS.set(from, _tmpDir.normalize());
  rayLOS.far = dist;
  return rayLOS.intersectObjects(worldMeshes, false).length === 0;
}

const waypoints = [];
while (waypoints.length < 60) {
  const x = rand(-30, 30), z = rand(-30, 30);
  if (isFree(x, z, 0.9)) waypoints.push(new THREE.Vector2(x, z));
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
  radar: $('radar'),
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
  onGround: true, health: 100, alive: true, eye: 1.65, speed: 0,
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
    const chance = clamp(0.5 + game.round * 0.035 - dist * 0.009 - moving - airborne - crouchBonus, 0.1, 0.8);
    const hit = Math.random() < chance;
    const aim = playerEye.clone().add(new THREE.Vector3(0, -0.35, 0));
    if (!hit) aim.add(new THREE.Vector3(rand(-1, 1), rand(-0.6, 0.8), rand(-1, 1)).multiplyScalar(0.6 + dist * 0.02));
    spawnTracer(muzzle, aim, 0xffc870);
    playShot(clamp(1.2 - dist / 40, 0.12, 0.8), 0.85);
    if (hit) damagePlayer(Math.round(rand(8, 15) * (Math.random() < 0.08 ? 2.5 : 1)), this);
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
      if (!this.alert) this.reaction = rand(0.45, 0.85) / (1 + game.round * 0.08);
      this.alert = true; this.spotted = 2;
      this.lastSeen.copy(player.pos); this.lostTimer = 0;
      this.faceToward(player.pos.x, player.pos.z, dt, 10);
      this.reaction -= dt;

      this.strafeTimer -= dt;
      if (this.strafeTimer <= 0) { this.strafeDir = [-1, 0, 1][(Math.random() * 3) | 0]; this.strafeTimer = rand(0.5, 1.4); }
      if (this.strafeDir) {
        const sx = (dz / dist) * this.strafeDir, sz = (-dx / dist) * this.strafeDir;
        this.pos.x += sx * 2.2 * dt; this.pos.z += sz * 2.2 * dt;
        moveSpeed = 2.2;
      }
      if (dist > 22) { this.moveToward(player.pos.x, player.pos.z, 2.5, dt); moveSpeed = 2.5; }

      if (this.reaction <= 0) {
        this.shootCD -= dt;
        if (this.shootCD <= 0) {
          this.shoot(dist);
          this.shootCD = Math.random() < 0.6 ? rand(0.1, 0.16) : rand(0.35, 0.8);
        }
      }
    } else if (this.alert) {
      this.lostTimer += dt;
      this.faceToward(this.lastSeen.x, this.lastSeen.z, dt);
      const d = this.moveToward(this.lastSeen.x, this.lastSeen.z, 3.6, dt);
      moveSpeed = 3.6;
      if (d < 1.2 || this.lostTimer > 7) { this.alert = false; this.target = null; }
    } else {
      if (!this.target) this.pickWaypoint();
      this.faceToward(this.target.x, this.target.y, dt, 5);
      const d = this.moveToward(this.target.x, this.target.y, 2.4, dt);
      moveSpeed = 2.4;
      if (d < 0.8) this.pickWaypoint();
    }

    collide(this.pos, 0.4, 1.8, STEP);
    this.pos.y = groundHeight(this.pos, 0.4);
    this.pos.x = clamp(this.pos.x, -31.5, 31.5);
    this.pos.z = clamp(this.pos.z, -31.5, 31.5);

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
    do { x = rand(-14, 14); z = rand(23, 30); tries++; } while ((!isFree(x, z, 0.6) || bots.some(b => Math.hypot(b.pos.x - x, b.pos.z - z) < 1.5)) && tries < 200);
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
  if (!locked && game.state === 'playing') {
    mouseDown = false; aiming = false;
  }
});

// ── Game flow ──
const ROUND_TIME = 115;
const game = { state: 'menu', round: 0, ct: 0, t: 0, kills: 0, timeLeft: ROUND_TIME, endTimer: 0 };

function resetPlayer() {
  let x, z;
  do { x = rand(-6, 6); z = rand(-30, -26); } while (!isFree(x, z, 0.5));
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
  game.round = 0; game.ct = 0; game.t = 0; game.kills = 0;
  game.timeLeft = ROUND_TIME; game.endTimer = 0;
  hud.scoreCT.textContent = '0'; hud.scoreT.textContent = '0';
  hud.kills.textContent = '0';
  hud.killfeed.innerHTML = '';
  clearBots();
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

// Game over → Redeploy
btnRetry.addEventListener('click', () => {
  startNewGame();
});

// Game over → Back to menu
btnBackMenu.addEventListener('click', () => {
  game.state = 'menu';
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
  c.restore();
  c.fillStyle = '#f0f0f2'; // white for player
  c.beginPath();
  c.moveTo(S / 2, S / 2 - 7);
  c.lineTo(S / 2 - 5, S / 2 + 5);
  c.lineTo(S / 2 + 5, S / 2 + 5);
  c.closePath(); c.fill();
}

// ── Main render loop ──
const clock = new THREE.Clock();

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);

  // Apply touch look on mobile
  if (isTouchDevice) applyTouchLook(dt);

  if (isGameActive()) {
    if (!isOnline) {
      // Single-player: local simulation
      game.timeLeft -= dt;
      if (game.timeLeft <= 0) endRound('T');
      updatePlayer(dt);
      for (const b of bots) b.update(dt);
    } else {
      // Online: server owns bots, we just render and send state
      updatePlayer(dt);
      updateOnlinePlayers(dt);
      sendPlayerState();
    }
    updateWeapon(dt);
    updateEffects(dt);
    updateHud(dt);
  } else if (game.state === 'roundEnd' && (isTouchDevice || locked)) {
    game.endTimer -= dt;
    updateEffects(dt);
    updateHud(dt);
    if (game.endTimer <= 0 && !isOnline) startRound();
  } else if (game.state === 'menu') {
    // Slow fly-over behind the menu
    const t = performance.now() * 0.00005;
    camera.position.set(Math.sin(t) * 26, 16, Math.cos(t) * 26);
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
// ════════════════════════════════════════════════════════════

// ── Online State ──
let isOnline = false;
let onlinePlayers = new Map(); // id -> { model, data, targetPos, targetYaw }
let onlineBots = new Map(); // id -> { model, data, targetPos }
let lastSnapshot = null;
let snapshotBuffer = [];
const SNAPSHOT_INTERP_MS = 100;

// ── CT Player Materials (Monochrome Team) ──
const ctMats = {
  skin: new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.9 }),
  helmet: new THREE.MeshStandardMaterial({ color: 0x3a3a3e, roughness: 0.7 }),
  vest: new THREE.MeshStandardMaterial({ color: 0x5a5a5e, roughness: 0.8 }),
  shirt: new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.9 }),
  pants: new THREE.MeshStandardMaterial({ color: 0x9a9a9e, roughness: 0.9 }),
  weapon: new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.4, metalness: 0.6 }),
  glove: new THREE.MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.8 }),
};

// ── Remote Player Model (Detailed Articulated) ──
class RemotePlayerModel {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.walkPhase = 0;
    this.health = 100;
    this.alive = true;
    this.weapon = 'rifle';
    this.parts = [];

    const g = this.group = new THREE.Group();
    const part = (geo, mat, x, y, z, partName, parent = g) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z); m.castShadow = true;
      m.userData = { playerId: id, part: partName };
      parent.add(m); if (partName) this.parts.push(m); return m;
    };

    // Legs (two-part with boots)
    this.legL = new THREE.Group(); this.legL.position.set(-0.14, 0.85, 0); g.add(this.legL);
    this.legR = new THREE.Group(); this.legR.position.set(0.14, 0.85, 0); g.add(this.legR);
    part(new THREE.BoxGeometry(0.22, 0.45, 0.24), ctMats.pants, 0, -0.225, 0, 'legs', this.legL);
    part(new THREE.BoxGeometry(0.22, 0.4, 0.24), ctMats.helmet, 0, -0.65, 0, 'legs', this.legL); // boot
    part(new THREE.BoxGeometry(0.22, 0.45, 0.24), ctMats.pants, 0, -0.225, 0, 'legs', this.legR);
    part(new THREE.BoxGeometry(0.22, 0.4, 0.24), ctMats.helmet, 0, -0.65, 0, 'legs', this.legR); // boot

    // Torso with vest
    part(new THREE.BoxGeometry(0.58, 0.68, 0.32), ctMats.shirt, 0, 1.2, 0, 'body');
    part(new THREE.BoxGeometry(0.6, 0.45, 0.36), ctMats.vest, 0, 1.25, 0, 'body'); // vest
    part(new THREE.BoxGeometry(0.15, 0.15, 0.08), ctMats.skin, 0, 1.5, 0.18, 'body'); // team indicator

    // Head with helmet
    part(new THREE.BoxGeometry(0.3, 0.32, 0.3), ctMats.skin, 0, 1.74, 0, 'head');
    part(new THREE.BoxGeometry(0.32, 0.18, 0.32), ctMats.helmet, 0, 1.88, 0, 'head'); // helmet
    part(new THREE.BoxGeometry(0.28, 0.08, 0.02), ctMats.helmet, 0, 1.77, 0.16, 'head'); // mask

    // Arms with gloves
    part(new THREE.BoxGeometry(0.16, 0.35, 0.16), ctMats.shirt, -0.38, 1.35, 0, 'body');
    part(new THREE.BoxGeometry(0.14, 0.2, 0.14), ctMats.glove, -0.38, 1.1, 0.1, 'body'); // glove
    part(new THREE.BoxGeometry(0.16, 0.35, 0.16), ctMats.shirt, 0.38, 1.35, 0, 'body');
    part(new THREE.BoxGeometry(0.14, 0.2, 0.14), ctMats.glove, 0.38, 1.1, 0.1, 'body'); // glove

    // Weapon
    part(new THREE.BoxGeometry(0.08, 0.1, 0.75), ctMats.weapon, 0.05, 1.36, 0.55, null);

    // Name tag (canvas texture)
    this.nameTag = this.createNameTag(name);
    this.nameTag.position.set(0, 2.3, 0);
    g.add(this.nameTag);

    // Health bar
    this.healthBar = this.createHealthBar();
    this.healthBar.position.set(0, 2.15, 0);
    g.add(this.healthBar);

    g.position.copy(this.pos);
    scene.add(g);
  }

  createNameTag(name) {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(42, 42, 46, 0.85)';
    ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = '#f0f0f2';
    ctx.font = 'bold 28px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, 128, 32);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(2, 0.5, 1);
    return sprite;
  }

  createHealthBar() {
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 16;
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(1.2, 0.15, 1);
    sprite.userData.canvas = canvas;
    sprite.userData.texture = tex;
    return sprite;
  }

  updateHealth(health) {
    this.health = health;
    const canvas = this.healthBar.userData.canvas;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 128, 16);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 0, 128, 16);
    const pct = Math.max(0, health / 100);
    const color = pct > 0.6 ? '#4ade80' : pct > 0.3 ? '#fbbf24' : '#ef4444';
    ctx.fillStyle = color;
    ctx.fillRect(2, 2, 124 * pct, 12);
    this.healthBar.userData.texture.needsUpdate = true;
  }

  update(dt, targetPos, targetYaw, walkPhase, speed) {
    // Interpolate position
    this.pos.lerp(targetPos, Math.min(1, dt * 10));
    this.group.position.copy(this.pos);

    // Interpolate rotation
    let yawDiff = targetYaw - this.yaw;
    yawDiff = Math.atan2(Math.sin(yawDiff), Math.cos(yawDiff));
    this.yaw += yawDiff * Math.min(1, dt * 10);
    this.group.rotation.y = this.yaw;

    // Walk animation
    this.walkPhase = walkPhase;
    const swing = Math.sin(this.walkPhase) * Math.min(1, speed / 2) * 0.6;
    this.legL.rotation.x = swing;
    this.legR.rotation.x = -swing;

    // Name tag always faces camera
    this.nameTag.lookAt(camera.position);
    this.healthBar.lookAt(camera.position);
  }

  dispose() {
    scene.remove(this.group);
    this.parts.forEach(p => {
      p.geometry.dispose();
      p.material.dispose();
    });
  }
}

// ── Online Snapshot Handling ──
function applySnapshot(snapshot) {
  if (!snapshot || !isOnline) return;
  lastSnapshot = snapshot;

  // Update game state from snapshot
  game.round = snapshot.round;
  game.timeLeft = snapshot.timeLeft;
  game.state = snapshot.state;
  game.ct = snapshot.scoreCT;
  game.t = snapshot.scoreT;

  // Update HUD
  hud.round.textContent = game.round;
  hud.scoreCT.textContent = game.ct;
  hud.scoreT.textContent = game.t;
  const t = Math.max(0, Math.ceil(game.timeLeft));
  hud.timer.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;

  // Update remote players
  const currentIds = new Set();
  for (const pData of snapshot.players) {
    if (pData.id === CSNet?.myId) continue; // Skip self
    currentIds.add(pData.id);
    let rp = onlinePlayers.get(pData.id);
    if (!rp) {
      rp = new RemotePlayerModel(pData.id, pData.name || 'Player');
      onlinePlayers.set(pData.id, rp);
    }
    rp.targetPos = new THREE.Vector3(pData.pos.x, pData.pos.y || 0, pData.pos.z);
    rp.targetYaw = pData.yaw;
    rp.alive = pData.alive;
    rp.group.visible = pData.alive;
    rp.updateHealth(pData.health);
    rp.weapon = pData.weapon;
  }

  // Remove disconnected players
  for (const [id, rp] of onlinePlayers) {
    if (!currentIds.has(id)) {
      rp.dispose();
      onlinePlayers.delete(id);
    }
  }

  // Update bots
  const botIds = new Set();
  for (const bData of snapshot.bots) {
    botIds.add(bData.id);
    let bot = onlineBots.get(bData.id);
    if (!bot) {
      bot = new RemotePlayerModel(bData.id, bData.name || 'Bot');
      onlineBots.set(bData.id, bot);
    }
    bot.targetPos = new THREE.Vector3(bData.pos.x, bData.pos.y || 0, bData.pos.z);
    bot.targetYaw = bData.yaw;
    bot.alive = bData.alive;
    bot.group.visible = bData.alive;
    bot.updateHealth(bData.health);
  }

  // Remove dead bots
  for (const [id, bot] of onlineBots) {
    if (!botIds.has(id)) {
      bot.dispose();
      onlineBots.delete(id);
    }
  }
}

function updateOnlinePlayers(dt) {
  for (const [id, rp] of onlinePlayers) {
    if (rp.targetPos) {
      rp.update(dt, rp.targetPos, rp.targetYaw, rp.walkPhase || 0, rp.speed || 0);
    }
  }
  for (const [id, bot] of onlineBots) {
    if (bot.targetPos) {
      bot.update(dt, bot.targetPos, bot.targetYaw, bot.walkPhase || 0, bot.speed || 0);
    }
  }
}

function sendPlayerState() {
  if (!isOnline || !CSNet || !CSNet.connected) return;
  const shoot = mouseDown || (isTouchDevice && touch.fire);
  const reload = keys.KeyR || false;
  CSNet.sendState(
    player.pos,
    player.yaw,
    player.pitch,
    player.speed,
    player.eye < 1.4,
    player.onGround,
    current === inventory.rifle ? 'rifle' : 'pistol',
    reload,
    shoot,
    null // hitRay - server validates
  );
}

// ── Online Mode Initialization ──
function initOnlineMode() {
  if (typeof CSNet === 'undefined') return;

  CSNet.onSnapshot = applySnapshot;
  CSNet.onMatchEnd = (results) => {
    isOnline = false;
    // Show results
    if (results && results.length > 0) {
      const myResult = results.find(r => r.id === CSNet.myId);
      if (myResult) {
        goScore.textContent = myResult.sc || 0;
        goXP.textContent = myResult.xp ? `+${myResult.xp} XP` : '--';
      }
    }
    triggerGameOver();
  };

  console.log('[CS] Online mode initialized');
}

// Check if we're starting an online game
window.startOnlineGame = function(roster) {
  isOnline = true;
  game.state = 'playing';
  game.round = 0;
  game.ct = 0;
  game.t = 0;
  game.kills = 0;
  game.timeLeft = 115;

  // Clear local bots - server owns them
  clearBots();

  // Reset local player
  resetPlayer();

  showScreen(gameScreen);
  if (!isTouchDevice) renderer.domElement.requestPointerLock();

  console.log('[CS] Online game started with', roster.length, 'players');
};

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

// Initialize online mode if net module is loaded
initOnlineMode();
