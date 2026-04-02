const fs = require('fs');

const INPUT = 'C:/Users/Maf19/Downloads/StatusReport_52_Scrubbed.csv';
const OUTPUT = 'C:/Users/Maf19/Downloads/StatusReport_52_Clean.csv';

// Read UTF-16LE
const buf = fs.readFileSync(INPUT);
const text = buf.toString('utf16le');
const lines = text.split(/\r?\n/);

const header = lines[0];
const headerCols = header.split('\t');

// Find column indices by name (strip BOM)
const clean = (s) => s.replace(/^\uFEFF/, '').trim();
const colIndex = {};
headerCols.forEach((c, i) => { colIndex[clean(c)] = i; });

const HOME_IDX = colIndex['Home__'];
const WORK_IDX = colIndex['Work__'];
const CELL_IDX = colIndex['Cell__'];
const CREATED_IDX = colIndex['created'];

console.log(`Column indices - Home__: ${HOME_IDX}, Work__: ${WORK_IDX}, Cell__: ${CELL_IDX}, created: ${CREATED_IDX}`);

// Normalize phone: strip non-digits, if 11 starting with 1 strip leading 1, must be exactly 10
function normalizePhone(raw) {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    digits = digits.slice(1);
  }
  return digits.length === 10 ? digits : null;
}

// Parse M/D/YYYY date
function parseDate(s) {
  if (!s) return new Date(0);
  const parts = s.trim().split('/');
  if (parts.length !== 3) return new Date(0);
  const [m, d, y] = parts.map(Number);
  return new Date(y, m - 1, d);
}

// Process rows
const dataLines = lines.slice(1).filter(l => l.trim() !== '');
const totalRows = dataLines.length;
console.log(`Rows in scrubbed file: ${totalRows}`);

// Step 1 & 2: Filter rows with at least one valid phone
const rowsWithPhones = []; // { line, phones: string[], created: Date }
let removedNoPhone = 0;

for (const line of dataLines) {
  const cols = line.split('\t');
  const phones = [
    normalizePhone(cols[HOME_IDX]),
    normalizePhone(cols[WORK_IDX]),
    normalizePhone(cols[CELL_IDX]),
  ].filter(Boolean);

  if (phones.length === 0) {
    removedNoPhone++;
    continue;
  }

  rowsWithPhones.push({
    line,
    phones,
    created: parseDate(cols[CREATED_IDX]),
  });
}

console.log(`Rows removed for no valid phones: ${removedNoPhone}`);
console.log(`Rows with at least one valid phone: ${rowsWithPhones.length}`);

// Step 3: Dedupe by phone number, keeping newest
// For each unique phone, track the row index with the newest created date
const phoneToNewest = new Map(); // phone -> index in rowsWithPhones

for (let i = 0; i < rowsWithPhones.length; i++) {
  const row = rowsWithPhones[i];
  for (const phone of row.phones) {
    const existing = phoneToNewest.get(phone);
    if (existing === undefined || row.created > rowsWithPhones[existing].created) {
      phoneToNewest.set(phone, i);
    }
  }
}

// A row survives if it is the newest for at least one of its phones
const survivingIndices = new Set(phoneToNewest.values());
const finalRows = [];
let removedDupes = 0;

for (let i = 0; i < rowsWithPhones.length; i++) {
  if (survivingIndices.has(i)) {
    finalRows.push(rowsWithPhones[i].line);
  } else {
    removedDupes++;
  }
}

console.log(`Rows removed as duplicates (older created date): ${removedDupes}`);
console.log(`Final row count: ${finalRows.length}`);

// Step 4: Write output - UTF-16LE with BOM, tab-delimited
const output = '\uFEFF' + header + '\r\n' + finalRows.join('\r\n') + '\r\n';
const outBuf = Buffer.from(output, 'utf16le');
fs.writeFileSync(OUTPUT, outBuf);

console.log(`\nSaved to: ${OUTPUT}`);
