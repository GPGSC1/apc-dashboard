# Seed Architecture — APC Dashboard

## Overview
Seeds are raw data dumps with ID-only dedup. ALL filtering (opened rules, triple gate, queue rules, Fishbein exclusion) happens at display time in the API routes, NOT in the seeds.

## Current Seeds (deployed to Vercel)

### aim_seed.json (~12MB)
- **Source:** AIM call history export (DashBuild/AIM_Seed.csv)
- **Date range:** 2026-02-25 → 2026-03-18
- **Contents:**
  - `transfers[]` — 3,743 transfer records (Call ID dedup). Fields: callId, phone, listKey, agent, date, dSec, cost, direction
  - `dailyCosts{}` — Per-list per-date cost/minutes aggregated from ALL 1M+ calls (not just transfers)
  - `dailyPhones{}` — Per-date unique phone sets from ALL calls (for Gate 2 same-day check)
  - `listCosts{}` — Aggregate totals per list
- **Dedup key:** Call ID (column 12 in CSV)
- **Note:** Only transfer records stored individually. Cost/phones aggregated from all calls for size.

### tcx_seed.json (~11MB)
- **Source:** 3CX call summary report (DashBuild/3CX_Seed.csv)
- **Date range:** 2026-01-01 → 2026-03-18
- **Contents:** 119,848 calls in compact array format
- **Queues included:** Mail 1-6, Home 1/2/4/5
- **Queues EXCLUDED (for size):** CS (8004), Collections (8005), PP After hours (8008), Spanish (8000/8025), CB (8001), TO (8021/8049), Home 3 (8039), Home TO (8007)
- **Dedup key:** CallID (column 0)
- **Format:** `{ headers: [...], rows: [[callId, startTime, phone, destName, status, talkSec, queueName, inOut], ...] }`
- **To restore excluded queues:** Re-extract from DashBuild/3CX_Seed.csv without queue filter

### moxy_seed.json (~3.7MB)
- **Source:** Moxy XLS export (DashBuild/MOX_Seed.xls)
- **Date range:** 2025-01-01 → 2026-03-18
- **Contents:** 9,141 deals — ALL statuses (Sold: 6,122, Cancelled: 2,206, Back Out: 782, etc.)
- **Dedup key:** Customer ID (column 11) — unique per deal, not per customer
- **Fields:** customerId, soldDate, names, phones, promoCode, campaign, source, contractNo, dealStatus, salesperson, cancelReason, make, model, state, admin

## Source List CSVs (deployed to Vercel, ~68MB total)
Used by data/route.ts to build phoneToList map for Gate 3 attribution.
- RT.csv (24MB) — Responder list (free)
- JH022326MN.csv (12MB) — $8,000
- DG021726SC.csv (11MB) — $5,000
- BL021926BO.csv (7.4MB) — $8,000
- JL021926LP.csv (5.2MB) — $8,000
- JL022526RS.csv (4.7MB) — $6,000
- JL021926CR.csv (4MB) — $8,000

## Files on Disk but NOT in Git (.gitignore)
These are still on the local machine if needed:
- AIM_Seed.csv (210MB) — Full AIM call history, 1M+ records
- 3CX_Seed.csv (44MB) — Full 3CX report, 281K records (ALL queues)
- MOX_Seed.xls (8MB) — Full Moxy export
- Acalls/Bcalls CSVs (136MB) — Old AIM exports
- Call Summary Reports — Old 3CX reports
- aim_calls_itd.csv (192MB) — Original AIM ITD export
- sales.xls, opened.csv — Old Moxy/3CX files

## Nightly Seed Update (4 AM Central)
- Scheduled task: `nightly-seed-update`
- Script: `seed-update.js` (gitignored, lives on local machine)
- Pulls yesterday's data from AIM + 3CX APIs
- Appends to seeds with dedup
- Commits and pushes to trigger Vercel deploy
- TODO: Add Moxy seed appending

## Future Expansion
- To add new queues: re-extract from full 3CX_Seed.csv in DashBuild
- To add new campaigns: add list CSVs and update DEFAULT_LISTS in data/route.ts
- To go further back in time: export larger date ranges from AIM/3CX/Moxy
- Moxy seed goes back to Jan 2025 for non-AI campaign reporting
- 3CX seed goes back to Jan 2026 for non-AI campaign reporting
