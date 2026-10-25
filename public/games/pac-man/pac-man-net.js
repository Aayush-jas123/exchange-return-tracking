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
      send({ t: 'join', r: joiningCode });
    },

    leaveRoom() {
      send({ t: 'leave' });
      room = null;
      renderLobby();
    },

    startGame() {
      send({ t: 'start' });
    },

    invite(id) {
      const key = myId + ':' + id;
      if (Date.now() - (invitedAt.get(key) || 0) < INVITE_COOLDOWN) return;
      invitedAt.set(key, Date.now());
      send({ t: 'invite', to: id });
      renderLobby();
    },

    sendState(x, y, score) {
      if (!inGame || !ready) return;
      const now = Date.now();
      if (now - lastStateSend < STATE_RATE) return;
      lastStateSend = now;
      send({ t: 'pm_state', x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, s: score });
    },

    endGame(myScore) {
      if (!inGame) return;
      inGame = false;
      send({ t: 'pm_end', scores: [{ id: myId, score: myScore }] });
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
        const hash = new URLSearchParams(location.hash.slice(1));
        const r = hash.get('r');
        const inv = hash.get('inv');
        if (r) { Net.joinRoom(r); hash.delete('r'); }
        if (inv) { send({ t: 'invite', to: inv }); hash.delete('inv'); }
        if (hash.toString()) {
          history.replaceState(null, '', location.pathname + location.search + (hash.toString() ? '#' + hash.toString() : ''));
        }
        renderLobby();
        break;

      case 'pr':
        athletes = m.a || [];
        rooms = (m.rooms || []).filter(rm => !rm.game || rm.game === GAME_TYPE);
        renderLobby();
        break;

      case 'room':
        if (m.r) {
          room = {
            r: m.r,
            host: m.host,
            status: m.s,
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
        showInviteToast(m);
        break;

      case 'go':
        if (room && room.r === m.race) {
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
          if (window.startOnlineGame) window.startOnlineGame(roster);
        }
        break;

      case 'ps':
        if (!inGame) break;
        const positions = m.p || [];
        for (const p of positions) {
          const pid = String(p[0]);
          const opp = players.find(pl => pl.id === pid);
          if (opp) {
            opp.x = typeof p[1] === 'number' ? p[1] / 100 : opp.x;
            opp.y = typeof p[2] === 'number' ? p[2] / 100 : opp.y;
            opp.score = typeof p[3] === 'number' ? p[3] : opp.score;
          }
        }
        Net.players = players;
        if (window.updateOnlinePlayers) window.updateOnlinePlayers(players);
        break;

      case 'res':
        if (inGame && room && m.race === room.r) {
          const rows = m.rows || [];
          if (window.endOnlineGame) {
            const winner = rows[0] ? String(rows[0].id) : '';
            window.endOnlineGame(winner, rows.map(r => ({ id: String(r.id), score: r.sc || 0 })));
          }
        }
        inGame = false;
        room = null;
        players = [];
        Net.players = [];
        renderLobby();
        break;

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

})();
