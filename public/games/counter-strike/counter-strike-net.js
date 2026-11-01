// ═══════════════════════════════════════════════════════════
// OFFCOMFRT Counter Strike — Networking Module
// Connects to existing RaceHub WebSocket (/ws/race)
// Memory-smart: minimal state, single connection, auto-reconnect
// ═══════════════════════════════════════════════════════════
(() => {
  'use strict';

  const GAME_TYPE = 'counter-strike';
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
  let raceId = null;

  // Invite tracking
  const invitedAt = new Map();
  const INVITE_COOLDOWN = 8000;

  // Online game state
  let inGame = false;
  let lastStateSend = 0;
  const STATE_RATE = 100; // ms between state sends (~10Hz)

  // ── Public API ──
  const Net = {
    myId: null,
    connected: false,
    inGame: false,
    room: null,

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
      Net.connected = false;
      room = null;
      raceId = null;
      inGame = false;
      Net.inGame = false;
      Net.room = null;
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
      const to = sid(id);
      if (!to || to === myId) return;
      const key = myId + ':' + to;
      if (Date.now() - (invitedAt.get(key) || 0) < INVITE_COOLDOWN) return;
      invitedAt.set(key, Date.now());
      send({ t: 'invite', to, game: GAME_TYPE });
      renderLobby();
    },

    // Stream player state to hub at 10Hz
    sendState(pos, yaw, pitch, speed, crouching, onGround, weapon, reload, shoot, hitRay) {
      if (!inGame || !ready) return;
      const nowMs = Date.now();
      if (nowMs - lastStateSend < STATE_RATE) return;
      lastStateSend = nowMs;
      send({
        t: 'cs_state',
        pos: { x: Math.round(pos.x * 100) / 100, z: Math.round(pos.z * 100) / 100 },
        yaw: Math.round(yaw * 1000) / 1000,
        pitch: Math.round(pitch * 1000) / 1000,
        speed: Math.round(speed * 100) / 100,
        crouching: !!crouching,
        onGround: onGround !== false,
        weapon: weapon || 'rifle',
        reload: !!reload,
        shoot: !!shoot,
        hitRay: hitRay || null
      });
    },

    endGame() {
      send({ t: 'cs_end' });
      inGame = false;
      Net.inGame = false;
    },

    // Callbacks
    onSnapshot: null,
    onRoundEnd: null,
    onMatchEnd: null,
    onRoomUpdate: null
  };

  // ── Connection ──
  function doConnect() {
    if (stopped) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws/race?t=${encodeURIComponent(getToken())}&c=game`;
    ws = new WebSocket(url);

    ws.onopen = () => {
      ready = true;
      Net.connected = true;
      tries = 0;
      console.log('[CSNet] Connected to RaceHub');
    };

    ws.onclose = () => {
      ready = false;
      Net.connected = false;
      ws = null;
      if (stopped) return;
      tries++;
      const delay = Math.min(30000, 1000 * Math.pow(2, tries - 1));
      retryTimer = setTimeout(doConnect, delay);
    };

    ws.onerror = () => {};

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (!msg || typeof msg.t !== 'string') return;

      // Hello — own identity
      if (msg.t === 'hello') {
        myId = sid(msg.me.id);
        myName = msg.me.n || '';
        Net.myId = myId;
        renderLobby();
        return;
      }

      // Presence
      if (msg.t === 'pr' || msg.t === 'presence') {
        athletes = msg.a || [];
        rooms = msg.rooms || msg.r || [];
        // Normalize athlete IDs to strings
        athletes = athletes.map(a => ({ ...a, id: sid(a.id) }));
        renderLobby();
        return;
      }

      // Room update
      if (msg.t === 'room') {
        // msg.r is the room code; the full room data is in msg itself
        const members = (msg.m || []).map(m => ({ ...m, id: sid(m.id) }));
        
        // Ensure current user is in the members list
        if (myId && !members.some(m => m.id === myId)) {
          members.push({
            id: myId,
            n: myName || 'You',
            lv: 0,
            on: true,
            wait: false
          });
        }
        
        room = {
          code: msg.r,
          host: sid(msg.host),
          status: msg.s,
          game: msg.g,
          max: msg.max || MAX_ROOM,
          members
        };
        Net.room = room;
        if (room) {
          raceId = room.code;
        }
        renderLobby();
        if (Net.onRoomUpdate) Net.onRoomUpdate(room);
        return;
      }

      // Game start
      if (msg.t === 'go') {
        if (msg.game !== GAME_TYPE) return;
        raceId = msg.race;
        inGame = true;
        Net.inGame = true;
        if (window.startCountdown) {
          window.startCountdown(msg.in || 3500, msg.roster || []);
        }
        return;
      }

      // Snapshot
      if (msg.t === 'snapshot' || (msg.round !== undefined && msg.state)) {
        if (Net.onSnapshot) Net.onSnapshot(msg);
        return;
      }

      // Results
      if (msg.t === 'res') {
        if (msg.game && msg.game !== GAME_TYPE) return;
        inGame = false;
        Net.inGame = false;
        if (window.endOnlineGame) window.endOnlineGame(msg.rows || []);
        if (Net.onMatchEnd) Net.onMatchEnd(msg.rows || []);
        return;
      }

      // Error
      if (msg.t === 'err') {
        console.warn('[CSNet] Server error:', msg.m);
        if (window.showLobbyError) window.showLobbyError(msg.m);
      }

      // Invite received
      if (msg.t === 'inv') {
        if (msg.g && msg.g !== GAME_TYPE) return; // ignore invites for other games
        const fromName = msg.from?.n || 'An athlete';
        const roomCode = msg.r;
        console.log('[CSNet] Invite from', fromName, 'to room', roomCode);
        // Show invite notification
        if (window.showInvite) {
          window.showInvite(fromName, roomCode, () => {
            Net.joinRoom(roomCode);
          });
        } else {
          // Fallback: auto-join if no UI handler
          Net.joinRoom(roomCode);
        }
        return;
      }
    };
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  // ── Helpers ──
  function sid(v) { return v == null ? null : String(v); }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function getToken() {
    // Try to get token from AthleteXP module or URL params
    if (window.AthleteXP && window.AthleteXP.token) return window.AthleteXP.token();
    const params = new URLSearchParams(location.search);
    return params.get('t') || params.get('token') || '';
  }

  // ── Lobby Rendering ──
  function renderLobby() {
    const lobbyEl = document.getElementById('csLobby');
    if (!lobbyEl) return;

    if (!Net.connected) {
      lobbyEl.innerHTML = '<div class="lobby-status">Connecting...</div>';
      return;
    }

    if (!room) {
      // Show room creation / join UI + online athletes
      const onlineAthletes = athletes.filter(a => sid(a.id) !== myId);
      lobbyEl.innerHTML = `
        <div class="lobby-actions">
          <button class="lobby-btn primary" id="csCreateRoom">Create Room</button>
          <div class="lobby-join">
            <input type="text" id="csJoinCode" placeholder="Room Code" maxlength="6" autocomplete="off" />
            <button class="lobby-btn" id="csJoinRoom">Join</button>
          </div>
        </div>
        <div class="lobby-room-list">
          <h3>Available Rooms</h3>
          <div id="csRoomList"></div>
        </div>
        <div class="lobby-athletes">
          <h3>Online Athletes (${onlineAthletes.length})</h3>
          <div id="csAthleteList"></div>
        </div>
      `;
      document.getElementById('csCreateRoom').onclick = () => Net.createRoom();
      document.getElementById('csJoinRoom').onclick = () => {
        const code = document.getElementById('csJoinCode').value.trim();
        if (code) Net.joinRoom(code);
      };

      // Render available rooms
      const listEl = document.getElementById('csRoomList');
      const csRooms = rooms.filter(r => r.game === GAME_TYPE);
      if (csRooms.length === 0) {
        listEl.innerHTML = '<div class="no-rooms">No rooms available. Create one!</div>';
      } else {
        listEl.innerHTML = csRooms.map(r => `
          <div class="room-card" data-code="${escapeHtml(r.code)}">
            <div class="room-code">${escapeHtml(r.code)}</div>
            <div class="room-info">${r.members?.length || 0}/${MAX_ROOM} players</div>
            <button class="room-join-btn" data-code="${escapeHtml(r.code)}">Join</button>
          </div>
        `).join('');
        listEl.querySelectorAll('.room-join-btn').forEach(btn => {
          btn.onclick = () => Net.joinRoom(btn.dataset.code);
        });
      }

      // Render online athletes with invite buttons
      const athleteEl = document.getElementById('csAthleteList');
      if (onlineAthletes.length === 0) {
        athleteEl.innerHTML = '<div class="no-athletes">No other athletes online</div>';
      } else {
        athleteEl.innerHTML = onlineAthletes.map(a => `
          <div class="athlete-row" data-id="${escapeHtml(a.id)}">
            <span class="athlete-name">${escapeHtml(a.n || a.name || 'Athlete')}</span>
            <span class="athlete-status">Online</span>
            <button class="athlete-invite-btn" data-id="${escapeHtml(a.id)}">Invite to Room</button>
          </div>
        `).join('');
        athleteEl.querySelectorAll('.athlete-invite-btn').forEach(btn => {
          btn.onclick = () => {
            // Create a room first if not in one, then invite
            if (!room) {
              Net.createRoom();
              // Wait for room creation, then invite
              setTimeout(() => {
                if (room) Net.invite(btn.dataset.id);
              }, 500);
            } else {
              Net.invite(btn.dataset.id);
            }
          };
        });
      }
      return;
    }

    // Show room details
    const isHost = sid(room.host) === myId;
    const members = room.members || [];
    const onlineCount = members.filter(m => m.on).length;

    lobbyEl.innerHTML = `
      <div class="room-header">
        <div class="room-code-large">${escapeHtml(room.code)}</div>
        <button class="lobby-btn small" id="csLeaveRoom">Leave</button>
      </div>
      <div class="room-members">
        <h3>Players (${onlineCount}/${MAX_ROOM})</h3>
        <div id="csMemberList"></div>
      </div>
      <div class="room-actions">
        ${isHost ? `
          <button class="lobby-btn primary" id="csStartGame" ${onlineCount < 1 ? 'disabled' : ''}>
            ${onlineCount < 1 ? 'Waiting for players...' : 'Start Game'}
          </button>
          <div class="invite-section">
            <h4>Invite Athletes</h4>
            <div id="csInviteList"></div>
          </div>
        ` : `
          <div class="waiting-msg">Waiting for host to start...</div>
        `}
      </div>
    `;

    document.getElementById('csLeaveRoom').onclick = () => Net.leaveRoom();
    if (isHost) {
      const startBtn = document.getElementById('csStartGame');
      if (startBtn) startBtn.onclick = () => Net.startGame();

      // Render invite list
      const inviteEl = document.getElementById('csInviteList');
      const otherAthletes = athletes.filter(a => sid(a.id) !== myId && !members.some(m => m.id === sid(a.id)));
      if (otherAthletes.length === 0) {
        inviteEl.innerHTML = '<div class="no-invites">No other athletes online</div>';
      } else {
        inviteEl.innerHTML = otherAthletes.map(a => {
          const inRoom = members.some(m => m.id === sid(a.id));
          const invited = room.invited?.includes(sid(a.id));
          return `
            <div class="invite-row" data-id="${escapeHtml(a.id)}">
              <span class="invite-name">${escapeHtml(a.n || a.name || 'Athlete')}</span>
              ${inRoom ? '<span class="invite-status">In room</span>' :
                invited ? '<span class="invite-status">Invited</span>' :
                `<button class="invite-btn" data-id="${escapeHtml(a.id)}">Invite</button>`}
            </div>
          `;
        }).join('');
        inviteEl.querySelectorAll('.invite-btn').forEach(btn => {
          btn.onclick = () => Net.invite(btn.dataset.id);
        });
      }
    }

    // Render member list
    const memberEl = document.getElementById('csMemberList');
    memberEl.innerHTML = members.map(m => `
      <div class="member-row ${m.on ? 'online' : 'offline'}">
        <span class="member-name">${escapeHtml(m.n || m.name || 'Athlete')} ${m.id === myId ? '(You)' : ''}</span>
        <span class="member-status">${m.on ? 'Online' : 'Away'}</span>
      </div>
    `).join('');
  }

  // ── Initialize ──
  function init() {
    // Get athlete ID from AthleteXP or URL
    if (window.AthleteXP && window.AthleteXP.getAthleteId) {
      myId = sid(window.AthleteXP.getAthleteId());
    }
    if (window.AthleteXP && window.AthleteXP.getAthleteName) {
      myName = window.AthleteXP.getAthleteName();
    }
    Net.myId = myId;

    // Expose to window
    window.CSNet = Net;

    // Auto-connect
    Net.connect();
  }

  // Boot when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
