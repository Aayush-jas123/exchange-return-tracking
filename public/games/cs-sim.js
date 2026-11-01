/* ============================================================================
   Counter Strike — Online World Simulator
   ----------------------------------------------------------------------------
   The authoritative game state lives here: RaceHub.js simulates the match,
   owns all bot AI, validates hits, and broadcasts snapshots at 10Hz.
   
   Clients only stream their own position + aim + shoot state, and render
   the snapshot they get back. This prevents cheating and ensures all
   players see the same bots/round state.
   
   No DOM and no wall-clock reads inside the stepping code — the hub calls
   step(world, dt) on a fixed 100ms tick.
   ============================================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CSSim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── Constants ──
  const MAP_SIZE = 66; // 66x66 play area
  const HALF_MAP = MAP_SIZE / 2;
  const ROUND_TIME = 115; // seconds
  const BOT_NAMES = ['Viper', 'Jackal', 'Cobra', 'Raven', 'Ghost', 'Hyena', 'Scorpion', 'Wolf', 'Falcon', 'Mamba', 'Rook', 'Shadow'];
  
  // Weapon definitions
  const WEAPONS = {
    rifle: { name: 'RIFLE', mag: 30, reserve: 90, rate: 0.1, auto: true, dmg: 34, reload: 2.3, spread: 0.004, recoil: 0.011, speed: 6.0 },
    pistol: { name: 'PISTOL', mag: 12, reserve: 48, rate: 0.17, auto: false, dmg: 27, reload: 1.6, spread: 0.006, recoil: 0.02, speed: 6.5 },
  };
  
  // Hit multipliers
  const PART_MULT = { head: 4, body: 1, legs: 0.75 };
  
  // Bot AI constants
  const BOT_SPEED = 2.4;
  const BOT_ALERT_SPEED = 3.6;
  const BOT_SHOOT_RANGE = 28;
  const BOT_REACTION_MIN = 0.15;
  const BOT_REACTION_MAX = 0.85;
  const BOT_STRAFE_SPEED = 2.2;
  const BOT_STRAFE_CHANGE_MIN = 0.5;
  const BOT_STRAFE_CHANGE_MAX = 1.4;
  const BOT_LOST_TIMER = 7;
  const BOT_STUCK_TIMER = 1.2;
  
  // Player constants
  const PLAYER_RADIUS = 0.35;
  const PLAYER_HEIGHT = 1.8;
  const PLAYER_EYE_STAND = 1.65;
  const PLAYER_EYE_CROUCH = 1.15;
  const PLAYER_SPEED = 6.0;
  const PLAYER_CROUCH_SPEED = 2.2;
  
  // Spawn zones
  const CT_SPAWN = { xMin: -6, xMax: 6, zMin: -30, zMax: -26 }; // South (player start)
  const T_SPAWN = { xMin: -14, xMax: 14, zMin: 23, zMax: 30 }; // North (bot start)
  
  // ── Map Colliders (simplified AABB) ──
  // Format: { minX, maxX, minZ, maxZ, minY, maxY }
  const COLLIDERS = [
    // Outer walls
    { minX: -HALF_MAP, maxX: HALF_MAP, minZ: -32.5 - 0.5, maxZ: -32.5 + 0.5, minY: 0, maxY: 7 },
    { minX: -HALF_MAP, maxX: HALF_MAP, minZ: 32.5 - 0.5, maxZ: 32.5 + 0.5, minY: 0, maxY: 7 },
    { minX: -32.5 - 0.5, maxX: -32.5 + 0.5, minZ: -HALF_MAP, maxZ: HALF_MAP, minY: 0, maxY: 7 },
    { minX: 32.5 - 0.5, maxX: 32.5 + 0.5, minZ: -HALF_MAP, maxZ: HALF_MAP, minY: 0, maxY: 7 },
    
    // Internal walls
    { minX: -18 - 10, maxX: -18 + 10, minZ: -0.6, maxZ: 0.6, minY: 0, maxY: 5 },
    { minX: 18 - 10, maxX: 18 + 10, minZ: -0.6, maxZ: 0.6, minY: 0, maxY: 5 },
    { minX: -3 - 0.6, maxX: 3 + 0.6, minZ: -3, maxZ: 3, minY: 0, maxY: 4.2 }, // Central box
    
    // Large structures
    { minX: -22 - 4, maxX: -22 + 4, minZ: -14 - 5, maxZ: -14 + 5, minY: 0, maxY: 5.5 },
    { minX: 22 - 5, maxX: 22 + 5, minZ: 16 - 4, maxZ: 16 + 4, minY: 0, maxY: 5.5 },
    { minX: -4 - 3, maxX: -4 + 3, minZ: 15 - 2, maxZ: 15 + 2, minY: 0, maxY: 3.5 },
    { minX: 5 - 2, maxX: 5 + 2, minZ: -14 - 3, maxZ: -14 + 3, minY: 0, maxY: 3.5 },
    
    // Corridor walls
    { minX: -10 - 0.6, maxX: -10 + 0.6, minZ: 19 - 6, maxZ: 19 + 6, minY: 0, maxY: 4.5 },
    { minX: 11 - 0.6, maxX: 11 + 0.6, minZ: -20 - 6, maxZ: -20 + 6, minY: 0, maxY: 4.5 },
    { minX: -26 - 4, maxX: -26 + 4, minZ: 10 - 0.6, maxZ: 10 + 0.6, minY: 0, maxY: 4 },
    { minX: 26 - 4, maxX: 26 + 4, minZ: -8 - 0.6, maxZ: -8 + 0.6, minY: 0, maxY: 4 },
    
    // Metal platforms
    { minX: 16 - 3, maxX: 16 + 3, minZ: 6 - 1.2, maxZ: 6 + 1.2, minY: 0, maxY: 2.6 },
    { minX: -15 - 1.2, maxX: -15 + 1.2, minZ: -6 - 3, maxZ: -6 + 3, minY: 0, maxY: 2.6 },
  ];
  
  // ── Waypoints for bot patrol ──
  const WAYPOINTS = [];
  for (let i = 0; i < 60; i++) {
    WAYPOINTS.push({
      x: (Math.random() - 0.5) * 60,
      y: (Math.random() - 0.5) * 60
    });
  }
  
  // ── Helper Functions ──
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (a, b) => a + Math.random() * (b - a);
  const dist2D = (x1, z1, x2, z2) => Math.hypot(x2 - x1, z2 - z1);
  
  function circleHitsBox(x, z, r, c) {
    const dx = x - clamp(x, c.minX, c.maxX);
    const dz = z - clamp(z, c.minZ, c.maxZ);
    return dx * dx + dz * dz < r * r;
  }
  
  function collide(pos, r) {
    for (const c of COLLIDERS) {
      if (!circleHitsBox(pos.x, pos.z, r, c)) continue;
      const cx = clamp(pos.x, c.minX, c.maxX);
      const cz = clamp(pos.z, c.minZ, c.maxZ);
      const dx = pos.x - cx;
      const dz = pos.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        pos.x += (dx / d) * (r - d);
        pos.z += (dz / d) * (r - d);
      } else {
        const pl = pos.x - c.minX;
        const pr = c.maxX - pos.x;
        const pb = pos.z - c.minZ;
        const pf = c.maxZ - pos.z;
        const m = Math.min(pl, pr, pb, pf);
        if (m === pl) pos.x = c.minX - r;
        else if (m === pr) pos.x = c.maxX + r;
        else if (m === pb) pos.z = c.minZ - r;
        else pos.z = c.maxZ + r;
      }
    }
  }
  
  function isFree(x, z, r) {
    if (Math.abs(x) > HALF_MAP - r || Math.abs(z) > HALF_MAP - r) return false;
    return !COLLIDERS.some(c => circleHitsBox(x, z, r, c));
  }
  
  function hasLOS(x1, z1, x2, z2) {
    const dx = x2 - x1;
    const dz = z2 - z1;
    const dist = Math.hypot(dx, dz);
    const steps = Math.ceil(dist / 0.5);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = x1 + dx * t;
      const z = z1 + dz * t;
      if (COLLIDERS.some(c => x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ)) {
        return false;
      }
    }
    return true;
  }
  
  // ── Bot Class ──
  class Bot {
    constructor(id, x, z, name) {
      this.id = id;
      this.name = name;
      this.pos = { x, y: 0, z };
      this.vel = { x: 0, z: 0 };
      this.yaw = 0;
      this.health = 100;
      this.alive = true;
      this.alert = false;
      this.lastSeen = { x: 0, z: 0 };
      this.lostTimer = 0;
      this.reaction = 0;
      this.shootCD = 0;
      this.strafeDir = 0;
      this.strafeTimer = 0;
      this.target = null;
      this.stuckTimer = 0;
      this.stuckRef = { x, z };
      this.walkPhase = Math.random() * 10;
      this.speed = 0;
    }
    
    pickWaypoint() {
      const from = { x: this.pos.x, z: this.pos.z };
      for (let i = 0; i < 20; i++) {
        const w = WAYPOINTS[(Math.random() * WAYPOINTS.length) | 0];
        const dist = dist2D(from.x, from.z, w.x, w.y);
        if (dist > 5 && hasLOS(from.x, from.z, w.x, w.y)) {
          this.target = w;
          return;
        }
      }
      this.target = WAYPOINTS[(Math.random() * WAYPOINTS.length) | 0];
    }
    
    moveToward(tx, tz, speed, dt) {
      const dx = tx - this.pos.x;
      const dz = tz - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.05) return d;
      const s = Math.min(speed * dt, d);
      this.pos.x += (dx / d) * s;
      this.pos.z += (dz / d) * s;
      return d;
    }
    
    faceToward(tx, tz, dt, rate = 8) {
      const want = Math.atan2(tx - this.pos.x, tz - this.pos.z);
      let diff = want - this.yaw;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      this.yaw += diff * Math.min(1, rate * dt);
      return Math.abs(diff);
    }
    
    update(dt, world) {
      if (!this.alive) return;
      
      const before = { x: this.pos.x, z: this.pos.z };
      let moveSpeed = 0;
      
      // Find closest alive player
      let closestPlayer = null;
      let closestDist = Infinity;
      for (const p of Object.values(world.players)) {
        if (!p.alive) continue;
        const d = dist2D(this.pos.x, this.pos.z, p.pos.x, p.pos.z);
        if (d < closestDist) {
          closestDist = d;
          closestPlayer = p;
        }
      }
      
      // Check line of sight to closest player
      let sees = false;
      if (closestPlayer && closestDist < 55) {
        const dx = closestPlayer.pos.x - this.pos.x;
        const dz = closestPlayer.pos.z - this.pos.z;
        let ang = Math.atan2(dx, dz) - this.yaw;
        ang = Math.abs(Math.atan2(Math.sin(ang), Math.cos(ang)));
        if (this.alert || ang < 1.25 || closestDist < 3) {
          sees = hasLOS(this.pos.x, this.pos.z, closestPlayer.pos.x, closestPlayer.pos.z);
        }
      }
      
      if (sees && closestPlayer) {
        // Combat mode
        if (!this.alert) this.reaction = rand(0.45, 0.85) / (1 + world.round * 0.08);
        this.alert = true;
        this.lastSeen = { x: closestPlayer.pos.x, z: closestPlayer.pos.z };
        this.lostTimer = 0;
        this.faceToward(closestPlayer.pos.x, closestPlayer.pos.z, dt, 10);
        this.reaction -= dt;
        
        // Strafe
        this.strafeTimer -= dt;
        if (this.strafeTimer <= 0) {
          this.strafeDir = [-1, 0, 1][(Math.random() * 3) | 0];
          this.strafeTimer = rand(BOT_STRAFE_CHANGE_MIN, BOT_STRAFE_CHANGE_MAX);
        }
        if (this.strafeDir) {
          const dx = closestPlayer.pos.x - this.pos.x;
          const dz = closestPlayer.pos.z - this.pos.z;
          const d = Math.hypot(dx, dz);
          const sx = (dz / d) * this.strafeDir;
          const sz = (-dx / d) * this.strafeDir;
          this.pos.x += sx * BOT_STRAFE_SPEED * dt;
          this.pos.z += sz * BOT_STRAFE_SPEED * dt;
          moveSpeed = BOT_STRAFE_SPEED;
        }
        
        // Approach if far
        if (closestDist > 22) {
          this.moveToward(closestPlayer.pos.x, closestPlayer.pos.z, 2.5, dt);
          moveSpeed = 2.5;
        }
        
        // Shoot
        if (this.reaction <= 0) {
          this.shootCD -= dt;
          if (this.shootCD <= 0 && closestPlayer) {
            this.shoot(world, closestPlayer, closestDist);
            this.shootCD = Math.random() < 0.6 ? rand(0.1, 0.16) : rand(0.35, 0.8);
          }
        }
      } else if (this.alert) {
        // Search mode
        this.lostTimer += dt;
        this.faceToward(this.lastSeen.x, this.lastSeen.z, dt);
        const d = this.moveToward(this.lastSeen.x, this.lastSeen.z, BOT_ALERT_SPEED, dt);
        moveSpeed = BOT_ALERT_SPEED;
        if (d < 1.2 || this.lostTimer > BOT_LOST_TIMER) {
          this.alert = false;
          this.target = null;
        }
      } else {
        // Patrol mode
        if (!this.target) this.pickWaypoint();
        this.faceToward(this.target.x, this.target.y, dt, 5);
        const d = this.moveToward(this.target.x, this.target.y, BOT_SPEED, dt);
        moveSpeed = BOT_SPEED;
        if (d < 0.8) this.pickWaypoint();
      }
      
      // Collision
      collide(this.pos, 0.4);
      this.pos.x = clamp(this.pos.x, -31.5, 31.5);
      this.pos.z = clamp(this.pos.z, -31.5, 31.5);
      
      // Stuck detection
      this.stuckTimer += dt;
      if (this.stuckTimer > BOT_STUCK_TIMER) {
        if (moveSpeed > 0 && dist2D(this.pos.x, this.pos.z, this.stuckRef.x, this.stuckRef.z) < 0.4) {
          if (!sees) {
            this.alert = false;
            this.pickWaypoint();
          }
        }
        this.stuckRef = { x: this.pos.x, z: this.pos.z };
        this.stuckTimer = 0;
      }
      
      // Walk animation
      const actual = dist2D(before.x, before.z, this.pos.x, this.pos.z) / Math.max(dt, 1e-4);
      this.walkPhase += dt * actual * 3.2;
      this.speed = actual;
    }
    
    shoot(world, target, dist) {
      // Calculate hit chance
      const moving = target.speed > 3.2 ? 0.18 : 0;
      const airborne = target.onGround ? 0 : 0.12;
      const crouchBonus = target.crouching ? 0.06 : 0;
      const chance = clamp(0.5 + world.round * 0.035 - dist * 0.009 - moving - airborne - crouchBonus, 0.1, 0.8);
      
      if (Math.random() < chance) {
        // Hit
        const dmg = Math.round(rand(8, 15) * (Math.random() < 0.08 ? 2.5 : 1));
        world.damagePlayer(target.id, dmg, this);
      }
      
      // Alert nearby bots
      for (const bot of world.bots) {
        if (bot === this || !bot.alive) continue;
        if (dist2D(bot.pos.x, bot.pos.z, this.pos.x, this.pos.z) < BOT_SHOOT_RANGE) {
          bot.alert = true;
          bot.lastSeen = { x: target.pos.x, z: target.pos.z };
          bot.lostTimer = 0;
        }
      }
    }
    
    damage(amount, part) {
      if (!this.alive) return false;
      this.health -= amount * (PART_MULT[part] || 1);
      if (!this.alert) this.reaction = rand(BOT_REACTION_MIN, BOT_REACTION_MAX);
      this.alert = true;
      if (this.health <= 0) {
        this.alive = false;
        return true;
      }
      return false;
    }
    
    snapshot() {
      return {
        id: this.id,
        name: this.name,
        pos: this.pos,
        yaw: this.yaw,
        health: this.health,
        alive: this.alive,
        alert: this.alert,
        walkPhase: this.walkPhase,
        speed: this.speed
      };
    }
  }
  
  // ── World Management ──
  function createWorld(playerIds) {
    const world = {
      round: 0,
      timeLeft: ROUND_TIME,
      state: 'lobby', // lobby, playing, roundEnd
      players: {},
      bots: [],
      scoreCT: 0,
      scoreT: 0,
      nextBotId: 1,
      endTimer: 0
    };
    
    // Initialize players
    for (const id of playerIds) {
      world.players[id] = createPlayer(id);
    }
    
    return world;
  }
  
  function createPlayer(id) {
    return {
      id,
      name: '',
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      yaw: Math.PI,
      pitch: 0,
      health: 100,
      alive: true,
      crouching: false,
      onGround: true,
      weapon: 'rifle',
      ammo: WEAPONS.rifle.mag,
      reserve: WEAPONS.rifle.reserve,
      kills: 0,
      deaths: 0,
      speed: 0,
      shootCD: 0,
      reloading: 0,
      walkPhase: 0
    };
  }
  
  function spawnBots(world, count) {
    const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
    for (let i = 0; i < count; i++) {
      let x, z, tries = 0;
      do {
        x = rand(T_SPAWN.xMin, T_SPAWN.xMax);
        z = rand(T_SPAWN.zMin, T_SPAWN.zMax);
        tries++;
      } while ((!isFree(x, z, 0.6) || world.bots.some(b => b.alive && dist2D(b.pos.x, b.pos.z, x, z) < 1.5)) && tries < 200);
      
      const bot = new Bot(world.nextBotId++, x, z, names[i % names.length]);
      bot.yaw = Math.PI;
      world.bots.push(bot);
    }
  }
  
  function resetPlayer(player) {
    let x, z;
    do {
      x = rand(CT_SPAWN.xMin, CT_SPAWN.xMax);
      z = rand(CT_SPAWN.zMin, CT_SPAWN.zMax);
    } while (!isFree(x, z, 0.5));
    
    player.pos = { x, y: 0, z };
    player.vel = { x: 0, y: 0, z: 0 };
    player.yaw = Math.PI;
    player.pitch = 0;
    player.health = 100;
    player.alive = true;
    player.crouching = false;
    player.onGround = true;
    player.weapon = 'rifle';
    player.ammo = WEAPONS.rifle.mag;
    player.reserve = WEAPONS.rifle.reserve;
    player.speed = 0;
    player.shootCD = 0;
    player.reloading = 0;
    player.walkPhase = 0;
  }
  
  function startRound(world) {
    world.round++;
    world.state = 'playing';
    world.timeLeft = ROUND_TIME;
    
    // Clear dead bots
    world.bots = world.bots.filter(b => b.alive);
    
    // Reset players
    for (const p of Object.values(world.players)) {
      resetPlayer(p);
    }
    
    // Spawn new bots
    const count = Math.min(3 + Math.floor(world.round / 2), 8);
    spawnBots(world, count);
  }
  
  function endRound(world, winner) {
    if (world.state !== 'playing') return;
    world.state = 'roundEnd';
    world.endTimer = 4;
    
    if (winner === 'CT') {
      world.scoreCT++;
    } else {
      world.scoreT++;
    }
  }
  
  function step(world, dt) {
    if (world.state === 'playing') {
      world.timeLeft -= dt;
      
      // Update bots
      for (const bot of world.bots) {
        bot.update(dt, world);
      }
      
      // Update players
      for (const p of Object.values(world.players)) {
        if (!p.alive) continue;
        
        // Reload
        if (p.reloading > 0) {
          p.reloading -= dt;
          if (p.reloading <= 0) {
            p.reloading = 0;
            const w = WEAPONS[p.weapon];
            const need = w.mag - p.ammo;
            const take = Math.min(need, p.reserve);
            p.ammo += take;
            p.reserve -= take;
          }
        }
        
        // Shoot cooldown
        p.shootCD = Math.max(0, p.shootCD - dt);
        
        // Walk animation
        p.walkPhase += dt * p.speed * 3.2;
      }
      
      // Check round end
      const aliveBots = world.bots.filter(b => b.alive);
      if (aliveBots.length === 0) {
        endRound(world, 'CT');
      } else if (world.timeLeft <= 0) {
        endRound(world, 'T');
      }
    } else if (world.state === 'roundEnd') {
      world.endTimer -= dt;
      if (world.endTimer <= 0) {
        startRound(world);
      }
    }
  }
  
  function playerInput(world, id, input) {
    const p = world.players[id];
    if (!p || !p.alive || world.state !== 'playing') return;
    
    // Update position
    p.pos.x = input.pos.x;
    p.pos.z = input.pos.z;
    p.yaw = input.yaw;
    p.pitch = input.pitch;
    p.speed = input.speed || 0;
    p.crouching = input.crouching || false;
    p.onGround = input.onGround !== false;
    
    // Collision
    collide(p.pos, PLAYER_RADIUS);
    p.pos.x = clamp(p.pos.x, -31.5, 31.5);
    p.pos.z = clamp(p.pos.z, -31.5, 31.5);
    
    // Weapon switch
    if (input.weapon && input.weapon !== p.weapon) {
      p.weapon = input.weapon;
      p.ammo = WEAPONS[input.weapon].mag;
      p.reserve = WEAPONS[input.weapon].reserve;
    }
    
    // Reload
    if (input.reload && p.reloading <= 0 && p.ammo < WEAPONS[p.weapon].mag && p.reserve > 0) {
      p.reloading = WEAPONS[p.weapon].reload;
    }
    
    // Shoot
    if (input.shoot && p.shootCD <= 0 && p.reloading <= 0 && p.ammo > 0) {
      p.shootCD = WEAPONS[p.weapon].rate;
      p.ammo--;
      
      // Validate hits against bots
      if (input.hitRay) {
        validateHit(world, p, input.hitRay);
      }
    }
  }
  
  function validateHit(world, shooter, ray) {
    // Ray: { origin: {x, z}, dir: {x, z}, maxDist }
    const maxDist = ray.maxDist || 200;
    const step = 0.5;
    const steps = Math.ceil(maxDist / step);
    
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = ray.origin.x + ray.dir.x * maxDist * t;
      const z = ray.origin.z + ray.dir.z * maxDist * t;
      
      // Check wall collision
      if (COLLIDERS.some(c => x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ)) {
        return null; // Hit wall
      }
      
      // Check bot collision
      for (const bot of world.bots) {
        if (!bot.alive) continue;
        if (dist2D(x, z, bot.pos.x, bot.pos.z) < 0.5) {
          // Hit bot
          const part = Math.random() < 0.2 ? 'head' : Math.random() < 0.7 ? 'body' : 'legs';
          const dmg = WEAPONS[shooter.weapon].dmg * PART_MULT[part];
          const killed = bot.damage(dmg, part);
          
          if (killed) {
            shooter.kills++;
            return { botId: bot.id, botName: bot.name, part, killed: true };
          }
          return { botId: bot.id, botName: bot.name, part, killed: false };
        }
      }
    }
    
    return null; // No hit
  }
  
  function damagePlayer(world, playerId, amount, attacker) {
    const p = world.players[playerId];
    if (!p || !p.alive) return;
    
    p.health = Math.max(0, p.health - amount);
    if (p.health <= 0) {
      p.alive = false;
      p.deaths++;
      if (attacker && world.players[attacker.id]) {
        // Bot killed player
      }
    }
  }
  
  function snapshot(world) {
    return {
      round: world.round,
      timeLeft: world.timeLeft,
      state: world.state,
      scoreCT: world.scoreCT,
      scoreT: world.scoreT,
      players: Object.values(world.players).map(p => ({
        id: p.id,
        name: p.name,
        pos: p.pos,
        yaw: p.yaw,
        pitch: p.pitch,
        health: p.health,
        alive: p.alive,
        crouching: p.crouching,
        weapon: p.weapon,
        kills: p.kills,
        deaths: p.deaths,
        walkPhase: p.walkPhase,
        speed: p.speed
      })),
      bots: world.bots.map(b => b.snapshot()),
      endTimer: world.endTimer
    };
  }
  
  function setPlayerName(world, id, name) {
    if (world.players[id]) {
      world.players[id].name = name;
    }
  }
  
  function aliveBots(world) {
    return world.bots.filter(b => b.alive);
  }
  
  // ── Public API ──
  return {
    createWorld,
    step,
    playerInput,
    snapshot,
    startRound,
    endRound,
    setPlayerName,
    aliveBots,
    damagePlayer,
    WEAPONS,
    MAP_SIZE,
    HALF_MAP,
    ROUND_TIME
  };
});
