# GPG Dashboard -- Project Handoff Document

## Project Overview

- **Company**: Guardian Protection Group (GPG) -- extended auto warranty and home warranty company
- **Product**: Three-dashboard analytics platform for sales performance, AI voice agent campaigns, and AI dialer automation
- **Dashboards**: Sales (`/sales`), AI Voice Agent (`/ai`), AIDA (`/aida`)
- **Landing page**: Root (`/`) -- simple card-based hub linking to each dashboard
- **Hosting**: Vercel at `gpg-dashboard-gpgsc1s-projects.vercel.app`
- **GitHub**: `GPGSC1/apc-dashboard` (main branch)
- **Database**: Vercel Postgres (Neon) -- `apc-dashboard-db`, Washington D.C. region
- **State Store**: Vercel KV (Upstash Redis) -- used exclusively by AIDA for operational state
- **Framework**: Next.js 16.1.6 with App Router, React 19, TypeScript, Tailwind CSS 4
- **Node deps**: `pg` for Postgres, `@upstash/redis` for KV, `papaparse` and `xlsx` for data import scripts

---

## Architecture

### Stack
- Next.js App Router (`app/` directory)
- Postgres (Neon) for ALL persistent data -- deals, calls, transfers, costs, teams, list memberships
- Vercel KV (Upstash Redis) for AIDA ephemeral state -- mode, cooldown, campaign tracking, performance cache, action logs
- No JSON seed files at runtime -- everything lives in Postgres (legacy JSON fallback code exists in `/api/data` but is unused when `POSTGRES_URL` is set)
- All dates are handled in Central Time (America/Chicago) -- this is critical because GPG operates in CT

### Cron Jobs (vercel.json)
1. **Seed Refresh**: `*/15 * * * 1-6` -- every 15 minutes, Monday through Saturday. Gated to 7:30am-7:00pm CT in code via `isWithinBusinessHours()`. Sunday is entirely skipped; Monday 7:30am catches Saturday night and Sunday gaps.
2. **AIDA Tick**: `* * * * *` -- every minute (Vercel cron minimum). Gated to business hours (8:00-18:00 CT, Mon-Fri) in code via AIDA config.

### Function Timeouts
- `seed-refresh/route.ts`: 60s max duration
- `aida/tick/route.ts`: 30s max duration

---

## Data Sources & APIs

### 1. AIM (AI Dialer) -- `dash.aimnow.ai`
- **Auth**: Bearer token via `AIM_BEARER_TOKEN` env var
- **REST API**: `https://dash.aimnow.ai/api`
  - `GET /api/calls` -- paginated (500/page), filters: `startedAt[]`, `outcomes[]` (89 = transfer)
  - `GET /api/campaigns` -- paginated (50/page), returns all campaign states
- **RPC API**: `https://dash.aimnow.ai/rpc/campaigns/update`
  - POST with body `{"json":{"params":{"id":NUMBER},"body":{"status":"...","concurrentCalls":"..."}}}`
  - Used by AIDA to pause/resume/throttle campaigns
- **Data collected**: Transfers (outcome=89), all calls (for cost/duration), phone-agent mapping, phone-list history
- **Agent short names**: Full AIM agent names mapped to display names (see Agent Mapping section)

### 2. 3CX (Phone System) -- `gpgsc.innicom.com`
- **Auth**: ASP.NET forms auth. Login at `/LoginPage.aspx`, extract `__VIEWSTATE`/`__EVENTVALIDATION`, POST credentials, get `.ASPXAUTH` cookie
- **Credentials**: `TCX_USERNAME` (default "1911"), `TCX_PASSWORD`, `TCX_DOMAIN` (default "gpgsc.innicom.com")
- **Report endpoint**: `/app0422/RunReportDefinitionToFile.ashx` -- returns CSV with call detail records
  - Report ID: `c80b90ab-0a2d-4413-b242-38e4046571f1`
  - CSV columns are positional: CallID(0), StartTime(1), Direction(3), Phone(8), Status(auto-detected ~12), FirstExt(4), FirstExtName(5), Destination(10), QueueName(~SSI+7)
- **Data collected**: Inbound calls to sales queues, agent extensions, answered/unanswered status, forwarding destinations
- **Sales queues tracked**: mail 1-6, home 1-5

### 3. Moxy Auto Warranty API -- `MoxyAPI.moxyws.com`
- **Auth**: Bearer token `a242ccb0-738e-4e4f-a418-facf89297904` via `MOXY_API_KEY` env var
- **Endpoint**: `GET /api/GetDealLog?fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD&dealType=Both`
- **Data collected**: Deal records with customer_id, contract_no, sold_date, phones, salesperson (closer/T.O.), owner (sales rep), deal_status, promo_code, campaign, make, model, state, admin

### 4. Moxy Home Warranty API -- same base URL
- **Auth**: Bearer token `3f7c2b0a-9e4d-4f6e-b1a8-8c9a6e2d7b54` via `MOXY_HOME_KEY` env var
- **Endpoint**: Same as auto, different API key returns home warranty deals
- **Table**: `moxy_home_deals` (same structure as `moxy_deals` minus make/model, plus `division='home'`)

### 5. 3CX Wallboard (AIDA only) -- `gpgsc.innicom.com/app0422/Wallboard.aspx`
- **Auth**: Same ASP.NET forms auth as 3CX reports, session cookies cached in Vercel KV with 15-min TTL
- **Service endpoint**: `WallboardService.svc/GetWallboardData?Filter=FILTER_ID`
  - Empty filter = Centerwide (total waiting across all queues)
  - Filter IDs: CS=628, Collections=623, Home1=640, Home2=642, Home3=644, Home4=648, Home5=650, CB=633, Mail1=626, Mail2=638, Mail3=639, Mail4=647, Mail5=649, Mail6=652
- **Response**: JSON with `d.Waiting` (calls waiting count), `d.CallsWaiting` (detail), `d.AgentData`
- **KNOWN ISSUE**: Wallboard currently returns 0 across all queues. Auth appears to work (gets `.ASPXAUTH` cookie) but data parsing may be wrong, or the wallboard service may require additional session state.

