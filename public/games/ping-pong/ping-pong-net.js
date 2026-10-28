// ═══════════════════════════════════════════════════════════
// OFFCOMFRT Ping Pong — Networking Module
// Connects to existing RaceHub WebSocket (/ws/race)
// Memory-smart: minimal state, single connection, auto-reconnect
// ═══════════════════════════════════════════════════════════
(() => {
  'use strict';

  const GAME_TYPE = 'ping-pong';
  const MAX_ROOM = 2; // ping-pong is 1v1

  // ── State (minimal footprint) ──
  let ws = null;
  let ready = false;
  let myId = null;
  let myName = '';
  let tries = 0;
  let retryTimer = null;
  let stopped = false;

  // Presence data (single source of truth)
  let athletes = [];   // [{ id, n, lv, w, r, s }]
  let rooms = [];      // [{ r, h, n, max, s, game }]

  // Room state
  let room = null;     // { r, host, status, g, members: [] }
  let joiningCode = null;
  let raceId = null;   // hub id of the match in flight (room codes are shared across games)

  // Invite tracking
  const invitedAt = new Map(); // id -> timestamp
  const INVITE_COOLDOWN = 8000;

  // Online game state
  let inGame = false;
  let opponentY = null;
  let opponentName = '';
  let lastStateSend = 0;
  const STATE_RATE = 50; // ms between state sends (~20Hz)

  // ─ Public API ──
  const Net = {
    opponentY: null,
    opponentName: '',

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
      const to = id == null ? '' : String(id);
      if (!to || to === myId) return;   // never offer an invite to yourself
      const key = myId + ':' + to;
      if (Date.now() - (invitedAt.get(key) || 0) < INVITE_COOLDOWN) return;
      invitedAt.set(key, Date.now());
      send({ t: 'invite', to, game: GAME_TYPE });
      renderLobby();
    },

    sendState(normalizedY, rally) {
      if (!inGame || !ready) return;
      const now = Date.now();
      if (now - lastStateSend < STATE_RATE) return;
      lastStateSend = now;
      send({ t: 'pp_state', y: Math.round(normalizedY * 1000) / 1000, r: rally });
    },

    endGame(winner, s1, s2) {
      if (!inGame) return;
      inGame = false;
      send({ t: 'pp_end', w: winner, s1, s2 });
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

    ws.onopen = () => {
      tries = 0;
    };

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
        ready = true;
        updateNetStatus('Live');
        // Rejoin room if we had one
        if (room && room.r) {
          Net.joinRoom(room.r);
        }
        // Deep links from the portal: `#r=<code>` joins a room, `#inv=<id>` invites an athlete.
        // They are read once at load — athlete-xp.js consumes the hash before this module runs.
        if (!room && BOOT.r) Net.joinRoom(BOOT.r);
        // A deep link may carry my own id (a stale share link) — inviting myself
        // is never a real invite.
        if (BOOT.inv && String(BOOT.inv) !== myId) send({ t: 'invite', to: String(BOOT.inv), game: GAME_TYPE });
        BOOT.r = null; BOOT.inv = null;
        renderLobby();
        break;

      case 'pr':
        // The hub sends raw database ids (athlete rows are numbers) while myId is
        // a string — normalise at the wire instead of trusting the type per site.
        athletes = (m.a || []).map(a => Object.assign({}, a, { id: String(a.id) }));
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
        // Invites reach every socket of the athlete — only take the ping-pong ones.
        if (!m.g || m.g === GAME_TYPE) showInviteToast(m);
        break;

      case 'go': {
        // The hub names the room the match belongs to; `race` is the match id.
        if (!room || (m.room && m.room !== room.r)) break;
        raceId = m.race || null;
        inGame = true;
        const roster = m.roster || [];
        const opp = roster.find(p => String(p.id) !== myId);
        opponentName = opp ? opp.n : 'Opponent';
        Net.opponentName = opponentName;
        if (window.startOnlineGame) window.startOnlineGame(opponentName);
        break;
      }

      case 'ps':
        // Position/state relay
        if (!inGame) break;
        const positions = m.p || [];
        for (const p of positions) {
          const pid = String(p[0]);
          if (pid !== myId) {
            // p[2] = y position (normalized 0-100 range from hub)
            // For ping-pong we send normalized Y directly
            const oppNormY = typeof p[2] === 'number' ? p[2] / 100 : null;
            if (oppNormY !== null) {
              opponentY = oppNormY;
              Net.opponentY = oppNormY;
              if (window.updateOpponentPaddle) window.updateOpponentPaddle(oppNormY);
            }
          }
        }
        break;

      case 'res':
        // Results for this room. The local game usually reported its own end already,
        // so the server scoreboard is only applied when the match is still on screen.
        if (room && (m.room ? m.room === room.r : (!raceId || m.race === raceId))) {
          const rows = m.rows || [];
          const mine = rows.find(r => String(r.id) === myId);
          const opp = rows.find(r => String(r.id) !== myId);
          const wasInGame = inGame;
          inGame = false;
          if (wasInGame && mine && window.endOnlineGame) {
            window.endOnlineGame(opp && opp.rank < mine.rank ? 2 : 1, mine.sc || 0, opp ? opp.sc || 0 : 0);
          }
        }
        inGame = false;
        raceId = null;
        // Stay in the room — the hub hands it back to the lobby a moment later.
        renderLobby();
        break;

      case 'err':
        // Show error as toast
        showToast(m.m || 'Error');
        break;

      case 'ok':
        showToast(m.m || '');
        break;
    }
  }

  // ── Lobby rendering ──
  function renderLobby() {
    const on = ready;
    const hasTok = !!myId;
    const ns = document.getElementById('netStatus');
    if (ns) {
      ns.className = 'net-status' + (on ? ' on' : '');
    }

    // Room card
    const rc = document.getElementById('roomCard');
    if (!rc) return;

    if (!hasTok) {
      rc.innerHTML = '<p>Open Ping Pong from your athlete portal to play live. You can still practise solo against the AI.</p>' +
        '<div class="btn-row"><button class="btn-p" data-act="back">Back to menu</button></div>';
      return;
    }

    if (!on) {
      rc.innerHTML = '<p>Connecting to the live arena\u2026</p>';
      return;
    }

    if (!room) {
      rc.innerHTML = '<div class="lab">Live match</div>' +
        '<p>Create a room, invite an athlete, or join an open lobby. First to 10 wins \u2014 3 misses and you\u2019re out.</p>' +
        '<div class="btn-row"><button class="btn-p" data-act="create">Create room</button></div>';
      return;
    }

    // In a room
    const isHost = String(room.host) === myId;
    const members = room.members;
    const liveCount = members.filter(m => m.on).length;
    const me = members.find(m => m.id === myId);
    const opp = members.find(m => m.id !== myId);

    let memHtml = members.map(m =>
      '<span><i></i>' + esc(m.n) +
      (m.id === myId ? ' <em>you</em>' : '') +
      (m.id === String(room.host) ? ' <em>host</em>' : '') +
      (!m.on ? ' <em>away</em>' : '') +
      '</span>'
    ).join('');

    let mainBtn;
    if (room.status !== 'lobby') {
      mainBtn = '<button class="btn-p" disabled>Match in progress</button>';
    } else if (isHost) {
      mainBtn = opp && opp.on
        ? '<button class="btn-p" data-act="start">Start match</button>'
        : '<button class="btn-p" disabled>Waiting for opponent</button>';
    } else {
      mainBtn = '<button class="btn-p" disabled>Waiting for host</button>';
    }

    let noteHtml = '';
    if (liveCount < 2 && room.status === 'lobby') {
      noteHtml = '<div class="note">Invite an athlete to start a match</div>';
    }

    rc.innerHTML =
      '<div class="rhead">' +
        '<div><div class="lab">Room code</div><div class="code">' + esc(room.r) + '</div></div>' +
        '<span class="chip' + (room.status !== 'lobby' ? ' hot' : '') + '">' + statusLabel(room.status) + '</span>' +
      '</div>' +
      '<div class="mem">' + memHtml + '</div>' +
      noteHtml +
      '<div class="btn-row">' + mainBtn + '<button class="btn-p alt" data-act="leave">Leave</button></div>';

    // Live athletes list
    const liveList = document.getElementById('liveList');
    const liveCountEl = document.getElementById('liveCount');
    if (liveList) {
      const others = athletes.filter(a => String(a.id) !== myId);
      if (liveCountEl) liveCountEl.textContent = on ? others.length + ' online' : '';

      if (!on) {
        liveList.innerHTML = '<div class="empty">Offline</div>';
      } else if (!others.length) {
        liveList.innerHTML = '<div class="empty">No one else is live</div>';
      } else {
        liveList.innerHTML = others.slice(0, 40).map(a => {
          let statusText, btnHtml = '';
          const sameRoom = a.r && a.r === room.r;
          if (sameRoom) statusText = 'In your room';
          else if (a.r && a.s === 'lobby') { statusText = 'Lobby \u00b7 ' + a.r; btnHtml = '<button class="btn-s w" data-act="join" data-r="' + esc(a.r) + '">Join</button>'; }
          else if (a.r) statusText = 'In match';
          else statusText = a.w === 'game' ? 'In arcade' : 'On portal';

          if (!btnHtml && !sameRoom) {
            const sent = Date.now() - (invitedAt.get(String(a.id)) || 0) < INVITE_COOLDOWN;
            btnHtml = '<button class="btn-s w" data-act="invite" data-id="' + esc(a.id) + '"' + (sent ? ' disabled' : '') + '>' + (sent ? 'Sent' : 'Invite') + '</button>';
          }

          return '<div class="lobby-row">' +
            '<div class="lobby-av live">' + esc(initials(a.n)) + '</div>' +
            '<div class="lobby-info"><b>' + esc(a.n) + '</b><small>' + esc(statusText) + (a.lv ? ' \u00b7 ' + esc(a.lv) : '') + '</small></div>' +
            btnHtml +
          '</div>';
        }).join('');
      }
    }

    // Open lobbies list
    const roomListEl = document.getElementById('roomList');
    if (roomListEl) {
      const openRooms = rooms.filter(rm => rm.r !== room.r);
      if (!on) {
        roomListEl.innerHTML = '<div class="empty">Offline</div>';
      } else if (!openRooms.length) {
        roomListEl.innerHTML = '<div class="empty">No open lobbies</div>';
      } else {
        roomListEl.innerHTML = openRooms.map(rm => {
          const full = rm.n >= rm.max;
          return '<div class="lobby-row">' +
            '<div class="lobby-av">' + rm.n + '</div>' +
            '<div class="lobby-info"><b>' + esc(rm.h) + '\u2019s room</b><small>' + esc(rm.r) + ' \u00b7 ' + rm.n + '/' + rm.max + ' \u00b7 ' + esc(statusLabel(rm.s)) + '</small></div>' +
            '<button class="btn-s' + (rm.s === 'lobby' && !full ? ' w' : '') + '" data-act="join" data-r="' + esc(rm.r) + '"' + (full ? ' disabled' : '') + '>' + (full ? 'Full' : rm.s === 'lobby' ? 'Join' : 'Join next') + '</button>' +
          '</div>';
        }).join('');
      }
    }
  }

  // ── Lobby action delegation ──
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const act = el.dataset.act;
    if (act === 'create') Net.createRoom();
    else if (act === 'start') Net.startGame();
    else if (act === 'leave') Net.leaveRoom();
    else if (act === 'join') Net.joinRoom(el.dataset.r);
    else if (act === 'invite') Net.invite(el.dataset.id);
    else if (act === 'back') { Net.disconnect(); }
  });

  // ── Invite toast ─
  function showInviteToast(m) {
    const el = document.getElementById('inviteToast');
    if (!el) return;
    const from = m.from ? m.from.n || 'An athlete' : 'An athlete';
    el.innerHTML = '<span><b>' + esc(from) + '</b> invited you to Ping Pong</span>' +
      '<button class="inv-btn" data-invite="join">Join</button>' +
      '<button class="inv-dismiss" data-invite="dismiss">&times;</button>';
    el.className = 'invite-toast show';

    el.onclick = ev => {
      const btn = ev.target.closest('[data-invite]');
      if (!btn) return;
      if (btn.dataset.invite === 'join') {
        // Land in the lobby first. Joining straight from the toast skips the menu,
        // and the menu is what switches the cabinet into online mode — without it
        // the match would start against the local AI.
        if (window.openOnlineLobby) window.openOnlineLobby();
        Net.joinRoom(m.r);
      }
      el.className = 'invite-toast hidden';
    };

    clearTimeout(el._t);
    el._t = setTimeout(() => { el.className = 'invite-toast hidden'; }, 25000);
  }

  // ── Generic toast ──
  function showToast(text) {
    if (!text) return;
    let el = document.getElementById('ppToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ppToast';
      el.style.cssText = 'position:fixed;left:50%;top:60px;transform:translateX(-50%);z-index:9999;' +
        'background:rgba(10,10,12,.92);color:#f0f0f2;border:1px solid #2a2a32;border-radius:999px;' +
        'padding:9px 16px;font:600 13px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;' +
        'pointer-events:none;transition:opacity .3s;opacity:0';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = '0'; }, 3200);
  }

  // ── Helpers ──
  function updateNetStatus(text) {
    const el = document.getElementById('netStatus');
    if (el) el.lastChild.textContent = text;
  }

  function statusLabel(s) {
    const labels = { lobby: 'Waiting', countdown: 'Starting', racing: 'Playing', results: 'Scoring' };
    return labels[s] || s || 'Unknown';
  }

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function initials(n) {
    return String(n || '?').trim().split(/\s+/).slice(0, 2).map(s => s[0] || '').join('').toUpperCase();
  }

  // ── Expose ──
  window.PingPongNet = Net;

  // A lobby invite/join link must land straight in the lobby, not on the menu.
  const BOOT = deepLink();
  if (BOOT.r || BOOT.inv) {
    setTimeout(() => {
      if (window.openOnlineLobby) window.openOnlineLobby();
      Net.connect();
    }, 0);
  }

})();
