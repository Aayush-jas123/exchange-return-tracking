# Athlete Admin — Advanced Controls Guide

## Overview

The athlete admin dashboard (`/pages/athlete-admin`) now includes comprehensive control panels for managing product requests, viewing game results, overriding athlete configurations, and editing all program settings.

---

## New Admin Sections

### 1. Game Results

**Location:** Sidebar → Gamification → Game Results

**Features:**
- **Global Leaderboard** — Top 100 athletes ranked by XP total, showing coins, level, and standing score
- **Game Activity Ledger** — Full transaction history of all game-related XP/coin awards (GAME_XP, GAME_COINS, RACE_XP)
- Filter ledger by game type
- Click any athlete row to open their detail drawer

**API Endpoints:**
- `GET /api/athlete-admin/leaderboard?limit=100`
- `GET /api/athlete-admin/game-ledger?athlete_id=&reason_code=&limit=200`

---

### 2. Product Requests

**Location:** Sidebar → Operations → Product Requests

**Features:**
- View all product requests submitted by athletes
- Filter by status: REQUESTED, APPROVED, REJECTED
- **Approve** requests with optional notes and shipping method
- **Reject** requests with a required reason
- Badge in sidebar shows count of pending (REQUESTED) requests
- Each row shows athlete name, Instagram handle, reason, items summary, and status

**API Endpoints:**
- `GET /api/athlete-admin/product-requests?status=&athlete_id=`
- `POST /api/athlete-admin/product-requests/:id/approve` — body: `{ notes, shipping_method }`
- `POST /api/athlete-admin/product-requests/:id/reject` — body: `{ reason }`

**Workflow:**
1. Athlete submits product request from their portal (Log tab → Request Product)
2. Request appears in admin dashboard with status REQUESTED
3. Admin reviews items, clicks Approve or Reject
4. Status updates to APPROVED or REJECTED with timestamp

---

### 3. Override Controls

**Location:** Sidebar → Operations → Override Controls

**Features:**
- Search for any athlete by ID, name, or athlete number
- **Override XP** — Set any XP value directly (logged in ledger)
- **Override Coins** — Set any coin balance directly (logged in ledger)
- **Override Status** — Change athlete status (ACTIVE, ON_TRIAL, RESERVE, SUSPENDED)
- **Override Level** — Manually set comfort level (bypasses XP requirements)
- **Reset Streak** — Clear an athlete's active streak
- **Award Badge** — Manually grant any badge to the athlete
- Optional reason field for audit trail

**API Endpoints:**
- `POST /api/athlete-admin/athletes/:id/override-xp` — body: `{ xp_total, reason }`
- `POST /api/athlete-admin/athletes/:id/override-coins` — body: `{ coin_balance, reason }`
- `POST /api/athlete-admin/athletes/:id/override-status` — body: `{ athlete_status, reason }`
- `POST /api/athlete-admin/athletes/:id/override-level` — body: `{ level_id }`
- `POST /api/athlete-admin/athletes/:id/reset-streak`
- `POST /api/athlete-admin/athletes/:id/award-badge` — body: `{ badge_code, reason }`

**Usage:**
1. Enter athlete ID or name in search box
2. Click Search to load their current values
3. Modify any field and click the corresponding Set button
4. All changes are confirmed with a prompt before execution
5. XP and coin overrides are logged in the ledger with source ADMIN_OVERRIDE

---

### 4. Configuration Management

**Location:** Sidebar → Operations → Configuration

**Features:**
- **Program Settings** — Edit all `program_settings` table entries (daily task picks, weekly rewards, streak bonuses, etc.)
- **Game Settings** — Modify game-specific configuration (daily XP caps, coin caps, per-run limits, etc.)
- **Comfort Levels** — View all level definitions with XP requirements and perks
- **Badge Definitions** — View all badge codes, categories, and criteria
- **Bulk Save** — Save all program and game settings in one action
- **Reset to Defaults** — Restore all gamification settings to factory defaults

**API Endpoints:**
- `GET /api/athlete-admin/config/all` — Returns all settings, game config, levels, and badges
- `POST /api/athlete-admin/config/bulk-update` — body: `{ settings: [{ key, value }, ...] }`
- `POST /api/athlete-admin/config/reset-gamification` — Resets all game settings to defaults

**Default Gamification Settings:**
| Key | Default |
|-----|---------|
| daily_task.max_picks | 5 |
| weekly_challenge.xp_reward_1st | 500 |
| weekly_challenge.xp_reward_2nd | 300 |
| weekly_challenge.xp_reward_3rd | 200 |
| weekly_challenge.coin_reward_1st | 100 |
| weekly_challenge.coin_reward_2nd | 60 |
| weekly_challenge.coin_reward_3rd | 40 |
| weekly_challenge.max_winners | 10 |
| streak.bonus_xp_per_day | 10 |
| streak.milestone_7_day | 50 |
| streak.milestone_30_day | 200 |
| streak.milestone_100_day | 1000 |
| streak.milestone_365_day | 5000 |
| game.daily_xp_cap | 500 |
| game.daily_coin_cap | 100 |
| game.xp_per_run_max | 100 |
| game.coins_per_run_max | 20 |
| gamification.confetti_enabled | true |
| gamification.sound_enabled | true |

---

## Complete Admin Sidebar Structure

```
Overview
  ├── Dashboard

Athletes
  ├── All Athletes
  └── Applications

Work
  ├── Task Templates
  └── Review Queue

System
  ├── Level Ladder
  ├── Ledger
  ├── Payouts
  └── Settings

Gamification
  ├── Daily Tasks
  ├── Weekly Challenge
  ├── Game Settings
  ├── Streaks & Badges
  └── Game Results ← NEW

Operations ← NEW
  ├── Product Requests
  ├── Override Controls
  └── Configuration
```

---

## Security Notes

- All admin endpoints require the `authAdmin` middleware (Bearer token)
- Override actions are logged in the ledger with source `ADMIN_OVERRIDE`
- Product request approvals/rejections are timestamped and attributed to "admin"
- Configuration changes take effect immediately after save
- Reset to Defaults cannot be undone — use with caution

---

## Integration with Existing Features

- **Product Requests** tie into the athlete portal's Log tab where athletes submit requests
- **Game Results** pull from the same leaderboard data the athlete portal displays
- **Override Controls** use the existing `LedgerService.log()` for audit trails
- **Configuration** reads/writes the same `program_settings` table used by `GamificationService`

---

## File Changes

| File | Changes |
|------|---------|
| `services/athlete-program/routes.js` | +335 lines: 15 new admin API endpoints |
| `public/page.athlete-admin.liquid` | +540 lines: 4 new sidebar sections, HTML, and JavaScript |

**New Endpoints Added (15):**
1. `GET /api/athlete-admin/product-requests`
2. `POST /api/athlete-admin/product-requests/:id/approve`
3. `POST /api/athlete-admin/product-requests/:id/reject`
4. `GET /api/athlete-admin/leaderboard`
5. `GET /api/athlete-admin/game-ledger`
6. `GET /api/athlete-admin/weekly-challenges/:id/entries`
7. `POST /api/athlete-admin/athletes/:id/override-xp`
8. `POST /api/athlete-admin/athletes/:id/override-coins`
9. `POST /api/athlete-admin/athletes/:id/override-status`
10. `POST /api/athlete-admin/athletes/:id/reset-streak`
11. `POST /api/athlete-admin/athletes/:id/award-badge`
12. `GET /api/athlete-admin/config/all`
13. `POST /api/athlete-admin/config/bulk-update`
14. `POST /api/athlete-admin/config/reset-gamification`

---

*Last updated: October 24, 2026*
