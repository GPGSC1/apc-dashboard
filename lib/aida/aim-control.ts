// ─── AIM Campaign Control via RPC ───────────────────────────────────────────
// Confirmed endpoint: POST https://dash.aimnow.ai/rpc/campaigns/update
// Auth: Bearer AIM_BEARER_TOKEN
// Body: {"json": {"params": {"id": NUMBER}, "body": {"status": "...", "concurrentCalls": "..."}}}

const AIM_RPC = "https://dash.aimnow.ai/rpc/campaigns/update";
const AIM_REST = "https://dash.aimnow.ai/api";

function token(): string {
  const t = process.env.AIM_BEARER_TOKEN;
  if (!t) throw new Error("AIM_BEARER_TOKEN not set");
  return t;
}

/** Update a campaign via RPC (status and/or concurrentCalls) */
async function rpcUpdate(
  campaignId: number,
  body: Record<string, string>
): Promise<void> {
  const res = await fetch(AIM_RPC, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      json: {
        params: { id: campaignId },
        body,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AIM RPC failed (${res.status}): ${text}`);
  }
}

/** Pause a campaign */
export async function pauseCampaign(campaignId: number): Promise<void> {
  await rpcUpdate(campaignId, { status: "paused" });
}

/** Resume a campaign */
export async function resumeCampaign(campaignId: number): Promise<void> {
  await rpcUpdate(campaignId, { status: "in_progress" });
}

/** Set concurrent calls for a campaign */
export async function setConcurrentCalls(
  campaignId: number,
  calls: number
): Promise<void> {
  await rpcUpdate(campaignId, { concurrentCalls: String(Math.max(1, Math.round(calls))) });
}

/** Resume a campaign AND set concurrent calls in one call */
export async function resumeWithCalls(
  campaignId: number,
  calls: number
): Promise<void> {
  await rpcUpdate(campaignId, {
    status: "in_progress",
    concurrentCalls: String(Math.max(1, Math.round(calls))),
  });
}

/** Pause all given campaigns */
export async function pauseAll(campaignIds: number[]): Promise<void> {
  await Promise.all(campaignIds.map((id) => pauseCampaign(id)));
}

/** Fetch current campaign state from REST API */
export async function getCampaign(
  campaignId: number
): Promise<{ id: number; name: string; status: string; concurrentCalls: number } | null> {
  const res = await fetch(`${AIM_REST}/campaigns/${campaignId}`, {
    headers: { Authorization: `Bearer ${token()}` },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const d = await res.json();
  return {
    id: d.id,
    name: d.name,
    status: d.status,
    concurrentCalls: d.concurrentCalls,
  };
}

/** List all active/paused/completed campaigns (paginated) */
export async function listActiveCampaigns(): Promise<
  Array<{ id: number; name: string; status: string; concurrentCalls: number; agentId: string; callsTotal: number; callsCompleted: number }>
> {
  const allCampaigns: any[] = [];
  const maxPages = 10; // 500 campaigns max (50 per page)
  for (let page = 1; page <= maxPages; page++) {
    try {
      const res = await fetch(`${AIM_REST}/campaigns?perPage=50&page=${page}`, {
        headers: { Authorization: `Bearer ${token()}` },
        cache: "no-store",
      });
      if (!res.ok) {
        console.error(`[AIM] campaigns page ${page} failed: ${res.status} ${res.statusText}`);
        break;
      }
      const data = await res.json();
      if (!data.data?.length) break;
      allCampaigns.push(...data.data);
      console.log(`[AIM] page ${page}: ${data.data.length} campaigns (total so far: ${allCampaigns.length})`);
      if (data.data.length < 50) break; // last page
    } catch (e) {
      console.error(`[AIM] campaigns page ${page} error:`, e);
      break;
    }
  }
  console.log(`[AIM] discovered ${allCampaigns.length} total campaigns`);
  return allCampaigns
    .filter((c: any) => c.status === "in_progress" || c.status === "paused" || c.status === "completed")
    .map((c: any) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      concurrentCalls: c.concurrentCalls,
      agentId: c.agentId,
      callsTotal: c.calls?.total ?? 0,
      callsCompleted: c.calls?.completed ?? 0,
    }));
}