---

## Database Schema

### `moxy_deals` -- Auto warranty deals from Moxy
| Column | Type | Notes |
|--------|------|-------|
| customer_id | TEXT | Campaign/customer identifier (e.g., "GPG12345") |
| contract_no | TEXT | Unique contract number (PRIMARY dedup key) |
| sold_date | DATE | Date deal was sold |
| first_name, last_name | TEXT | Customer name |
| home_phone, mobile_phone | TEXT | 10-digit normalized phones |
| salesperson | TEXT | Closer / T.O. agent (the person who closed the deal) |
| owner | TEXT | Sales Rep (the person who originally took the call) |
| deal_status | TEXT | Active, Back Out, VOID, Cancelled, Cancel POA, etc. |
| promo_code | TEXT | "CS", "SP", "API", etc. -- used for deal attribution |
| campaign | TEXT | Campaign code -- used for queue rule fallback |
| source | TEXT | Lead source |
| cancel_reason | TEXT | Why the deal was cancelled |
| make, model | TEXT | Vehicle info (auto only) |
| state | TEXT | Customer state |
| admin | NUMERIC | Admin fee amount |
| **Unique index**: `idx_moxy_deals_unique ON (contract_no) WHERE contract_no IS NOT NULL AND contract_no != ''` |
| **Fallback index**: `idx_moxy_deals_cid_fallback ON (customer_id) WHERE (contract_no IS NULL OR contract_no = '') AND customer_id IS NOT NULL AND customer_id != ''` |

### `moxy_home_deals` -- Home warranty deals from Moxy
Same structure as `moxy_deals` minus `make` and `model` columns, plus `division TEXT DEFAULT 'home'`.
**Unique constraint**: `UNIQUE(customer_id, contract_no)` plus `idx_moxy_home_unique ON (contract_no)`.

### `queue_calls` -- 3CX inbound call detail records
| Column | Type | Notes |
|--------|------|-------|
| phone | TEXT | 10-digit caller phone |
| queue | TEXT | Queue name (e.g., "mail 1", "home 2") |
| call_date | DATE | Date of call |
| first_ext | TEXT | Extension that answered (4-digit). Blank = unanswered. "99xx" = AI forwarded. |
| agent_name | TEXT | Name of agent who answered |
| direction | TEXT | "Inbound" (only inbound stored) |
| status | TEXT | "answered" or "unanswered" |
| destination | TEXT | Forwarding destination number (11-digit starting with "1" = AI forward) |
| **Unique constraint**: `ON CONFLICT (phone, queue, call_date)` -- one record per phone per queue per day |

### `aim_transfers` -- AIM transfer calls (outcome=89)
| Column | Type | Notes |
|--------|------|-------|
| call_id | TEXT PK | AIM call identifier |
| phone | TEXT | 10-digit customer phone |
| list_key | TEXT | List attribution (RT, JL021926LP, etc.) |
| agent | TEXT | Short agent name |
| call_date | DATE | Date of transfer |
| duration_sec | NUMERIC | Call duration in seconds |
| cost | NUMERIC | Call cost |

### `aim_daily_costs` -- Daily cost aggregates per list
| Column | Type | Notes |
|--------|------|-------|
| list_key | TEXT | List name |
| call_date | DATE | Date |
| minutes | INTEGER | Total minutes for that list on that day |
| cost | NUMERIC | Total cost ($0.29/min) |
| **Unique**: `ON CONFLICT (list_key, call_date)` |

### `aim_agent_daily_costs` -- Daily cost aggregates per agent
| Column | Type | Notes |
|--------|------|-------|
| agent | TEXT | Short agent name |
| call_date | DATE | Date |
| minutes | INTEGER | Total minutes |
| cost | NUMERIC | Total cost |
| **Unique**: `ON CONFLICT (agent, call_date)` |

### `aim_phone_agent` -- Phone-to-agent mapping (most recent call wins)
| Column | Type | Notes |
|--------|------|-------|
| phone | TEXT PK | 10-digit phone |
| agent | TEXT | Most recent agent who called this phone |
| last_call_date | DATE | Date of most recent call |
| **Upsert**: Only updates if `EXCLUDED.last_call_date >= aim_phone_agent.last_call_date` |

### `aim_phone_history` -- Phone-to-list history for tiebreaking
| Column | Type | Notes |
|--------|------|-------|
| phone | TEXT | 10-digit phone |
| list_key | TEXT | List the phone was called from |
| call_date | DATE | Date of call |
| **Unique**: `ON CONFLICT DO NOTHING` (phone, list_key, call_date) |

### `list_phones` -- Phone-to-list membership (static, loaded from CSV)
| Column | Type | Notes |
|--------|------|-------|
| phone | TEXT | 10-digit phone |
| list_key | TEXT | Which list this phone belongs to |

### `mail4_phones` -- Phones that have called into Mail 4 queue
| Column | Type | Notes |
|--------|------|-------|
| phone | TEXT PK | 10-digit phone. `ON CONFLICT DO NOTHING`. |

### `phone_last_queue` -- Most recent queue visit per phone (for recency gate)
| Column | Type | Notes |
|--------|------|-------|
| phone | TEXT PK | 10-digit phone |
| queue | TEXT | Last queue visited |
| call_date | DATE | Date of last visit |
| **Upsert**: Only updates if `EXCLUDED.call_date >= phone_last_queue.call_date` |

### `opened_calls` -- Calls opened (answered by human closer) in Mail 4
| Column | Type | Notes |
|--------|------|-------|
| call_date | DATE | Date |
| phone | TEXT | Caller phone |

### `seed_metadata` -- Tracks last refresh dates per source
| Column | Type | Notes |
|--------|------|-------|
| source | TEXT PK | "aim", "tcx", "moxy", "moxy_home", "refresh" |
| max_date | DATE | Most recent date fetched |
| updated_at | TIMESTAMP | When last updated |

### `teams` -- Team definitions (Postgres-backed, editable via UI)
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | Auto-increment |
| name | TEXT | Team display name |
| color | TEXT | Hex color code (default "#6B2D99") |

