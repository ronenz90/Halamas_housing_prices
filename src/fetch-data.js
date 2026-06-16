/**
 * fetch-data.js — CBS Housing Price Index via Cloudflare Worker
 * 
 * Strategy:
 * 1. Load existing housing.json as base (never lose data)
 * 2. Fetch district indices via Cloudflare Worker proxy
 * 3. Keep existing locality prices (updated manually each quarter)
 * 4. Save merged result
 */

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');

const DATA_DIR  = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'housing.json');

// ── CHANGE THIS after deploying your Cloudflare Worker ──────────────────────
// Format: https://cbs-housing-proxy.YOUR_USERNAME.workers.dev
const WORKER_URL = process.env.CBS_WORKER_URL || '';

const DISTRICT_INDICES = {
  national:  { id: 40010, name:'ארצי',    nameEn:'National'  },
  jerusalem: { id: 60000, name:'ירושלים', nameEn:'Jerusalem' },
  north:     { id: 60100, name:'צפון',    nameEn:'North'     },
  haifa:     { id: 60200, name:'חיפה',    nameEn:'Haifa'     },
  center:    { id: 60300, name:'מרכז',    nameEn:'Center'    },
  tel_aviv:  { id: 60400, name:'תל אביב',nameEn:'Tel Aviv'  },
  south:     { id: 60500, name:'דרום',    nameEn:'South'     },
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
        'Accept': 'application/json',
      }
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJSON(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (!data.trim()) return reject(new Error('empty response'));
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function computeYearlyChange(entries) {
  return entries.map((e, i) => {
    if (i < 6) return { ...e, yearlyChange: null };
    const prev = entries[i - 6];
    return { ...e, yearlyChange: +((e.value - prev.value) / prev.value * 100).toFixed(3) };
  });
}

function loadExisting() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      const distCount = Object.values(d.indices || {}).filter(v => v?.entries?.length > 0).length;
      const locCount  = Object.keys(d.localities || {}).length;
      console.log(`  Loaded existing: ${distCount} districts, ${locCount} localities (${d.generated?.slice(0,10)||'?'})`);
      return d;
    }
  } catch(e) { console.warn('  Could not load existing:', e.message); }
  return { indices: {}, localities: {} };
}

async function fetchDistrict(key, meta) {
  // Try Worker first, then direct CBS
  const urls = [];
  if (WORKER_URL) urls.push(`${WORKER_URL}/api?id=${meta.id}`);
  urls.push(`https://api.cbs.gov.il/index/data/price?id=${meta.id}&format=json&download=false&startPeriod=01-2010&pagesize=500`);

  for (const url of urls) {
    const via = url.includes('workers.dev') ? 'Worker' : 'Direct CBS';
    try {
      console.log(`  ${key}: trying ${via}...`);
      const json = await fetchJSON(url);
      const raw = Array.isArray(json) ? json : (json.Data || json.data || json.items || []);
      if (!raw.length) { console.log(`    empty array`); continue; }

      const entries = raw
        .map(e => ({
          period:      e.period || e.Period,
          value:       parseFloat(e.value  || e.Value),
          change:      e.change !== undefined ? parseFloat(e.change) : null,
          provisional: e.provisional === true || e.provisional === 'true',
        }))
        .filter(e => e.period && !isNaN(e.value));

      if (!entries.length) { console.log(`    no valid entries`); continue; }

      const withYearly = computeYearlyChange(entries);
      const latest = entries[entries.length - 1];
      console.log(`    ✓ ${entries.length} entries, latest: ${latest?.period} (via ${via})`);
      return { meta, entries: withYearly, latestPeriod: latest?.period };
    } catch(e) {
      console.log(`    ✗ ${e.message}`);
      await sleep(300);
    }
  }
  return null;
}

async function main() {
  console.log('🏠 CBS Housing Dashboard — Data Fetch');
  console.log(`   ${new Date().toISOString()}`);
  console.log(`   Worker: ${WORKER_URL || '(not configured — direct CBS only)'}\n`);

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // 1. Load existing — NEVER lose data
  const existing = loadExisting();
  const output = {
    ...existing,
    generated:  new Date().toISOString(),
    source:     'הלשכה המרכזית לסטטיסטיקה (CBS)',
    workerUrl:  WORKER_URL || 'direct',
    indices:    { ...(existing.indices  || {}) },
    localities: { ...(existing.localities || {}) },
  };

  // 2. Fetch district indices
  console.log('\n📈 Fetching district indices...');
  let updated = 0;
  for (const [key, meta] of Object.entries(DISTRICT_INDICES)) {
    const result = await fetchDistrict(key, meta);
    if (result) {
      output.indices[key] = result;
      updated++;
    } else {
      console.log(`  ⚠ ${key}: keeping existing`);
    }
    await sleep(400);
  }
  console.log(`\n  Updated: ${updated}/${Object.keys(DISTRICT_INDICES).length} districts`);

  // 3. Locality prices stay as-is (updated manually each quarter)
  const locCount = Object.keys(output.localities).length;
  console.log(`  Localities: ${locCount} (preserved from existing data)`);

  // 4. Save
  fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2));
  const size = (fs.statSync(DATA_FILE).size / 1024).toFixed(1);
  console.log(`\n✅ Saved data/housing.json (${size} KB)`);
  console.log(`   Districts with data: ${Object.values(output.indices).filter(v => v?.entries?.length > 0).length}`);
  console.log(`   Localities: ${locCount}`);

  if (!WORKER_URL) {
    console.log('\n⚠️  TIP: Set CBS_WORKER_URL secret in GitHub repo settings');
    console.log('   after deploying the Cloudflare Worker for reliable fetching.');
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
