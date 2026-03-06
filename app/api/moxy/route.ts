import { NextResponse } from 'next/server';
import https from 'https';
import zlib from 'zlib';
import { promisify } from 'util';

const inflateRaw = promisify(zlib.inflateRaw);
const inflate    = promisify(zlib.inflate);
const unzip      = promisify(zlib.unzip);

// ─── Types ───────────────────────────────────────────────────────────────────
export interface MoxySale {
  contractNo:   string;
  phone:        string;   // best available 10-digit normalised
  cellPhone:    string;
  homePhone:    string;
  firstName:    string;
  lastName:     string;
  salesRep:     string;
  soldDate:     string;   // raw string from Moxy (MM/DD/YYYY or serial)
  status:       string;   // e.g. "Sold", "Cancelled"
  promoCode:    string;
  cancelReason: string;
  make:         string;
  model:        string;
  state:        string;
  admin:        string;
}

// ─── Moxy Auto Deal Log credentials ──────────────────────────────────────────
const AUTO_KEY    = '5ae589ba-27e4-41bc-9824-a9110cdfc35f';
const AUTO_ACTION = 'JEBMPFp0eVVJWB9uCnhtAxkXTnRWdHIDBRQUaF58I1NOFh5sCQEAAAD/////AQAAAAQmQjULAgAAABREAmhAfnAFHFUca1V8cA0YRQ0YIhZEH3ZcfW8FGEcUeV59egcYTx1pTxwNEDU0QTIwN0RCMEM0Nzg4QzgDRxhtFEQCa1djcgcaQw1qVXh1DRlCDQkiBBJJNV0=';

// ─── Helpers ─────────────────────────────────────────────────────────────────
function normalizePhone(raw: string): string {
  if (!raw) return '';
  const d = raw.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return d.length === 10 ? d : '';
}

function extractAll(xml: string, field: string): string[] {
  const re = new RegExp(`<${field}[^>]*>([^<]*)<\\/${field}>`, 'gi');
  const vals: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) vals.push(m[1] ?? '');
  return vals;
}

function extractField(xml: string, ...names: string[]): string[] {
  for (const name of names) {
    const vals = extractAll(xml, name);
    if (vals.length > 0) return vals;
  }
  return [];
}

async function decompress(buf: Buffer): Promise<string> {
  for (const fn of [unzip, inflate, inflateRaw]) {
    try { return (await fn(buf)).toString('utf8'); } catch { /* try next */ }
  }
  throw new Error('Could not decompress Moxy response');
}

function soapRequest(aKey: string, action: string): Promise<string> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <soap:Body>
    <getDsB2 xmlns="http://tempuri.org/">
      <aKey>${aKey}</aKey>
      <action>${action}</action>
      <dlrId>-99</dlrId>
    </getDsB2>
  </soap:Body>
</soap:Envelope>`;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'ep149b.moxyws.com',
        port: 443,
        path: '/wsmenu52/service.asmx',
        method: 'POST',
        headers: {
          'Content-Type':   'text/xml; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'SOAPAction':     'http://tempuri.org/getDsB2',
        },
      },
      (res) => {
        let d = '';
        res.on('data', c => (d += c));
        res.on('end', () => resolve(d));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Route handler ────────────────────────────────────────────────────────────
export async function GET() {
  try {
    const raw = await soapRequest(AUTO_KEY, AUTO_ACTION);

    const resultMatch = raw.match(/<getDsB2Result>([\s\S]*?)<\/getDsB2Result>/);
    if (!resultMatch) {
      return NextResponse.json({ ok: false, error: 'No result in Moxy SOAP response', sales: [] }, { status: 500 });
    }

    const b64 = resultMatch[1].trim();
    if (b64.length < 100) {
      return NextResponse.json({ ok: true, count: 0, sales: [] });
    }

    const xml = await decompress(Buffer.from(b64, 'base64'));

    const contractNos   = extractField(xml, 'ContractNo',   'contractNo',    'Contract_x0020_No');
    const homePhones    = extractField(xml, 'HomePhone',    'homephone');
    const cellPhones    = extractField(xml, 'CellPhone',    'cellphone',     'Cell_x0020_Phone');
    const phones        = extractField(xml, 'Phone',        'phone');
    const firstNames    = extractField(xml, 'First',        'FirstName');
    const lastNames     = extractField(xml, 'Last',         'LastName');
    const salesReps     = extractField(xml, 'SalesRep',     'Sales_x0020_Rep');
    const soldDates     = extractField(xml, 'DateSold',     'Date_x0020_Sold', 'solddate');
    const statuses      = extractField(xml, 'Status',       'DealStatus',    'Deal_x0020_Status', 'Stat', 'ContractStatus');
    const promoCodes    = extractField(xml, 'PromoCode',    'Promo_x0020_Code');
    const cancelReasons = extractField(xml, 'CancelReason', 'Cancel_x0020_Reason', 'CancellationReason');
    const makes         = extractField(xml, 'Make');
    const models        = extractField(xml, 'Model');
    const states        = extractField(xml, 'State');
    const admins        = extractField(xml, 'Admin');

    const count = Math.max(contractNos.length, soldDates.length, phones.length);
    const sales: MoxySale[] = [];

    for (let i = 0; i < count; i++) {
      const hp = normalizePhone(homePhones[i] ?? '');
      const cp = normalizePhone(cellPhones[i] ?? '');
      const pp = normalizePhone(phones[i] ?? '');
      // Prefer home phone (consistent with existing sales.xls attribution logic)
      const bestPhone = hp || cp || pp;

      sales.push({
        contractNo:   contractNos[i]   ?? '',
        phone:        bestPhone,
        cellPhone:    cp,
        homePhone:    hp,
        firstName:    firstNames[i]    ?? '',
        lastName:     lastNames[i]     ?? '',
        salesRep:     salesReps[i]     ?? '',
        soldDate:     soldDates[i]     ?? '',
        status:       statuses[i]      ?? '',
        promoCode:    promoCodes[i]    ?? '',
        cancelReason: cancelReasons[i] ?? '',
        make:         makes[i]         ?? '',
        model:        models[i]        ?? '',
        state:        states[i]        ?? '',
        admin:        admins[i]        ?? '',
      });
    }

    return NextResponse.json({
      ok:          true,
      count:       sales.length,
      sales,
      lastUpdated: new Date().toISOString(),
    });

  } catch (err: any) {
    console.error('[moxy/route.ts]', err);
    return NextResponse.json({ ok: false, error: err.message, sales: [] }, { status: 500 });
  }
}
