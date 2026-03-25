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
| COMMODITY_CODE | 17,178 | ZA + NA only so far |
| MFN_RATE | 17,178 | |
| TARIFF_RATE | 17,178 | |
| VAT_RATE | 8,589 | ZA 15% standard |
| TRADE_AGREEMENT | 6 | UK-SACU-EPA, EU-SACU-EPA, EFTA-SACU, SADC-FTA, SACU-MERCOSUR, AFCFTA |
| PREFERENTIAL_RATE | 35,946 | ZA pref rates |
| OPPORTUNITIES | 127 | All AI-enriched with Claude |
| TENANT_CONTEXT | 1 | GTM tenant — Layer 1 |
| API_KEY | 1 | GTM key |

## Live Edge Functions
```
POST   /functions/v1/tariff-lookup         — landed cost (full or rates-only)
POST   /functions/v1/classify              — top 3 HS code suggestions + cache confirm
POST   /functions/v1/onboard              — GET/POST tenant context Layer 1
GET    /functions/v1/opportunities         — opportunity feed with AI insights
POST   /functions/v1/enrich-opportunities  — generate Claude AIInsight per card
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
| 11 | /classify — Claude classification + cache | ✅ Partial (no pgvector yet) |
| 16 | Frontend — 4 screens (Opportunities, Lookup, Classify, Alerts) | ✅ |
| **3b** | **GB tariff parser — NEXT TASK** | **⬜** |
| 10 | pgvector embeddings → HS_DESCRIPTION_EMBEDDING | ⬜ |
| 12 | Xero connector | ⬜ |
| 13 | Acumatica connector | ⬜ |
| 14 | Email connection (Gmail + Outlook) | ⬜ |
| 17 | BR, CL, ZA, AU, TH, MX parsers | ⬜ |

## NEXT TASK — GB tariff parser

Build `tariff_parser/parsers/gb_parser.py`:

**Source:** UK Trade Tariff API — `https://www.trade-tariff.service.gov.uk/api/v2/`
- No auth required
- Rate limit: 1 request/second (be polite — add sleep)
- Commodity endpoint: `GET /api/v2/commodities/{10-digit-code}`
- Headings endpoint: `GET /api/v2/headings/{4-digit-code}` — use to discover all commodities under a heading

**What to parse:**
- `commodity.data.attributes.goods_nomenclature_item_id` → CommodityCode (10-digit)
- `commodity.data.attributes.description` → NationalDescription
- MFN duty from `commodity.data.relationships.import_measures` where `measure_type.id == '103'`
- Preferential rates from measures with measure_type ids: `'142'`, `'145'`, `'146'`
- VAT from measure_type `'305'` (UK VAT — 20% standard, 0% food/children's)

**Tables to write:**
1. `COMMODITY_CODE` — (CommodityCode, CountryCode='GB')
2. `MFN_RATE` — APPLIED rate, EffectiveTo=NULL
3. `TARIFF_RATE` — summary rate table
4. `VAT_RATE` — 0% or 20% per commodity

**Start with Chapter 20** (HS heading 2004 = frozen potato products — our test case)
- Heading 2004: `GET /api/v2/headings/2004`
- This returns all commodity codes under that heading

**Follow the pattern in `tariff_parser/parsers/za_parser.py`** for how rows are
structured and written to Supabase. Use the same orchestrator pattern.

**ZA hash for reference (skip re-download):**
```
LAST_HASH_ZA=06efaac9c8e554edc17f2f32de71d6631fbab592478bb5070300bc7e8e07beb2
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
│       └── enrich-opportunities/index.ts
├── tariff_parser/
│   ├── orchestrator.py
│   ├── pref_rate_writer.py
│   ├── config/country_config.py
│   └── parsers/
│       ├── za_parser.py             ← reference implementation
│       └── gb_parser.py             ← BUILD THIS NEXT
├── ui/
│   └── index.html                   ← 4-screen frontend
└── docs/
```
