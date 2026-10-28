// ============================================================================
// RaceHub — live presence, lobbies and multiplayer Rooftop Race
// ----------------------------------------------------------------------------
// One WebSocket endpoint (/ws/race) shared by the athlete portal and the game:
//   - presence: who is live (portal or in the arcade) and which room they're in
//   - rooms:    host creates, others join by code / invite, host starts a race
//   - race:     every client simulates the same seeded world and streams its
//               inputs (tick-stamped); the hub replays them through the shared
//               simulation, so positions, deaths and scores are server truth
//   - solo:     solo runs are replayed the same way before arcade XP is paid
//   - XP:       awarded server-side by finishing position (never by the client)
// State is in-memory by design — a single Render instance, rooms are ephemeral.
// ============================================================================

const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const Sim = require('../../public/games/rooftop-sim');
const PM = require('../../public/games/pacman-sim');

const PATH = '/ws/race';
const MAX_ROOM = 6;
// Every cabinet shares this hub, so each room names the game it belongs to and
// the clients filter lobbies by it — a rooftop client must never join a ping-pong room.
const GAME_LABELS = {
  'rooftop-racing': 'Rooftop Racing',
  'fruit-ninja': 'Fruit Ninja',
  'ping-pong': 'Ping Pong',
  'pac-man': 'Pac-Man',
  'crossy-road': 'Crossy Road'
};
const ROOM_MAX = { 'ping-pong': 2, 'pac-man': 4, 'crossy-road': 4 };
const PLAY_MS = 10 * 60 * 1000;   // a match nobody reports an end for still hands the lobby back
function normalizeGame(v) { return Object.prototype.hasOwnProperty.call(GAME_LABELS, v) ? v : 'rooftop-racing'; }
function isArcade(game) { return game === 'ping-pong' || game === 'pac-man' || game === 'crossy-road'; }
const COUNTDOWN_MS = 3500;
const RACE_MS = 180000;          // hard cap so infinite runs still finish
const GRACE_MS = 4000;           // late "end" reports after the cap
const RECONNECT_MS = 8000;       // a racer who drops gets this long to come back
const TICK_MS = 100;
const MIN_SCORE_FOR_XP = 400;    // metres (~20s of running) — keeps AFK racers from farming XP
const TPS = 60;                  // simulation ticks per second (Sim.STEP)
const RACE_TICKS = RACE_MS / 1000 * TPS;
const SOLO_TICKS = 15 * 60 * TPS; // solo runs are endless in theory — 15 min bound for the replay
const TICK_SLACK = 30;           // a client may be ≤0.5s ahead of the hub's clock
const LAG_TICKS = 240;           // >4s behind real time (hidden tab, slow-mo) → the hub runs you without inputs
const MAX_PENDING = 600;         // unapplied inputs held per run
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function now() { return Date.now(); }
function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}
function num(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

// ── Default athlete resolver + XP award (overridable for tests) ──
const athleteCache = new Map(); // id -> { at, info }
async function defaultResolve(rawToken) {
  const TokenService = require('./TokenService');
  const resolved = await TokenService.resolve(rawToken);
  if (!resolved || resolved.scope !== 'PROGRESS') return null;
  const id = resolved.influencerId;
  const hit = athleteCache.get(id);
  if (hit && now() - hit.at < 5 * 60 * 1000) return hit.info;

  const supabase = require('../../config/supabase');
  const { data: a } = await supabase
    .from('influencers')
    .select('id, name, instagram_handle, level_id')
    .eq('id', id)
    .maybeSingle();
  if (!a) return null;
  let level = '';
  if (a.level_id) {
    const { data: l } = await supabase.from('comfort_levels').select('display_name').eq('id', a.level_id).maybeSingle();
    level = l?.display_name || '';
  }
  const info = { id: a.id, name: (a.name || a.instagram_handle || 'Athlete').trim(), level };
  athleteCache.set(id, { at: now(), info });
  return info;
}

async function evaluateLevel(influencerId) {
  const LevelEngine = require('./LevelEngine');
  try { await LevelEngine.evaluate(influencerId); } catch (e) { console.error('[RaceHub] level evaluation failed:', e.message); }
}
async function defaultAward(influencerId, raceId, rank, field) {
  const GamificationService = require('./GamificationService');
  const r = await GamificationService.awardRaceXp(influencerId, raceId, rank, field);
  if (r.awarded > 0) await evaluateLevel(influencerId);
  return r;
}
// `game` names the cabinet that paid the run, so a Pac-Man or Ping Pong score
// converts with that game's own units-per-XP rate and lands on that game's
// ladder instead of being counted as metres run on the rooftops.
async function defaultAwardRun(influencerId, score, runId, game = 'rooftop-racing') {
  const GamificationService = require('./GamificationService');
  // Only a Rooftop run is replayed from logged inputs, so it is the only one the
  // arcade treats as verified; the other cabinets have no such gate.
  const r = await GamificationService.awardGameXp(influencerId, game, score, runId, { verified: game === 'rooftop-racing' });
  if (r.awarded > 0) await evaluateLevel(influencerId);
  return r;
}

// ── Replay helpers: a "run" is { sim, pend, ni, startAt, cap } ──
function newRun(seed, kit, startAt, cap) {
  return { sim: Sim.createSim(seed, kit), pend: [], ni: 0, startAt, cap };
}
function wallTicks(run) { return Math.floor((now() - run.startAt) * TPS / 1000); }
// Append a batch of inputs. `o` is the client's index of the first entry, so
// resends are de-duplicated and gaps (lost frames) are detected.
function ingest(run, msg) {
  const o = Math.floor(num(msg.o, 0, 1e9));
  const list = Array.isArray(msg.i) ? msg.i : [];
  if (list.length > 240) return false;
  if (o > run.ni) return false;
  for (let j = run.ni - o; j < list.length; j++) {
    const v = Number(list[j]);
    if (run.pend.length < MAX_PENDING) run.pend.push(Number.isInteger(v) && v > 0 ? v : 0);
    run.ni++;
  }
  return true;
}
// Simulate up to the client's tick, never past real time or the run's cap.
function advanceRun(run, k) {
  const lim = Math.min(Math.floor(num(k, 0, run.cap)), wallTicks(run) + TICK_SLACK, run.cap);
  Sim.advance(run.sim, lim, run.pend);
}
function forceLagging(run) {
  const lagK = Math.min(run.cap, wallTicks(run) - LAG_TICKS);
  if (run.sim.k < lagK) { Sim.advance(run.sim, lagK, run.pend); return true; }
  return false;
}
const runOver = run => run.sim.p.st === Sim.DEAD || run.sim.k >= run.cap;

function createHub({ resolveAthlete = defaultResolve, awardXp = defaultAward, awardRun = defaultAwardRun } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  const athletes = new Map(); // id -> { id, name, level, sockets:Set<ws> }
  const rooms = new Map();    // code -> room
  const solos = new Set();    // live solo sockets (ws.solo)
  const inviteLog = new Map(); // `${from}:${to}` -> ms
  let presenceTimer = null;

  // ── Presence ──
  function presencePayload() {
    const a = [];
    for (const p of athletes.values()) {
      let inGame = false, room = null;
      for (const ws of p.sockets) {
        if (ws.kind === 'game') inGame = true;
        if (ws.room) room = ws.room;
      }
      const rm = room && rooms.get(room);
      a.push({ id: p.id, n: p.name, lv: p.level, w: inGame ? 'game' : 'portal', r: rm ? rm.code : null, s: rm ? rm.status : null, g: rm ? rm.game : null });
    }
    const list = [];
    for (const rm of rooms.values()) {
      const host = rm.members.get(rm.hostId);
      list.push({ r: rm.code, h: host ? host.name : '', n: rm.members.size, max: rm.max || MAX_ROOM, s: rm.status, game: rm.game || 'rooftop-racing' });
    }
    return JSON.stringify({ t: 'pr', a, rooms: list });
  }
  function schedulePresence() {
    if (presenceTimer) return;
    presenceTimer = setTimeout(() => {
      presenceTimer = null;
      const msg = presencePayload();
      for (const ws of wss.clients) send(ws, msg);
    }, 300);
  }

  // ── Rooms ──
  function newCode() {
    for (;;) {
      let c = '';
      const bytes = crypto.randomBytes(4);
      for (let i = 0; i < 4; i++) c += ROOM_ALPHABET[bytes[i] % ROOM_ALPHABET.length];
      if (!rooms.has(c)) return c;
    }
  }
  function freeColor(rm) {
    const used = new Set([...rm.members.values()].map(m => m.c));
    for (let i = 0; i < MAX_ROOM; i++) if (!used.has(i)) return i;
    return 0;
  }
  function roomState(rm) {
    return {
      t: 'room', r: rm.code, host: rm.hostId, s: rm.status, g: rm.game, max: rm.max || MAX_ROOM, dur: isArcade(rm.game) ? 0 : RACE_MS,
      m: [...rm.members.values()].map(m => ({ id: m.id, n: m.name, lv: m.level, c: m.c, wait: !!m.waiting, on: !!m.ws }))
    };
  }
  function broadcastRoom(rm, msg) {
    const s = typeof msg === 'string' ? msg : JSON.stringify(msg);
    for (const m of rm.members.values()) send(m.ws, s);
  }
  function pushRoom(rm) { broadcastRoom(rm, roomState(rm)); schedulePresence(); }

  function joinRoom(ws, rm, gameType) {
    const me = ws.athlete;
    // Codes are typed/shared across cabinets — refuse a seat in another game's room
    // instead of dropping a rooftop racer into a ping-pong lobby.
    if (gameType && normalizeGame(gameType) !== rm.game) {
      return send(ws, { t: 'err', m: `That lobby is for ${GAME_LABELS[rm.game] || 'another game'}` });
    }
    if (ws.room && ws.room !== rm.code) leaveRoom(ws);
    let m = rm.members.get(me.id);
    if (m) {
      // Same athlete again (new tab or reconnect) — newest socket takes the seat.
      if (m.ws && m.ws !== ws) { send(m.ws, { t: 'kick', m: 'Opened in another tab' }); m.ws.room = null; }
      m.ws = ws; m.droppedAt = 0;
    } else {
      if (rm.members.size >= (rm.max || MAX_ROOM)) return send(ws, { t: 'err', m: 'Room is full' });
      m = {
        id: me.id, name: me.name, level: me.level, c: freeColor(rm), ws,
        waiting: rm.status !== 'lobby', inRace: false, alive: false, dnf: false,
        x: 0, y: 0, a: 0, v: 0, sc: 0, run: null, dirty: false, droppedAt: 0
      };
      rm.members.set(me.id, m);
    }
    ws.room = rm.code;
    pushRoom(rm);
    if (rm.status === 'countdown' || rm.status === 'racing') {
      if (m.inRace) send(ws, goMessage(rm)); // reconnecting racer resumes
    }
  }

  function leaveRoom(ws, { dropped = false } = {}) {
    const rm = ws.room && rooms.get(ws.room);
    ws.room = null;
    if (!rm) return;
    const m = rm.members.get(ws.athlete.id);
    if (!m || m.ws !== ws) return;
    if (dropped && m.inRace && (rm.status === 'racing' || rm.status === 'countdown')) {
      m.ws = null; m.droppedAt = now(); // seat kept briefly for a reconnect
      pushRoom(rm);
      return;
    }
    if (m.inRace && rm.status === 'racing') { m.alive = false; m.dnf = true; m.ws = null; }
    else if (m.inRace && rm.game === 'pac-man' && rm.pm) {
      // There is no reconnect into a running board — take the athlete out of the
      // shared world so the last one standing can end the match.
      const wp = rm.pm.players[m.id];
      if (wp) { wp.alive = false; wp.lives = 0; }
      rm.members.delete(m.id);
    }
    else rm.members.delete(m.id);
    afterMemberGone(rm);
  }

  function afterMemberGone(rm) {
    const connected = [...rm.members.values()].filter(m => m.ws);
    if (!connected.length) {
      clearTimeout(rm.timer);
      clearTimeout(rm.guard);
      rooms.delete(rm.code);
      schedulePresence();
      return;
    }
    const host = rm.members.get(rm.hostId);
    if (!host || !host.ws) rm.hostId = connected[0].id;
    if (rm.status === 'racing') checkAllDone(rm);
    pushRoom(rm);
  }

  function goMessage(rm) {
    return {
      t: 'go', race: rm.raceId, room: rm.code, game: rm.game, seed: rm.seed, in: rm.startAt - now(), dur: RACE_MS,
      roster: [...rm.members.values()].filter(m => m.inRace).map(m => ({ id: m.id, n: m.name, c: m.c }))
    };
  }

  function startRace(ws) {
    const rm = rooms.get(ws.room);
    if (!rm) return send(ws, { t: 'err', m: 'Not in a room' });
    if (rm.hostId !== ws.athlete.id) return send(ws, { t: 'err', m: 'Only the host can start' });
    if (rm.status !== 'lobby') return;
    rm.raceId = crypto.randomUUID();
    rm.seed = crypto.randomBytes(4).readUInt32LE(0);
    rm.startAt = now() + COUNTDOWN_MS;
    rm.status = 'countdown';

    if (isArcade(rm.game)) {
      // Lightweight start — no simulation replay needed
      for (const m of rm.members.values()) {
        Object.assign(m, { inRace: !!m.ws, waiting: !m.ws, alive: !!m.ws, dnf: false, sc: 0 });
      }
      // Pac-Man plays one shared board: the hub owns its pellets, ghosts and
      // kills, so every athlete in the room sees the same maze and the same
      // deaths instead of a private copy of the game.
      if (rm.game === 'pac-man') {
        rm.pm = PM.createWorld([...rm.members.values()].filter(m => m.inRace).map(m => ({ id: m.id, spawn: m.c })));
      }
      broadcastRoom(rm, { t: 'go', race: rm.raceId, room: rm.code, game: rm.game, seed: rm.seed, in: COUNTDOWN_MS, dur: 0,
        roster: [...rm.members.values()].filter(m => m.inRace).map(m => ({ id: m.id, n: m.name, c: m.c })) });
      pushRoom(rm);
      clearTimeout(rm.timer);
      clearTimeout(rm.guard);
      rm.timer = setTimeout(() => {
        rm.status = 'playing';
        pushRoom(rm);
        // A player who closes the tab mid-match never reports an end — hand the
        // lobby back so the room does not stay "Match in progress" forever.
        rm.guard = setTimeout(() => {
          if (!rooms.has(rm.code)) return;
          if (rm.game === 'pac-man') return finishPM(rm);
          if (rm.status !== 'playing') return;
          rm.status = 'lobby';
          for (const m of rm.members.values()) { m.inRace = false; m.alive = false; }
          pushRoom(rm);
        }, PLAY_MS);
      }, COUNTDOWN_MS);
      return;
    }

    for (const m of rm.members.values()) {
      Object.assign(m, { inRace: !!m.ws, waiting: !m.ws, alive: !!m.ws, dnf: false, x: 0, y: 60, a: 0, v: 0, sc: 0, dirty: true });
      m.run = m.inRace ? newRun(rm.seed, m.c, rm.startAt, RACE_TICKS) : null;
    }
    broadcastRoom(rm, goMessage(rm));
    pushRoom(rm);
    clearTimeout(rm.timer);
    rm.timer = setTimeout(() => {
      rm.status = 'racing';
      pushRoom(rm);
      rm.timer = setTimeout(() => finishRace(rm), RACE_MS + GRACE_MS);
    }, COUNTDOWN_MS);
  }

  // Mirror the authoritative sim into the relayed racer state.
  function syncMember(m) {
    const p = m.run.sim.p;
    m.x = p.x; m.y = Math.round(p.y * 10) / 10; m.a = Sim.code(p);
    m.v = Math.round(p.vx) / 10; m.sc = Sim.score(p);
    if (runOver(m.run)) m.alive = false;
    m.dirty = true;
  }

  function racerFor(ws) {
    const rm = rooms.get(ws.room);
    if (!rm || (rm.status !== 'racing' && rm.status !== 'countdown')) return null;
    const m = rm.members.get(ws.athlete.id);
    if (!m || !m.inRace || !m.alive || !m.run || m.ws !== ws) return null;
    return [rm, m];
  }

  function onState(ws, msg) {
    const hit = racerFor(ws);
    if (!hit) return;
    const [rm, m] = hit;
    if (!ingest(m.run, msg)) return send(ws, { t: 'rs', s: 'race', n: m.run.ni });
    advanceRun(m.run, msg.k);
    syncMember(m);
    if (!m.alive) checkAllDone(rm);
  }

  function onEnd(ws, msg) {
    const hit = racerFor(ws);
    if (!hit) return;
    const [rm, m] = hit;
    if (ingest(m.run, msg)) advanceRun(m.run, msg.k);
    syncMember(m);
    m.alive = false; m.a = Sim.DEAD;
    checkAllDone(rm);
  }

  // ── Solo runs — same replay, paid as arcade XP ──
  function onSolo(ws) {
    if (ws.solo) endSolo(ws);
    if (now() - (ws.soloAt || 0) < 1500) return send(ws, { t: 'err', m: 'Slow down' });
    ws.soloAt = now();
    const id = crypto.randomUUID(), seed = crypto.randomBytes(4).readUInt32LE(0);
    ws.solo = Object.assign(newRun(seed, 0, now(), SOLO_TICKS), { id });
    solos.add(ws);
    send(ws, { t: 'sgo', id, seed });
  }
  function onSoloMsg(ws, msg, end) {
    const run = ws.solo;
    if (!run || msg.id !== run.id) return;
    if (!ingest(run, msg)) { if (!end) return send(ws, { t: 'rs', s: 'solo', n: run.ni }); }
    else advanceRun(run, msg.k);
    if (end || runOver(run)) endSolo(ws);
  }
  function endSolo(ws) {
    const run = ws.solo;
    if (!run) return;
    ws.solo = null; solos.delete(ws);
    const sc = Sim.score(run.sim.p), id = run.id;
    Promise.resolve()
      .then(() => awardRun(ws.athlete.id, sc, id, 'rooftop-racing'))
      .then(r => send(ws, { t: 'sres', id, sc, xp: r.awarded || 0, coins: r.coins_awarded || 0, why: r.reason || null, today: r.earned_today, cap: r.daily_cap }))
      .catch(e => { console.error('[RaceHub] solo XP award failed:', e.message); send(ws, { t: 'sres', id, sc, xp: 0, why: 'error' }); });
  }

  function checkAllDone(rm) {
    const live = [...rm.members.values()].some(m => m.inRace && m.alive && (m.ws || now() - m.droppedAt < RECONNECT_MS));
    if (!live) finishRace(rm);
  }

  async function finishRace(rm) {
    if (rm.status !== 'racing' && rm.status !== 'countdown') return;
    clearTimeout(rm.timer);
    rm.status = 'results';
    const racers = [...rm.members.values()].filter(m => m.inRace);
    racers.forEach(m => { if (m.alive && !m.ws) m.dnf = true; m.alive = false; });
    racers.sort((a, b) => (a.dnf - b.dnf) || (b.sc - a.sc));
    const field = racers.length;
    const raceId = rm.raceId;

    racers.forEach(m => { m.run = null; }); // free the replay worlds before the async awards
    const rows = await Promise.all(racers.map(async (m, i) => {
      const row = { id: m.id, n: m.name, c: m.c, sc: Math.floor(m.sc), rank: i + 1, xp: 0, why: null };
      if (field < 2) row.why = 'solo';
      else if (m.dnf) row.why = 'dnf';
      else if (m.sc < MIN_SCORE_FOR_XP) row.why = 'score_too_low';
      else {
        try {
          const r = await awardXp(m.id, raceId, i + 1, field);
          row.xp = r.awarded || 0;
          row.why = r.reason || null;
          row.today = r.earned_today; row.cap = r.daily_cap;
        } catch (e) {
          console.error('[RaceHub] race XP award failed:', e.message);
          row.why = 'error';
        }
      }
      return row;
    }));

    if (!rooms.has(rm.code)) return;
    broadcastRoom(rm, { t: 'res', race: raceId, rows });
    for (const m of [...rm.members.values()]) {
      if (!m.ws) { rm.members.delete(m.id); continue; }
      Object.assign(m, { inRace: false, waiting: false, alive: false, dnf: false });
    }
    rm.status = 'lobby';
    if (!rm.members.size) { rooms.delete(rm.code); schedulePresence(); return; }
    afterMemberGone(rm);
  }

  // ── Ping Pong state relay (lightweight, no simulation) ──
  const ppRateLimit = new Map(); // ws -> lastSendMs
  function onPPState(ws, msg) {
    const rm = ws.room && rooms.get(ws.room);
    if (!rm || rm.game !== 'ping-pong' || rm.status !== 'playing') return;
    const nowMs = now();
    const last = ppRateLimit.get(ws) || 0;
    if (nowMs - last < 40) return; // 25Hz cap
    ppRateLimit.set(ws, nowMs);
    const m = rm.members.get(ws.athlete.id);
    if (!m || !m.inRace) return;
    // Relay normalized Y and rally count to the other player
    const payload = JSON.stringify({ t: 'ps', p: [[m.id, 0, Math.round((msg.y || 0) * 100), 0, 0, msg.r || 0, 1]] });
    for (const other of rm.members.values()) {
      if (other.id !== m.id && other.ws) send(other.ws, payload);
    }
  }
  async function onPPEnd(ws, msg) {
    const rm = ws.room && rooms.get(ws.room);
    if (!rm || rm.game !== 'ping-pong') return;
    const reporter = rm.members.get(ws.athlete.id);
    if (!reporter) return;
    // Every online client draws itself as player 1, so s1 is the reporter's own
    // score and s2 the opponent's — never the join order of the room.
    const opponent = [...rm.members.values()].find(m => m.id !== reporter.id);
    const s1 = Math.max(0, Math.floor(Number(msg.s1) || 0));
    const s2 = Math.max(0, Math.floor(Number(msg.s2) || 0));
    const scoreOf = new Map([[String(reporter.id), s1]]);
    if (opponent) scoreOf.set(String(opponent.id), s2);
    const winnerId = Number(msg.w) === 2 && opponent ? opponent.id : reporter.id;

    // Each rally point is paid on its own score and its own ladder — the loser of
    // an 11-9 match still earned XP for the nine points they scored.
    const rows = [];
    for (const m of rm.members.values()) {
      const row = { id: m.id, n: m.name, c: m.c, sc: scoreOf.get(String(m.id)) || 0, rank: m.id === winnerId ? 1 : 2, xp: 0, coins: 0, why: null };
      if (m.inRace && row.sc > 0) {
        try {
          const r = await awardRun(m.id, row.sc, 'pp_' + rm.raceId + '_' + m.id, 'ping-pong');
          row.xp = r.awarded || 0;
          row.coins = r.coins_awarded || 0;
          row.today = r.earned_today; row.cap = r.daily_cap;
          row.why = r.reason || null;
        } catch (e) { console.error('[RaceHub] ping-pong XP award failed:', e.message); row.why = 'error'; }
      }
      rows.push(row);
    }
    rows.sort((a, b) => a.rank - b.rank);
    broadcastRoom(rm, { t: 'res', race: rm.raceId, rows });
    // Cleanup room
    rm.status = 'results';
    for (const m of rm.members.values()) { m.inRace = false; m.alive = false; }
    clearTimeout(rm.timer);
    clearTimeout(rm.guard);
    setTimeout(() => {
      if (rooms.has(rm.code)) {
        rm.status = 'lobby';
        for (const m of [...rm.members.values()]) { if (!m.ws) rm.members.delete(m.id); }
        if (!rm.members.size) { rooms.delete(rm.code); schedulePresence(); return; }
        afterMemberGone(rm);
      }
    }, 2000);
  }

  // ── Pac-Man — one shared board per room, simulated here ──
  const pmRateLimit = new Map(); // ws -> lastSendMs
  const crRateLimit = new Map(); // ws -> lastSendMs
  function onPMState(ws, msg) {
    const rm = ws.room && rooms.get(ws.room);
    if (!rm || rm.game !== 'pac-man' || !rm.pm) return;
    if (rm.status !== 'playing') return;
    const nowMs = now();
    const last = pmRateLimit.get(ws) || 0;
    if (nowMs - last < 60) return; // clients stream at 10Hz
    pmRateLimit.set(ws, nowMs);
    const m = rm.members.get(ws.athlete.id);
    if (!m || !m.inRace) return;
    // Position + facing go straight into the world, which also scores the pellet
    // under the athlete — so every screen loses the same dot.
    PM.touch(rm.pm, m.id, msg.x, msg.y, msg.d);
  }

  // 10Hz world tick: step ghosts, resolve kills, broadcast the same snapshot to
  // the whole room. Nothing in here is per-socket.
  function pmTick(rm) {
    if (rm.status !== 'playing' || !rm.pm) return;
    PM.step(rm.pm, TICK_MS / 1000);
    broadcastRoom(rm, PM.snapshot(rm.pm));
    if (PM.over(rm.pm)) finishPM(rm);
  }

  async function finishPM(rm) {
    if (rm.status !== 'playing' && rm.status !== 'countdown') return;
    clearTimeout(rm.timer);
    clearTimeout(rm.guard);
    rm.status = 'results';
    const world = rm.pm;
    rm.pm = null;
    const racers = [...rm.members.values()].filter(m => m.inRace);
    const scores = racers.map(m => ({
      id: m.id,
      score: world && world.players[m.id] ? Math.floor(world.players[m.id].sc) : 0
    }));
    // Arcade XP is paid on the hub's own score, never on a client report, and on
    // every athlete's own pellets — the last one standing is not the only earner.
    const rows = racers.map(m => {
      const s = scores.find(x => x.id === m.id);
      return { id: m.id, n: m.name, c: m.c, sc: s ? s.score : 0, rank: 0, xp: 0, coins: 0, why: null };
    });
    rows.sort((a, b) => b.sc - a.sc);
    rows.forEach((r, i) => { r.rank = i + 1; });
    // Sequential so the shared daily cap is read after the previous award lands.
    for (const row of rows) {
      if (row.sc <= 0) continue;
      try {
        const r = await awardRun(row.id, row.sc, 'pm_' + rm.raceId + '_' + row.id, 'pac-man');
        row.xp = r.awarded || 0;
        row.coins = r.coins_awarded || 0;
        row.today = r.earned_today; row.cap = r.daily_cap;
        row.why = r.reason || null;
      } catch (e) { console.error('[RaceHub] pac-man XP award failed:', e.message); row.why = 'error'; }
    }
    if (!rooms.has(rm.code)) return;
    broadcastRoom(rm, { t: 'res', race: rm.raceId, rows });
    for (const m of [...rm.members.values()]) {
      if (!m.ws) { rm.members.delete(m.id); continue; }
      Object.assign(m, { inRace: false, waiting: false, alive: false, dnf: false });
    }
    // The board is gone, the athletes are not — straight back to the lobby.
    rm.status = 'lobby';
    if (!rm.members.size) { rooms.delete(rm.code); schedulePresence(); return; }
    afterMemberGone(rm);
  }

  // Leaving mid-match (tab closed, forfeit) takes the athlete off the board.
  function onPMEnd(ws) {
    const rm = ws.room && rooms.get(ws.room);
    if (!rm || rm.game !== 'pac-man' || !rm.pm) return;
    const wp = rm.pm.players[ws.athlete.id];
    if (!wp) return;
    wp.alive = false;
    wp.lives = 0;
    if (PM.over(rm.pm)) finishPM(rm);
  }

  function onCRState(ws, msg) {
    const rm = ws.room && rooms.get(ws.room);
    if (!rm || rm.game !== 'crossy-road' || rm.status !== 'playing') return;
    const nowMs = now();
    const last = crRateLimit.get(ws) || 0;
    if (nowMs - last < 100) return; // 10Hz cap
    crRateLimit.set(ws, nowMs);
    const m = rm.members.get(ws.athlete.id);
    if (!m || !m.inRace) return;
    // Relay lane + column + score to all other players
    const payload = JSON.stringify({ t: 'ps', p: [[m.id, msg.l || 0, msg.c || 0, msg.s || 0]] });
    for (const other of rm.members.values()) {
      if (other.id !== m.id && other.ws) send(other.ws, payload);
    }
  }

  async function onCREnd(ws, msg) {
    const rm = ws.room && rooms.get(ws.room);
    if (!rm || rm.game !== 'crossy-road') return;
    const scores = Array.isArray(msg.scores) ? msg.scores : [];
    const members = [...rm.members.values()];
    const scoreOf = new Map(scores.map(s => [String(s.id), Math.max(0, Math.floor(Number(s.score) || 0))]));
    // Each runner is paid on their own lanes crossed, on the Crossy Road ladder.
    const rows = members.map(m => ({
      id: m.id, n: m.name, c: m.c, sc: scoreOf.get(String(m.id)) || 0, rank: 0, xp: 0, coins: 0, why: null
    }));
    rows.sort((a, b) => b.sc - a.sc);
    rows.forEach((r, i) => { r.rank = i + 1; });
    for (const row of rows) {
      if (row.sc <= 0) continue;
      try {
        const r = await awardRun(row.id, row.sc, 'cr_' + rm.raceId + '_' + row.id, 'crossy-road');
        row.xp = r.awarded || 0;
        row.coins = r.coins_awarded || 0;
        row.today = r.earned_today; row.cap = r.daily_cap;
        row.why = r.reason || null;
      } catch (e) { console.error('[RaceHub] crossy-road XP award failed:', e.message); row.why = 'error'; }
    }
    broadcastRoom(rm, { t: 'res', race: rm.raceId, rows });
    // Cleanup room
    rm.status = 'results';
    for (const m of members) { m.inRace = false; m.alive = false; }
    clearTimeout(rm.timer);
    clearTimeout(rm.guard);
    setTimeout(() => {
      if (rooms.has(rm.code)) {
        rm.status = 'lobby';
        for (const m of [...rm.members.values()]) { if (!m.ws) rm.members.delete(m.id); }
        if (!rm.members.size) { rooms.delete(rm.code); schedulePresence(); return; }
        afterMemberGone(rm);
      }
    }, 2000);
  }

  function invite(ws, to, gameType) {
    const me = ws.athlete;
    const target = athletes.get(to) || athletes.get(Number(to));
    if (!target) return send(ws, { t: 'err', m: 'That athlete is offline' });
    // Ids arrive from the client as strings and live here as database values —
    // compare them as text so a self-invite can never slip through.
    if (String(target.id) === String(me.id)) return send(ws, { t: 'err', m: "You can't invite yourself" });
    let rm = ws.room && rooms.get(ws.room);
    if (!rm) {
      if (ws.kind !== 'game') return send(ws, { t: 'err', m: 'Open a game to invite' });
      // The room inherits the inviting game — an invite from Pac-Man must never
      // land the pair in a Rooftop Race room.
      rm = createRoom(ws, gameType);
    }
    const key = `${me.id}:${target.id}`;
    if (now() - (inviteLog.get(key) || 0) < 8000) return send(ws, { t: 'ok', m: 'Invite already sent' });
    inviteLog.set(key, now());
    const msg = JSON.stringify({ t: 'inv', from: { id: me.id, n: me.name }, r: rm.code, s: rm.status, g: rm.game });
    for (const s of target.sockets) send(s, msg);
    send(ws, { t: 'ok', m: `Invite sent to ${target.name}`, to: target.id });
  }

  function createRoom(ws, gameType) {
    if (ws.room) leaveRoom(ws);
    const game = normalizeGame(gameType);
    const rm = { code: newCode(), hostId: ws.athlete.id, status: 'lobby', members: new Map(), seed: 0, raceId: null, startAt: 0, timer: null, guard: null, game, max: ROOM_MAX[game] || MAX_ROOM };
    rooms.set(rm.code, rm);
    joinRoom(ws, rm);
    return rm;
  }

  // ── Socket lifecycle ──
  wss.on('connection', (ws, req, athlete, kind) => {
    ws.athlete = athlete;
    ws.kind = kind;
    ws.room = null;
    ws.alive = true;
    ws.rate = { at: now(), n: 0 };

    let p = athletes.get(athlete.id);
    if (!p) { p = { ...athlete, sockets: new Set() }; athletes.set(athlete.id, p); }
    p.name = athlete.name; p.level = athlete.level;
    p.sockets.add(ws);

    send(ws, { t: 'hello', me: { id: athlete.id, n: athlete.name, lv: athlete.level } });
    send(ws, presencePayload());
    schedulePresence();

    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', raw => {
      const t = now();
      if (t - ws.rate.at > 1000) { ws.rate.at = t; ws.rate.n = 0; }
      if (++ws.rate.n > 40) return; // flood guard — 10 Hz states + a few commands
      let msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      if (!msg || typeof msg.t !== 'string') return;
      if (msg.t === 'st') return onState(ws, msg);
      if (msg.t === 'end') return onEnd(ws, msg);
      if (msg.t === 'invite') return invite(ws, msg.to, msg.game);
      if (ws.kind !== 'game') return; // the portal only watches presence + sends invites
      if (msg.t === 'ss') return onSoloMsg(ws, msg, false);
      if (msg.t === 'se') return onSoloMsg(ws, msg, true);
      if (msg.t === 'solo') return onSolo(ws);
      if (msg.t === 'create') return createRoom(ws, msg.game);
      if (msg.t === 'pp_state') return onPPState(ws, msg);
      if (msg.t === 'pp_end') return onPPEnd(ws, msg);
      if (msg.t === 'pm_state') return onPMState(ws, msg);
      if (msg.t === 'pm_end') return onPMEnd(ws, msg);
      if (msg.t === 'cr_state') return onCRState(ws, msg);
      if (msg.t === 'cr_end') return onCREnd(ws, msg);
      if (msg.t === 'join') {
        const rm = rooms.get(String(msg.r || '').toUpperCase());
        if (!rm) return send(ws, { t: 'err', m: 'That lobby has closed' });
        return joinRoom(ws, rm, msg.game);
      }
      if (msg.t === 'leave') { leaveRoom(ws); return send(ws, { t: 'room', r: null }); }
      if (msg.t === 'start') return startRace(ws);
    });
    ws.on('close', () => {
      endSolo(ws);
      leaveRoom(ws, { dropped: true });
      p.sockets.delete(ws);
      if (!p.sockets.size) athletes.delete(p.id);
      schedulePresence();
    });
    ws.on('error', () => {});
  });

  // Position relay, lag enforcement + reconnect expiry
  const tick = setInterval(() => {
    for (const ws of solos) if (forceLagging(ws.solo) && runOver(ws.solo)) endSolo(ws);
    for (const rm of rooms.values()) {
      if (rm.game === 'pac-man') { pmTick(rm); continue; }
      if (rm.status !== 'racing' && rm.status !== 'countdown') continue;
      let dirty = false;
      const p = [];
      for (const m of rm.members.values()) {
        if (!m.inRace) continue;
        if (m.alive && m.run && forceLagging(m.run)) syncMember(m);
        if (!m.ws && m.droppedAt && now() - m.droppedAt > RECONNECT_MS && m.alive) {
          m.alive = false; m.dnf = true; m.dirty = true;
        }
        if (m.dirty) dirty = true;
        m.dirty = false;
        p.push([m.id, Math.round(m.x), m.y, m.a, m.v, Math.floor(m.sc), m.alive ? 1 : 0]);
      }
      if (dirty) broadcastRoom(rm, { t: 'ps', p });
      if (rm.status === 'racing') checkAllDone(rm);
    }
  }, TICK_MS);
  tick.unref?.();

  // Heartbeat — drop half-open sockets (phones locking, tunnels)
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      try { ws.ping(); } catch (e) {}
    }
    const cutoff = now() - 60000;
    for (const [k, at] of inviteLog) if (at < cutoff) inviteLog.delete(k);
  }, 25000);
  beat.unref?.();

  function attach(server) {
    server.on('upgrade', async (req, socket, head) => {
      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch (e) { return; }
      if (url.pathname !== PATH) return; // not ours — leave for other handlers
      const token = url.searchParams.get('t');
      const kind = url.searchParams.get('c') === 'game' ? 'game' : 'portal';
      let athlete = null;
      try { athlete = token ? await resolveAthlete(token) : null; } catch (e) { athlete = null; }
      if (!athlete) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req, athlete, kind));
    });
    console.log(`🏁 RaceHub live on ${PATH}`);
    return api;
  }

  const api = {
    attach,
    isOnline: id => athletes.has(id),
    stats: () => ({ athletes: athletes.size, rooms: rooms.size, sockets: wss.clients.size, solos: solos.size }),
    close: () => { clearInterval(tick); clearInterval(beat); for (const ws of wss.clients) ws.terminate(); wss.close(); }
  };
  return api;
}

// Process-wide hub used by server.js; routes read presence from it.
let current = null;
function attachDefault(server) {
  if (!current) current = createHub().attach(server);
  return current;
}

module.exports = { createHub, attachDefault, getHub: () => current, PATH, RACE_MS, MAX_ROOM };
