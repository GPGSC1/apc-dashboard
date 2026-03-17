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
    try { return await (fn as any)(buf); } catch { }
  }
  throw new Error('Could not decompress');
}

function soapRequest(): Promise<string> {
  const body = '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><getDsB2 xmlns="http://tempuri.org/"><aKey>' + AUTO_KEY + '</aKey><action>' + AUTO_ACTION + '</action><dlrId>-99</dlrId></getDsB2></soap:Body></soap:Envelope>';
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'ep149b.moxyws.com', port: 443, path: '/wsmenu52/service.asmx', method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'SOAPAction': 'http://tempuri.org/getDsB2' }
    }, (res) => { let d = ''; res.on('data', c => (d += c)); res.on('end', () => resolve(d)); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export async function GET() {
  try {
    const raw = await soapRequest();
    const resultMatch = raw.match(/<getDsB2Result>([\s\S]*?)<\/getDsB2Result>/);
    if (!resultMatch) return NextResponse.json({ ok: false, error: 'No SOAP result', snippet: raw.substring(0, 500) });
    const b64 = resultMatch[1].trim();
    if (b64.length < 100) return NextResponse.json({ ok: true, message: 'Empty result' });
    const buf = await decompress(Buffer.from(b64, 'base64'));
    const utf8 = buf.toString('utf8');
    const latin1 = buf.toString('latin1');
    const xmlMatch = utf8.match(/<(?:xs:|xsd:)?schema|<NewDataSet|<diffgr:|<[A-Z][a-zA-Z]+>/);
    const xmlMatchL = latin1.match(/<(?:xs:|xsd:)?schema|<NewDataSet|<diffgr:|<[A-Z][a-zA-Z]+>/);
    const xmlContent = xmlMatch ? utf8 : (xmlMatchL ? latin1 : '');
    const xmlStart = xmlContent.indexOf('<');
    const xmlSnippet = xmlStart >= 0 ? xmlContent.substring(xmlStart, xmlStart + 3000) : 'no xml found';
    const tagPattern = /<([A-Za-z][A-Za-z0-9_]*)[\s>]/g;
    const tags = new Set<string>();
    let m;
    const searchIn = xmlContent.substring(0, 50000);
    while ((m = tagPattern.exec(searchIn)) !== null) tags.add(m[1]);
    return NextResponse.json({
      ok: true,
      b64Length: b64.length,
      bufLength: buf.length,
      hasXmlUtf8: !!xmlMatch,
      hasXmlLatin1: !!xmlMatchL,
      uniqueTags: Array.from(tags).slice(0, 80),
      xmlSnippet,
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message });
  }
}
