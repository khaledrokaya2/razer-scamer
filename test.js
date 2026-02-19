/**
 * razerMultiCheck.js
 *
 * Pipeline model — each browser immediately starts login the moment
 * it finishes launching, without waiting for any other browser.
 * Fully configurable session count.
 */

const puppeteer = require('puppeteer');

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const SESSION_COUNT = 8; // ← Change this to any number (10, 50, 100...)

const ACCOUNT = {
  email: 'mostloda14@gmail.com',
  password: 'vvt?Zr54S%Xe+Wp',
};

const LOGIN_URL = 'https://razerid.razer.com';
const DASHBOARD_URL = 'https://razerid.razer.com/dashboard';

// Delay between each browser spawn — prevents OS from being overwhelmed
// 300ms = 10 browsers in 3s, 100 browsers in 30s
const LAUNCH_STAGGER_MS = 300;

const MAX_RETRIES = 2;

// ─── HELPERS ─────────────────────────────────────────────────────────────────

const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const delay = (ms) => new Promise(r => setTimeout(r, ms));

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:123.0) Gecko/20100101 Firefox/123.0',
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 1280, height: 800 },
  { width: 1600, height: 900 },
  { width: 1280, height: 1024 },
  { width: 1400, height: 1050 },
  { width: 1680, height: 1050 },
  { width: 1024, height: 768 },
];

// ─── STEALTH ─────────────────────────────────────────────────────────────────

async function applyStealthPatches(page) {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [{ name: 'Chrome PDF Plugin' }, { name: 'Chrome PDF Viewer' }] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
  });
}

// ─── SAFE NAVIGATION ─────────────────────────────────────────────────────────

async function safeGoto(page, url, label, options = {}) {
  const opts = { waitUntil: 'domcontentloaded', timeout: 20000, ...options };
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      await page.goto(url, opts);
      return;
    } catch (err) {
      const isNetError = err.message.includes('ERR_ABORTED') || err.message.includes('net::');
      if (isNetError && attempt <= MAX_RETRIES) {
        console.warn(`${label} Nav failed, retrying (${attempt}/${MAX_RETRIES})...`);
        await delay(1000 * attempt);
      } else {
        throw err;
      }
    }
  }
}

// ─── FULL SESSION PIPELINE ───────────────────────────────────────────────────
// Each session runs its own full pipeline: launch → login → balance → close
// No waiting for any other session at any point.

async function runSession(index) {
  const label = `[Session ${index + 1}]`;
  const userAgent = USER_AGENTS[index % USER_AGENTS.length];
  const viewport = VIEWPORTS[index % VIEWPORTS.length];

  let browser;

  // ── Step 1: Launch ──
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        `--window-size=${viewport.width},${viewport.height}`,
      ],
    });
    console.log(`${label} ✅ Browser ready → starting login immediately`);
  } catch (err) {
    console.error(`${label} ❌ Launch failed: ${err.message}`);
    return { email: ACCOUNT.email, error: `Launch failed: ${err.message}` };
  }

  const page = await browser.newPage();

  try {
    await applyStealthPatches(page);
    await page.setUserAgent(userAgent);
    await page.setViewport(viewport);
    page.setDefaultTimeout(30000);

    // ── Step 2: Login (immediately after launch, no waiting) ──
    // Retry full page load if the form doesn't appear (blank/partial load)
    let formFound = false;
    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
      await safeGoto(page, LOGIN_URL, label);
      try {
        await page.waitForSelector('#input-login-email', { visible: true, timeout: 8000 });
        await page.waitForSelector('#input-login-password', { visible: true, timeout: 8000 });
        formFound = true;
        break;
      } catch {
        console.warn(`${label} Login form not found, reloading (${attempt}/${MAX_RETRIES})...`);
        await delay(1000 * attempt);
      }
    }
    if (!formFound) throw new Error('Login form never appeared after retries');

    await page.type('#input-login-email', ACCOUNT.email, { delay: randInt(20, 50) });
    await page.type('#input-login-password', ACCOUNT.password, { delay: randInt(20, 50) });

    try {
      await page.waitForSelector('button[aria-label="Accept All"]', { visible: true, timeout: 2000 });
      await page.click('button[aria-label="Accept All"]');
      await delay(150);
    } catch { /* no banner */ }

    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
    ]);

    const url = page.url();
    if (url === 'https://razerid.razer.com' || url === 'https://razerid.razer.com/') {
      throw new Error('Login failed — wrong credentials or captcha');
    }

    console.log(`${label} ✅ Logged in → fetching balance`);

    // ── Step 3: Balance (immediately after login) ──
    await safeGoto(page, DASHBOARD_URL, label);
    await page.waitForSelector('.info-balance', { visible: true, timeout: 8000 });

    const balance = await page.evaluate(() => {
      const b = document.querySelectorAll('.info-balance');
      return {
        gold: b[0]?.innerText.trim() || 'N/A',
        silver: b[1]?.innerText.trim() || 'N/A',
      };
    });

    console.log(`${label} ✅ Gold: ${balance.gold} | Silver: ${balance.silver}`);
    return { email: ACCOUNT.email, ...balance };

  } catch (err) {
    console.error(`${label} ❌ ${err.message}`);
    return { email: ACCOUNT.email, error: err.message };

  } finally {
    // Force close with timeout — prevents hanging if browser is unresponsive
    await Promise.race([
      browser.close(),
      delay(5000),
    ]).catch(() => { });
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log(`Starting ${SESSION_COUNT} sessions (staggered ${LAUNCH_STAGGER_MS}ms apart)...\n`);
  console.log(`Each browser starts its login THE MOMENT it finishes launching.\n`);

  // Fire off all sessions — each one starts its own pipeline independently.
  // The stagger is only between the launch calls, not between the sessions themselves.
  const sessionPromises = [];

  for (let i = 0; i < SESSION_COUNT; i++) {
    // Wait before spawning next browser (OS stability)
    if (i > 0) await delay(LAUNCH_STAGGER_MS);
    // Do NOT await the session — push it and move on to spawn the next browser
    sessionPromises.push(runSession(i));
  }

  // All browsers are now launched and running their pipelines independently.
  // Just wait for all of them to report back.
  const results = await Promise.all(sessionPromises);

  // ── Final report ──
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n══════════════════════════════════════════');
  console.log('           BALANCE CHECK RESULTS          ');
  console.log('══════════════════════════════════════════');
  results.forEach((r, i) => {
    console.log(`Session ${i + 1} | ${r.email}`);
    if (r.error) {
      console.log(`  ❌ Error: ${r.error}`);
    } else {
      console.log(`  🟡 Gold:   ${r.gold}`);
      console.log(`  ⚪ Silver: ${r.silver}`);
    }
    console.log('──────────────────────────────────────────');
  });
  console.log(`\n✅ All done in ${elapsed}s`);
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});