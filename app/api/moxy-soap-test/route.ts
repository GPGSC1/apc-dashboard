import { NextResponse } from 'next/server';
import https from 'https';
import zlib from 'zlib';
import { promisify } from 'util';

const inflateRaw = promisify(zlib.inflateRaw);
const inflate    = promisify(zlib.inflate);
const unzip      = promisify(zlib.unzip);

const AUTO_KEY    = '5ae589ba-27e4-41bc-9824-a9110cdfc35f';
const AUTO_ACTION = 'JEBMPFp0eVVJWB9uCnhtAxkXTnRWdHIDBRQUaF58I1NOFh5sCQEAAAD/////AQAAAAQmQjULAgAAABREAmhAfnAFHFUca1V8cA0YRQ0YIhZEH3ZcfW8FGEcUeV59egcYTx1pTxwNEDU0QTIwN0RCMEM0Nzg4QzgDRxhtFEQCa1djcgcaQw1qVXh1DRlCDQkiBBJJNV0=';

async function decompress(buf: Buffer): Promise<Buffer> {
  for (const fn of [unzip, inflate, inflateRaw]) {
    try { return await (fn as any)(buf); } catch {}
  }
  throw new Error('Could not decompress');
}

function soapRequest(): Promise<string> {
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
    '<soap:Body><getDsB2 xmlns="http://tempuri.org/">' +
    '<aKey>' + AUTO_KEY + '</aKey>' +
    '<action>' + AUTO_ACTION + '</action>' +
    '<dlrId>-99</dlrId>' +
    '</getDsB2></soap:Body></soap:Envelope>';

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'ep149b.moxyws.com',
      port: 443,
      path: '/wsmenu52/service.asmx',
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'SOAPAction': 'http://tempuri.org/getDsB2',
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export async function GET() {
  try {
    const raw = await soapRequest();
    const resultMatch = raw.match(/<getDsB2Result>([\s\S]*?)<\/getDsB2Result>/);
    if (!resultMatch) {
      return NextResponse.json({ ok: false, error: 'No SOAP result', snippet: raw.substring(0, 500) });
    }

    const b64 = resultMatch[1].trim();
    if (b64.length < 100) {
      return NextResponse.json({ ok: true, message: 'Empty result' });
    }

    const buf = await decompress(Buffer.from(b64, 'base64'));
    const xml = buf.toString('utf8');
    const xmlLen = xml.length;

    // LIGHTWEIGHT: fast string counts instead of full XML parse
    const totalRecords = (xml.match(/<DealLog>/gi) || []).length;
    const soldCount    = (xml.match(/<dealstatus>Sold<\/dealstatus>/gi) || []).length;

    // Today in Central Time
    const now = new Date();
    const ct  = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    const mm  = String(ct.getMonth() + 1).padStart(2, '0');
    const dd  = String(ct.getDate()).padStart(2, '0');
    const yyyy = ct.getFullYear();
    const todayPadded = mm + '/' + dd + '/' + yyyy;
    const todayShort  = (ct.getMonth() + 1) + '/' + ct.getDate() + '/' + yyyy;

    // Yesterday
    const yd = new Date(ct); yd.setDate(yd.getDate() - 1);
    const ymm = String(yd.getMonth() + 1).padStart(2, '0');
    const ydd = String(yd.getDate()).padStart(2, '0');
    const yesterdayPadded = ymm + '/' + ydd + '/' + yyyy;
    const yesterdayShort  = (yd.getMonth() + 1) + '/' + yd.getDate() + '/' + yyyy;

    // Count solddate for today & yesterday
    const re1 = new RegExp('<solddate>' + todayPadded + '</solddate>', 'gi');
    const re2 = new RegExp('<solddate>' + todayShort + '</solddate>', 'gi');
    const re3 = new RegExp('<solddate>' + yesterdayPadded + '</solddate>', 'gi');
    const re4 = new RegExp('<solddate>' + yesterdayShort + '</solddate>', 'gi');
    const soldToday     = (xml.match(re1) || []).length + (xml.match(re2) || []).length;
    const soldYesterday = (xml.match(re3) || []).length + (xml.match(re4) || []).length;

    // Count lastSaved for today
    const re5 = new RegExp('<lastSaved>' + todayPadded + '</lastSaved>', 'gi');
    const re6 = new RegExp('<lastSaved>' + todayShort + '</lastSaved>', 'gi');
    const savedToday = (xml.match(re5) || []).length + (xml.match(re6) || []).length;

    // Collect all unique solddate values with counts
    const dateCounts: Record<string, number> = {};
    const sdRe = /<solddate>(\d{1,2}\/\d{1,2}\/\d{4})<\/solddate>/gi;
    let m;
    while ((m = sdRe.exec(xml)) !== null) {
      dateCounts[m[1]] = (dateCounts[m[1]] || 0) + 1;
    }
    const sorted = Object.entries(dateCounts)
      .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
      .slice(-15);

    // Extract a few of today's sold records for review
    const todaySample: any[] = [];
    if (soldToday > 0) {
      const blockRe = new RegExp('<DealLog>([\\s\\S]*?(?:' + todayPadded + '|' + todayShort + ')[\\s\\S]*?)</DealLog>', 'gi');
      let bm;
      let count = 0;
      while ((bm = blockRe.exec(xml)) !== null && count < 5) {
        const bl = bm[1];
        const gt = (t: string) => { const r = bl.match(new RegExp('<' + t + '>([^<]*)</' + t + '>', 'i')); return r ? r[1] : ''; };
        if (gt('dealstatus').toLowerCase() === 'sold') {
          todaySample.push({
            name: gt('firstName') + ' ' + gt('lastname'),
            soldDate: gt('solddate'),
            homePhone: gt('HomePhone'),
            promoCode: gt('promoCode'),
            owner: gt('owner'),
          });
          count++;
        }
      }
    }

    return NextResponse.json({
      ok: true,
      xmlSize: xmlLen,
      totalRecords,
      soldCount,
      todayDate: todayPadded,
      soldToday,
      soldYesterday,
      savedToday,
      recentSoldDates: sorted,
      todaySample,
    });

  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message });
  }
}
