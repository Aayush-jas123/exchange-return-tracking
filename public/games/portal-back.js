// Portal return — every cabinet loads this before anything else so an athlete can
// always step back out to the portal from inside a game.
// The portal hands its own URL down as `p` in the hash; the hash is read here
// first because athlete-xp.js wipes it on load, and the value is kept in
// sessionStorage so a restart inside a game still knows the way home.
(() => {
  'use strict';

  const KEY = 'ap_portal_url';
  const FALLBACK = 'https://offcomfrt.in/pages/athlete-portal'; // live storefront portal

  function resolvePortal() {
    try {
      const fromHash = new URLSearchParams(location.hash.slice(1)).get('p');
      const fromQuery = new URLSearchParams(location.search).get('portal');
      const explicit = fromHash || fromQuery;
      if (explicit) {
        sessionStorage.setItem(KEY, explicit);
        return explicit;
      }
      const stored = sessionStorage.getItem(KEY);
      if (stored) return stored;
      // Opened straight from the portal: a cross-origin referrer only carries the
      // origin, so re-attach the portal page path when nothing else is left.
      const ref = document.referrer;
      if (ref) {
        const u = new URL(ref);
        if (u.origin !== location.origin) {
          const url = u.origin + (u.pathname && u.pathname !== '/' ? u.pathname : '/pages/athlete-portal');
          sessionStorage.setItem(KEY, url);
          return url;
        }
      }
    } catch (err) { /* private mode, bad param — fall through to the default */ }
    return FALLBACK;
  }

  const PORTAL = resolvePortal();

  const CSS = `
#apBackPortal{
  position:fixed;
  left:calc(10px + env(safe-area-inset-left,0px));
  bottom:calc(10px + env(safe-area-inset-bottom,0px));
  z-index:2147483000;
  display:inline-flex;align-items:center;gap:7px;
  height:34px;padding:0 14px 0 12px;box-sizing:border-box;
  border:1px solid rgba(255,255,255,.26);border-radius:999px;
  background:rgba(10,10,12,.72);
  -webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);
  box-shadow:0 8px 26px rgba(0,0,0,.45);
  color:#f4f4f4;
  font:700 10.5px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  letter-spacing:.16em;text-transform:uppercase;text-decoration:none;
  cursor:pointer;user-select:none;-webkit-user-select:none;
  -webkit-tap-highlight-color:transparent;touch-action:manipulation;
  transition:background .18s ease,border-color .18s ease,transform .12s ease
}
#apBackPortal.top{top:calc(70px + env(safe-area-inset-top,0px));bottom:auto}
#apBackPortal:hover{background:rgba(10,10,12,.94);border-color:rgba(255,255,255,.6)}
#apBackPortal:active{transform:scale(.95)}
#apBackPortal i{font-style:normal;font-size:14px;line-height:1;letter-spacing:0}
`;

  function goBack() {
    // Games open in the portal's own tab, so a plain navigation is the way home;
    // the portal restores the session from sessionStorage on load.
    location.href = PORTAL;
  }

  function mount() {
    if (document.getElementById('apBackPortal') || !document.body) return;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const a = document.createElement('a');
    a.id = 'apBackPortal';
    a.href = PORTAL;
    a.title = 'Back to the athlete portal';
    a.setAttribute('aria-label', 'Back to the athlete portal');
    const arrow = document.createElement('i');
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '\u2190';
    const label = document.createElement('span');
    label.textContent = 'Portal';
    a.append(arrow, label);
    if (window.AP_BACK_POS === 'top-left') a.classList.add('top');

    // Games listen for pointer input across the whole surface; keep taps on the
    // chip out of their handlers so leaving never swings a blade or a paddle.
    ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'touchmove', 'contextmenu']
      .forEach(type => a.addEventListener(type, e => e.stopPropagation(), true));
    a.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      goBack();
    }, true);

    document.body.appendChild(a);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
