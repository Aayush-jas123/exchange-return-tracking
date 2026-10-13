# Athlete Portal Access Guide

## Overview
Migrated influencers can now access the athlete portal through token-based authentication. The admin dashboard provides a way to generate and manage portal access tokens for each athlete.

## How to Give Athletes Portal Access

### From the Admin Dashboard

1. **Open the Admin Dashboard**
   - URL: `https://offcomfrt.in/pages/athlete-admin`
   - Note: portal pages are Shopify-hosted (theme templates + pages), not served by the Render API server. If the URL 404s, the athlete templates/pages have not been deployed to the Shopify theme yet — see "Deploying the portal pages" below.

2. **Navigate to Athletes Tab**
   - You'll see a list of all migrated athletes

3. **Click "View" on Any Athlete**
   - This opens the athlete detail drawer on the right side

4. **Find the "Portal Access" Section**
   - Scroll down in the drawer to find "Portal Access"
   - Click **"Generate Portal Token"**

5. **Copy the Token**
   - The system will display:
     - **Portal URL**: `https://exchange-return-tracking.onrender.com/pages/athlete-portal`
     - **Access Token**: A long alphanumeric string (e.g., `a3f5b8c9d2e4f6...`)
   - Click **"Copy Token"** to copy it to your clipboard
   - **⚠️ IMPORTANT**: Save this token now — it won't be shown again!

6. **Share with the Athlete**
   - Send them:
     - The portal URL
     - Their access token
   - They can paste the token at the portal login screen to access their dashboard

### If an Athlete Loses Their Token

1. Open the athlete's drawer in the admin dashboard
2. In the "Portal Access" section, you'll see "Token Already Exists"
3. Click **"Rotate Token"**
4. This will:
   - Invalidate the old token (it stops working)
   - Generate a new token
   - Display the new token for you to copy and share

## Deploying the portal pages

The portal pages are Shopify-hosted. Both pieces are required — a theme template AND a page record — otherwise `/pages/<handle>` returns 404 (verified: `/pages/influencer-portal` → 200, `/pages/contact` → 404 even though its template exists).

1. **Upload the templates to the live theme**
   - Shopify Admin → Online Store → Themes → ⋯ → Edit code → templates → Add a new template
   - Upload `public/page.athlete-portal.liquid`, `page.athlete-admin.liquid`, `page.athlete-apply.liquid` from this repo (source of truth: `exchange-return-tracking-main/public/`)
   - Or push via the connected theme workspace / Shopify CLI

2. **Create the page records** (templates alone do NOT create URLs)
   - Shopify Admin → Online Store → Pages → Add page
   - "Athlete Portal" → handle `athlete-portal` (set via Search engine listing) → Theme template: `athlete-portal` → Visible
   - Repeat for "Athlete Admin" (`athlete-admin`) and "Athlete Apply" (`athlete-apply`)

3. **Verify**: `https://offcomfrt.in/pages/athlete-portal` must show the OFFCOMFRT token login card. If login still fails, the in-page Diagnostics panel now shows per-endpoint status (401 = bad/revoked token, 404 = API routes missing, network error = server/CORS) with a Copy button.

## For Migrated Influencers

If you have many migrated influencers who need tokens, you can use the batch script:

```bash
cd /Users/sunny/Downloads/OFFCOMFRT/exchange-return-tracking-main
SUPABASE_URL=your_url SUPABASE_SERVICE_ROLE_KEY=your_key node get-athlete-tokens.js
```

This will:
- Check all active athletes
- Generate tokens for those who don't have one
- Save results to `athlete-tokens-YYYY-MM-DD.json`

## Athlete Portal Features

Once athletes log in with their token, they can:
- ✅ View their level, XP, and standing score
- ✅ See active tasks and assignments
- ✅ Submit task proof (post URLs)
- ✅ View the leaderboard
- ✅ Track their coin balance and earnings

## Technical Details

- **Token Storage**: Only the hash is stored in the database (SHA-256)
- **Token Scope**: PROGRESS tokens are permanent and non-expiring
- **Security**: Tokens are single-use for display — once generated, they can't be retrieved again
- **Rotation**: Admins can rotate tokens to invalidate old ones and issue new ones

## API Endpoint

The admin dashboard uses this endpoint:
```
POST /api/athlete-admin/athletes/:id/token
Body: { rotate: true/false }
Headers: { Authorization: 'Bearer <admin_token>' }
```

Response includes the raw token (only shown once).
