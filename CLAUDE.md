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

## Database — 29 tables across 9 groups
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
| COMMODITY_CODE | 30,745 | ZA + NA + GB (13,567 GB) |
| MFN_RATE | 30,745 | |
| TARIFF_RATE | 30,745 | |
| VAT_RATE | 22,156 | ZA 15% standard, GB 0%/20% |
| TRADE_AGREEMENT | 6 | UK-SACU-EPA, EU-SACU-EPA, EFTA-SACU, SADC-FTA, SACU-MERCOSUR, AFCFTA |
| PREFERENTIAL_RATE | 35,946 | ZA pref rates |
| HS_DESCRIPTION_EMBEDDING | 16,814 | 5,613 international (UN Comtrade) + 11,201 national |
| OPPORTUNITIES | 127 | All AI-enriched with Claude |
| ERP_INTEGRATION | 1 | Xero OAuth2 connected (Phlo Systems Ltd) |
| TENANT_CONTEXT | 1 | GTM tenant — Layer 1 |
| API_KEY | 1 | GTM key |

## Live Edge Functions
```
POST   /functions/v1/tariff-lookup         — landed cost (full or rates-only)
POST   /functions/v1/classify              — top 3 HS code suggestions + cache confirm
POST   /functions/v1/onboard              — GET/POST tenant context Layer 1
GET    /functions/v1/opportunities         — opportunity feed with AI insights
POST   /functions/v1/enrich-opportunities  — generate Claude AIInsight per card
POST   /functions/v1/upload-tariff         — admin upload PDF/CSV, Claude extraction
GET    /functions/v1/xero-connect          — Xero OAuth2 connect + callback
POST   /functions/v1/xero-connect          — status/refresh/disconnect
POST   /functions/v1/xero-sync             — pull Xero purchase invoices
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
| 16 | Frontend — 5 screens (Opportunities, Lookup, Classify, Alerts, Admin) | ✅ |
| 3b | GB tariff parser — 13,567 commodities loaded | ✅ |
| 10 | pgvector embeddings — 16,814 vectors (UN Comtrade + national) | ✅ |
| 12 | Xero connector — OAuth2 + invoice sync | ✅ |
| -- | Admin upload screen — PDF/CSV → Claude AI extraction | ✅ |
| 13 | Acumatica connector | ⬜ |
| 14 | Email connection (Gmail + Outlook) | ⬜ |
| 17 | BR, CL, AU, TH, MX parsers (admin upload covers these) | ⬜ |

## Key scripts
```
python3 -m tariff_parser.orchestrator --country GB              # GB sync (Chapter 20 default)
python3 -m tariff_parser.orchestrator --country GB --headings 2004 2009  # specific headings
python3 -m tariff_parser.gb_full_load                           # all 98 GB chapters (~99 min)
python3 -m tariff_parser.gb_full_load --resume-from 44          # resume after failure
python3 -m tariff_parser.embedding_loader --source all          # load HS embeddings
python3 -m tariff_parser.embedding_loader --source comtrade     # international only
```

## Tariff sources by country (for future parsers)
| Country | Type | URL pattern |
|---|---|---|
| GB | API JSON | trade-tariff.service.gov.uk/api/v2/ |
| BR | API JSON | Full NCM ~50MB — hash full file then diff |
| AU/TH/MX/AR/UY | HTML scrape | Country-specific |
| ZA/NA | PDF | SARS Schedule 1 — already built |
| SA/AE/OM | HTML | GCC CET — shared tariff |
| PH | API JSON | AD investigation open on HS 2004.10 |

## Countries in scope (17)
`AO` `AR` `AU` `BR` `CL` `DO` `GB` `MU` `MX` `NA` `OM` `PH` `SA` `TH` `AE` `UY` `ZA`

## Intelligence engine design
- DB rules engine (SQL) runs after each tariff sync → writes OPPORTUNITIES + ALERTS
- Claude enriches AIInsight per opportunity card — pre-computed, not live on page load
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
├── SESSION.md
├── database/
│   ├── ddl/                         ← 01_ through 11_ SQL files
│   ├── functions/                   ← get_landed_cost.sql, run_rules_engine.sql
│   ├── seeds/                       ← seed_trade_agreements.sql, seed_za_vat.sql
│   └── auth/                        ← api_auth_setup.sql
├── supabase/
│   └── functions/
│       ├── tariff-lookup/index.ts
│       ├── classify/index.ts
│       ├── onboard/index.ts
│       ├── opportunities/index.ts
│       ├── enrich-opportunities/index.ts
│       ├── upload-tariff/index.ts   ← admin PDF/CSV upload + Claude extraction
│       ├── xero-connect/index.ts    ← Xero OAuth2 flow
│       └── xero-sync/index.ts       ← pull Xero purchase invoices
├── tariff_parser/
│   ├── orchestrator.py
│   ├── pref_rate_writer.py
│   ├── embedding_loader.py          ← HS embeddings (UN Comtrade + national)
│   ├── gb_full_load.py              ← batch load all GB chapters
│   ├── config/country_config.py
│   └── parsers/
│       ├── za_parser.py             ← ZA/NA PDF parser
│       └── gb_parser.py             ← GB API parser (13,567 commodities)
├── ui/
│   └── index.html                   ← 5-screen frontend (+ Admin tab)
└── docs/
```
