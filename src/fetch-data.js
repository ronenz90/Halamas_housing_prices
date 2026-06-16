/**
 * fetch-data.js
 * Fetches housing price index data from CBS (הלמ"ס) API
 * and saves it to data/housing.json
 * 
 * CBS API docs: https://www.cbs.gov.il/he/Pages/ממשק-API.aspx
 * 
 * Index codes:
 *   40010 = National housing price index
 *   60000 = Jerusalem district
 *   60100 = North district
 *   60200 = Haifa district
 *   60300 = Center district
 *   60400 = Tel Aviv district
 *   60500 = South district
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const CBS_BASE = 'https://api.cbs.gov.il/index/data/price';
const USER_AGENT = 'IsraelHousingDashboard/1.0 (github-pages-project)';

const INDICES = {
  national:   { id: 40010,  name: 'ארצי',      nameEn: 'National' },
  jerusalem:  { id: 60000,  name: 'ירושלים',   nameEn: 'Jerusalem' },
  north:      { id: 60100,  name: 'צפון',       nameEn: 'North' },
  haifa:      { id: 60200,  name: 'חיפה',       nameEn: 'Haifa' },
  center:     { id: 60300,  name: 'מרכז',       nameEn: 'Center' },
  tel_aviv:   { id: 60400,  name: 'תל אביב',   nameEn: 'Tel Aviv' },
  south:      { id: 60500,  name: 'דרום',       nameEn: 'South' },
};

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
      }
    };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          console.error('Parse error for URL:', url);
          console.error('Response:', data.substring(0, 500));
          reject(new Error('JSON parse error: ' + e.message));
        }
      });
    }).on('error', reject);
  });
}

function buildUrl(indexId, startYear = 2000) {
  const startPeriod = `01-${startYear}`;
  return `${CBS_BASE}?id=${indexId}&format=json&download=false&startPeriod=${startPeriod}&pagesize=1000`;
}

function parseEntry(entry) {
  // CBS API returns: { period, value, base_period, ... }
  return {
    period: entry.period || entry.Period,
    value: parseFloat(entry.value || entry.Value),
    change: entry.change !== undefined ? parseFloat(entry.change) : null,
    provisional: entry.provisional === true || entry.provisional === 'true',
  };
}

function computeYearlyChange(entries) {
  // CBS publishes bi-monthly. 12 months back = 6 entries back
  return entries.map((e, i) => {
    if (i < 6) return { ...e, yearlyChange: null };
    const prev = entries[i - 6];
    const yc = ((e.value - prev.value) / prev.value) * 100;
    return { ...e, yearlyChange: +yc.toFixed(3) };
  });
}

async function fetchIndex(key, meta) {
  const url = buildUrl(meta.id);
  console.log(`Fetching ${meta.nameEn} (${meta.id})...`);
  
  try {
    const json = await fetchJSON(url);
    
    // CBS response structure: { Data: [...] } or array directly
    let rawEntries = Array.isArray(json) ? json 
                   : (json.Data || json.data || json.items || json.results || []);
    
    if (!rawEntries.length) {
      console.warn(`  ⚠️  No entries found for ${meta.nameEn}`);
      return { key, meta, entries: [], lastUpdated: new Date().toISOString() };
    }

    const entries = rawEntries.map(parseEntry).filter(e => !isNaN(e.value));
    const withYearly = computeYearlyChange(entries);
    
    console.log(`  ✓ ${entries.length} entries, latest: ${entries[entries.length-1]?.period}`);
    
    return {
      key,
      meta,
      entries: withYearly,
      lastUpdated: new Date().toISOString(),
      count: entries.length,
      latestPeriod: entries[entries.length-1]?.period,
    };
  } catch (err) {
    console.error(`  ✗ Error fetching ${meta.nameEn}:`, err.message);
    return { key, meta, entries: [], error: err.message, lastUpdated: new Date().toISOString() };
  }
}

async function main() {
  console.log('🏠 Fetching CBS Housing Price Index Data...\n');
  
  // Ensure data directory exists
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const results = {};
  
  // Fetch all indices sequentially to be polite to the API
  for (const [key, meta] of Object.entries(INDICES)) {
    results[key] = await fetchIndex(key, meta);
    await new Promise(r => setTimeout(r, 500)); // 500ms delay between requests
  }

  const output = {
    generated: new Date().toISOString(),
    source: 'הלשכה המרכזית לסטטיסטיקה (CBS) — api.cbs.gov.il',
    methodology: 'Bi-monthly index. Last 3 values are provisional (marked with *).',
    indices: results,
  };

  const outPath = path.join(dataDir, 'housing.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
  
  console.log(`\n✅ Data saved to ${outPath}`);
  console.log(`   Total size: ${(fs.statSync(outPath).size / 1024).toFixed(1)} KB`);
  
  // Also write a compact version for faster loading
  const compact = {
    generated: output.generated,
    indices: {}
  };
  for (const [k, v] of Object.entries(results)) {
    compact.indices[k] = {
      meta: v.meta,
      entries: v.entries,
      latestPeriod: v.latestPeriod,
    };
  }
  fs.writeFileSync(
    path.join(dataDir, 'housing.min.json'),
    JSON.stringify(compact),
    'utf8'
  );
  console.log('   Compact version also saved.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
