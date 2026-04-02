import { Pool, types } from "pg";

// Tell node-pg to return DATE (1082) and TIMESTAMP (1114) and TIMESTAMPTZ (1184)
// as raw strings instead of JS Date objects. This prevents timezone shift bugs
// where midnight UTC dates get converted to the previous day in CT (UTC-5/6).
types.setTypeParser(1082, (val: string) => val); // DATE -> "YYYY-MM-DD"
types.setTypeParser(1114, (val: string) => val); // TIMESTAMP
types.setTypeParser(1184, (val: string) => val); // TIMESTAMPTZ

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.POSTGRES_URL || process.env.POSTGRES_URL_NO_SSL || process.env.DATABASE_URL_UNPOOLED,
      ssl: { rejectUnauthorized: false },
      max: 5,
    });
  }
  return pool;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function query(text: string, params?: any[]) {
  const client = await getPool().connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}
