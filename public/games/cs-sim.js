/* ============================================================================
   Counter Strike — Online World Simulator
   ----------------------------------------------------------------------------
   The authoritative game state lives here: RaceHub.js simulates the match,
   owns all bot AI, validates hits, and broadcasts snapshots at 10Hz.

   Clients only stream their own position + aim + shoot state, and render
   the snapshot they get back. This prevents cheating and ensures all
   players see the same bots/round state.

   Map geometry and collision arithmetic come from cs-map.js — the SAME module
   the browser loads — so the hub's walls are the player's walls.

   No DOM and no wall-clock reads inside the stepping code — the hub calls
   step(world, dt) on a fixed 100ms tick.
   ============================================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./cs-map.js'));
  else root.CSSim = factory(root.CSMap);
})(typeof self !== 'undefined' ? self : this, function (CSMap) {
  'use strict';

  // ── Constants ──
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

  // Body metrics shared with the client's model: a standing figure occupies 0 → 1.8 m, and the
  // hub needs those numbers to decide which body part a validated ray actually crossed.
  const PLAYER_RADIUS = 0.35;
  const PLAYER_HEIGHT = 1.8;
  const PLAYER_EYE_STAND = 1.65;
  const PLAYER_EYE_CROUCH = 1.15;
  const BOT_HEIGHT = 1.8;

  // A bullet has to be judged where the shooter SAW the target, not where the hub keeps it. Cabinets
  // draw bots from a deliberately delayed snapshot buffer (INTERP_DELAY 110ms in script.js) on top of
  // one-way latency and a 100ms hub tick, so the image an athlete aims at is 150-250ms in the past.
  // Validated against the live position, a bot at alert speed covers 0.5-0.7m in that window — more
  // than the hit radius — and a clean body shot came back with no marker at all. That is what made
  // co-op enemies feel unkillable next to identical single-player bots, which are hit-tested in the
  // same frame they are drawn.
  const HIT_REWIND = 0.25; // seconds of client-side latency credited to the shooter
  const TRAIL_KEEP = 0.7;  // seconds of bot history to remember: the rewind plus round-trip slack
  const HIT_RADIUS = 0.5;  // horizontal miss tolerance, unchanged from the original test

  // How long a player row may keep a claimed speed with no packet behind it. Cabinets drive the
  // leg swing from the row's `speed`, and streaming stops the moment a round ends (playerInput
  // ignores claims outside 'playing' too), so a teammate who was sprinting when the clock hit zero
  // would march on the spot for the whole intermission: a frozen position plus a running gait is
  // precisely what a lagging player looks like, even though nothing on the wire is late.
  const STALE_INPUT = 0.3;

  // Transient combat events kept per world so every client can draw the tracer / hit / kill it
  // missed. Capped: a 4-player room spraying rifles for two seconds must not grow the snapshot.
  const FX_CAP = 48;

  // ── Helper Functions ──
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (a, b) => a + Math.random() * (b - a);
  const dist2D = (x1, z1, x2, z2) => Math.hypot(x2 - x1, z2 - z1);

  // All collision goes through cs-map.js so the hub and the browser agree bit for bit.
  const collide = (world, pos, r, h) => CSMap.collide(world.colliders, pos, r, h, CSMap.STEP);
  const ground = (world, pos, r) => CSMap.groundHeight(world.colliders, pos, r, CSMap.STEP);
  const free = (world, x, z, r) => CSMap.isFree(world.colliders, world.half, x, z, r);
  const los = (world, x1, z1, x2, z2) => CSMap.hasLOS(world.colliders, x1, z1, x2, z2);

  function pushFx(world, ev) {
    world.fx.push(ev);
    if (world.fx.length > FX_CAP) world.fx.splice(0, world.fx.length - FX_CAP);
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
      this.trail = []; // timestamped positions, newest last, for the hit rewind above
    }

    pickWaypoint(world) {
      const from = { x: this.pos.x, z: this.pos.z };
      for (let i = 0; i < 20; i++) {
        const w = world.waypoints[(Math.random() * world.waypoints.length) | 0];
        if (!w) continue;
        const dist = dist2D(from.x, from.z, w.x, w.z);
        if (dist > 5 && los(world, from.x, from.z, w.x, w.z)) {
          this.target = w;
          return;
        }
      }
      this.target = world.waypoints[(Math.random() * world.waypoints.length) | 0] || { x: 0, z: 0 };
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
          sees = los(world, this.pos.x, this.pos.z, closestPlayer.pos.x, closestPlayer.pos.z);
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
          const d = Math.hypot(dx, dz) || 1;
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
        if (!this.target) this.pickWaypoint(world);
        this.faceToward(this.target.x, this.target.z, dt, 5);
        const d = this.moveToward(this.target.x, this.target.z, BOT_SPEED, dt);
        moveSpeed = BOT_SPEED;
        if (d < 0.8) this.pickWaypoint(world);
      }

      // Collision — height-aware, so a bot walks over pavement and low barriers exactly like the
      // player does instead of gridlocking on a 18 cm curb.
      collide(world, this.pos, 0.4, BOT_HEIGHT);
      const edge = world.half - 1.5;
      this.pos.x = clamp(this.pos.x, -edge, edge);
      this.pos.z = clamp(this.pos.z, -edge, edge);
      this.pos.y = ground(world, this.pos, 0.4);

      // Stuck detection
      this.stuckTimer += dt;
      if (this.stuckTimer > BOT_STUCK_TIMER) {
        if (moveSpeed > 0 && dist2D(this.pos.x, this.pos.z, this.stuckRef.x, this.stuckRef.z) < 0.4) {
          if (!sees) {
            this.alert = false;
            this.pickWaypoint(world);
          }
        }
        this.stuckRef = { x: this.pos.x, z: this.pos.z };
        this.stuckTimer = 0;
      }

      // Walk animation
      const actual = dist2D(before.x, before.z, this.pos.x, this.pos.z) / Math.max(dt, 1e-4);
      this.walkPhase += dt * actual * 3.2;
      this.speed = actual;

      // Six samples at the hub's 10Hz tick comfortably span the visual lag a client shoots into.
      this.trail.push({ x: this.pos.x, y: this.pos.y, z: this.pos.z, t: world.now });
      while (this.trail.length > 2 && world.now - this.trail[0].t > TRAIL_KEEP) this.trail.shift();
    }

    shoot(world, target, dist) {
      // Muzzle event so every client draws the tracer and animates the shot
      const origin = { x: this.pos.x, y: this.pos.y + 1.45, z: this.pos.z };
      const dx = target.pos.x - this.pos.x, dz = target.pos.z - this.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      pushFx(world, {
        e: 'shot', by: 'b', id: this.id,
        o: [r2(origin.x), r2(origin.y), r2(origin.z)],
        d: [r2(dx / d), 0, r2(dz / d)],
      });

      // Calculate hit chance — these are the SINGLE-PLAYER cabinet's numbers, not the ones this file
      // carried. Its bots rolled 0.5 + round*0.035 against a 0.8 cap for 8-15 damage with an 8% chance
      // of a 2.5x spike, so the same athlete died roughly twice as fast in a co-op round as in a solo
      // one, and a match you cannot survive is exactly as unwinnable as a bot you cannot hit.
      // The wall check below stays, because a solo bot shooting through a warehouse is a bug rather
      // than difficulty.
      const moving = target.speed > 3.2 ? 0.18 : 0;
      const airborne = target.onGround ? 0 : 0.12;
      const crouchBonus = target.crouching ? 0.06 : 0;
      const chance = clamp(0.35 + world.round * 0.02 - dist * 0.009 - moving - airborne - crouchBonus, 0.08, 0.65);

      let hit = false;
      if (Math.random() < chance) {
        // Walls between bot and target genuinely stop the bullet — the roll used to fire blind,
        // so a bot behind a warehouse wall still killed you on the other side of it.
        hit = los(world, this.pos.x, this.pos.z, target.pos.x, target.pos.z);
        if (hit) {
          const dmg = Math.round(rand(5, 10) * (Math.random() < 0.06 ? 1.8 : 1));
          world.damagePlayer(target.id, dmg, this);
          pushFx(world, { e: 'hit', id: target.id, dmg, mine: Math.max(0, Math.round(target.health)) });
        }
      }
      pushFx(world, { e: 'tracer', by: 'b', id: this.id, vid: target.id, hit, to: [r2(target.pos.x), r2(target.pos.y + 1.2), r2(target.pos.z)] });

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

    // The caller applies the body-part multiplier exactly once, the way the cabinet does. This used
    // to multiply again, so a leg shot in co-op cost six rifle rounds instead of four and a head
    // shot was worth sixteen.
    damage(amount) {
      if (!this.alive) return false;
      this.health -= amount;
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
        pos: { x: r2(this.pos.x), y: r2(this.pos.y), z: r2(this.pos.z) },
        yaw: r3(this.yaw),
        health: Math.max(0, Math.round(this.health)),
        alive: this.alive,
        alert: this.alert,
        walkPhase: r2(this.walkPhase),
        speed: r2(this.speed)
      };
    }
  }

  const r2 = (v) => Math.round((v || 0) * 100) / 100;
  const r3 = (v) => Math.round((v || 0) * 1000) / 1000;

  // ── World Management ──
  function createWorld(playerIds, mapName) {
    const map = mapName && CSMap.MAPS[mapName] ? mapName : 'industrial';
    const info = CSMap.info(map);
    const world = {
      map,
      half: info.half,
      colliders: CSMap.collidersFor(map),
      waypoints: CSMap.waypoints(map, map === 'classic' ? 60 : 110),
      spawns: { ct: info.ct, t: info.t },
      round: 0,
      timeLeft: ROUND_TIME,
      state: 'lobby', // lobby, playing, roundEnd
      players: {},
      bots: [],
      scoreCT: 0,
      scoreT: 0,
      nextBotId: 1,
      endTimer: 0,
      fx: [],
      fxSeq: 1,
      now: 0, // monotonic seconds; the clock the hit rewind reads
    };
    // Bots damage players through the world, so the hub must hand them that door — without it the
    // first landed bot shot threw inside the shared 100ms tick and took every room's loop down.
    world.damagePlayer = (id, amount, attacker) => damagePlayer(world, id, amount, attacker);

    for (const id of playerIds) {
      world.players[String(id)] = createPlayer(id);
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
      lastInput: 0,
      shootCD: 0,
      reloading: 0,
      walkPhase: 0
    };
  }

  function spawnBots(world, count) {
    const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
    const band = world.spawns.t;
    for (let i = 0; i < count; i++) {
      let x, z, tries = 0;
      do {
        x = rand(band.xMin, band.xMax);
        z = rand(band.zMin, band.zMax);
        tries++;
      } while ((!free(world, x, z, 0.6) || world.bots.some(b => b.alive && dist2D(b.pos.x, b.pos.z, x, z) < 1.5)) && tries < 200);

      const bot = new Bot(world.nextBotId++, x, z, names[i % names.length]);
      bot.yaw = Math.PI;
      bot.pos.y = ground(world, bot.pos, 0.4);
      world.bots.push(bot);
    }
  }

  function resetPlayer(world, player) {
    const band = world.spawns.ct;
    let x, z, tries = 0;
    do {
      x = rand(band.xMin, band.xMax);
      z = rand(band.zMin, band.zMax);
      tries++;
    } while (!free(world, x, z, 0.5) && tries < 200);

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
    world.fx.length = 0;

    // Clear dead bots
    world.bots = world.bots.filter(b => b.alive);

    // Reset players
    for (const p of Object.values(world.players)) {
      resetPlayer(world, p);
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
    world.now += dt;

    // Outside the state branch on purpose: the intermission is exactly when packets stop arriving.
    for (const p of Object.values(world.players)) {
      if (p.speed > 0 && (!p.lastInput || world.now - p.lastInput > STALE_INPUT)) p.speed = 0;
    }

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
    const p = world.players[String(id)];
    if (!p || !p.alive || world.state !== 'playing') return;
    const pos = input.pos || {};
    if (typeof pos.x !== 'number' || typeof pos.z !== 'number') return;

    // Update position. y travels with it: the client owns the climb onto containers and up stair
    // runs, and without the height the hub would read a player standing on a deck as being inside
    // it and shove them back down in everyone else's view.
    p.pos.x = pos.x;
    p.pos.z = pos.z;
    p.pos.y = clamp(typeof pos.y === 'number' ? pos.y : 0, 0, 12);
    p.yaw = input.yaw || 0;
    p.pitch = input.pitch || 0;
    p.speed = input.speed || 0;
    p.lastInput = world.now;
    p.crouching = input.crouching || false;
    p.onGround = input.onGround !== false;

    // Collision, then keep the reported height honest with what the shared geometry says the
    // player is actually standing on.
    collide(world, p.pos, PLAYER_RADIUS, PLAYER_HEIGHT);
    const edge = world.half - 1.2;
    p.pos.x = clamp(p.pos.x, -edge, edge);
    p.pos.z = clamp(p.pos.z, -edge, edge);
    const g = ground(world, p.pos, PLAYER_RADIUS);
    if (p.pos.y < g) p.pos.y = g;
    else if (p.pos.y - g > 1.6) p.pos.y = g; // no teleporting onto a roof you cannot reach

    // Weapon switch. Unknown names are ignored rather than fatal: an older or patched client that
    // reported a weapon the hub has no table for used to throw here and stall the room's tick.
    if (input.weapon && input.weapon !== p.weapon && WEAPONS[input.weapon]) {
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
      // Direction in the client's convention: the cabinet aims with camera.rotation.order 'YXZ',
      // so forward is (-sin(yaw)cos(pitch), sin(pitch), -cos(yaw)cos(pitch)). Peers use this to
      // draw the tracer, and any other sign here would render every shot backwards on screen.
      pushFx(world, {
        e: 'shot', by: 'p', id: p.id,
        o: [r2(p.pos.x), r2(p.pos.y + (p.crouching ? PLAYER_EYE_CROUCH : PLAYER_EYE_STAND)), r2(p.pos.z)],
        d: [r2(-Math.sin(p.yaw) * Math.cos(p.pitch)), r2(Math.sin(p.pitch)), r2(-Math.cos(p.yaw) * Math.cos(p.pitch))],
      });
    }

    // Hit validation lives outside the shoot block on purpose. A cabinet sends exactly one ray per
    // shot it really fired, and a pistol tap released between two 100ms packets would otherwise
    // arrive with `shoot` already false — the bullet would fire on the shooter's screen and do
    // nothing in the shared world.
    if (input.hitRay) validateHit(world, p, input.hitRay);
  }

  // Where along a horizontal band a figure's body parts sit, used to turn a validated ray into a
  // head / torso / leg hit instead of the random roll this used to fake.
  function partAtHeight(relY) {
    if (relY > 2) return null; // a ray clearing the head is a miss; without this it scored a headshot
    if (relY > 1.55) return 'head';
    if (relY > 0.75) return 'body';
    if (relY > 0.05) return 'legs';
    return null;
  }

  // Where a bot was at time t, read back through the trail it keeps each tick. Anything with no
  // history yet — a bot spawned this second — is judged on its live position rather than given a
  // phantom rewind.
  function trailPosition(bot, t) {
    const trail = bot.trail;
    if (!trail || trail.length < 2) return bot.pos;
    if (t >= trail[trail.length - 1].t) return bot.pos;
    if (t <= trail[0].t) return trail[0];
    for (let i = trail.length - 1; i > 0; i--) {
      const a = trail[i - 1], b = trail[i];
      if (a.t <= t && t <= b.t) {
        const u = (t - a.t) / Math.max(1e-4, b.t - a.t);
        return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u };
      }
    }
    return trail[trail.length - 1];
  }

  // Does this ray cross the figure's volume, and where on it? One position at a time; validateHit
  // calls it for the seen position and the live one and keeps the nearer result.
  function rayHitsBot(ray, at, wallDist) {
    const ex = at.x - ray.ox, ez = at.z - ray.oz;
    const along = ex * ray.dx + ez * ray.dz;
    if (along <= 0 || along >= wallDist) return null;
    if (dist2D(ray.ox + ray.dx * along, ray.oz + ray.dz * along, at.x, at.z) > HIT_RADIUS) return null;
    const part = partAtHeight(ray.oy + ray.dy * along - at.y);
    return part ? { along, part } : null;
  }

  function validateHit(world, shooter, ray) {
    // Ray: { o:[x,y,z], d:[x,y,z], dist } — direction is a unit vector, all hub-side validated.
    if (!ray || !Array.isArray(ray.o) || !Array.isArray(ray.d)) return null;
    const [ox, oy, oz] = ray.o;
    let [dx, dy, dz] = ray.d;
    const len = Math.hypot(dx, dy, dz);
    if (!(len > 0.0001)) return null;
    dx /= len; dy /= len; dz /= len;
    const maxDist = clamp(ray.dist || 120, 1, 200);
    const shot = { ox, oy, oz, dx, dy, dz };

    // Distance to the nearest wall along the shot, from the shared geometry.
    const wall = CSMap.rayBlock(world.colliders, ox, oy, oz, dx, dy, dz, maxDist);
    const wallDist = wall ? wall.dist : maxDist;

    // Nearest bot the ray crosses before that wall, judged both where the shooter was shown it and
    // where the hub has it now, so the rewind can only ever be more forgiving than the live test.
    let best = null;
    const seenAt = world.now - HIT_REWIND;
    for (const bot of world.bots) {
      if (!bot.alive) continue;
      for (const at of [trailPosition(bot, seenAt), bot.pos]) {
        const hit = rayHitsBot(shot, at, wallDist);
        if (hit && (!best || hit.along < best.along)) best = { bot, along: hit.along, part: hit.part };
      }
    }
    if (!best) return null;

    const wdef = WEAPONS[shooter.weapon] || WEAPONS.rifle;
    const killed = best.bot.damage(wdef.dmg * PART_MULT[best.part]);
    shooter.kills += killed ? 1 : 0;
    pushFx(world, {
      e: 'hit', by: 'p', id: shooter.id, bot: best.bot.id, part: best.part,
      killed, dist: r2(best.along),
    });
    if (killed) {
      pushFx(world, { e: 'kill', by: shooter.id, victim: best.bot.id, name: best.bot.name, part: best.part });
      const alive = world.bots.some(b => b.alive);
      if (!alive) endRound(world, 'CT');
    }
    return { botId: best.bot.id, part: best.part, killed };
  }

  function damagePlayer(world, playerId, amount, attacker) {
    const p = world.players[String(playerId)];
    if (!p || !p.alive) return;

    p.health = Math.max(0, p.health - amount);
    if (p.health <= 0) {
      p.alive = false;
      p.deaths++;
      pushFx(world, { e: 'death', by: attacker && attacker.id, victim: p.id, name: p.name });
      // Everyone down ends the round for the terrorists' side.
      if (!Object.values(world.players).some(q => q.alive)) endRound(world, 'T');
    }
  }

  // Combat events are one-shot: they are drained here, at the moment the hub reads them to
  // broadcast, so a tracer/muzzle/hit is delivered to every client exactly once and never replays.
  //
  // `t` is part of the payload, not decoration: the cabinet drops any frame whose `t` is not a
  // string (pacman-sim already tags its own snapshot), so an untagged world here means the hub
  // streams a match nobody renders — no terrorists, no teammates, an empty arena.
  function snapshot(world) {
    const fx = world.fx.slice();
    world.fx.length = 0;
    return {
      t: 'snapshot',
      map: world.map,
      round: world.round,
      timeLeft: r2(world.timeLeft),
      state: world.state,
      scoreCT: world.scoreCT,
      scoreT: world.scoreT,
      players: Object.values(world.players).map(p => ({
        id: p.id,
        name: p.name,
        pos: { x: r2(p.pos.x), y: r2(p.pos.y), z: r2(p.pos.z) },
        yaw: r3(p.yaw),
        pitch: r3(p.pitch),
        health: Math.max(0, Math.round(p.health)),
        alive: p.alive,
        crouching: p.crouching,
        onGround: p.onGround !== false,
        weapon: p.weapon,
        kills: p.kills,
        deaths: p.deaths,
        speed: r2(p.speed),
        walkPhase: r2(p.walkPhase)
      })),
      bots: world.bots.map(b => b.snapshot()),
      fx,
      endTimer: r2(world.endTimer)
    };
  }

  function setPlayerName(world, id, name) {
    if (world.players[String(id)]) {
      world.players[String(id)].name = name;
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
    ROUND_TIME,
  };
});
