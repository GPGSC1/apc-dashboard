import { NextResponse } from "next/server";
import { query } from "../../../lib/db/connection";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const from = url.searchParams.get("start") ?? "2026-04-01";
  const to = url.searchParams.get("end") ?? "2026-04-07";

  // T.O. team members (same query as sales-data)
  const toTeamResult = await query(
    `SELECT tm.agent_name FROM team_members tm
     JOIN teams t ON t.id = tm.team_id
     WHERE LOWER(t.name) IN ('to.', 't.o.')`,
    []
  );
  const toNames = toTeamResult.rows.map((r: any) => r.agent_name);

  // All distinct dest_name values in queue_calls for the range
  const destNames = await query(
    `SELECT dest_name, COUNT(*) as cnt
     FROM queue_calls
     WHERE call_date BETWEEN $1 AND $2
       AND dest_name IS NOT NULL AND dest_name != ''
     GROUP BY dest_name
     ORDER BY cnt DESC`,
    [from, to]
  );

  // Look for any dest_name containing "crews", "schieferle", "robin", "cortez", etc
  const toLowerNames = toNames.map((n: string) => n.toLowerCase().trim());
  const suspectDestNames = destNames.rows.filter((r: any) => {
    const d = (r.dest_name || "").toLowerCase().trim();
    return toLowerNames.some((tn: string) => {
      const lastName = tn.split(" ").pop() || "";
      return lastName.length > 3 && d.includes(lastName);
    });
  });

  // Exact matches
  const toSet = new Set(toLowerNames);
  const exactMatches = destNames.rows.filter((r: any) =>
    toSet.has((r.dest_name || "").toLowerCase().trim())
  );

  return NextResponse.json({
    dateRange: { from, to },
    toTeamMembers: toNames,
    totalDistinctDestNames: destNames.rows.length,
    exactMatches,
    suspectDestNamesContainingToLastNames: suspectDestNames,
    top30DestNames: destNames.rows.slice(0, 30),
  });
}
