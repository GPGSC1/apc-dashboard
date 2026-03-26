import { NextResponse } from "next/server";
import { query } from "../../../lib/db/connection";

export const dynamic = "force-dynamic";

/**
 * GET /api/teams — List all teams with their members + unassigned agents
 */
export async function GET() {
  try {
    const teamsResult = await query(
      `SELECT id, name, color FROM teams ORDER BY name`
    );

    // Auto-discover all agent names from 3CX calls, Moxy deals (owner + closer), and Moxy home deals
    // Insert any new names into team_members as unassigned
    await query(`
      INSERT INTO team_members (agent_name, team_id, role)
      SELECT DISTINCT name, NULL, 'closer' FROM (
        SELECT DISTINCT TRIM(agent_name) as name FROM queue_calls
          WHERE agent_name IS NOT NULL AND TRIM(agent_name) != ''
        UNION
        SELECT DISTINCT TRIM(owner) as name FROM moxy_deals
          WHERE owner IS NOT NULL AND TRIM(owner) != ''
        UNION
        SELECT DISTINCT TRIM(salesperson) as name FROM moxy_deals
          WHERE salesperson IS NOT NULL AND TRIM(salesperson) != ''
        UNION
        SELECT DISTINCT TRIM(owner) as name FROM moxy_home_deals
          WHERE owner IS NOT NULL AND TRIM(owner) != ''
        UNION
        SELECT DISTINCT TRIM(salesperson) as name FROM moxy_home_deals
          WHERE salesperson IS NOT NULL AND TRIM(salesperson) != ''
      ) all_names
      WHERE name IS NOT NULL AND name != ''
      ON CONFLICT (agent_name) DO NOTHING
    `);

    const membersResult = await query(
      `SELECT tm.agent_name, tm.team_id, tm.role, t.name as team_name
       FROM team_members tm
       LEFT JOIN teams t ON t.id = tm.team_id
       ORDER BY tm.agent_name`
    );

    const teams = teamsResult.rows.map((t: Record<string, unknown>) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      members: membersResult.rows
        .filter((m: Record<string, unknown>) => m.team_id === t.id)
        .map((m: Record<string, unknown>) => ({ name: m.agent_name, role: m.role })),
    }));

    const unassigned = membersResult.rows
      .filter((m: Record<string, unknown>) => !m.team_id)
      .map((m: Record<string, unknown>) => ({ name: m.agent_name, role: m.role }));

    return NextResponse.json({ teams, unassigned });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/**
 * POST /api/teams — Create team, assign/unassign members, delete team
 * Body: { action, ...params }
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { action } = body;

    if (action === "create_team") {
      const { name, color } = body;
      if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
      const result = await query(
        `INSERT INTO teams (name, color) VALUES ($1, $2) RETURNING id, name, color`,
        [name.trim(), color || "#6B2D99"]
      );
      return NextResponse.json({ ok: true, team: result.rows[0] });
    }

    if (action === "rename_team") {
      const { teamId, name } = body;
      await query(`UPDATE teams SET name = $1 WHERE id = $2`, [name.trim(), teamId]);
      return NextResponse.json({ ok: true });
    }

    if (action === "delete_team") {
      const { teamId } = body;
      // Unassign all members first
      await query(`UPDATE team_members SET team_id = NULL WHERE team_id = $1`, [teamId]);
      await query(`DELETE FROM teams WHERE id = $1`, [teamId]);
      return NextResponse.json({ ok: true });
    }

    if (action === "assign") {
      const { agentName, teamId } = body;
      // teamId null = unassign
      await query(
        `UPDATE team_members SET team_id = $1 WHERE agent_name = $2`,
        [teamId, agentName]
      );
      return NextResponse.json({ ok: true });
    }

    if (action === "assign_bulk") {
      const { agentNames, teamId } = body;
      for (const name of agentNames) {
        await query(
          `UPDATE team_members SET team_id = $1 WHERE agent_name = $2`,
          [teamId, name]
        );
      }
      return NextResponse.json({ ok: true, count: agentNames.length });
    }

    if (action === "set_role") {
      const { agentName, role } = body;
      await query(
        `UPDATE team_members SET role = $1 WHERE agent_name = $2`,
        [role, agentName]
      );
      return NextResponse.json({ ok: true });
    }

    if (action === "set_color") {
      const { teamId, color } = body;
      await query(`UPDATE teams SET color = $1 WHERE id = $2`, [color, teamId]);
      return NextResponse.json({ ok: true });
    }

    if (action === "add_agent") {
      const { agentName, teamId, role } = body;
      await query(
        `INSERT INTO team_members (agent_name, team_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (agent_name) DO UPDATE SET team_id = $2, role = $3`,
        [agentName.trim(), teamId || null, role || "closer"]
      );
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
