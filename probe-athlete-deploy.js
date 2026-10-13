// Probe Shopify: does the athlete-portal page exist? Which themes exist?
// Run: node probe-athlete-deploy.js
require('dotenv').config();
const store = process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_STORE;
const token = process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_TOKEN;
if (!store || !token) { console.error('Missing SHOPIFY_STORE_DOMAIN / SHOPIFY_ACCESS_TOKEN in .env'); process.exit(1); }
const base = `https://${store.replace(/^https?:\/\//, '')}`;

(async () => {
  // 1. Does a Shopify page with handle athlete-portal exist?
  for (const handle of ['athlete-portal', 'athlete-admin', 'athlete-apply']) {
    const r = await fetch(`${base}/admin/api/2024-10/pages.json?handle=${handle}`, {
      headers: { 'X-Shopify-Access-Token': token }
    });
    const data = await r.json();
    const page = (data.pages || [])[0];
    console.log(`page "${handle}": ${page ? `EXISTS (id=${page.id}, template=${page.template_suffix || 'default'})` : 'MISSING'}`);
  }

  // 2. List themes
  const tr = await fetch(`${base}/admin/api/2024-10/themes.json`, {
    headers: { 'X-Shopify-Access-Token': token }
  });
  const themes = (await tr.json()).themes || [];
  for (const t of themes) {
    console.log(`theme: id=${t.id} name="${t.name}" role=${t.role}${t.previewable ? ' previewable' : ''}`);
    // 3. Check athlete templates in each theme
    for (const name of ['templates/page.athlete-portal.liquid', 'templates/page.athlete-admin.liquid']) {
      const ar = await fetch(`${base}/admin/api/2024-10/themes/${t.id}/assets.json?asset[key]=${encodeURIComponent(name)}`, {
        headers: { 'X-Shopify-Access-Token': token }
      });
      console.log(`  ${name}: ${ar.status === 200 ? 'PRESENT' : 'absent'}`);
    }
  }
})();
