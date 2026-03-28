# Customs Intelligence — Claude Code Context

## Project
Standalone SaaS microservice for international commodity trade customs intelligence.
Owner: Phlo Systems Limited — saurabh.goyal@phlo.io
Repo: github.com/phlo-systems/customs-intelligence

## Stack
- **Database:** Supabase (PostgreSQL + pgvector) — project: `ci-phlo`
- **API:** Supabase Edge Functions (Deno/TypeScript)
- **Parsers:** Python 3 (tariff_parser/)
- **Frontend:** Vanilla HTML/JS (ui/index.html)
- **AI:** Anthropic Claude — Phlo holds the API key, no customer BYOK

## Supabase
- URL: `https://epytgmksddhvwziwxhuq.supabase.co`
- Service role key and anon key are in `.env` (never commit)
- Deploy edge functions: `supabase functions deploy <name> --no-verify-jwt`
- All edge functions use custom `X-API-Key` header auth (JWT disabled)

## Python env
- Run parsers from repo root: `python3 -m tariff_parser.orchestrator --country ZA`
- Dependencies in `tariff_parser/requirements.txt`
- Env vars needed: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`

## Database — 37 tables across 11 groups
```
Group 1 — HS Hierarchy:     COUNTRY, HS_SECTION, HS_HEADING, HS_SUBHEADING
Group 2 — Commodity/Rates:  COMMODITY_CODE, MFN_RATE, TARIFF_RATE, TARIFF_RATE_HIST
Group 3 — Preferences:      TRADE_AGREEMENT, PREFERENTIAL_RATE, RULES_OF_ORIGIN, ORIGIN_DOCUMENT
Group 4 — Regulatory:       REG_MEASURE, IMPORT_CONDITION, EXPORT_MEASURE, SANCTIONS_MEASURE
Group 5 — Indirect Tax:     VAT_RATE, EXCISE, AD_MEASURE, DUTY_RELIEF
Group 6 — Sync & Audit:     TARIFF_SOURCE, SOURCE_SYNC_JOB, SOURCE_SYNC_CHANGE
Group 7 — Intelligence:     OPPORTUNITIES, ALERTS, TENANT_CONTEXT, TENANT_BEHAVIOUR_LOG
Group 8 — Classification:   HS_DESCRIPTION_EMBEDDING, CLASSIFICATION_REQUEST, PRODUCT_CLASSIFICATION_CACHE
Group 9 — ERP & Email:      ERP_INTEGRATION, EMAIL_CONTEXT_EXTRACT
Group 10 — India-specific:  DRAWBACK_RATE, EXEMPTION_NOTIFICATION, EXCHANGE_RATE
Group 11 — Monitoring:      NOTIFICATION_TRACKER, CBIC_CHAPTER_SYNC, DATA_FRESHNESS
```

## Key schema rules
- PKs are natural: `(CommodityCode, CountryCode)` — no surrogate keys
- `EffectiveTo IS NULL` = currently active rate throughout all rate tables
- `TARIFF_RATE_HIST` is written exclusively by DB trigger — never write directly
- `ValuationBasis` is CIF or FOB per country — critical for landed cost accuracy
- Brazil VAT: 5 taxes (II+IPI+PIS+COFINS+ICMS) stack sequentially — never sum flat
- Always query `SANCTIONS_MEASURE` first before any landed cost calculation

## Data loaded (Supabase ci-phlo)
| Table | Rows | Notes |
|---|---|---|
| COMMODITY_CODE | ~43,000 | ZA + NA + GB (13,562) + IN (12,083) |
| MFN_RATE | ~43,000 | BCD rates per commodity per country |
| TARIFF_RATE | ~43,000 | Summary rate table |
| VAT_RATE | ~33,000 | ZA 15%, GB 0%/20%, IN IGST 0/3/5/18/28% |
| TRADE_AGREEMENT | 6 | UK-SACU-EPA, EU-SACU-EPA, EFTA-SACU, SADC-FTA, SACU-MERCOSUR, AFCFTA |
| PREFERENTIAL_RATE | 35,946 | ZA pref rates |
| HS_DESCRIPTION_EMBEDDING | 16,814 | 5,613 international (UN Comtrade) + 11,201 national |
| DRAWBACK_RATE | 2,732 | India drawback schedule (Notif 77/2023) |
| EXEMPTION_NOTIFICATION | 532 | India Notification 50/2017 BCD exemptions |
| AD_MEASURE | 10 | India anti-dumping + safeguard duties |
| EXCHANGE_RATE | 80 | Daily market rates (IN/ZA/GB/NA × 20 currencies) |
| NOTIFICATION_TRACKER | ~4 | CBIC notifications detected by monitor |
| CBIC_CHAPTER_SYNC | 97 | India chapter update timestamps for change detection |
| DATA_FRESHNESS | 6 | Per-country per-datatype staleness tracking |
| OPPORTUNITIES | ~200 | Data-driven + personalised per tenant |
| ALERTS | ~80 | Rules-engine generated (verified) + AI (tagged) |
| ERP_INTEGRATION | 3 | Xero (Phlo Systems), Acumatica (pending), Outlook |
| EMAIL_CONTEXT_EXTRACT | 2 | Outlook trade extracts |
| TENANT_CONTEXT | 8 | Multi-tenant with 5-layer context |

## Live Edge Functions
```
POST   /functions/v1/tariff-lookup         — landed cost (full or rates-only)
POST   /functions/v1/classify              — 3-stage: cache → vector → Claude
POST   /functions/v1/onboard              — GET/POST tenant context Layer 1
GET    /functions/v1/opportunities         — opportunity feed with AI insights
POST   /functions/v1/enrich-opportunities  — generate Claude AIInsight per card
POST   /functions/v1/upload-tariff         — admin upload PDF/CSV, Claude extraction
GET/POST /functions/v1/xero-connect        — Xero OAuth2 connect/callback/status
POST   /functions/v1/xero-sync             — pull Xero invoices (ACCPAY + ACCREC)
POST   /functions/v1/acumatica-connect     — Acumatica OAuth2/client-credentials
POST   /functions/v1/acumatica-sync        — pull Acumatica POs + SOs
GET/POST /functions/v1/email-connect       — Gmail/Outlook OAuth2 + extract review
POST   /functions/v1/email-sync            — scan emails, Claude extracts trade context
GET/POST /functions/v1/alerts              — trade alerts + generate (AI guardrails)
GET/POST /functions/v1/tenant-profile      — full profile + context doc upload
POST   /functions/v1/admin                — dashboard, tenants, usage, data_freshness, notifications, run_monitor
```

## GTM API key (for testing)
```
X-API-Key: ci_live_a7f3e2b1c9d4f8a2e6b0c3d7f1a4e8b2
TenantUID: a0000000-0000-0000-0000-000000000001
```

## Build phases — what's done and what's next
| Phase | Task | Status |
|---|---|---|
| 1 | DDL deployed to Supabase ci-phlo (29 tables) | ✅ |
| 2 | ZA + NA data loaded — MFN, VAT, pref rates | ✅ |
| 3 | ZA tariff sync worker (za_parser.py) | ✅ |
| 4 | tariff-lookup Edge Function | ✅ |
| 5 | API auth + usage logging | ✅ |
| 6 | Onboarding → TENANT_CONTEXT Layer 1 | ✅ |
| 8 | DB rules engine → OPPORTUNITIES | ✅ |
| 9 | AI enrichment → AIInsight per card | ✅ |
| 11 | /classify — 3-stage pipeline (cache → vector → Claude) | ✅ |
| 16 | Frontend — 6 screens (Opportunities, Lookup, Classify, Profile, Alerts, Admin) | ✅ |
| 3b | GB tariff parser — 13,567 commodities loaded | ✅ |
| 10 | pgvector embeddings — 16,814 vectors (UN Comtrade + national) | ✅ |
| 12 | Xero connector — OAuth2 + invoice sync (ACCPAY + ACCREC, USD conversion) | ✅ |
| 13 | Acumatica connector — OAuth2/client-credentials + PO/SO sync | ✅ |
| 14 | Email connector — Gmail + Outlook, Claude extract, accept/reject | ✅ |
| -- | Admin upload screen — PDF/CSV → Claude AI extraction | ✅ |
| -- | Company Profile — trade insights, context docs, ERP/email connections | ✅ |
| -- | Alerts screen — severity filters, AI-generated, dismiss/action | ✅ |
| -- | Inline setup guides for all connectors | ✅ |
| 15 | Personalised opportunity generation from profile | ✅ |
| -- | India tariff — 12,083 codes, BCD+SWS+IGST+AD+drawback+exemptions | ✅ |
| -- | GB full load — all 98 chapters, 13,562 codes | ✅ |
| -- | 7-rule SQL intelligence engine + AI alert guardrails | ✅ |
| -- | Daily monitoring cron — CBIC API, notifications, DGTR, exchange rates | ✅ |
| -- | Admin — data freshness dashboard + notification tracker | ✅ |
| -- | Compare screen — side-by-side route comparison (importer + exporter) | ✅ |
| -- | Swipe cards — Tinder-style mobile opportunity review | ✅ |
| -- | Smart HS input — type product name → autocomplete suggestions | ✅ |
| -- | Mobile responsive — 3 breakpoints, iOS tap targets | ✅ |
| -- | Multi-tenant auth (signup, per-tenant API keys) | ✅ |
| -- | ZA + GB monitors + runbooks (all 3 countries now monitored) | ✅ |
| -- | Import document requirements (43 conditions: IN 24, ZA 11, GB 8) | ✅ |
| -- | Unified daily cron — `run_daily_monitor.sh` (IN + ZA + GB + forex + rules) | ✅ |
| 17 | BR, CL, AU, TH, MX parsers (admin upload covers these) | ⬜ |
| -- | **Server deployment** — move daily cron from laptop to cloud (see below) | ⬜ |
| -- | Production hardening (Key Vault, rate limiting, monitoring) | ⬜ |
| -- | DGFT import/export policy (free/restricted/prohibited per HS) | ⬜ |
| -- | India HS embeddings for classify endpoint | ⬜ |

## Key scripts
```
# India tariff
python3 -m tariff_parser.in_full_load --pdf-dir ~/Downloads --upload-pdfs  # all 97 IN chapters
python3 -m tariff_parser.in_full_load --pdf-dir ~/Downloads --chapters 27 85  # specific chapters