### `team_members` -- Agent-to-team assignments
| Column | Type | Notes |
|--------|------|-------|
| agent_name | TEXT PK | Must match 3CX agent_name or Moxy salesperson/owner |
| team_id | INTEGER FK | References teams.id (NULL = unassigned) |
| role | TEXT | "closer", "manager", etc. |

---

## Queue Mapping

3CX queue names map to dashboard labels:

| 3CX Queue | Label | Division |
|-----------|-------|----------|
| mail 1 | A1 | Auto |
| mail 2 | A2 | Auto |
| mail 3 | A3 | Auto |
| mail 4 | A4 | Auto |
| mail 5 | A5 | Auto |
| mail 6 | A6 | Auto |
| home 1 | H1 | Home |
| home 2 | H2 | Home |
| home 3 | H3 | Home |
| home 4 | H4 | Home |
| home 5 | H5 | Home |

Defined in `lib/queue-map.ts`. The `mapQueue()` function does case-insensitive substring matching (e.g., "8023 Mail 1" maps to "A1").

---

## Sales Dashboard (`/sales`) -- CRITICAL BUSINESS LOGIC

### API Route: `/api/sales-data`
File: `app/api/sales-data/route.ts`
Accepts `?start=YYYY-MM-DD&end=YYYY-MM-DD` query params. Defaults to today.

### Deal Attribution Logic (priority order)

For each Moxy deal (auto + home combined):

1. **Promo code check** (highest priority, before queue lookup):
   - `promo_code = "CS"` --> CS deal (Customer Service). Counted in Additional Sales only, NOT in queue breakdown. `continue` to skip queue attribution.
   - `promo_code = "SP"` --> Spanish deal. Same treatment as CS.
2. **Salesperson check**:
   - `salesperson` (closer) matches "Jeremy Fishbein" (case-insensitive) --> AI deal. Counted in Additional Sales only. `continue` to skip queue attribution.
3. **Excluded salesperson check**: If BOTH `owner` and `salesperson` are in `EXCLUDED_SALESPERSONS` list ("Jeremy Fishbein", "GPG X1 Transfer"), skip the deal entirely.
4. **Phone-based queue lookup**: For the deal's home_phone and mobile_phone (normalized to 10-digit):
   - Query `queue_calls` for ALL historical calls from these phones, sorted by date DESC
   - Find the most recent queue visit ON or BEFORE the sold date
   - The matched queue (mapped via `mapQueue()`) becomes the deal's attributed queue
5. **Fallback queue rules** (if no phone match in queue_calls): Apply `applyQueueRules()` using campaign code and customer_id:
   - **Auto deals**:
     - `promo_code = "API"` --> A4
     - Campaign/CID starts with `GPG` --> A1
     - Campaign/CID starts with `FWM`, `WF`, `FTD`, `FD` --> A3
     - Campaign/CID starts with any of: `DMW`, `MKA`, `DMC`, `SCD`, `APD`, `TDM`, `SDC`, `TDN`, `TDS`, `MX`, `2DMWTD`, `PMI`, `SAC TD`, `TD_`, `TDV`, `TDSF`, `TDT` --> A2
     - Contains `PMI` anywhere --> A2
     - Starts with `TD` --> A2
     - Regex `^MKA.{3}KA` --> A1
     - Characters 5-6 match specific 2-letter codes (KC, KH, KL, LA, etc.) --> A1
     - Regex `^\d{3}[A-Z]{2}$` --> A1
   - **Home deals**:
     - Starts with `TDH` --> H2
     - Starts with `TAB` --> H3
     - Regex `^\d{3}[A-Z]{2}$` --> H1
     - Starts with `132883-GPGH` --> H1
     - Starts with `GPGH` --> H1
6. **F/B classification**: If a deal has a queue but the product type doesn't match the queue division (e.g., auto product from home queue), it's an F/B (Flip/Bundle) deal.
7. **No queue found**: Deal is silently dropped from queue breakdown (but CS/AI/SP deals are already counted).

### Dedup Logic
- **Primary**: `contract_no` as unique index. Upsert on conflict updates `deal_status`, `salesperson`, `cancel_reason`, `customer_id`, `owner`.
- **Fallback**: `customer_id` when `contract_no` is empty/null (separate conflict target).
- **Query-level**: `DISTINCT ON (customer_id || '|' || contract_no)` prevents counting the same deal twice in a query result.

### Status Filtering
Excluded from all counts: `deal_status IN ('Back Out', 'VOID', '')`. Note: `Cancelled` and `Cancel POA` are NOT currently in the exclusion list in the SQL query (only 'Back Out' and 'VOID' and empty string are excluded).

### Status Sync (Upsert Behavior)
The seed-refresh uses `ON CONFLICT DO UPDATE SET deal_status = EXCLUDED.deal_status, salesperson = EXCLUDED.salesperson, ...` -- this means deal statuses are updated on every refresh. If a deal gets cancelled or backed out, the next refresh will update the status in Postgres, and the dashboard query will exclude it.

### Call Counting Logic

Three categories of calls, all based on `queue_calls` table:

1. **Human answered**: `first_ext IS NOT NULL AND first_ext != '' AND LENGTH(TRIM(first_ext)) <= 4 AND TRIM(first_ext) NOT LIKE '99%'`
   - Has a 4-digit extension that doesn't start with 99
   - Counted as `COUNT(DISTINCT phone)` per queue -- same phone calling same queue multiple times in the date range = 1 call
   - Same phone in different queues counts in each queue

2. **AI-Forwarded (AI-FWD)**: Two patterns:
   - `first_ext LIKE '99%'` (extension starts with 99 = AI routing extension)
   - OR `first_ext IS NULL/empty AND destination IS 11-digit starting with '1'` (forwarded to external AI number)

3. **Dropped**: `first_ext IS NULL/empty AND NOT AI-forwarded AND phone was NEVER answered in that queue during the entire date range`
   - Uses a `NOT EXISTS` subquery to check if the phone was answered (by human OR AI) in the same queue within the same date range
   - If the phone was answered on a different day within the range, it's NOT dropped

