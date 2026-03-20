import { NextResponse } from "next/server";

const AIM_REST = "https://dash.aimnow.ai/api";

async function aimFetch(path: string): Promise<any> {
  const token = process.env.AIM_BEARER_TOKEN;
  if (!token) throw new Error("AIM_BEARER_TOKEN not set");
  const res = await fetch(`${AIM_REST}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`AIM ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function GET() {
  try {
    const [campaigns, agents] = await Promise.all([
      aimFetch("/campaigns"),
      aimFetch("/agents"),
    ]);

    return NextResponse.json({
      campaigns: (campaigns?.data ?? campaigns ?? []).map((c: any) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        concurrentCalls: c.concurrentCalls,
        agentId: c.agentId,
        agentName: c.agent?.name,
        groupId: c.groupId,
      })),
      agents: (agents?.data ?? agents ?? []).map((a: any) => ({
        id: a.id,
        name: a.name,
      })),
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
