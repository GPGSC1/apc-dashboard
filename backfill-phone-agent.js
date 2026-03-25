// Backfill aim_phone_agent from ALL AIM calls (no campaign filter)
// This catches inbound callbacks and non-tracked campaign calls
const { Client } = require("pg");

const AIM_TOKEN = "cTSKKqhtYJUuJnscOcHKRpDuYBDjOhGpYyjRuDXpJfFWwCORFLhrliBdHNzwSFmY";
const PG_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL;

function customerPhone(call) {
  const dir = (call.direction ?? "").toLowerCase();
  const raw = dir === "inbound" ? (call.from ?? "") : (call.to ?? "");
  return raw.replace(/\D/g, "").slice(-10);
}

function shortAgent(name) {
  const map = {
    "Transfer Activation Outbound Agent with Moxy": "Activation",
    "Purchased Data Transfer Agent with Moxy": "Purchased Data",
    "Transfer Outbound Agent with Moxy": "Moxy OG",
    "Transfer Outbound Agent with Moxy version 2": "Moxy v2",
    "Meta Transfer Agent": "Meta Transfer Agent",
    "Cathy": "Cathy",
    "Overflow Agent with Spanish Transfer": "Overflow ES",
  };
  return map[name] || name;
}

async function fetchPage(params) {
  const url = new URL("https://dash.aimnow.ai/api/calls");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${AIM_TOKEN}` } });
  if (!res.ok) return [];
  const body = await res.json();
  return body.items ?? body.data ?? body ?? [];
}

async function main() {
  if (!PG_URL) { console.error("Set POSTGRES_URL"); process.exit(1); }
  const client = new Client({ connectionString: PG_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // Process week by week from campaign start
  const startDate = new Date("2026-02-25");
  const endDate = new Date(); // today
  const phoneAgentMap = new Map(); // phone → { agent, date }
  let totalCalls = 0;

  const current = new Date(startDate);
  while (current <= endDate) {
    const weekEnd = new Date(current);
    weekEnd.setDate(weekEnd.getDate() + 6);
    if (weekEnd > endDate) weekEnd.setTime(endDate.getTime());

    const from = current.toISOString();
    const to = new Date(weekEnd.getTime() + 86400000 - 1).toISOString();
    
    console.log(`Fetching ${current.toISOString().slice(0,10)} to ${weekEnd.toISOString().slice(0,10)}...`);

    // Paginate with NO outcome filter — get ALL calls
    let page = 1;
    let fetched = 0;
    while (true) {
      const calls = await fetchPage({
        "startedAt[]": from,
        "startedAt[]": to,
        perPage: "500",
        page: String(page),
      });
      if (!calls.length) break;
      
      for (const call of calls) {
        const phone = customerPhone(call);
        const agent = shortAgent(call.agent?.name ?? "Unknown");
        const callDate = call.startedAt ?? "";
        
        if (phone.length === 10 && agent && agent !== "Unknown") {
          const existing = phoneAgentMap.get(phone);
          if (!existing || callDate > existing.date) {
            phoneAgentMap.set(phone, { agent, date: callDate });
          }
        }
      }
      
      fetched += calls.length;
      if (calls.length < 500) break;
      page++;
    }
    totalCalls += fetched;
    console.log(`  ${fetched} calls, ${phoneAgentMap.size} unique phones so far`);

    current.setDate(current.getDate() + 7);
  }

  console.log(`\nTotal: ${totalCalls} calls, ${phoneAgentMap.size} unique phone→agent mappings`);

  // Batch upsert to Postgres
  const entries = Array.from(phoneAgentMap.entries());
  const batchSize = 200;
  let inserted = 0;
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const values = [];
    const params = [];
    batch.forEach(([phone, { agent, date }], idx) => {
      const off = idx * 3;
      values.push(`($${off+1},$${off+2},$${off+3})`);
      params.push(phone, agent, date.slice(0, 10));
    });
    await client.query(
      `INSERT INTO aim_phone_agent (phone, agent, last_call_date) VALUES ${values.join(",")}
       ON CONFLICT (phone) DO UPDATE SET agent=EXCLUDED.agent, last_call_date=EXCLUDED.last_call_date
       WHERE EXCLUDED.last_call_date >= aim_phone_agent.last_call_date`,
      params
    );
    inserted += batch.length;
  }

  console.log(`Upserted ${inserted} rows into aim_phone_agent`);

  // Check how many of the 22 unattributed phones are now covered
  const missing22 = [
    "2107241155","2392478445","2705429704","3302191596","3303391243",
    "3869567265","4094998527","4786971933","5043777636","5132571235",
    "5157108353","6312583746","6602297564","7046504255","7089803158",
    "7157649821","7174191427","7797745103","8575593047","9199260419",
    "9283263818","9522000774"
  ];
  const result = await client.query(
    `SELECT phone, agent, last_call_date FROM aim_phone_agent WHERE phone = ANY($1)`,
    [missing22]
  );
  console.log(`\nOf the 22 previously unattributed phones:`);
  console.log(`  ${result.rows.length} now have agent attribution:`);
  for (const r of result.rows) {
    console.log(`  ${r.phone} → ${r.agent} (${r.last_call_date})`);
  }
  console.log(`  ${22 - result.rows.length} still unattributed`);

  await client.end();
}

main().catch(e => { console.error(e); process.exit(1); });
