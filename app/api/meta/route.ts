import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

// ── Types ──────────────────────────────────────────────────────────────────
interface MetaCall {
  date: string;            // YYYY-MM-DD
  time: string;            // HH:MM
  status: "transferred" | "answered" | "unanswered";
}

interface MetaLead {
  phone: string;           // 10-digit
  calls: MetaCall[];       // up to 6 most recent, newest first
  mail6TalkTimeSec: number; // 3CX Mail 6 talk time (for transferred calls)
  isSold: boolean;         // phone in Moxy Sold + 3CX Mail 6 + AIM dash campaign
}

interface AimCall {
  phone: string;
  date: string;
  time: string;
  durationSec: number;
  outcomes: string[];
  endedReason: string;
  cost: number;
  transferred: boolean;
  agent: string;
}

interface CxCall {
  phone: string;
  date: string;
  time: string;
  talkTimeSec: number;
  status: string;
  destName: string;
}

interface MoxySale {
  phone: string;
  status: string;
}

// ── Config ─────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(process.cwd(), 'data');

function normalizePhone(raw: string): string {
  const d = (raw || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return d.length === 10 ? d : '';
}

function loadSeedFile<T>(filename: string): T | null {
  try {
    const filepath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filepath)) return null;
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch {
    return null;
  }
}

function filterByDateRange(
  calls: Array<{ date: string; [key: string]: any }>,
  startDate: string | null,
  endDate: string | null
): Array<{ date: string; [key: string]: any }> {
  return calls.filter(call => {
    if (startDate && call.date < startDate) return false;
    if (endDate && call.date > endDate) return false;
    return true;
  });
}

// ── Main route ─────────────────────────────────────────────────────────────
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const startParam = searchParams.get('start');
    const endParam = searchParams.get('end');

    // Load seed files
    const aimSeedFile = loadSeedFile<{ calls: AimCall[] }>('meta_aim_seed.json');
    const cxSeedFile = loadSeedFile<{ calls: CxCall[] }>('meta_3cx_seed.json');

    if (!aimSeedFile?.calls || !cxSeedFile?.calls) {
      return NextResponse.json({
        ok: false,
        error: 'Meta seed files not found',
        leads: [],
        summary: { totalLeads: 0, transferred: 0, answered: 0, unanswered: 0, sold: 0 },
        lastUpdated: new Date().toISOString(),
      }, { status: 500 });
    }

    // Filter by date range
    const aimCalls = filterByDateRange(aimSeedFile.calls, startParam, endParam);
    const cxCalls = filterByDateRange(cxSeedFile.calls, startParam, endParam);

    // Build 3CX lookup: phone -> max talk time
    const cx3LookupMap = new Map<string, number>();
    for (const call of cxCalls) {
      const existing = cx3LookupMap.get(call.phone) || 0;
      cx3LookupMap.set(call.phone, Math.max(existing, call.talkTimeSec));
    }

    // Get Moxy sold phones
    let soldPhones = new Set<string>();
    try {
      const moxyRes = await fetch('http://localhost:3000/api/moxy', {
        cache: 'no-store',
      });
      if (moxyRes.ok) {
        const moxyData = await moxyRes.json();
        if (moxyData.sales && Array.isArray(moxyData.sales)) {
          soldPhones = new Set(
            moxyData.sales
              .filter((s: MoxySale) => s.status === 'Sold' && s.phone)
              .map((s: MoxySale) => normalizePhone(s.phone))
          );
        }
      }
    } catch (e) {
      console.error('[meta/route] Moxy API error:', e);
    }

    // Group AIM calls by phone
    const phoneMap = new Map<string, MetaCall[]>();
    const statusMap = new Map<string, string>();

    for (const call of aimCalls) {
      const phone = normalizePhone(call.phone);
      if (!phone) continue;

      // Determine call status
      let status: "transferred" | "answered" | "unanswered" = "unanswered";
      if (call.transferred) {
        status = "transferred";
      } else if (
        call.endedReason &&
        !call.endedReason.toLowerCase().includes('voicemail') &&
        !call.endedReason.toLowerCase().includes('no-answer') &&
        !call.endedReason.toLowerCase().includes('busy') &&
        !call.endedReason.toLowerCase().includes('error')
      ) {
        status = "answered";
      }

      const metaCall: MetaCall = {
        date: call.date,
        time: call.time,
        status,
      };

      if (!phoneMap.has(phone)) {
        phoneMap.set(phone, []);
      }
      phoneMap.get(phone)!.push(metaCall);
    }

    // Build leads
    const leads: MetaLead[] = [];
    for (const [phone, calls] of phoneMap.entries()) {
      // Sort by date/time descending (newest first)
      calls.sort((a, b) => {
        const aTs = `${a.date}T${a.time}`;
        const bTs = `${b.date}T${b.time}`;
        return bTs.localeCompare(aTs);
      });

      // Keep max 6 most recent
      const recentCalls = calls.slice(0, 6);

      // Get mail6 talk time
      const mail6TalkTime = cx3LookupMap.get(phone) || 0;

      // Check if sold: must be in Moxy AND have 3CX Mail 6 call AND have AIM Meta call
      const isSold = soldPhones.has(phone) && mail6TalkTime > 0;

      leads.push({
        phone,
        calls: recentCalls,
        mail6TalkTimeSec: mail6TalkTime,
        isSold,
      });
    }

    // Sort leads by most recent call date
    leads.sort((a, b) => {
      const aDate = a.calls[0]?.date || '';
      const aTime = a.calls[0]?.time || '';
      const bDate = b.calls[0]?.date || '';
      const bTime = b.calls[0]?.time || '';
      const aTs = `${aDate}T${aTime}`;
      const bTs = `${bDate}T${bTime}`;
      return bTs.localeCompare(aTs);
    });

    // Calculate summary
    const summary = {
      totalLeads: leads.length,
      transferred: leads.reduce((sum, lead) => sum + lead.calls.filter(c => c.status === 'transferred').length, 0),
      answered: leads.reduce((sum, lead) => sum + lead.calls.filter(c => c.status === 'answered').length, 0),
      unanswered: leads.reduce((sum, lead) => sum + lead.calls.filter(c => c.status === 'unanswered').length, 0),
      sold: leads.filter(l => l.isSold).length,
    };

    return NextResponse.json({
      ok: true,
      leads,
      summary,
      lastUpdated: new Date().toISOString(),
    });

  } catch (err) {
    console.error('[meta/route]', err);
    return NextResponse.json({
      ok: false,
      error: String(err),
      leads: [],
      summary: { totalLeads: 0, transferred: 0, answered: 0, unanswered: 0, sold: 0 },
      lastUpdated: new Date().toISOString(),
    }, { status: 500 });
  }
}