# GB tariff
python3 -m tariff_parser.gb_full_load                           # all 98 GB chapters (~90 min)
python3 -m tariff_parser.gb_full_load --resume-from 44          # resume after failure

# Monitoring & updates
python3 -m scripts.india_tariff_monitor                         # daily check (CBIC + DGTR + notifications)
python3 -m scripts.india_tariff_monitor --report-only           # freshness report only
python3 -m scripts.india_chapter_updater                        # auto-update stale chapters from CBIC API
python3 -m scripts.india_chapter_updater --chapters 27 85       # force specific chapters
python3 -m scripts.exchange_rate_updater                        # fetch daily exchange rates
./scripts/run_india_monitor.sh                                  # full cron pipeline

# Existing
python3 -m tariff_parser.orchestrator --country ZA              # ZA sync
python3 -m tariff_parser.embedding_loader --source all          # load HS embeddings
```

## Tariff sources by country
| Country | Type | URL pattern | Status |
|---|---|---|---|
| IN | PDF + API | cbic.gov.in (base64-JSON PDFs), CBIC API for change detection | ✅ Built + automated |
| GB | API JSON | trade-tariff.service.gov.uk/api/v2/ | ✅ Built |
| ZA/NA | PDF | SARS Schedule 1 | ✅ Built |
| BR | API JSON | Full NCM ~50MB — hash full file then diff | ⬜ Next priority |
| AU/TH/MX/AR/UY | HTML scrape | Country-specific | ⬜ |
| SA/AE/OM | HTML | GCC CET — shared tariff | ⬜ |
| PH | API JSON | AD investigation open on HS 2004.10 | ⬜ |

## Countries in scope (19)
`AO` `AR` `AU` `BR` `CL` `CN` `DO` `GB` `IN` `MU` `MX` `NA` `OM` `PH` `SA` `TH` `AE` `UY` `ZA`

## Countries with tariff data loaded
| Country | Codes | Source | Notes |
|---|---|---|---|
| IN | 12,083 | CBIC Tariff Act PDFs (97 chapters) | BCD + SWS + IGST + AD + drawback + exemptions |
| ZA | ~17,000 | SARS Schedule 1 PDFs | MFN + VAT 15% + preferential rates (6 FTAs) |
| NA | ~17,000 | Shared with ZA (SACU) | Same tariff schedule |
| GB | 13,562 | UK Trade Tariff API (98 chapters) | MFN + VAT 0%/20% |

## Intelligence engine design
- **Layer 1 — Data-driven (SQL rules engine):** 7 rules scan real DB data after each sync
  - Rule 1: DUTY_INCREASE alerts (from TARIFF_RATE_HIST)
  - Rule 2: DUTY_REDUCTION opportunities (rate decreases)
  - Rule 3: EXPIRY_WARNING (preferential rates expiring within 90 days)
  - Rule 4: AD_INVESTIGATION (new anti-dumping/safeguard measures)
  - Rule 5: REGULATORY_CHANGE (from NOTIFICATION_TRACKER)
  - Rule 6: NEW_FTA (pref rate < MFN rate savings)
  - Rule 7: COMPETITOR_DISADVANTAGE (tenant market advantage)
- **Layer 2 — Personalised (SQL):** generate_personalised_opportunities() uses all 5 tenant context layers
  - FTA savings on tenant's actual routes, new market alternatives, competitor intel, drawback claims
  - Relevance scoring: +20 active route, +15 ERP supplier, +10 high interest
- **Layer 3 — AI-enriched (Claude):** personalised insights per card using 5-layer context
  - AI-generated alerts verified against DB before insertion (guardrails)
  - Verified = original severity; unverified = downgraded to LOW + tagged
- AI cost ~£0.002 per card
- 7 opportunity types: DUTY_REDUCTION, NEW_FTA, COMPETITOR_DISADVANTAGE, NEW_MARKET,
  EXPIRING_PREFERENCE, QUOTA_OPENED, COMPLIANCE_EASE

## Classification design
- Stage 1: vector search on HS_DESCRIPTION_EMBEDDING (pgvector, cosine similarity)
- Stage 2: Claude re-rank only when Stage 1 confidence < 0.90
- Currently Claude-only (pgvector embeddings not yet computed)
- Cache: PRODUCT_CLASSIFICATION_CACHE checked first — returns confidence=1.0

## Security rules (always follow)
- `AuthCredentialRef` and `AuthTokenRef` = Azure Key Vault secret NAME only — never the actual key
- Raw email body never stored — structured extract only (GDPR)
- OAuth scopes: read-only only — never send or modify
- `SANCTIONS_MEASURE` — never cache, always query fresh on every trade evaluation
- API keys stored hashed — never plaintext

## File structure
```
customs-intelligence/
├── CLAUDE.md                        ← you are here
├── CHANGELOG.md
├── AGENTS.md
├── vercel.json                      ← Vercel deployment config
├── database/
│   ├── ddl/                         ← 01_ through 16_ SQL files
│   │   ├── 13_drawback_rate.sql
│   │   ├── 14_tariff_monitor.sql    ← notification_tracker, cbic_chapter_sync, data_freshness
│   │   ├── 15_exchange_rate.sql
│   │   └── 16_exemption_notification.sql
│   ├── functions/
│   │   ├── get_landed_cost_optional_export.sql  ← main landed cost calc (BCD+SWS+exemptions+AD+IGST+drawback)
│   │   ├── run_rules_engine.sql                 ← 7-rule intelligence engine
│   │   ├── generate_personalised_opportunities.sql  ← profile-driven opps
│   │   └── match_hs_codes.sql
│   ├── seeds/                       ← seed_trade_agreements.sql, seed_za_vat.sql
│   └── auth/                        ← api_auth_setup.sql
├── scripts/
│   ├── india_tariff_monitor.py      ← daily cron: check CBIC API, notifications, DGTR
│   ├── india_chapter_updater.py     ← auto-download + reparse stale chapters with diff
│   ├── exchange_rate_updater.py     ← daily exchange rates from open API
│   ├── run_india_monitor.sh         ← cron wrapper (daily 6AM IST)
│   ├── INDIA_UPDATE_RUNBOOK.md      ← manual update procedures for 7 scenarios
│   └── logs/                        ← daily monitor logs
├── supabase/
│   └── functions/
│       ├── tariff-lookup/index.ts
│       ├── classify/index.ts
│       ├── onboard/index.ts
│       ├── opportunities/index.ts
│       ├── enrich-opportunities/index.ts  ← personalised AI insights (5-layer context)
│       ├── upload-tariff/index.ts   ← admin PDF/CSV upload + Claude extraction
│       ├── xero-connect/index.ts    ← Xero OAuth2 flow
│       ├── xero-sync/index.ts       ← pull Xero invoices (ACCPAY + ACCREC)
│       ├── acumatica-connect/       ← Acumatica OAuth2/client-credentials
│       ├── acumatica-sync/          ← pull Acumatica POs + SOs
│       ├── email-connect/index.ts   ← Gmail/Outlook OAuth2 + extract review
│       ├── email-sync/index.ts      ← scan emails, Claude extracts context
│       ├── alerts/index.ts          ← trade alerts + AI generation (with guardrails)
│       ├── admin/index.ts           ← dashboard, tenants, data freshness, notifications, run_monitor
│       └── tenant-profile/index.ts  ← full profile + context doc upload
├── tariff_parser/
│   ├── orchestrator.py
│   ├── pref_rate_writer.py
│   ├── embedding_loader.py          ← HS embeddings (UN Comtrade + national)
│   ├── gb_full_load.py              ← batch load all 98 GB chapters
│   ├── in_full_load.py              ← batch load all 97 IN chapters from PDFs
│   ├── config/country_config.py
│   ├── writers/db_writer.py         ← write_za_rows(), write_gb_rows(), write_in_rows()
│   └── parsers/
│       ├── za_parser.py             ← ZA/NA PDF parser
│       ├── gb_parser.py             ← GB API parser
│       ├── in_parser.py             ← India Customs Tariff Act PDF parser
│       └── in_drawback_parser.py    ← India Drawback Schedule parser
├── ui/
│   └── index.html                   ← 7-screen frontend (+ swipe view, mobile responsive)
└── docs/
```

## India landed cost stack
```
CIF Value
  + BCD (Basic Customs Duty)           ← MFN_RATE, overridden by EXEMPTION_NOTIFICATION
  + SWS (Social Welfare Surcharge)     ← 10% of BCD (computed in get_landed_cost)
  + Anti-Dumping / Safeguard Duty      ← AD_MEASURE (checked per origin country)
  + IGST (Integrated GST)             ← VAT_RATE (TaxType=GST, 0/3/5/18/28%)
  ─────────────────────────────────
  = Total Landed Cost
  - Drawback (if re-exporting)         ← DRAWBACK_RATE (% of FOB, subject to cap)
