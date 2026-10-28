// ═══════════════════════════════════════════════════════════
// OFFCOMFRT Pac-Man — Networking Module
// Connects to existing RaceHub WebSocket (/ws/race)
// Memory-smart: minimal state, single connection, auto-reconnect
// ═══════════════════════════════════════════════════════════
(() => {
  'use strict';

  const GAME_TYPE = 'pac-man';
  const MAX_ROOM = 4;

  // ── State (minimal footprint) ─
  let ws = null;
  let ready = false;
  let myId = null;
  let myName = '';
  let tries = 0;
  let retryTimer = null;
  let stopped = false;

  // Presence data
  let athletes = [];
  let rooms = [];

  // Room state
  let room = null;
  let joiningCode = null;
  let raceId = null;   // hub id of the match in flight (room codes are shared across games)

  // Invite tracking
  const invitedAt = new Map();
  const INVITE_COOLDOWN = 8000;

  // Online game state
  let inGame = false;
  let players = [];  // [{id, name, x, y, score, alive}]
  let lastStateSend = 0;
  const STATE_RATE = 100; // ms between state sends (~10Hz)

  // ─ Public API ──
  const Net = {
    myId: null,
    players: [],

    connect() {
      if (ws || stopped) return;
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
      renderLobby();
    },

    createRoom() {
      send({ t: 'create', game: GAME_TYPE });
    },

    joinRoom(code) {
      joiningCode = String(code).toUpperCase();
      send({ t: 'join', r: joiningCode, game: GAME_TYPE });
    },

    leaveRoom() {
      send({ t: 'leave' });
      room = null;
      raceId = null;
      renderLobby();
    },

    startGame() {
      send({ t: 'start' });
    },

    invite(id) {
      const key = myId + ':' + id;
      if (Date.now() - (invitedAt.get(key) || 0) < INVITE_COOLDOWN) return;
      invitedAt.set(key, Date.now());
      // Without the game the hub opens a Rooftop Race room for the invite.
      send({ t: 'invite', to: id, game: GAME_TYPE });
      renderLobby();
    },

    // One board for the whole lobby: the hub owns the pellets, the ghosts and
    // every death, so all I stream is where I am and which way I face.
    sendState(x, y, dir) {
      if (!inGame || !ready) return;
      const now = Date.now();
      if (now - lastStateSend < STATE_RATE) return;
      lastStateSend = now;
      send({ t: 'pm_state', x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, d: dir | 0 });
    },

    // Forfeit — steps off the shared board so the rest of the room can finish.
    endGame() {
      if (!inGame) return;
      inGame = false;
      send({ t: 'pm_end' });
    }
  };

  // ── WebSocket ──
  function doConnect() {
    const token = window.AthleteXP ? window.AthleteXP.token() : null;
    if (!token) { updateNetStatus('Guest'); return; }

    updateNetStatus('Connecting');
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
      inGame = false;
      updateNetStatus('Offline');
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
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(msg));
    }
  }

  // ── Deep links ──
  // The portal opens a game with `#t=<token>&r=<room>` or `#t=<token>&inv=<athlete>`.
  // athlete-xp.js consumes the hash on load, so its parsed params are read first.
  function deepLink() {
    const p = (window.AthleteXP && window.AthleteXP.params) || {};
    const hash = new URLSearchParams(location.hash.slice(1));
    const r = p.r || hash.get('r');
    const inv = p.inv || hash.get('inv');
    if (window.AthleteXP && window.AthleteXP.params) { window.AthleteXP.params.r = null; window.AthleteXP.params.inv = null; }
    return { r: r || null, inv: inv || null };
  }

  // ── Message handling ──
  function onMsg(m) {
    switch (m.t) {
      case 'hello':
        myId = String(m.me.id);
        myName = m.me.n || '';
        Net.myId = myId;
        ready = true;
        updateNetStatus('Live');
        if (room && room.r) Net.joinRoom(room.r);
        if (!room && BOOT.r) Net.joinRoom(BOOT.r);
        if (BOOT.inv) send({ t: 'invite', to: BOOT.inv, game: GAME_TYPE });
        BOOT.r = null; BOOT.inv = null;
        renderLobby();
        break;

      case 'pr':
        athletes = m.a || [];
        rooms = (m.rooms || []).filter(rm => !rm.game || rm.game === GAME_TYPE);
        renderLobby();
        break;

      case 'room':
        if (m.r && (!m.g || m.g === GAME_TYPE)) {
          room = {
            r: m.r,
            host: m.host,
            status: m.s,
            g: m.g || GAME_TYPE,
            members: (m.m || []).map(mem => ({
              id: String(mem.id),
              n: mem.n,
              lv: mem.lv,
              c: mem.c,
              on: !!mem.on,
              wait: !!mem.wait
            }))
          };
        } else {
          room = null;
        }
        renderLobby();
        break;

      case 'inv':
        // Invites reach every socket of the athlete — only take the pac-man ones.
        if (!m.g || m.g === GAME_TYPE) showInviteToast(m);
        break;

      case 'go': {
        // The hub names the room the match belongs to; `race` is the match id.
        if (!room || (m.room && m.room !== room.r)) break;
        raceId = m.race || null;
        inGame = true;
        const roster = m.roster || [];
        const opps = roster.filter(p => String(p.id) !== myId).map(p => ({
          id: String(p.id),
          name: p.n,
          x: 1, y: 29,
          score: 0,
          alive: true
        }));
        players = opps;
        Net.players = opps;
        if (window.startOnlineGame) window.startOnlineGame(roster, m.in || 0);
        break;
      }

      case 'pm_sync':
        // The whole shared board — pellets, ghosts, lives, deaths — arrives here.
        if (!inGame) break;
        if (window.applyOnlineSync) window.applyOnlineSync(m);
        break;

      case 'res': {
        const mine = room && (m.room ? m.room === room.r : (!raceId || m.race === raceId));
        const wasInGame = inGame;
        inGame = false;
        raceId = null;
        players = [];
        Net.players = [];
        const rows = m.rows || [];
        if (mine && wasInGame && window.endOnlineGame) {
          window.endOnlineGame(rows[0] ? String(rows[0].id) : '', rows.map(r => ({
            id: String(r.id), name: r.n, score: r.sc || 0, rank: r.rank
          })));
        }
        // Stay in the room — the hub hands it back to the lobby a moment later.
        renderLobby();
        break;
      }

      case 'err':
        showToast(m.m || 'Error');
        break;

      case 'ok':
        showToast(m.m || '');
        break;
    }
  }

  // ── Lobby rendering ──
  function renderLobby() {
    const area = $('roomArea');
    const aList = $('athleteList');
    const lList = $('lobbyList');
    if (!area) return;

    // Room card
    if (room) {
      const isHost = room.host === myId;
      const canStart = isHost && room.status === 'lobby' && room.members.length >= 2;
      const memHtml = room.members.map(m =>
        '<span><i></i>' + esc(m.n) + ' <small style="color:var(--dim)">Lv.' + (m.lv || 1) + '</small></span>'
      ).join('');
      area.innerHTML = '<div class="room-card">' +
        '<div class="rhead"><div><div class="lab">Room Code</div><div class="code">' + esc(room.r) + '</div></div>' +
        '<span class="chip' + (room.members.length >= MAX_ROOM ? ' hot' : '') + '">' + room.members.length + '/' + MAX_ROOM + '</span></div>' +
        '<div class="mem">' + memHtml + '</div>' +
        '<div class="btn-row">' +
        (isHost ? '<button class="btn-p" id="btnStart" ' + (canStart ? '' : 'disabled') + '>Start Game</button>' : '') +
        '<button class="btn-p alt" id="btnLeave">Leave</button>' +
        '</div></div>';
      const btnStart = $('btnStart');
      if (btnStart) btnStart.onclick = () => Net.startGame();
      $('btnLeave').onclick = () => Net.leaveRoom();
    } else {
      area.innerHTML = '<div class="room-card">' +
        '<div class="note">Create a room to invite athletes, or join an open lobby.</div>' +
        '<div class="btn-row"><button class="btn-p" id="btnCreate">Create Room</button></div></div>';
      $('btnCreate').onclick = () => Net.createRoom();
    }

    // Athletes list
    const live = athletes.filter(a => a.w === 'game' || a.w === 'portal');
    $('liveCount').textContent = live.length;
    if (!live.length) {
      aList.innerHTML = '<div class="empty">No one online</div>';
    } else {
      aList.innerHTML = live.map(a => {
        const inRoom = a.r && rooms.find(rm => rm.r === a.r);
        return '<div class="lobby-row">' +
          '<div class="lobby-av' + (a.w === 'game' ? ' live' : '') + '">' + (a.n || '?')[0].toUpperCase() + '</div>' +
          '<div class="lobby-info"><b>' + esc(a.n || 'Unknown') + '</b><small>' +
          (inRoom ? 'In room ' + inRoom.r : (a.w === 'game' ? 'In game' : 'Portal')) +
          '</small></div>' +
          (a.id !== myId && room && room.status === 'lobby' && room.members.length < MAX_ROOM ?
            '<button class="btn-s" data-invite="' + a.id + '">Invite</button>' : '') +
          '</div>';
      }).join('');
      aList.querySelectorAll('[data-invite]').forEach(btn => {
        btn.onclick = () => Net.invite(btn.dataset.invite);
      });
    }

    // Open lobbies
    const open = rooms.filter(rm => rm.s === 'lobby');
    $('lobbyCount').textContent = open.length;
    if (!open.length) {
      lList.innerHTML = '<div class="empty">No open lobbies</div>';
    } else {
      lList.innerHTML = open.map(rm =>
        '<div class="lobby-row">' +
        '<div class="lobby-av live">' + rm.r[0] + '</div>' +
        '<div class="lobby-info"><b>Room ' + esc(rm.r) + '</b><small>' + rm.n + '/' + (rm.max || MAX_ROOM) + ' players' +
        (rm.h ? ' \u00b7 Host: ' + esc(rm.h) : '') + '</small></div>' +
        '<button class="btn-s w" data-join="' + rm.r + '">Join</button></div>'
      ).join('');
      lList.querySelectorAll('[data-join]').forEach(btn => {
        btn.onclick = () => Net.joinRoom(btn.dataset.join);
      });
    }
  }

  // ── UI helpers ──
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function updateNetStatus(label) {
    const el = $('netStatus');
    const lbl = $('netLabel');
    if (!el) return;
    el.className = 'net-status' + (label === 'Live' ? ' on' : '');
    if (lbl) lbl.textContent = label;
  }

  function showInviteToast(m) {
    const toast = $('inviteToast');
    if (!toast) return;
    const from = m.from || 'Someone';
    toast.innerHTML = '<span>' + esc(from) + ' invites you to Pac-Man</span>' +
      '<button class="inv-btn" id="invAccept">Accept</button>' +
      '<button class="inv-dismiss" id="invDismiss">&times;</button>';
    toast.className = 'invite-toast show';
    $('invAccept').onclick = () => { Net.joinRoom(m.r); toast.className = 'invite-toast hidden'; };
    $('invDismiss').onclick = () => { toast.className = 'invite-toast hidden'; };
    setTimeout(() => { if (toast.className.includes('show')) toast.className = 'invite-toast hidden'; }, 25000);
  }

  function showToast(msg) {
    if (!msg) return;
    const toast = $('inviteToast');
    if (!toast) return;
    toast.innerHTML = '<span>' + esc(msg) + '</span>';
    toast.className = 'invite-toast show';
    setTimeout(() => { toast.className = 'invite-toast hidden'; }, 3000);
  }

  // Expose
  window.PacManNet = Net;

  // A lobby invite/join link must land straight in the lobby, not on the menu.
  const BOOT = deepLink();
  if (BOOT.r || BOOT.inv) {
    setTimeout(() => {
      if (window.openOnlineLobby) window.openOnlineLobby();
      Net.connect();
    }, 0);
  }

})();
