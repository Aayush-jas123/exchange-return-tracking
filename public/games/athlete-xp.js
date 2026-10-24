// Athlete arcade bridge — reports a finished run to the athlete API so the
// score turns into XP and shop coins. The portal opens games with `#t=<token>`; the token is
// kept in sessionStorage so restarts inside the game keep earning.
(() => {
  const API = '/api/athlete';
  const KEY = 'ap_game_token';

  // `r` = room code to join, `inv` = athlete id to invite (multiplayer race).
  const hash = new URLSearchParams(location.hash.slice(1));
  const hashToken = hash.get('t');
  const params = { r: hash.get('r') || null, inv: hash.get('inv') || null };
  if (hashToken) sessionStorage.setItem(KEY, hashToken);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  const token = () => sessionStorage.getItem(KEY);

  function toast(text) {
    let el = document.getElementById('apXpToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'apXpToast';
      el.style.cssText = 'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:99999;' +
        'background:rgba(10,10,12,.92);color:#fff;border:1px solid rgba(255,255,255,.18);border-radius:999px;' +
        'padding:9px 16px;font:600 13px/1.2 -apple-system,BlinkMacSystemFont,Inter,sans-serif;letter-spacing:.02em;' +
        'pointer-events:none;transition:opacity .3s;opacity:0';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = '0'; }, 3200);
  }

  const MESSAGES = {
    cooldown: 'Run logged — reward cooldown, play again in a moment',
    score_too_low: 'Go further to earn XP & coins on this run',
    daily_cap: 'Daily arcade XP & coins maxed — come back tomorrow',
    duplicate: 'Run already counted'
  };

  async function report(game, score) {
    const t = token();
    if (!t) return null; // played outside the portal — nothing to credit
    const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    try {
      const res = await fetch(`${API}/${encodeURIComponent(t)}/games/xp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game, score, run_id: runId })
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) sessionStorage.removeItem(KEY);
        return null;
      }
      const r = body.data || {};
      const parts = [];
      if (r.awarded > 0) parts.push(`+${r.awarded} XP`);
      if (r.coins_awarded > 0) parts.push(`+${r.coins_awarded} coins`);
      if (parts.length) toast(`${parts.join(' · ')} · ${r.earned_today}/${r.daily_cap} XP today`);
      else if (MESSAGES[r.reason]) toast(MESSAGES[r.reason]);
      return r;
    } catch (e) {
      return null;
    }
  }

  window.AthleteXP = { report, token, params, toast };
})();
