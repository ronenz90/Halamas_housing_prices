/**
 * fetch-data.js — CBS Housing Price Index
 * 
 * Strategy:
 * 1. Load existing housing.json as base (never lose existing data)
 * 2. Try CBS API for district indices — if successful, update them
 * 3. Try CBS Excel for locality prices — if successful, update them
 * 4. Save merged result (always preserve what we have)
 */

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');

const DATA_DIR  = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'housing.json');

// Multiple User-Agents to try (CBS sometimes blocks generic ones)
const USER_AGENTS = [
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'curl/8.4.0',
];

const DISTRICT_INDICES = {
  national:  { id: 40010, name:'ארצי',    nameEn:'National'  },
  jerusalem: { id: 60000, name:'ירושלים', nameEn:'Jerusalem' },
  north:     { id: 60100, name:'צפון',    nameEn:'North'     },
  haifa:     { id: 60200, name:'חיפה',    nameEn:'Haifa'     },
  center:    { id: 60300, name:'מרכז',    nameEn:'Center'    },
  tel_aviv:  { id: 60400, name:'תל אביב',nameEn:'Tel Aviv'  },
  south:     { id: 60500, name:'דרום',    nameEn:'South'     },
};

const QUARTERLY_EXCEL_CANDIDATES = [
  'https://www.cbs.gov.il/he/mediarelease/Madad/DocLib/2026/155/10_26_155t3.xls',
  'https://www.cbs.gov.il/he/mediarelease/Madad/DocLib/2026/051/10_26_051t3.xls',
  'https://www.cbs.gov.il/he/mediarelease/Madad/DocLib/2025/403/10_25_403t3.xls',
  'https://www.cbs.gov.il/he/mediarelease/Madad/DocLib/2025/310/10_25_310t3.xls',
  'https://www.cbs.gov.il/he/mediarelease/Madad/DocLib/2025/213/10_25_213t3.xls',
  'https://www.cbs.gov.il/he/mediarelease/Madad/DocLib/2025/120/10_25_120t3.xls',
  'https://www.cbs.gov.il/he/mediarelease/Madad/DocLib/2025/086/10_25_086t3.xls',
];

// ── HELPERS ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchJSON(url, ua) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': ua, 'Accept': 'application/json', 'Accept-Language': 'he-IL,he;q=0.9' }
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJSON(res.headers.location, ua).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (!data.trim()) return reject(new Error('empty response'));
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse: ' + data.slice(0,100))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function fetchBinary(url, ua) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': ua, 'Accept': '*/*' }
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchBinary(res.headers.location, ua).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function computeYearlyChange(entries) {
  return entries.map((e, i) => {
    if (i < 6) return { ...e, yearlyChange: null };
    const prev = entries[i - 6];
    return { ...e, yearlyChange: +((e.value - prev.value) / prev.value * 100).toFixed(3) };
  });
}

// ── LOAD EXISTING DATA ────────────────────────────────────────────────────────
function loadExisting() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      console.log(`  Loaded existing data (generated: ${d.generated?.slice(0,10)||'unknown'})`);
      return d;
    }
  } catch(e) { console.warn('  Could not load existing data:', e.message); }
  return { indices: {}, localities: {} };
}

// ── FETCH DISTRICT INDEX ──────────────────────────────────────────────────────
async function fetchDistrictIndex(key, meta) {
  const url = `https://api.cbs.gov.il/index/data/price?id=${meta.id}&format=json&download=false&startPeriod=01-2010&pagesize=500`;
  
  for (const ua of USER_AGENTS) {
    try {
      console.log(`  ${key} (id=${meta.id}) with UA: ${ua.slice(0,30)}...`);
      const json = await fetchJSON(url, ua);
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
      console.log(`    ✓ ${entries.length} entries, latest: ${entries[entries.length-1]?.period}`);
      return { meta, entries: withYearly, latestPeriod: entries[entries.length-1]?.period };
    } catch(e) {
      console.log(`    ✗ ${e.message}`);
      await sleep(400);
    }
  }
  return null; // all UAs failed
}

