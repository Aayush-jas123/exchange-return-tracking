# Game Unlock Feature

## Overview
Added the ability to lock/unlock games in the athlete portal's Games tab. Admins can control game availability from the admin portal's new "Game Management" section.

## Changes Made

### 1. Database Migration
**File:** `supabase_migration_game_unlocks.sql`

Seeds two new settings in `program_settings`:
- `game.fruit-ninja.unlocked` = `false` (locked by default)
- `game.rooftop-racing.unlocked` = `true` (unlocked by default)

**Action Required:** Run this migration manually in the Supabase SQL Editor before the feature works.

### 2. Backend Service
**File:** `services/athlete-program/GamificationService.js`

Added two new methods:
- `getGameUnlocks()` — Returns an object mapping game IDs to their unlock status
- `updateGameUnlock(gameId, unlocked, actorId)` — Updates a specific game's unlock status

### 3. Backend Routes
**File:** `services/athlete-program/routes.js`

Added three new endpoints:

**Athlete-facing:**
- `GET /api/athlete/:token/games/unlocks` — Fetch game unlock status (requires PROGRESS scope)

**Admin-facing:**
- `GET /api/athlete-admin/game-unlocks` — Fetch all game unlock statuses
- `PATCH /api/athlete-admin/game-unlocks/:gameId` — Toggle a game's unlock status (body: `{ unlocked: boolean }`)

### 4. Athlete Portal Frontend
**File:** `public/page.athlete-portal.liquid`

**CSS:** `shopify-assets/athlete-portal.css`
- `.gt.locked` — dimmed art, not-allowed cursor, "Tap to play" row hidden
- `.gt-lock` / `.gt-lock .lk` — full-tile overlay with lock glyph
- `.gt-lock span` / `.gt-lock small` — "Coming soon" label + supporting line

**HTML:** every game tile carries a `data-game-id` plus a `.gt-lock` overlay
(labelled "Coming soon").

**JavaScript:** `shopify-assets/athlete-portal.js`
- `loadUnlocks()` calls `/games/unlocks` once from `enterPortal()` (deliberately
  kept out of the `ENDPOINTS` array so a failed read never blocks login)
- `linkGames()` applies `.locked`, strips the `href` of any tile whose flag is
  explicitly `false`, then reorders the grid so **locked tiles sink to the bottom**
  below the playable cabinets and re-stamps the `01 · …` ordinals to match the
  new visual order; tapping one shows a "Coming soon" toast
- `server.js` returns a 403 "Coming soon" interstitial for a locked game's HTML
  entry path, so a direct URL cannot bypass the portal tile

### 5. Admin Portal Frontend
**File:** `public/page.athlete-admin.liquid`

**Navigation:**
- Added "Game Management" nav item in the Gamification group

**HTML section:**
- Added `#sec-game-management` section with description and `#gameManagementView` container

**JavaScript additions:**
- Added `gameUnlocks` state variable
- Added `loadGameManagement()` — Fetches game unlock statuses from API
- Added `renderGameManagement()` — Renders game cards with lock/unlock toggles
- Added `toggleGameUnlock(gameId, unlocked)` — API call to toggle game status
- Added nav handler for `game-management` section

## How It Works

### Athlete Experience
1. When the athlete portal loads, it fetches `/games/unlocks` along with other endpoints
2. The `linkGames()` function checks each game's unlock status
3. Locked games show:
   - Dimmed appearance (opacity 0.7)
   - Darker grayscale filter on thumbnail
   - Lock overlay with icon and "Locked / Ask admin to unlock" text
   - Click shows toast message instead of navigating
4. Unlocked games work normally with token appended to URL

### Admin Experience
1. Admin navigates to "Game Management" in the Gamification section
2. Sees a list of all games with:
   - Game name and description
   - Current status badge (Unlocked/Locked) with color coding
   - Toggle button to lock/unlock
3. Clicking toggle calls `PATCH /api/athlete-admin/game-unlocks/:gameId`
4. UI updates immediately with new status
5. Changes take effect for athletes on next portal load

## Adding New Games

To add a new game to the system:

1. **Migration:** Add a new setting:
   ```sql
   INSERT INTO program_settings (key, value, description, category, created_at, updated_at)
   VALUES ('game.<game-id>.unlocked', 'false', 'Whether <Game Name> is unlocked', 'game', NOW(), NOW())
   ON CONFLICT (key) DO NOTHING;
   ```

2. **Athlete Portal:** Add a game tile with `data-game-id="<game-id>"`:
   ```html
   <a class="gt" data-game-id="<game-id>" href="..." target="_blank">
     ...
   </a>
   ```

3. **Admin Portal:** Add the game to the `games` array in `renderGameManagement()`:
   ```javascript
   { id: '<game-id>', name: '<Game Name>', description: '...' }
   ```

## Testing

### Pre-deployment Checklist
- [ ] Run `supabase_migration_game_unlocks.sql` in Supabase SQL Editor
- [ ] Verify `node -c services/athlete-program/routes.js` passes
- [ ] Verify `node -c services/athlete-program/GamificationService.js` passes
- [ ] Verify athlete portal inline script syntax (done)
- [ ] Verify admin portal inline script syntax (done)
- [ ] Verify all DOM IDs exist (done)

### Manual Testing
1. **Athlete Portal:**
   - Log in with a test athlete token
   - Navigate to Games tab
   - Verify Fruit Ninja shows lock overlay
   - Verify clicking shows toast message
   - Verify Rooftop Racing works normally

2. **Admin Portal:**
   - Log in to admin dashboard
   - Navigate to Game Management
   - Verify both games appear with correct status
   - Click "Unlock Game" on Fruit Ninja
   - Verify status changes to "Unlocked"
   - Refresh athlete portal — Fruit Ninja should now work

## Files Modified
- `services/athlete-program/GamificationService.js`
- `services/athlete-program/routes.js`
- `public/page.athlete-portal.liquid`
- `public/page.athlete-admin.liquid`

## Files Created
- `supabase_migration_game_unlocks.sql`
- `GAME_UNLOCK_FEATURE.md` (this file)
