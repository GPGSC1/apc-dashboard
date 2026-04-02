const fs = require('fs');

// ── helpers ──────────────────────────────────────────────────────────────────
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  if (digits.length === 10) return digits;
  return null; // not a valid 10-digit phone
}

// ── Step 1: Fetch ALL Moxy sales phones ─────────────────────────────────────
// Generate date chunks of up to 179 days each
function dateChunks(startStr, endStr) {
  const chunks = [];
  let cur = new Date(startStr);
  const end = new Date(endStr);
  while (cur < end) {
    const chunkEnd = new Date(cur);
    chunkEnd.setDate(chunkEnd.getDate() + 179);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    chunks.push({
      from: cur.toISOString().slice(0, 10),
      to: chunkEnd.toISOString().slice(0, 10),
    });
    cur = new Date(chunkEnd);
    cur.setDate(cur.getDate() + 1);
  }
  return chunks;
}

async function fetchMoxyPhones() {
  const salesPhones = new Set();

  const apis = [
    { name: 'Moxy Auto', token: 'a242ccb0-738e-4e4f-a418-facf89297904' },
    { name: 'Moxy Home', token: '3f7c2b0a-9e4d-4f6e-b1a8-8c9a6e2d7b54' },
  ];

  const chunks = dateChunks('2020-01-01', '2026-04-01');
  console.log(`Will fetch ${chunks.length} date chunks per API`);

  for (const api of apis) {
    let totalDeals = 0;
    console.log(`Fetching ${api.name}...`);
    for (const chunk of chunks) {
      const url = `https://MoxyAPI.moxyws.com/api/GetDealLog?fromDate=${chunk.from}&toDate=${chunk.to}&dealType=Both`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${api.token}` },
      });
      if (!res.ok) {
        console.error(`  ${api.name} chunk ${chunk.from}-${chunk.to} failed: ${res.status}`);
        const body = await res.text();
        console.error(`  Body: ${body.substring(0, 200)}`);
        continue;
      }
      const deals = await res.json();
      totalDeals += deals.length;

      for (const deal of deals) {
        for (const key of Object.keys(deal)) {
          if (/phone/i.test(key) || /mobile/i.test(key)) {
            const p = normalizePhone(String(deal[key]));
            if (p) salesPhones.add(p);
          }
        }
      }
    }
    console.log(`  ${api.name}: ${totalDeals} total deals`);
  }

  console.log(`Total unique Moxy sales phones: ${salesPhones.size}`);
  return salesPhones;
}

// ── Step 2: Load NevAns phones ──────────────────────────────────────────────
function loadNevAns() {
  const text = fs.readFileSync(
    'C:/Users/Maf19/OneDrive/Desktop/DashBuild/apc-dashboard/nevans-phones.csv',
    'utf-8'
  );
  const lines = text.trim().split(/\r?\n/);
  const phones = new Set();
  for (let i = 1; i < lines.length; i++) {
    // single column: phone
    const p = lines[i].trim();
    if (p && /^\d{10}$/.test(p)) phones.add(p);
  }
  console.log(`NevAns phones loaded: ${phones.size}`);
  return phones;
}

// ── Step 3: Scrub the responder file ────────────────────────────────────────
async function main() {
  const salesPhones = await fetchMoxyPhones();
  const nevAnsPhones = loadNevAns();

  // Read UTF-16LE CSV
  let text = fs.readFileSync('C:/Users/Maf19/Downloads/StatusReport 52 New.csv', 'utf16le');
  // Strip BOM if present
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const lines = text.split(/\r?\n/);
  const header = lines[0];
  const cols = header.split('\t');

  // Find phone column indices
  const homeIdx = cols.findIndex(c => c.trim() === 'Home__');
  const workIdx = cols.findIndex(c => c.trim() === 'Work__');
  const cellIdx = cols.findIndex(c => c.trim() === 'Cell__');
  console.log(`Column indices -- Home__: ${homeIdx}, Work__: ${workIdx}, Cell__: ${cellIdx}`);

  let removedSales = 0;
  let removedNevAns = 0;
  const kept = [header];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue; // skip empty lines

    const fields = line.split('\t');
    const phones = [];
    for (const idx of [homeIdx, workIdx, cellIdx]) {
      if (idx >= 0 && idx < fields.length) {
        const p = normalizePhone(fields[idx]);
        if (p) phones.push(p);
      }
    }

    // Check against scrub lists
    let matchedSales = false;
    let matchedNevAns = false;
    for (const p of phones) {
      if (salesPhones.has(p)) { matchedSales = true; break; }
      if (nevAnsPhones.has(p)) { matchedNevAns = true; break; }
    }

    if (matchedSales) {
      removedSales++;
    } else if (matchedNevAns) {
      removedNevAns++;
    } else {
      kept.push(line);
    }
  }

  // Count original data rows (excluding header and empty lines)
  let totalDataRows = 0;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim()) totalDataRows++;
  }

  // Write output -- same UTF-16LE encoding with BOM, \r\n line endings
  const output = '\ufeff' + kept.join('\r\n');
  fs.writeFileSync('C:/Users/Maf19/Downloads/StatusReport_52_Scrubbed.csv', output, 'utf16le');

  // ── Step 4: Summary ─────────────────────────────────────────────────────
  console.log('\n========== SCRUB SUMMARY ==========');
  console.log(`Total rows in original:       ${totalDataRows}`);
  console.log(`Rows removed (sales match):   ${removedSales}`);
  console.log(`Rows removed (NevAns match):  ${removedNevAns}`);
  console.log(`Rows remaining:               ${kept.length - 1}`);  // minus header
  console.log(`Unique Moxy sales phones:     ${salesPhones.size}`);
  console.log(`NevAns phones used:           ${nevAnsPhones.size}`);
  console.log(`Output: C:/Users/Maf19/Downloads/StatusReport_52_Scrubbed.csv`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
