/**
 * fetch-data.js — CBS Housing Price Index + Quarterly Avg Prices by Locality
 * 
 * Fetches two data sources:
 * 1. CBS API (api.cbs.gov.il) — bi-monthly district-level index (JSON)
 * 2. CBS Excel (cbs.gov.il) — quarterly avg prices by locality & rooms (XLS)
 * 
 * Runs via GitHub Actions on the 15th of each month.
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { execSync } = require('child_process');

// ── CONFIG ───────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, '..', 'data');
const UA = 'IsraelHousingDashboard/2.0 (github.com/ronenz90/Halamas_housing_prices)';

// District index API endpoints
const DISTRICT_INDICES = {
  national:  40010,
  jerusalem: 60000,
  north:     60100,
  haifa:     60200,
  center:    60300,
  tel_aviv:  60400,
  south:     60500,
};
const DISTRICT_META = {
  national:  { name:'ארצי',    nameEn:'National'   },
  jerusalem: { name:'ירושלים', nameEn:'Jerusalem'  },
  north:     { name:'צפון',    nameEn:'North'      },
  haifa:     { name:'חיפה',    nameEn:'Haifa'      },
  center:    { name:'מרכז',    nameEn:'Center'     },
  tel_aviv:  { name:'תל אביב',nameEn:'Tel Aviv'   },
  south:     { name:'דרום',    nameEn:'South'      },
};

// CBS publishes quarterly avg-price Excel files.
// URL pattern: https://www.cbs.gov.il/he/mediarelease/Madad/DocLib/{YEAR}/{DOC_ID}/{DOC_ID}t3.xls
// The doc ID changes each release. We discover it by scraping the CBS housing page.
// Fallback: try last known URLs for recent quarters.
const CBS_HOUSING_PAGE = 'https://www.cbs.gov.il/he/subjects/Pages/מדד-מחירי-דירות.aspx';

// Known quarterly Excel URLs (lasts few releases — we try newest first)
// Pattern: t3 = prices by locality & rooms
const QUARTERLY_EXCEL_CANDIDATES = [
  // 2026
  'https://www.cbs.gov.il/he/mediarelease/Madad/DocLib/2026/155/10_26_155t3.xls',
  'https://www.cbs.gov.il/he/mediarelease/Madad/DocLib/2026/051/10_26_051t3.xls',
  // 2025
  'https://www.cbs.gov.il/he/mediarelease/Madad/DocLib/2025/403/10_25_403t3.xls',
  'https://www.cbs.gov.il/he/mediarelease/Madad/DocLib/2025/310/10_25_310t3.xls',
  'https://www.cbs.gov.il/he/mediarelease/Madad/DocLib/2025/213/10_25_213t3.xls',
  'https://www.cbs.gov.il/he/mediarelease/Madad/DocLib/2025/120/10_25_120t3.xls',
  'https://www.cbs.gov.il/he/mediarelease/Madad/DocLib/2025/086/10_25_086t3.xls',
  'https://www.cbs.gov.il/he/mediarelease/Madad/DocLib/2025/051/10_25_051t3.xls',
  // 2024
  'https://www.cbs.gov.il/he/mediarelease/Madad/DocLib/2024/403/10_24_403t3.xls',
  'https://www.cbs.gov.il/he/mediarelease/Madad/DocLib/2024/310/10_24_310t3.xls',
];

// ── HELPERS ──────────────────────────────────────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse: ' + data.slice(0,200))); }
      });
    }).on('error', reject);
  });
}

function fetchBinary(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': UA } }, res => {
      // Follow redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchBinary(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function computeYearlyChange(entries) {
  return entries.map((e, i) => {
    if (i < 6) return { ...e, yearlyChange: null };
    const prev = entries[i - 6];
    return { ...e, yearlyChange: +((( e.value - prev.value) / prev.value * 100).toFixed(3)) };
  });
}

// ── FETCH DISTRICT INDEX ──────────────────────────────────────────────────────
async function fetchDistrictIndex(key, id) {
  const url = `https://api.cbs.gov.il/index/data/price?id=${id}&format=json&download=false&startPeriod=01-2010&pagesize=500`;
  console.log(`  Fetching district ${key} (id=${id})...`);
  try {
    const json = await fetchJSON(url);
    const raw = Array.isArray(json) ? json : (json.Data || json.data || json.items || []);
    if (!raw.length) throw new Error('empty response');
    const entries = raw
      .map(e => ({
        period:      e.period || e.Period,
        value:       parseFloat(e.value  || e.Value),
        change:      e.change !== undefined ? parseFloat(e.change) : null,
        provisional: e.provisional === true || e.provisional === 'true',
      }))
      .filter(e => !isNaN(e.value));
    const withYearly = computeYearlyChange(entries);
    console.log(`    ✓ ${entries.length} entries, latest: ${entries[entries.length-1]?.period}`);
    return { key, meta: { id, ...DISTRICT_META[key] }, entries: withYearly, latestPeriod: entries[entries.length-1]?.period };
  } catch(err) {
    console.error(`    ✗ ${key}: ${err.message}`);
    return { key, meta: { id, ...DISTRICT_META[key] }, entries: [], error: err.message };
  }
}

// ── FETCH QUARTERLY LOCALITY PRICES ──────────────────────────────────────────
// Install xlsx if needed, then parse the Excel file
async function fetchLocalityPrices() {
  console.log('\n📊 Fetching quarterly locality prices from CBS Excel...');

  // Install xlsx parser
  try {
    execSync('npm install xlsx --prefix /tmp/xlsxpkg 2>/dev/null', { stdio: 'ignore' });
  } catch(e) { /* already installed */ }

  let xlsBuf = null;
  let successUrl = null;

  for (const url of QUARTERLY_EXCEL_CANDIDATES) {
    try {
      console.log(`  Trying: ${url.split('/').slice(-2).join('/')}`);
      xlsBuf = await fetchBinary(url);
      if (xlsBuf.length > 5000) { // valid file
        successUrl = url;
        console.log(`  ✓ Downloaded ${(xlsBuf.length/1024).toFixed(0)}KB`);
        break;
      }
    } catch(e) {
      console.log(`    skip: ${e.message}`);
    }
    await sleep(300);
  }

  if (!xlsBuf) {
    console.warn('  ⚠️  Could not fetch quarterly Excel — using cached data if available');
    return null;
  }

  // Save raw file for debugging
  fs.writeFileSync(path.join(DATA_DIR, 'latest_quarterly.xls'), xlsBuf);

  // Parse with xlsx
  try {
    const XLSX = require('/tmp/xlsxpkg/node_modules/xlsx');
    const wb = XLSX.read(xlsBuf, { type: 'buffer', codepage: 1255 }); // Hebrew Windows encoding

    // The file typically has sheet "לוח 3" or similar with locality data
    // Find the sheet with locality price data
    let targetSheet = null;
    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(ws);
      // Look for sheet containing room counts and city names
      if (csv.includes('ירושלים') && (csv.includes('3') || csv.includes('חדר'))) {
        targetSheet = ws;
        console.log(`  Using sheet: "${sheetName}"`);
        break;
      }
    }

    if (!targetSheet) {
      // Fallback: use first sheet
      targetSheet = wb.Sheets[wb.SheetNames[0]];
      console.log(`  Fallback to first sheet: "${wb.SheetNames[0]}"`);
    }

    const rows = XLSX.utils.sheet_to_json(targetSheet, { header: 1, defval: '' });

    // Parse the locality price table
    // CBS format: locality | total | 1-2 rooms | 3 rooms | 4 rooms | 5+ rooms | new | used
    const localityPrices = {};
    let headerRowIdx = -1;
    let quarterLabel = '';

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowStr = row.join(',');

      // Find quarter label (e.g., "2025 רביעי רבעון")
      if (rowStr.match(/רבע|quarter|Q[1-4]/i) && rowStr.match(/202[0-9]/)) {
        quarterLabel = row.filter(c => c !== '').join(' ').trim();
      }

      // Find header row (contains "חדרים" or room numbers)
      if (rowStr.includes('3') && rowStr.includes('4') && rowStr.includes('5') && rowStr.includes('ישוב')) {
        headerRowIdx = i;
        continue;
      }

      // Parse data rows after header
      if (headerRowIdx >= 0 && i > headerRowIdx) {
        const cityName = String(row[0] || row[1] || '').trim();
        if (!cityName || cityName.length < 2) continue;
        // Skip summary/total rows
        if (cityName.includes('סה"כ') || cityName.includes('כלל') || cityName.includes('Total')) continue;

        const nums = row.map(c => {
          const n = parseFloat(String(c).replace(/,/g, ''));
          return isNaN(n) ? null : n;
        });
        const validNums = nums.filter(n => n !== null && n > 100000); // prices > 100k NIS

        if (validNums.length >= 2) {
          localityPrices[cityName] = {
            name: cityName,
            total:   validNums[0] || null,
            rooms3:  validNums[1] || null,
            rooms4:  validNums[2] || null,
            rooms5:  validNums[3] || null,
            quarter: quarterLabel || 'latest',
          };
        }
      }
    }

    const count = Object.keys(localityPrices).length;
    console.log(`  ✓ Parsed ${count} localities from Excel`);
    if (count === 0) {
      console.warn('  ⚠️  Zero localities parsed — sheet structure may have changed');
    }

    return { localities: localityPrices, sourceUrl: successUrl, quarter: quarterLabel };

  } catch(err) {
    console.error('  ✗ Excel parse error:', err.message);
    return null;
  }
}

