// ═══════════════════════════════════════════════════════════
// OFFCOMFRT Crossy Road — Networking Module
// Connects to existing RaceHub WebSocket (/ws/race)
// Memory-smart: minimal state, single connection, auto-reconnect
// ═══════════════════════════════════════════════════════════
(() => {
  'use strict';

  const GAME_TYPE = 'crossy-road';
  const MAX_ROOM = 4;

  // ── State (minimal footprint) ──
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
  let players = [];  // [{id, name, lane, column, score, alive}]
  let lastStateSend = 0;
  const STATE_RATE = 100; // ms between state sends (~10Hz)

  // ── DOM helper ──
  const $ = (id) => document.getElementById(id);

  // ── Public API ──
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
      send({ t: 'invite', to: id, game: GAME_TYPE });
    },

    sendState(lane, column, score) {
      if (!inGame || !ready) return;
      const now = Date.now();
      if (now - lastStateSend < STATE_RATE) return;
      lastStateSend = now;
      send({ t: 'cr_state', l: lane, c: column, s: score });
    },

    sendEnd(score) {
      if (!inGame) return;
      inGame = false;
      send({ t: 'cr_end', scores: [{ id: myId, score: score }] });
    }
  };

  // ─ WebSocket ──
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
      inGame = false;
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
        if (room && room.r) Net.joinRoom(room.r);
        const hash = new URLSearchParams(location.hash.slice(1));
        const r = hash.get('r');
        const inv = hash.get('inv');
        if (r) { Net.joinRoom(r); hash.delete('r'); }
        if (inv) { send({ t: 'invite', to: inv, game: GAME_TYPE }); hash.delete('inv'); }
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
            lane: 0, column: Math.floor(17 / 2),
            score: 0,
            alive: true
          }));
          players = opps;
          Net.players = opps;
          if (window.CrossyRoad) window.CrossyRoad.startOnlineGame();
        }
        break;

      case 'ps':
        if (!inGame) break;
        const positions = m.p || [];
        for (const p of positions) {
          const pid = String(p[0]);
          const opp = players.find(pl => pl.id === pid);
          if (opp) {
            opp.lane = typeof p[1] === 'number' ? p[1] : opp.lane;
            opp.column = typeof p[2] === 'number' ? p[2] : opp.column;
            opp.score = typeof p[3] === 'number' ? p[3] : opp.score;
          }
        }
        Net.players = players;
        if (window.CrossyRoad) {
          for (const opp of players) {
            window.CrossyRoad.updateRemotePlayer(opp.id, opp.lane, opp.column);
          }
        }
        break;

      case 'res':
        if (inGame && room && m.race === room.r) {
          const rows = m.rows || [];
          const myRow = rows.find(r => String(r.id) === myId);
          const myRank = myRow ? myRow.rank : 0;
          const myXP = myRow ? myRow.xp : 0;

          // Update game over UI
          const goXP = $('goXP');
          const goRank = $('goRank');
          const goResults = $('goResults');
          if (goXP) goXP.textContent = myXP > 0 ? '+' + myXP : '--';
          if (goRank) goRank.textContent = myRank > 0 ? '#' + myRank : '--';

          if (goResults) {
            goResults.innerHTML = rows.map(r =>
              '<div class="go-result-row">' +
              '<span class="rr-rank">#' + (r.rank || 0) + '</span>' +
              '<span class="rr-name">' + esc(r.n || 'Player') + '</span>' +
              '<span class="rr-score">' + (r.sc || 0) + ' lanes</span>' +
              '</div>'
            ).join('');
          }
          // Show game over screen
          if (window.CrossyRoad) window.CrossyRoad.showScreen(window.CrossyRoad.screen.over);
        }
        inGame = false;
        room = null;
        players = [];
        Net.players = [];
        if (window.CrossyRoad) window.CrossyRoad.clearRemotePlayers();
        renderLobby();
        break;

      case 'err':
        showToast(m.m || 'Error');
        break;

      case 'ok':
        if (m.m) showToast(m.m);
        break;
    }
  }

  // ── Lobby rendering ──
  function renderLobby() {
    const codeEl = $('lobbyCode');
    const playersEl = $('lobbyPlayers');
    const startBtn = $('btnStartRace');
    const inviteBtn = $('btnInvite');

    if (!codeEl) return;

    if (room) {
      const isHost = room.host === myId;
      const canStart = isHost && room.status === 'lobby' && room.members.length >= 1;

      codeEl.textContent = room.r;

      if (playersEl) {
        playersEl.innerHTML = room.members.map(m =>
          '<div class="lobby-player">' +
          '<span class="dot"></span>' +
          '<span class="pname">' + esc(m.n) + '</span>' +
          (String(m.id) === room.host ? '<span class="phost">Host</span>' : '') +
          '</div>'
        ).join('');
      }

      if (startBtn) {
        startBtn.disabled = !canStart;
        startBtn.textContent = room.status === 'lobby' ? 'Start Race' : 'Waiting...';
      }
      if (inviteBtn) {
        inviteBtn.onclick = () => {
          const live = athletes.filter(a => a.w === 'game' || a.w === 'portal');
          if (live.length === 0) { showToast('No athletes online'); return; }
          // Invite first available athlete
          const target = live.find(a => String(a.id) !== myId);
          if (target) Net.invite(target.id);
          else showToast('No one to invite');
        };
      }
    } else {
      codeEl.textContent = '----';
      if (playersEl) playersEl.innerHTML = '<div class="lobby-player"><span class="dot"></span><span class="pname" style="color:var(--dim)">Create a room to start</span></div>';
      if (startBtn) startBtn.disabled = true;
      // Auto-create room when lobby screen is shown
      if (ready && !joiningCode) Net.createRoom();
    }
  }

  // ── UI helpers ──
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function showInviteToast(m) {
    const toast = $('inviteToast');
    if (!toast) return;
    const from = m.from ? (m.from.n || 'Someone') : 'Someone';
    toast.innerHTML = '<span>' + esc(from) + ' invites you to Crossy Road</span>';
    toast.className = 'invite-toast show';
    if (m.r) { Net.joinRoom(m.r); }
    setTimeout(() => { toast.className = 'invite-toast hidden'; }, 4000);
  }

  function showToast(msg) {
    if (!msg) return;
    const toast = $('inviteToast');
    if (!toast) return;
    toast.innerHTML = '<span>' + esc(msg) + '</span>';
    toast.className = 'invite-toast show';
    setTimeout(() => { toast.className = 'invite-toast hidden'; }, 3000);
  }

  // ── Lobby button bindings ──
  function bindLobbyButtons() {
    const startBtn = $('btnStartRace');
    const leaveBtn = $('btnLeaveLobby');
    if (startBtn) startBtn.addEventListener('click', () => Net.startGame());
    if (leaveBtn) leaveBtn.addEventListener('click', () => {
      Net.leaveRoom();
      if (window.CrossyRoad) window.CrossyRoad.showScreen(window.CrossyRoad.screen.menu);
    });
  }

  // Init lobby bindings when DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindLobbyButtons);
  } else {
    bindLobbyButtons();
  }

  // Expose
  window.Net = Net;

})();