### Salesperson Attribution
- `salesperson` field in Moxy = **closer / T.O. agent** (the person who closed the deal)
- `owner` field in Moxy = **Sales Rep** (the person who originally took the call)
- **Performance tab uses `owner`** (Sales Rep) for deal attribution, NOT `salesperson` (closer)
- When `owner` is blank, falls back to `salesperson` (closer): `const salesRep = deal.owner?.trim() || closer;`

### F/B (Flip/Bundle) Logic

A "flip" or "bundle" occurs when a deal's product type doesn't match the queue division where the call came in:

- **Auto Flip**: Customer called a Home queue --> bought auto policy ONLY (no home policy for that phone)
- **Auto Bundle**: Customer called a Home queue --> bought BOTH auto AND home policies (same phone has both product types in the date range)
- **Home Flip**: Customer called an Auto queue --> bought home policy ONLY
- **Home Bundle**: Customer called an Auto queue --> bought BOTH auto AND home policies

Bundle detection uses `phoneProductSet` -- a Map tracking which product types each phone has across all deals in the date range. If a phone has both "auto" and "home", it's a bundle.

F/B deals:
- Are NOT counted in the queue row's deal count (only in the F/B summary row)
- ARE counted in the product totals (auto total includes auto flips from home queues; home total includes home flips from auto queues)
- ARE counted in the company total

### Additional Sales Row

Three categories, each split by auto/home:
- **CS Deals**: `promo_code = 'CS'`
- **AI Deals**: `salesperson` matches "Jeremy Fishbein" (case-insensitive)
- **Spanish Deals**: `promo_code = 'SP'`

These are counted in product totals (Auto/Home) and company total but NOT in any queue breakdown row.

### Math Audit Rule
```
Auto total = A1 + A2 + A3 + A4 + A5 + A6 + F/B(auto) + CS(auto) + AI(auto) + SP(auto)
Home total = H1 + H2 + H3 + H4 + H5 + F/B(home) + CS(home) + AI(home) + SP(home)
Company total = Auto total + Home total
```
If these don't add up, something is double-counted or dropped.

### Performance Tab
- Three-state product toggle: Combined (default) / Auto / Home
- **Combined view**: Name, Total Deals, Total Calls, Close %
- **Auto/Home view**: Adds per-queue columns with D (deals) - C (calls) - % (close rate) for each queue in that division
- Agent-level call data comes from `queue_calls` grouped by `agent_name` and `queue`
- Deal attribution to agents uses `owner` (Sales Rep), matching against the `bySalesperson` accumulator
- Queue columns have vertical dividers, sortable by any D/C/% column
- Team management via Manage Teams modal -- creates/deletes teams in Postgres `teams` and `team_members` tables
- "All Agents" vs "By Team" toggle for grouping

---

## AI Voice Agent Dashboard (`/ai`)

### API Route: `/api/data`
File: `app/api/data/route.ts`
Accepts `?start=YYYY-MM-DD&end=YYYY-MM-DD`. Defaults to campaign start date (2026-02-25) through today.

### Triple Gate Attribution

For a Moxy sale to count as an AI campaign sale, ALL three gates must pass:

1. **Mail 4 Gate**: At least one of the deal's phones must exist in `mail4_phones` table (phone has called into Mail 4 queue)
2. **List Membership Gate**: The phone must exist in `list_phones` table (belongs to one of the campaign lists)
3. **Queue Recency Gate**: The phone's most recent queue visit (from `phone_last_queue`) must NOT be a competing mail queue (not mail 4) with a date on or before the sale date
   - Mail 4 queue = PASS (our queue)
   - Non-mail queue = PASS (not competing)
   - Other mail queue BEFORE sale = BLOCK (competing queue got the call first)
   - Other mail queue AFTER sale = PASS (sale already happened)

### List Attribution with AIM Tiebreaker
When a phone belongs to multiple lists:
1. Check `aim_phone_history` for most recent AIM call to that phone -- use that list
2. Fallback to first list in the array

### Campaign Lists
| List Key | List Cost |
|----------|-----------|
| RT (Respond/Trigger) | $0 |
| JL021926LP | $8,000 |
| BL021926BO | $8,000 |
| JH022326MN | $8,000 |
| JL021926CR | $8,000 |
| DG021726SC | $5,000 |
| JL022526RS | $6,000 |

### Metrics Per List
- **T** (Transfers): Phones in the list that also appear in `aim_transfers`
- **O** (Opened): Calls answered by human closer in Mail 4 queue (distinct phones, `first_ext` is 4-digit non-99)
- **S** (Sales): Moxy deals passing the triple gate and attributed to this list
- **Min/Cost**: From `aim_daily_costs` table (aggregated from AIM all-calls data)
- **List Cost**: Fixed cost of purchasing the list

### Cost Metrics
- All AIM calls cost $0.29/minute
- **Cost per sale** = total dial cost / total sales (includes lists with 0 sales in the denominator)
- Agent costs are proportionally allocated to lists based on transfer counts

### Views
- **By List**: Shows T, O, S, Min, Cost per list
- **By Agent**: Shows per-agent metrics with list breakdown
- **Campaign Tabs**: Transfer, Outbound, Inbound, Meta, Overview, Agent Mapping

### Agent Grid (`aimByAgentGrid`)
Each agent's minutes and cost are proportionally allocated across lists based on their transfer count per list. Formula: `allocMin = totalMin * (transfers_in_list / total_transfers)`.

### Fishbein Exclusion
Jeremy Fishbein deals are excluded from AI dashboard sales counts (`salesperson` containing "fishbein" is skipped).

---

## AIDA (`/aida`) -- AI Dialer Automation

### Purpose
Monitors 3CX wallboard for queue depth (calls waiting) and automatically controls AIM campaigns -- pausing, resuming, and adjusting concurrent call levels to prevent queue overflow.