// ── MERGE WITH EXISTING ───────────────────────────────────────────────────────
function mergeLocalityData(newData, existingPath) {
  if (!newData || Object.keys(newData.localities || {}).length === 0) {
    // Return existing cached data
    try {
      const existing = JSON.parse(fs.readFileSync(existingPath, 'utf8'));
      if (existing.localities) {
        console.log('  Using cached locality data');
        return existing.localities;
      }
    } catch(e) {}
    return {};
  }
  return newData.localities;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🏠 CBS Housing Dashboard — Data Fetch\n');
  console.log(`   Time: ${new Date().toISOString()}\n`);

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const existingPath = path.join(DATA_DIR, 'housing.json');

  // 1. Fetch all district indices
  console.log('📈 Fetching district indices from CBS API...');
  const indices = {};
  for (const [key, id] of Object.entries(DISTRICT_INDICES)) {
    indices[key] = await fetchDistrictIndex(key, id);
    await sleep(500);
  }

  // 2. Fetch quarterly locality prices
  const localityResult = await fetchLocalityPrices();
  const localities = mergeLocalityData(localityResult, existingPath);

  // 3. Save output
  const output = {
    generated:    new Date().toISOString(),
    source:       'הלשכה המרכזית לסטטיסטיקה (CBS)',
    indexSource:  'api.cbs.gov.il — bi-monthly district index',
    priceSource:  localityResult?.sourceUrl || 'cached',
    latestQuarter: localityResult?.quarter || 'cached',
    methodology:  'Index: bi-monthly hedonic. Prices: quarterly average by rooms. Last 3 index values provisional.',
    indices,
    localities,
  };

  fs.writeFileSync(existingPath, JSON.stringify(output, null, 2));
  console.log(`\n✅ Saved to data/housing.json (${(fs.statSync(existingPath).size/1024).toFixed(1)} KB)`);

  // Compact version
  const compact = {
    generated: output.generated,
    latestQuarter: output.latestQuarter,
    indices: Object.fromEntries(Object.entries(indices).map(([k,v]) => [k, { meta:v.meta, entries:v.entries, latestPeriod:v.latestPeriod }])),
    localities: output.localities,
  };
  fs.writeFileSync(path.join(DATA_DIR, 'housing.min.json'), JSON.stringify(compact));
  console.log('   Compact version saved.');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