```

## Daily monitoring (cron — 6AM IST)
Pipeline: `run_daily_monitor.sh` (unified for all countries):
1. India: `india_tariff_monitor.py` → `india_chapter_updater.py` (if changes)
2. South Africa: `za_tariff_monitor.py` (checks SARS PDF headers, re-parses if changed)
3. UK: `gb_tariff_monitor.py` (checks API sections structure)
4. Exchange rates: `exchange_rate_updater.py` (20 currencies × 4 countries)
5. Rules engine: `run_rules_engine()` + `generate_personalised_opportunities()`

## Deployment
- **Frontend:** Vercel — `vercel --prod` → https://customs-intelligence.vercel.app
- **Edge Functions:** `supabase functions deploy <name> --no-verify-jwt`

## Server deployment (TODO)
Currently the daily cron runs from a laptop (macOS cron). This is unreliable —
missed jobs when laptop sleeps. Needs to move to a server.

**Options (in order of simplicity):**
1. **GitHub Actions scheduled workflow** — free, runs `run_daily_monitor.sh` on schedule,
   needs `.env` secrets as GitHub Secrets. ~5 min setup.
2. **Supabase Edge Function + pg_cron** — call a "monitor" edge function from pg_cron.
   No external server needed. Limited by edge function timeout (60s per country).
3. **Small VPS (e.g. Hetzner €4/mo)** — full cron, all scripts, logs, reliability.
   Set `CI_PROJECT_DIR` and `CI_PYTHON` env vars.
4. **Docker container on Railway/Render** — Dockerfile + cron scheduler.

**Requirements for server:**
- Python 3.12+ with pdfplumber, requests
- Access to Supabase (SUPABASE_URL, SUPABASE_SERVICE_KEY)
- Access to ANTHROPIC_API_KEY (for AI enrichment)
- Outbound HTTPS to: cbic.gov.in, sars.gov.za, trade-tariff.service.gov.uk,
  taxinformation.cbic.gov.in, dgtr.gov.in, open.er-api.com
- ~500MB disk for PDF downloads + logs
- Cron: `30 0 * * *` (daily 00:30 UTC)

**Env vars for server:**
```bash
export CI_PROJECT_DIR=/app/customs-intelligence
export CI_PYTHON=/usr/bin/python3
export SUPABASE_URL=https://epytgmksddhvwziwxhuq.supabase.co
export SUPABASE_SERVICE_KEY=<from .env>
export ANTHROPIC_API_KEY=<from .env>
```
- **Database:** Supabase (managed PostgreSQL) — DDL via `supabase db query --linked`