### Architecture
- **Tick route**: `/api/aida/tick` -- called every minute by Vercel cron
- **Status route**: `/api/aida/status` -- returns current state, config, recent actions, performance data
- **Control route**: `/api/aida/control` -- manual actions (pause, resume, enable, disable, refresh_campaigns, set_config)
- **Wallboard debug**: `/api/aida/wallboard-debug` -- step-by-step login/poll diagnostic endpoint
- **State**: Stored in Vercel KV (Redis) via `lib/aida/kv-schema.ts`
- **Throttle engine**: Pure function in `lib/aida/throttle.ts` -- no side effects, returns action type + new levels

### Tick Flow (every minute)
1. Auth check (CRON_SECRET on Pro plan, accepts unauthenticated on Hobby)
2. Initialize state if first run (discovers campaigns from AIM API)
3. Auto-refresh campaigns every 5 minutes from AIM API (updates status, concurrent calls, removes deleted campaigns)
4. Business hours gate -- if outside hours, transition to `after_hours` mode and pause all campaigns
5. If returning from after-hours, set mode to `running`
6. Refresh performance data from Postgres
7. Poll wallboard for current queue depth
8. Evaluate throttle decision (pure function)
9. Execute action (if not dry-run)
10. Update state in KV
11. Log action to KV (90-day retention)

### Throttle States and Thresholds
| State | Condition | Action |
|-------|-----------|--------|
| RAMP_UP | totalWaiting <= 1 | Increase concurrent calls by 25% |
| HOLD | 2 <= totalWaiting <= 4 | No change (dead band) |
| THROTTLE_DOWN | totalWaiting >= 5 | Decrease concurrent calls by 25% |
| EMERGENCY_PAUSE | totalWaiting >= 10 | Pause ALL campaigns, enter 5-min cooldown |
| RESUME_FROM_COOLDOWN | After cooldown expires | Resume at 50% of pre-pause levels |
| AFTER_HOURS_PAUSE | Outside business hours | Pause all campaigns |

### Configuration (stored in KV)
```
{
  enabled: false,        // false = DRY RUN (current default)
  thresholds: { rampUp: 1, holdMax: 4, throttleDown: 5, emergencyPause: 10 },
  cooldownMinutes: 5,
  stepPercent: 25,        // % change per action
  resumePercent: 50,      // resume at this % of pre-pause levels
  businessHours: { start: 8, end: 18, days: [1,2,3,4,5] }  // Mon-Fri
}
```

### Operational Modes
- `running` -- actively monitoring and controlling
- `paused` -- manually paused via control endpoint
- `cooldown` -- after emergency pause, waiting for cooldown timer
- `after_hours` -- outside business hours
- `off` -- initial state before first tick

### AIM Campaign Control
File: `lib/aida/aim-control.ts`
- `pauseCampaign(id)` -- sets status to "paused"
- `resumeCampaign(id)` -- sets status to "in_progress"
- `setConcurrentCalls(id, calls)` -- adjusts dial level (min 1)
- `resumeWithCalls(id, calls)` -- resume AND set level in one call
- `pauseAll(ids)` -- pause multiple campaigns in parallel
- `listActiveCampaigns()` -- paginated discovery (up to 500 campaigns)

### Wallboard Polling
File: `lib/aida/wallboard.ts`
- Authenticates to 3CX wallboard via ASP.NET forms auth
- Session cookies cached in KV with 15-min TTL
- Polls centerwide (all queues) + individual queue filters in parallel
- On auth failure, clears cache and retries with fresh login
- Returns `WallboardSnapshot` with `totalWaiting` and `byQueue` breakdown

### Performance Data
File: `lib/aida/performance.ts`
- Computes yesterday, week-to-date, and month-to-date stats for each list and agent
- Queries Postgres directly (aim_daily_costs, aim_transfers, moxy_deals)
- Cached in KV with 24-hour TTL

### KV Keys
- `aida:state` -- current AidaState (mode, campaigns, cooldown, etc.)
- `aida:config` -- AidaConfig (thresholds, business hours, enabled flag)
- `aida:wb:session` -- wallboard auth cookies (15-min TTL)
- `aida:log:YYYY-MM-DD` -- daily action log (90-day retention)
- `aida:log:index` -- list of dates with logs
- `aida:performance` -- cached performance data (24-hour TTL)

---

## Seed Refresh Schedule

File: `app/api/seed-refresh/route.ts`

### Timing
- Vercel cron: `*/15 * * * 1-6` (every 15 min, Mon-Sat)
- Code gate: 7:30am-7:00pm CT
- Sunday: no refreshes at all
- Monday 7:30am: catches all of Saturday night + Sunday

### What Runs
All four sources run in parallel via `Promise.allSettled`:
1. `refreshAim(dates)` -- AIM transfers, daily costs, agent costs, phone-agent mapping, phone history
2. `refresh3cx(dates)` -- 3CX call records -> queue_calls, mail4_phones, phone_last_queue, opened_calls
3. `refreshMoxy(dates)` -- Moxy auto warranty deals
4. `refreshMoxyHome(dates)` -- Moxy home warranty deals

### Date Selection
- Always fetches yesterday + today (to catch late-entered deals after business hours)
- Checks `seed_metadata` for gap detection, but currently always fetches yesterday + today regardless
- Manual override: `?dates=2026-03-24,2026-03-25`

### Upsert Behavior
- **AIM transfers**: `ON CONFLICT DO NOTHING` (immutable once recorded)
- **AIM daily costs**: `ON CONFLICT (list_key, call_date) DO UPDATE` (recalculated each refresh)
- **AIM agent costs**: `ON CONFLICT (agent, call_date) DO UPDATE` (recalculated)
- **AIM phone-agent**: `ON CONFLICT (phone) DO UPDATE ... WHERE EXCLUDED.last_call_date >= existing` (most recent wins)
- **Queue calls**: `ON CONFLICT (phone, queue, call_date) DO UPDATE` with CASE logic -- only overwrite if the new record has a non-empty first_ext (prefer answered over unanswered)
- **Moxy deals**: `ON CONFLICT (contract_no) DO UPDATE SET deal_status, salesperson, cancel_reason, customer_id, owner` (status sync -- this is how backouts are caught)
- **Moxy home deals**: `ON CONFLICT (customer_id, contract_no) DO UPDATE SET deal_status, salesperson, cancel_reason, owner`