// ── FETCH LOCALITY EXCEL ──────────────────────────────────────────────────────
async function fetchLocalityPrices() {
  console.log('\n📊 Fetching quarterly locality prices from CBS Excel...');

  // Install xlsx
  try {
    const { execSync } = require('child_process');
    execSync('npm install xlsx --prefix /tmp/xlsxpkg 2>/dev/null', { stdio: 'ignore' });
  } catch(e) {}

  for (const url of QUARTERLY_EXCEL_CANDIDATES) {
    for (const ua of USER_AGENTS) {
      try {
        console.log(`  Trying ${url.split('/').slice(-1)[0]} ...`);
        const buf = await fetchBinary(url, ua);
        if (buf.length < 5000) { console.log(`    too small (${buf.length}B)`); continue; }
        console.log(`  ✓ Downloaded ${(buf.length/1024).toFixed(0)}KB`);

        const XLSX = require('/tmp/xlsxpkg/node_modules/xlsx');
        const wb = XLSX.read(buf, { type: 'buffer', codepage: 1255 });
        
        // Find sheet with locality data
        let ws = null;
        for (const name of wb.SheetNames) {
          const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
          if (csv.includes('ירושלים') && csv.length > 2000) {
            ws = wb.Sheets[name];
            console.log(`  Sheet: "${name}"`);
            break;
          }
        }
        if (!ws) { ws = wb.Sheets[wb.SheetNames[0]]; console.log(`  Fallback sheet: "${wb.SheetNames[0]}"`); }

        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        const localities = {};
        let quarterLabel = '';

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const str = row.join(' ');
          
          // Find quarter
          if (/רבע|Q[1-4]/i.test(str) && /202\d/.test(str)) {
            quarterLabel = row.filter(c=>c!=='').join(' ').trim().slice(0,30);
          }

          const cityName = String(row[0]||row[1]||'').trim();
          if (!cityName || cityName.length < 2) continue;
          if (/סה"כ|כלל|total|ממוצע|סך/i.test(cityName)) continue;

          // Extract price numbers from row
          const prices = row.map(c => {
            const n = parseFloat(String(c).replace(/,/g, ''));
            return n > 200000 && n < 20000000 ? n : null;
          }).filter(Boolean);

          if (prices.length >= 3) {
            localities[cityName] = {
              name: cityName,
              rooms3:  prices[0] || null,
              rooms4:  prices[1] || null,
              rooms5:  prices[2] || null,
              total:   prices[3] || prices[0] || null,
              quarter: quarterLabel || 'latest',
            };
          }
        }

        const count = Object.keys(localities).length;
        console.log(`  ✓ Parsed ${count} localities`);
        if (count >= 10) return { localities, quarter: quarterLabel };
        console.log('  Too few localities, trying next...');
      } catch(e) {
        console.log(`    ✗ ${e.message}`);
      }
      await sleep(300);
    }
  }
  return null;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🏠 CBS Housing Dashboard — Data Fetch');
  console.log(`   Time: ${new Date().toISOString()}\n`);

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // 1. Load existing data as base — NEVER lose it
  const existing = loadExisting();
  const output = {
    ...existing,
    generated: new Date().toISOString(),
    source: 'הלשכה המרכזית לסטטיסטיקה (CBS)',
    indices:    { ...(existing.indices || {}) },
    localities: { ...(existing.localities || {}) },
  };

  // 2. Try to update district indices from CBS API
  console.log('\n📈 Fetching district indices from CBS API...');
  let apiSuccessCount = 0;
  for (const [key, meta] of Object.entries(DISTRICT_INDICES)) {
    const result = await fetchDistrictIndex(key, meta);
    if (result) {
      output.indices[key] = result;
      apiSuccessCount++;
    } else {
      console.log(`  ⚠ ${key}: keeping existing data`);
      // keep existing[key] — already in output.indices
    }
    await sleep(600);
  }
  console.log(`\n  API results: ${apiSuccessCount}/${Object.keys(DISTRICT_INDICES).length} districts updated`);

  // 3. Try to update locality prices from Excel
  const locResult = await fetchLocalityPrices();
  if (locResult && Object.keys(locResult.localities).length >= 10) {
    output.localities = locResult.localities;
    output.latestQuarter = locResult.quarter;
    console.log(`\n  ✓ Localities updated from Excel`);
  } else {
    console.log(`\n  ⚠ Using cached locality data (${Object.keys(output.localities).length} localities)`);
  }

  // 4. Save — always write, even if nothing changed (updates timestamp)
  const json = JSON.stringify(output, null, 2);
  fs.writeFileSync(DATA_FILE, json);
  console.log(`\n✅ Saved data/housing.json (${(fs.statSync(DATA_FILE).size/1024).toFixed(1)} KB)`);
  console.log(`   Districts with data: ${Object.values(output.indices).filter(v=>v?.entries?.length>0).length}`);
  console.log(`   Localities: ${Object.keys(output.localities).length}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
