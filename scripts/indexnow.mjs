// Tells search engines that support IndexNow (Bing, Yandex, Naver, Seznam...)
// which pages the site has, so a change is crawled in minutes rather than days.
//
// Run by .github/workflows/indexnow.yml after a push to main. It waits for the
// deploy to publish the key file (that is how IndexNow checks the site owner
// agrees), then submits every URL in the live sitemap.
//
//   INDEXNOW_SITE=https://example.com INDEXNOW_KEY=<key> node scripts/indexnow.mjs
const site = process.env.INDEXNOW_SITE?.replace(/\/$/, '');
const key = process.env.INDEXNOW_KEY;
if (!site || !key) throw new Error('INDEXNOW_SITE and INDEXNOW_KEY are required');

const keyLocation = `${site}/${key}.txt`;
const WAIT_MS = 15 * 60_000;
const POLL_MS = 20_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Workers Builds deploys on its own schedule, so poll until the key is live. */
async function waitForKey() {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const response = await fetch(keyLocation, { cache: 'no-store' }).catch(() => null);
    if (response?.ok && (await response.text()).trim() === key) return;
    await sleep(POLL_MS);
  }
  throw new Error(`${keyLocation} did not serve the key within ${WAIT_MS / 60_000} minutes`);
}

/** Every <loc> of the sitemap, following a sitemap index if there is one. */
async function sitemapUrls(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const xml = await response.text();
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((match) => match[1]);
  if (!xml.includes('<sitemapindex')) return locs;
  return (await Promise.all(locs.map(sitemapUrls))).flat();
}

await waitForKey();
const urlList = [...new Set(await sitemapUrls(`${site}/sitemap.xml`))];

const response = await fetch('https://api.indexnow.org/IndexNow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host: new URL(site).host, key, keyLocation, urlList }),
});
// 200 and 202 both mean accepted (202: the key is still being validated).
if (response.status !== 200 && response.status !== 202) {
  throw new Error(`IndexNow answered ${response.status}: ${await response.text()}`);
}
console.log(`IndexNow accepted ${urlList.length} URLs for ${site} (${response.status})`);