---

## Agent Mapping (AIM Voice Agents)

| Full AIM Name | Dashboard Display Name |
|---------------|----------------------|
| Transfer Activation Outbound Agent with Moxy | Activation |
| Transfer Outbound Agent with Moxy | Moxy OG |
| Female Transfer Outbound Agent with Moxy version 3 | Female v3 |
| Transfer Outbound Agent with Moxy version 2 | Moxy v2 |
| Male Transfer Outbound Agent with Moxy version 3 | Male v3 |
| Overflow Agent with Spanish Transfer | Overflow ES |
| Outbound Jr. Closer to TO Agent with Moxy Tools | Jr Closer |

Defined in `app/api/seed-refresh/route.ts` as `AGENT_SHORT` constant.

---

## Key Business Rules

### People
- **Jeremy Fishbein** = Operations manager, not a closer. Deals in his name = AI front-to-back sales (no human closer involved). His deals go to "AI Deals" in Additional Sales row.
- **James Crews, Jim Schieferle** = T.O. (Take Over) managers. They close deals FOR reps, not originate them. Performance tab attributes to `owner`, not `closer`.
- **Farrah Zenk** = CS (Customer Service) agent.
- **GPG X1 Transfer** = System/transfer account, excluded from sales dashboard.

### Deal Rules
- **Mail 4 is unpublished** -- ONLY AIM can send calls there. Any phone in Mail 4 was sent by the AI campaign.
- **"Back Out" within 3 days** of sale = legitimate backout. After 3 days, the deal status is considered permanent.
- **T.O. vs Sales Rep**: `salesperson`/`closer` = T.O. agent (who closed the deal). `owner` = Sales Rep (who took the original call). Performance tab uses `owner`.
- **CS/Collections/Home queues do NOT block** auto deal attribution in the recency check (customer calling about existing service, not competing with a new auto sale).
- **T.O. queue calls still count** for the original queue (don't block attribution).

### Excluded Statuses
Currently excluded from deal counts in SQL: `'Back Out'`, `'VOID'`, `''` (empty string).

### Phone Normalization
All phones are normalized to 10-digit: strip non-digits, if 11 digits starting with "1" then strip the leading 1.

---

## Known Issues / Active Work

1. **AIDA wallboard shows 0 across all queues** -- auth appears to work (gets `.ASPXAUTH` cookie) but the wallboard service returns 0 for all queue counts. Could be a parsing issue, or the wallboard may require additional session state (e.g., selecting a filter first). Debug endpoint at `/api/aida/wallboard-debug`.

2. **Performance tab name mismatches** -- 3CX `agent_name` (from extensions) doesn't always match Moxy `salesperson`/`owner` names. Agent call counts may not align with deal counts if names differ (e.g., "Jon Smith" in 3CX vs "Jonathan Smith" in Moxy).

3. **Availability, Trends, and Text Mike tabs** are "Coming Soon" placeholders in the Sales dashboard UI.

4. **Historical data before 3/24** may have stale deal statuses because the original upsert used `DO NOTHING` instead of `DO UPDATE`. Fixed on 3/24 by switching to `DO UPDATE SET deal_status, salesperson, owner`.

5. **queue_calls coverage**: Only has data from CSV import (1/1/2026 - 3/23/2026) + live seed-refresh (3/24+). No data before January 2026.

6. **AIDA is in DRY RUN mode** (`config.enabled = false`). It logs decisions but does NOT execute campaign control actions. Must be explicitly enabled via `/api/aida/control` with `{"action":"enable"}`.

---

## Environment Variables (Vercel)

| Variable | Purpose |
|----------|---------|
| `POSTGRES_URL` | Neon Postgres connection string (pooled) |
| `POSTGRES_URL_NON_POOLING` | Neon direct connection (for migrations) |
| `KV_REST_API_URL` | Upstash Redis REST URL |
| `KV_REST_API_TOKEN` | Upstash Redis auth token |
| `AIM_BEARER_TOKEN` | AIM dialer API auth |
| `TCX_USERNAME` | 3CX login username (default "1911") |
| `TCX_PASSWORD` | 3CX login password |
| `TCX_DOMAIN` | 3CX domain (default "gpgsc.innicom.com") |
| `MOXY_API_KEY` | Moxy auto warranty API key |
| `MOXY_HOME_KEY` | Moxy home warranty API key |
| `CRON_SECRET` | Vercel cron auth (Pro plan only) |

---

## File Structure

### API Routes (`app/api/`)
| File | Purpose |
|------|---------|
| `sales-data/route.ts` | Powers `/sales` dashboard -- deal attribution, call counting, queue breakdown, F/B, performance |
| `data/route.ts` | Powers `/ai` dashboard -- triple gate attribution, list/agent metrics, cost analysis |
| `seed-refresh/route.ts` | Cron job -- fetches from all 4 sources, upserts into Postgres |
| `teams/route.ts` | CRUD for team management (GET list, POST create/assign/delete/rename) |
| `aida/tick/route.ts` | AIDA cron -- wallboard poll, throttle evaluation, campaign control |
| `aida/status/route.ts` | AIDA status endpoint -- state, config, recent logs, performance |
| `aida/control/route.ts` | AIDA manual control -- pause, resume, enable, disable, set_config |
| `aida/wallboard-debug/route.ts` | Step-by-step wallboard login diagnostic |
| `meta/route.ts` | Meta (Facebook) lead tracking for AI dashboard |
| `calls/route.ts` | Call data endpoint |
| `moxy/route.ts` | Direct Moxy API proxy |
| `aim/route.ts` | Direct AIM API proxy |
| `aim-seed/route.ts` | Legacy AIM seed route |
| `3cx-seed/route.ts` | Legacy 3CX seed route |
| `test-moxy/route.ts` | Moxy API test endpoint |
| `aida-discover/route.ts` | AIM campaign discovery |

### Library Files (`lib/`)
| File | Purpose |
|------|---------|
| `db/connection.ts` | Postgres pool singleton (`pg.Pool`, max 5 connections, SSL) |
| `queue-map.ts` | Queue name mapping (3CX -> dashboard labels), `mapQueue()`, `isAutoQueue()`, `isHomeQueue()` |
| `teams.ts` | Static team assignments, `EXCLUDED_SALESPERSONS`, `isExcludedSalesperson()` |
| `date-utils.ts` | `parseDate()` (handles M/D/YYYY, YYYY-MM-DD, Excel serials), `todayLocal()`, `tomorrowLocal()` -- all CT |
| `aida/types.ts` | TypeScript interfaces: AidaCampaign, AidaState, AidaConfig, WallboardSnapshot, ThrottleAction, AidaLogEntry, DEFAULT_CONFIG |
| `aida/kv-schema.ts` | KV read/write functions: getState, setState, getConfig, setConfig, getWbSession, setWbSession, appendLog, getLog |
| `aida/throttle.ts` | Pure throttle decision engine: `evaluateThrottle(state, config, snapshot)` -> ThrottleAction |
| `aida/time.ts` | Central Time helpers: `nowCentral()`, `todayCentral()`, `isBusinessHours()` |
| `aida/aim-control.ts` | AIM campaign control: pause, resume, setConcurrentCalls, listActiveCampaigns |
| `aida/wallboard.ts` | 3CX wallboard polling: login, queue filter polling, session caching |
| `aida/performance.ts` | Performance data computation: yesterday/WTD/MTD stats for lists and agents |

### Page Components (`app/`)
| File | Purpose |
|------|---------|
| `page.tsx` | Landing page -- card-based hub linking to /ai, /sales, /aida |
| `sales/page.tsx` | Sales dashboard UI -- queue tables, performance tab, team management |
| `ai/page.tsx` | AI voice agent dashboard -- list metrics, agent grid, cost analysis |
| `aida/page.tsx` | AIDA dashboard -- campaign status, wallboard display, action log, config controls |
| `layout.tsx` | Root layout with Plus Jakarta Sans font |

### Utility Scripts (project root)
| File | Purpose |
|------|---------|
| `seed-rebuild.js` | Full database rebuild script (re-imports all historical data) |
| `import_queue_calls.js` | CSV import for historical queue_calls data (1/1-3/23) |
| `backfill-phone-agent.js` | Backfill aim_phone_agent from historical AIM data |

### Config Files
| File | Purpose |
|------|---------|
| `vercel.json` | Cron schedules + function timeout overrides |
| `package.json` | Dependencies (Next 16, pg, @upstash/redis, React 19) |
| `tsconfig.json` | TypeScript config |
| `next.config.ts` | Next.js config |

---

## When to Use Claude Code vs Cowork

### Claude Code (this tool) -- USE FOR:
- Any backend changes: API routes, database queries, seed-refresh logic
- Data attribution logic changes (queue rules, F/B logic, triple gate)
- Postgres migrations, backfills, data fixes
- Git operations, deployments
- Complex business logic debugging (comparing API data vs DB vs dashboard)
- Creating/modifying queue rules in `applyQueueRules()`
- AIDA campaign control logic and throttle engine
- Any multi-file refactoring
- Reading/analyzing API responses

### Cowork (Chrome extension) -- USE FOR:
- Visual UI feedback (screenshot comparison)
- Testing wallboard connectivity (can see live 3CX wallboard in browser)
- Comparing what the user sees vs what the API returns
- Quick visual checks on dashboard appearance
- Browser-based debugging (console errors, network requests)
- Anything requiring real-time browser interaction

---

## Recent Changes Log

1. Added Moxy Home API integration (separate API key, `moxy_home_deals` table)
2. Added F/B (Flip/Bundle) 4-corner breakdown (Auto Flip/Bundle, Home Flip/Bundle)
3. Moved from JSON seed files to Postgres (all runtime data now in DB)
4. Added `queue_calls` table with full call detail: direction, status, first_ext, agent_name, destination
5. Added team management (Postgres-backed `teams` + `team_members` tables, CRUD via `/api/teams`)
6. Performance tab with Combined/Auto/Home toggle and per-queue D-C-% grid
7. Fixed deal dedup (customer_id + contract_no concatenation with `DISTINCT ON`)
8. Fixed status sync (ON CONFLICT DO UPDATE instead of DO NOTHING -- catches backouts)
9. Excluded 'Back Out' and 'VOID' from deal counts
10. Added CS/AI/SP deals to Additional Sales row (separated from queue breakdown)
11. Switched deal attribution from `salesperson` (closer) to `owner` (Sales Rep)
12. Added AI-FWD and Dropped call counting to sales dashboard
13. Built AIDA system with wallboard polling, throttle engine, and KV state management
14. Added `aim_phone_agent` table for phone-to-agent mapping across ALL calls (not just transfers)
15. Added `aim_phone_history` table for list tiebreaking in multi-list phones

---

## Date & Time Troubleshooting Guide (CRITICAL -- READ THIS FIRST)

This project has been plagued by date/time bugs. Every external API returns dates differently, and Postgres DATE columns drop time components, causing subtle off-by-one and timezone-shift bugs. **All new features that touch dates MUST follow these patterns.**

### Core Rule: Everything is Central Time (America/Chicago)
GPG operates in CT. All dates displayed, queried, and compared must be CT. The server (Vercel) runs in UTC. **Never use `new Date()` directly for date logic** -- always convert to CT first.

### The Timestamp-After-Date Trap
**Problem**: API responses often return dates with timestamps appended (e.g., `"4/1/2026 12:00:00 AM"`, `"2026-04-01T05:00:00.000Z"`). If you naively pass these to `new Date()`, JavaScript interprets them in UTC, which can shift the date backward by one day in CT (e.g., `2026-04-01T05:00:00Z` → March 31 in CT).

**Solution**: Always strip the time component before using the date. The `parseDate()` function in `lib/date-utils.ts` handles this:
```typescript
// parseDate("4/1/2026 12:00:00 AM") → "2026-04-01"
// parseDate("2026-04-01T05:00:00.000Z") → "2026-04-01"
// parseDate("2026-04-01") → "2026-04-01"
// parseDate(46113) → "2026-04-01" (Excel serial)
```
It splits on space first (`s.split(" ")[0]`), then on `T`, extracting just the YYYY-MM-DD portion. **Always use `parseDate()` for any date from an external API.**

### Date Range Queries: BETWEEN is Inclusive
Postgres `BETWEEN $1 AND $2` is inclusive on both ends. When the user selects "Apr 1 - Apr 5", pass `start=2026-04-01&end=2026-04-05` and the SQL `WHERE sold_date BETWEEN $1 AND $2` correctly includes both Apr 1 and Apr 5.

**Pitfall**: Moxy API's `toDate` parameter is EXCLUSIVE (it returns records up to but not including `toDate`). So to get deals through Apr 5, you must pass `toDate=2026-04-06` (the next day). The seed-refresh handles this with `tomorrowLocal()` or `addDays(date, 1)`.

### API Date Format Reference

| Source | Format Returned | Gotcha |
|--------|----------------|--------|
| **Moxy API** | `"M/D/YYYY h:mm:ss AM/PM"` (e.g., `"4/1/2026 12:00:00 AM"`) | Must strip time. The `12:00:00 AM` is meaningless filler. |
| **Moxy API dates param** | `fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD` | `toDate` is EXCLUSIVE -- pass day+1 to include the target date |
| **3CX CSV** | ISO-ish: `"2026-04-01T13:45:22"` or sometimes `"M/D/YYYY H:MM"` | Column positions vary. Always use parseDate(). |
| **AIM API** | ISO 8601: `"2026-04-01T17:30:00.000Z"` (UTC) | The Z means UTC. Strip time or convert to CT before comparing dates. |
| **Postgres DATE column** | Returns as JS Date object or `"YYYY-MM-DD"` depending on driver | When comparing in JS, always `.toISOString().slice(0,10)` or format explicitly. `date instanceof Date ? date.toISOString().slice(0,10) : String(date).slice(0,10)` |
| **Excel serial numbers** | Integer (e.g., `46113` = April 1, 2026) | `parseDate()` handles these. Base epoch is Dec 30, 1899. |

### todayLocal() and tomorrowLocal()
Both use `Intl.DateTimeFormat` with `timeZone: "America/Chicago"` and `en-CA` locale (which gives YYYY-MM-DD format). They return the correct CT date even when the server is in UTC.

```typescript
// WRONG -- gives UTC date, could be yesterday in CT after midnight UTC
const today = new Date().toISOString().slice(0, 10);

// RIGHT -- gives CT date
const today = todayLocal(); // from lib/date-utils.ts
```

### centralParts() in seed-refresh
For business-hours gating and date arithmetic in the cron job, `centralParts()` uses `Intl.DateTimeFormat` to decompose the current time into CT year/month/day/hour/minute/dow. This avoids all UTC conversion issues.

### addDays() Safety
When doing date arithmetic, always anchor at noon UTC to avoid DST boundary issues:
```typescript
function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T12:00:00Z"); // noon UTC = safe from DST
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
```

### Postgres DATE vs TIMESTAMP
- All date columns in this project are `DATE` type (no time component).
- When inserting, pass `"YYYY-MM-DD"` strings. Postgres handles it cleanly.
- When reading back, the `pg` driver may return a JS `Date` object. Always convert: `row.sold_date instanceof Date ? row.sold_date.toISOString().slice(0,10) : String(row.sold_date).slice(0,10)`
- **Never store timestamps in DATE columns** -- the time is silently dropped and you lose precision.

### Common Date Bugs We've Hit and Fixed

1. **Moxy dates shifted back one day**: Moxy returns `"4/1/2026 12:00:00 AM"`. Old code passed this to `new Date()` which interpreted it as midnight local time, then `.toISOString()` converted to UTC, shifting to previous day. **Fix**: `parseDate()` strips the time before any conversion.

2. **3CX call_date off by one**: 3CX CSV times are in CT but were being parsed as UTC. A call at 11pm CT on Apr 1 became Apr 2 in UTC. **Fix**: `parseDate()` only extracts the date portion, ignoring the time entirely.

3. **Date range returning wrong day count**: Using `new Date("2026-04-05")` creates midnight UTC, which is 7pm previous day in CT. Comparisons like `date <= endDate` could miss the last day. **Fix**: Always compare date strings (`"2026-04-05" <= "2026-04-05"`) not Date objects.

4. **Moxy toDate exclusivity**: Passing `toDate=2026-04-05` to Moxy API returns deals through Apr 4 only. **Fix**: Always add 1 day to the end date when calling Moxy: `addDays(toDate, 1)`.

5. **Stale deal statuses**: The seed-refresh cron only fetches yesterday+today. Deals from earlier in the month can have their status change (Sold→Back Out, Sold→Cancelled) without our DB knowing. **Fix**: Periodic manual re-seed for the full month (`?dates=2026-04-01,2026-04-02,...`), or the upsert `ON CONFLICT DO UPDATE SET deal_status` catches it when the same date range is re-fetched.

### Template: Safe Date Handling for New API Integrations

```typescript
import { parseDate, todayLocal } from "../../../lib/date-utils";

// 1. Get current date in CT
const today = todayLocal();

// 2. Parse any API date safely
const soldDate = parseDate(apiRecord.sold_date); // handles all formats
if (!soldDate) continue; // skip unparseable dates

// 3. Date range for queries
const fromDate = url.searchParams.get("start") ?? todayLocal();
const toDate = url.searchParams.get("end") ?? todayLocal();

// 4. For Moxy API calls (toDate is exclusive)
const moxyTo = addDays(toDate, 1);
const moxyUrl = `${MOXY_BASE}/api/GetDealLog?fromDate=${fromDate}&toDate=${moxyTo}`;

// 5. SQL queries (BETWEEN is inclusive)
const result = await query(
  `SELECT * FROM table WHERE date_col BETWEEN $1 AND $2`,
  [fromDate, toDate]
);

// 6. Reading dates back from Postgres
for (const row of result.rows) {
  const dateStr = row.call_date instanceof Date
    ? row.call_date.toISOString().slice(0, 10)
    : String(row.call_date).slice(0, 10);
}
```
