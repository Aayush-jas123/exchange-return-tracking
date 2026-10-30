// ═══════════════════════════════════════════════════════════
// OFFCOMFRT Crossy Road — Networking Module
// Connects to the shared RaceHub WebSocket (/ws/race)
// Rooms are game-scoped: create/join/invite always name this cabinet, so a
// Crossy code can never open a Ping Pong lobby and vice versa.
// ═══════════════════════════════════════════════════════════
(() => {
  'use strict';

  const GAME_TYPE = 'crossy-road';
  const MAX_ROOM = 4;

  // ── State (minimal footprint) ──
  let ws = null;
  let ready = false;
  let myId = null;
  let tries = 0;
  let retryTimer = null;
  let stopped = false;
  let wantRoom = false;   // the lobby asked for a room of its own; honoured on hello

  // Presence data
  let athletes = [];      // [{ id, n, lv, w, r, s, g }]
  let rooms = [];         // [{ r, h, n, max, s, game }]

  // Room state
  let room = null;        // { r, host, status, max, members: [] }
  let joiningCode = null; // code typed/clicked, waiting for the hub to seat us
  let raceId = null;      // hub id of the match in flight (room codes are shared)

  // Invite tracking
  const invitedAt = new Map(); // 'me:them' -> timestamp
  const INVITE_COOLDOWN = 8000;

  // Online run
  let inGame = false;
  let players = [];       // [{ id, name, color, lane, column, score, alive }]
  let lastSent = { l: -1, c: -1, at: 0 }; // last cell pushed to the hub
  let pendingState = false;               // a hop landed inside the rate window
  let lastPushAt = 0;
  const STATE_RATE = 100; // ms between state sends (~10Hz)
  const PUSH_RATE = 320;  // ms between shoves — just over the hub's own window

  // ── DOM helper ──
  const $ = (id) => document.getElementById(id);

  // ── Public API ──
  const Net = {
    myId: null,
    players: [],

    // `create` is the menu's Online Race button: it asks for a room of my own as
    // soon as the hub says hello. Deep links join instead and never create.
    connect(opts) {
      if (opts && opts.create) wantRoom = true;
      if (ws) {
        // Already live: a late "host a room" tap still creates one, unless this
        // cabinet is in the middle of joining someone else's room.
        if (wantRoom && ready && !room && !joiningCode) Net.createRoom();
        return;
      }
      stopped = false;
      doConnect();
    },

    disconnect() {
      stopped = true;
      clearTimeout(retryTimer);
      retryTimer = null;
      if (ws) { ws.onclose = null; ws.close(); ws = null; }
      ready = false;
      room = null;
      raceId = null;
      inGame = false;
      players = [];
      Net.players = [];
      if (window.CrossyRoad && window.CrossyRoad.clearRemotePlayers) window.CrossyRoad.clearRemotePlayers();
      renderLobby();
    },

    createRoom() {
      wantRoom = false;
      joiningCode = null;
      send({ t: 'create', game: GAME_TYPE });
    },

    joinRoom(code) {
      const r = String(code || '').trim().toUpperCase();
      if (!r) return;
      joiningCode = r;
      send({ t: 'join', r, game: GAME_TYPE });
      renderLobby();
    },

    leaveRoom() {
      send({ t: 'leave' });
      room = null;
      raceId = null;
      joiningCode = null;
      inGame = false;
      players = [];
      Net.players = [];
      if (window.CrossyRoad && window.CrossyRoad.clearRemotePlayers) window.CrossyRoad.clearRemotePlayers();
      renderLobby();
    },

    startGame() {
      if (!room || room.status !== 'lobby' || String(room.host) !== myId) return;
      send({ t: 'start' });
    },

    invite(id) {
      const to = id == null ? '' : String(id);
      if (!to || !myId || to === myId) return;  // never offer an invite to yourself
      const key = myId + ':' + to;
      if (Date.now() - (invitedAt.get(key) || 0) < INVITE_COOLDOWN) return;
      invitedAt.set(key, Date.now());
      send({ t: 'invite', to, game: GAME_TYPE });
      renderLobby();
    },

    sendState(lane, column, score, force) {
      if (!inGame || !ready) return;
      const l = Number(lane) | 0;
      const c = Number(column) | 0;
      const now = Date.now();
      const moved = l !== lastSent.l || c !== lastSent.c;
      // A hop is news and goes out at once; a resting runner only heartbeats once
      // a second, so an idle chicken costs the room nothing.
      if (!force) {
        if (!moved && !pendingState && now - lastSent.at < 1000) return;
        if (now - lastSent.at < STATE_RATE) { pendingState = true; return; }
      }
      pendingState = false;
      lastSent = { l, c, at: now };
      send({ t: 'cr_state', l, c, s: Number(score) | 0 });
    },

    // The runner standing on a cell, or null — what a shove is aimed at.
    playerAt(lane, column) {
      for (let i = 0; i < players.length; i++) {
        const p = players[i];
        if (p.alive && p.lane === lane && p.column === column) return p;
      }
      return null;
    },

    // Ask the hub to relay a shove. It checks the pair and rebroadcasts the cell,
    // so every screen (including the victim's) applies the same displacement.
    push(id, lane, column) {
      if (!inGame || !ready) return;
      const now = Date.now();
      if (now - lastPushAt < PUSH_RATE) return;
      lastPushAt = now;
      send({ t: 'cr_push', to: String(id), l: Number(lane) | 0, c: Number(column) | 0 });
    },

    sendEnd(score) {
      if (!inGame) return;
      inGame = false;
      send({ t: 'cr_end', scores: [{ id: myId, score: score }] });
    }
  };

  // ── WebSocket ──
  function doConnect() {
    const token = window.AthleteXP ? window.AthleteXP.token() : null;
    if (!token) { renderLobby(); return; }

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    try {
      ws = new WebSocket(proto + '://' + location.host + '/ws/race?c=game&t=' + encodeURIComponent(token));
    } catch (e) {
      return scheduleRetry();
    }

    ws.onopen = () => { tries = 0; };

    ws.onmessage = e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }
      onMsg(msg);
    };

    ws.onclose = () => {
      if (!ws) return;
      ws = null;
      ready = false;
      room = null;
      raceId = null;
      inGame = false;
      players = [];
      Net.players = [];
      if (window.CrossyRoad && window.CrossyRoad.clearRemotePlayers) window.CrossyRoad.clearRemotePlayers();
      renderLobby();
      scheduleRetry();
    };

    ws.onerror = () => {};
  }

  function scheduleRetry() {
    if (stopped) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(doConnect, Math.min(15000, 1000 * Math.pow(2, tries++)));
  }

  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  // ── Deep links ──
  // The portal opens a cabinet with `#t=<token>&r=<room>` (join a room) or
  // `#t=<token>&inv=<athlete>` (open a room and invite them). athlete-xp.js
  // consumes the hash on load, so its parsed params are read first.
  function deepLink() {
    const p = (window.AthleteXP && window.AthleteXP.params) || {};
    const hash = new URLSearchParams(location.hash.slice(1));
    const r = p.r || hash.get('r');
    const inv = p.inv || hash.get('inv');
    if (window.AthleteXP && window.AthleteXP.params) {
      window.AthleteXP.params.r = null;
      window.AthleteXP.params.inv = null;
    }
    return { r: r ? String(r).toUpperCase() : null, inv: inv ? String(inv) : null };
  }

  // ── Message handling ──
  function onMsg(m) {
    switch (m.t) {
      case 'hello':
        myId = String(m.me.id);
        Net.myId = myId;
        ready = true;
        tries = 0;
        // Rejoin first, then the deep link, then a queued join, then a new room.
        if (room && room.r) Net.joinRoom(room.r);
        else if (BOOT.r) Net.joinRoom(BOOT.r);
        else if (BOOT.inv && BOOT.inv !== myId) send({ t: 'invite', to: BOOT.inv, game: GAME_TYPE });
        else if (joiningCode) Net.joinRoom(joiningCode);
        else if (wantRoom) Net.createRoom();
        BOOT.r = null;
        BOOT.inv = null;
        renderLobby();
        break;

      case 'pr':
        // The hub emits database ids (numbers) while myId is a string — normalise
        // at the wire so every comparison below is plain text.
        athletes = (m.a || []).map(a => Object.assign({}, a, { id: String(a.id) }));
        rooms = (m.rooms || []).filter(rm => !rm.game || rm.game === GAME_TYPE);
        renderLobby();
        break;

      case 'room':
        // A foreign room never belongs in this cabinet.
        if (m.r && (!m.g || m.g === GAME_TYPE)) {
          room = {
            r: m.r,
            host: m.host == null ? null : String(m.host),
            status: m.s,
            max: m.max || MAX_ROOM,
            members: (m.m || []).map(mem => ({
              id: String(mem.id),
              n: mem.n,
              c: mem.c,
              on: !!mem.on,
              wait: !!mem.wait
            }))
          };
          joiningCode = null;
        } else {
          room = null;
        }
        renderLobby();
        break;

      case 'inv':
        // Invites reach every socket of the athlete — only take the Crossy ones.
        if (!m.g || m.g === GAME_TYPE) showInvite(m);
        break;

      case 'go': {
        // The hub names the room the match belongs to; `race` is the match id.
        if (!room || (m.room && m.room !== room.r)) break;
        raceId = m.race || null;
        inGame = true;
        lastSent = { l: -1, c: -1, at: 0 };
        pendingState = false;
        const roster = m.roster || [];
        const mine = roster.find(p => String(p.id) === myId);
        players = roster.filter(p => String(p.id) !== myId).map(p => ({
          id: String(p.id),
          name: p.n,
          color: p.c || 0,
          lane: 0,
          column: spawnColumn(p.c),
          score: 0,
          alive: true
        }));
        Net.players = players;
        // A new race starts from a clean scoreboard — the old one belongs to the
        // last result screen.
        const goResults = $('goResults');
        if (goResults) goResults.innerHTML = '';
        // Same seed, same spawn columns: the whole room builds one map.
        if (window.CrossyRoad && window.CrossyRoad.startOnlineGame) {
          window.CrossyRoad.startOnlineGame({ seed: m.seed, color: mine ? mine.c : 0 });
        }
        // Everyone is already standing on their spawn — draw them now instead of
        // waiting for the first position relay.
        for (const p of players) {
          if (window.CrossyRoad && window.CrossyRoad.updateRemotePlayer) {
            window.CrossyRoad.updateRemotePlayer(p.id, 0, p.column, p.name, p.color);
          }
        }
        break;
      }

      case 'ps':
        if (!inGame) break;
        for (const p of (m.p || [])) {
          const pid = String(p[0]);
          if (pid === myId) continue;
          const opp = players.find(pl => pl.id === pid);
          if (!opp) continue;
          opp.lane = typeof p[1] === 'number' ? p[1] : opp.lane;
          opp.column = typeof p[2] === 'number' ? p[2] : opp.column;
          opp.score = typeof p[3] === 'number' ? p[3] : opp.score;
          if (window.CrossyRoad && window.CrossyRoad.updateRemotePlayer) {
            window.CrossyRoad.updateRemotePlayer(opp.id, opp.lane, opp.column, opp.name, opp.color);
          }
        }
        Net.players = players;
        break;

      case 'cr_push': {
        // A shove: one runner displaced the other along their own heading.
        if (!inGame) break;
        const to = String(m.to);
        const l = Number(m.l) | 0;
        const c = Number(m.c) | 0;
        if (to !== myId) {
          const hit = players.find(pl => pl.id === to);
          if (hit) { hit.lane = l; hit.column = c; }
        }
        if (window.CrossyRoad && window.CrossyRoad.applyPush) {
          window.CrossyRoad.applyPush(to, l, c);
        }
        break;
      }

      case 'res': {
        // Results for this room. The hub pays every runner, so this arrives once
        // the last athlete has finished (or the match guard expired).
        const forRoom = room && (m.room ? m.room === room.r : (!raceId || m.race === raceId));
        if (!forRoom) break;
        const rows = m.rows || [];
        const mine = rows.find(r => String(r.id) === myId);
        const wasInGame = inGame;
        inGame = false;
        players = [];
        Net.players = [];
        if (window.CrossyRoad && window.CrossyRoad.clearRemotePlayers) window.CrossyRoad.clearRemotePlayers();
        showResults(rows, mine);
        const reward = mine
          ? { xp: mine.xp || 0, coins: mine.coins || 0, today: mine.today, cap: mine.cap, why: mine.why }
          : null;
        // A paid race speaks up once; a duplicate report of the same race is silent.
        if (wasInGame && reward && (reward.xp > 0 || reward.coins > 0 || reward.why === 'daily_cap')) {
          if (window.AthleteXP && window.AthleteXP.announce) {
            window.AthleteXP.announce({
              awarded: reward.xp, coins_awarded: reward.coins,
              earned_today: reward.today, daily_cap: reward.cap, reason: reward.why
            }, 'Crossy Road');
          }
        }
        raceId = null;
        // Stay seated — the hub hands the room back to the lobby a moment later.
        renderLobby();
        break;
      }

      case 'err':
        if (joiningCode) joiningCode = null;
        showToast(m.m || 'Error');
        renderLobby();
        break;

      case 'ok':
        if (m.m) showToast(m.m);
        renderLobby();
        break;
    }
  }

  // ── Results ──
  function showResults(rows, mine) {
    const goScore = $('goScore');
    const goXP = $('goXP');
    const goRank = $('goRank');
    const goResults = $('goResults');
    if (goScore) goScore.textContent = mine ? (mine.sc || 0) : 0;
    if (goXP) goXP.textContent = mine && mine.xp > 0 ? '+' + mine.xp : '--';
    if (goRank) goRank.textContent = mine && mine.rank > 0 ? '#' + mine.rank : '--';
    if (goResults) {
      goResults.innerHTML = rows.map(r =>
        '<div class="go-result-row">' +
        '<span class="rr-rank">#' + (r.rank || 0) + '</span>' +
        '<span class="rr-name">' + esc(r.n || 'Runner') + '</span>' +
        '<span class="rr-score">' + (r.sc || 0) + ' lanes</span>' +
        '</div>'
      ).join('');
    }
    if (window.CrossyRoad && window.CrossyRoad.showScreen) {
      window.CrossyRoad.showScreen(window.CrossyRoad.screen.over);
    }
  }

  // ── Lobby rendering ──
  function renderLobby() {
    if (!$('lobbyCode')) return;
    renderRoom();
    renderInvitees();
    renderRooms();
  }

  function renderRoom() {
    const codeEl = $('lobbyCode');
    const subEl = $('lobbySub');
    const playersEl = $('lobbyPlayers');
    const startBtn = $('btnStartRace');

    // Not signed in to the portal — there is no socket to open.
    if (!myId) {
      codeEl.textContent = '----';
      if (subEl) subEl.textContent = 'Open Crossy Road from your athlete portal to race live';
      if (playersEl) playersEl.innerHTML = emptyRow('Live racing needs your portal session');
      if (startBtn) { startBtn.disabled = true; startBtn.textContent = 'Create Room'; }
      return;
    }

    if (!ready) {
      codeEl.textContent = '----';
      if (subEl) subEl.textContent = 'Connecting to the live arena\u2026';
      if (playersEl) playersEl.innerHTML = emptyRow('Connecting\u2026');
      if (startBtn) { startBtn.disabled = true; startBtn.textContent = 'Create Room'; }
      return;
    }

    if (!room) {
      codeEl.textContent = '----';
      if (subEl) subEl.textContent = 'Create a room, or join one with a code';
      if (playersEl) playersEl.innerHTML = emptyRow('No room yet');
      // Without a room the primary button creates one.
      if (startBtn) { startBtn.disabled = false; startBtn.textContent = 'Create Room'; }
      return;
    }

    const isHost = String(room.host) === myId;
    const othersOn = room.members.filter(m => m.id !== myId && m.on).length;

    codeEl.textContent = room.r;
    if (subEl) {
      subEl.textContent = !isHost
        ? 'Waiting for the host to start the race'
        : othersOn
          ? 'Invite more runners, then start the race'
          : 'Share this code or invite an athlete';
    }

    if (playersEl) {
      playersEl.innerHTML = room.members.map(m => {
        const isMe = m.id === myId;
        return '<div class="lobby-player">' +
          '<span class="dot' + (m.on ? '' : ' off') + '"></span>' +
          '<span class="pname">' + esc(m.n || 'Athlete') + (isMe ? ' <span class="pyou">you</span>' : '') + '</span>' +
          (!m.on ? '<span class="pmeta">away</span>' : '') +
          (m.id === String(room.host) ? '<span class="phost">Host</span>' : '') +
          '</div>';
      }).join('');
    }

    if (startBtn) {
      if (room.status !== 'lobby') {
        startBtn.disabled = true;
        startBtn.textContent = 'Race in progress';
      } else if (!isHost) {
        startBtn.disabled = true;
        startBtn.textContent = 'Waiting for host';
      } else if (!othersOn) {
        startBtn.disabled = true;
        startBtn.textContent = 'Waiting for players';
      } else {
        startBtn.disabled = false;
        startBtn.textContent = 'Start Race';
      }
    }
  }

  function renderInvitees() {
    const el = $('inviteList');
    const btn = $('btnInvite');
    const live = athletes.filter(a => a.id !== myId && (a.w === 'game' || a.w === 'portal'));

    if (btn) {
      btn.disabled = !myId || !live.length;
      btn.textContent = live.length ? 'Invite Athletes \u00b7 ' + live.length + ' online' : 'No athletes online';
    }
    if (!el) return;

    if (!myId || !live.length) {
      el.innerHTML = emptyRow('No athletes online right now');
      return;
    }

    const full = !!room && room.members.length >= (room.max || MAX_ROOM);
    el.innerHTML = live.map(a => {
      const inMine = !!room && room.members.some(mb => mb.id === a.id);
      const sent = Date.now() - (invitedAt.get(myId + ':' + a.id) || 0) < INVITE_COOLDOWN;
      let statusText = a.w === 'game' ? 'In arcade' : 'On portal';
      if (a.r) statusText = 'Room ' + a.r + (a.s === 'lobby' ? ' \u00b7 lobby' : '');
      let action;
      if (inMine) action = '<span class="pmeta">in room</span>';
      else if (full) action = '<span class="pmeta">room full</span>';
      else {
        action = '<button class="lobby-mini" type="button" data-invite="' + esc(a.id) + '"' +
          (sent ? ' disabled' : '') + '>' + (sent ? 'Sent \u2713' : 'Invite') + '</button>';
      }
      return '<div class="lobby-player">' +
        '<span class="dot' + (a.w === 'game' ? ' live' : ' off') + '"></span>' +
        '<span class="pname">' + esc(a.n || 'Athlete') + '</span>' +
        '<span class="pmeta">' + esc(statusText) + '</span>' + action +
        '</div>';
    }).join('');
  }

  function renderRooms() {
    const el = $('roomList');
    if (!el) return;
    if (!ready) { el.innerHTML = emptyRow('Connecting\u2026'); return; }
    const open = rooms.filter(rm => !room || rm.r !== room.r);
    if (!open.length) {
      el.innerHTML = emptyRow('No open lobbies — create one above');
      return;
    }
    el.innerHTML = open.map(rm => {
      const full = rm.n >= rm.max;
      const joinable = !full;
      return '<div class="lobby-player">' +
        '<span class="dot"></span>' +
        '<span class="pname">' + esc(firstName(rm.h)) + '\u2019s room</span>' +
        '<span class="pmeta">' + esc(rm.r) + ' \u00b7 ' + rm.n + '/' + rm.max + ' \u00b7 ' + esc(statusLabel(rm.s)) + '</span>' +
        '<button class="lobby-mini" type="button" data-join="' + esc(rm.r) + '"' + (joinable ? '' : ' disabled') + '>' +
        (full ? 'Full' : rm.s === 'lobby' ? 'Join' : 'Join next') + '</button>' +
        '</div>';
    }).join('');
  }

  function emptyRow(text) {
    return '<div class="lobby-player"><span class="dot off"></span><span class="pname" style="color:var(--dim)">' + esc(text) + '</span></div>';
  }

  // ── UI helpers ──
  // The spawn columns live in the cabinet so the bird on screen and the seat the
  // hub handed out can never disagree.
  function spawnColumn(color) {
    return window.CrossyRoad && window.CrossyRoad.spawnColumn
      ? window.CrossyRoad.spawnColumn(color)
      : 8;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function firstName(n) {
    return String(n || 'Athlete').trim().split(/\s+/)[0] || 'Athlete';
  }

  function statusLabel(s) {
    const labels = { lobby: 'Lobby', countdown: 'Starting', playing: 'Racing', racing: 'Racing', results: 'Scoring' };
    return labels[s] || s || 'Lobby';
  }

  function hideToast() {
    const toast = $('inviteToast');
    if (toast) toast.className = 'invite-toast hidden';
  }

  // An invite is an offer, never a forced join: it names the room, and the athlete
  // decides. Joining goes through the lobby so the cabinet is in online mode first.
  function showInvite(m) {
    const toast = $('inviteToast');
    if (!toast || !m || !m.r) return;
    const from = m.from ? (m.from.n || 'An athlete') : 'An athlete';
    toast.innerHTML = '<span><b>' + esc(from) + '</b> invites you to Crossy Road</span>' +
      '<button class="inv-btn" type="button" data-invite-act="join">Join</button>' +
      '<button class="inv-dismiss" type="button" data-invite-act="dismiss" aria-label="Dismiss">&times;</button>';
    toast.className = 'invite-toast show';
    toast.onclick = ev => {
      const btn = ev.target.closest('[data-invite-act]');
      if (!btn) return;
      if (btn.dataset.inviteAct === 'join') {
        if (window.openOnlineLobby) window.openOnlineLobby();
        Net.joinRoom(m.r);
      }
      hideToast();
    };
    clearTimeout(toast._t);
    toast._t = setTimeout(hideToast, 25000);
  }

  function showToast(msg) {
    if (!msg) return;
    const toast = $('inviteToast');
    if (!toast) return;
    toast.onclick = null;
    toast.innerHTML = '<span>' + esc(msg) + '</span>';
    toast.className = 'invite-toast show';
    clearTimeout(toast._t);
    toast._t = setTimeout(hideToast, 3200);
  }

  // ── Lobby button bindings ──
  function bindLobbyButtons() {
    const startBtn = $('btnStartRace');
    const leaveBtn = $('btnLeaveLobby');
    const inviteBtn = $('btnInvite');
    const joinBtn = $('btnJoinCode');
    const joinInput = $('joinCode');

    // One primary button: create a room when seated nowhere, start the race when
    // the host is in a lobby.
    if (startBtn) startBtn.addEventListener('click', () => {
      if (!room) Net.createRoom();
      else Net.startGame();
    });

    if (leaveBtn) leaveBtn.addEventListener('click', () => {
      Net.leaveRoom();
      if (window.CrossyRoad) window.CrossyRoad.showScreen(window.CrossyRoad.screen.menu);
    });

    // The roster is always on screen; this scrolls to it for a long lobby.
    if (inviteBtn) inviteBtn.addEventListener('click', () => {
      const list = $('inviteList');
      if (list && list.scrollIntoView) list.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    const doJoin = () => {
      if (!joinInput) return;
      const code = joinInput.value.trim().toUpperCase();
      if (!code) return;
      Net.joinRoom(code);
      joinInput.value = '';
    };
    if (joinBtn) joinBtn.addEventListener('click', doJoin);
    if (joinInput) {
      joinInput.addEventListener('input', () => {
        joinInput.value = joinInput.value.toUpperCase();
      });
      joinInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); doJoin(); }
      });
    }

    // Invite/join buttons are re-rendered on every presence tick — delegate.
    document.addEventListener('click', e => {
      const inv = e.target.closest('[data-invite]');
      if (inv && !inv.disabled) { Net.invite(inv.dataset.invite); return; }
      const join = e.target.closest('[data-join]');
      if (join && !join.disabled) { Net.joinRoom(join.dataset.join); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindLobbyButtons);
  } else {
    bindLobbyButtons();
  }

  // Expose
  window.Net = Net;
  window.CrossyRoadNet = Net;

  // A portal lobby/invite link must land straight in the live lobby: the menu
  // never opens a socket, so nothing would happen otherwise. Deferred one tick so
  // script.js has published window.openOnlineLobby.
  const BOOT = deepLink();
  if (BOOT.r || BOOT.inv) {
    setTimeout(() => {
      if (window.openOnlineLobby) window.openOnlineLobby();
      Net.connect();
    }, 0);
  }

})();
