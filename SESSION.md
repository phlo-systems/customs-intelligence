# Session Log

---

## Session: 25 Mar 2026 — Initial Design Sprint

### What we built
- Complete data model — 29 tables across 9 groups (see `database/ddl/`)
- Full DDL scripts — all tables, indexes, RLS policies, DB trigger for TARIFF_RATE_HIST
- `CUSTOMS_INTELLIGENCE.md` v5.0 — complete developer reference (494 lines)
- `Customs_Data_Model_WCO_v3.xlsx` — 27 sheets with sample data and TARIFF_LOOKUP_QUERY sheet
- UI mockups — 8 screens including Dashboard, Opportunities feed, Product upload flow
- GitHub repo structure and file organisation

### Key decisions made
| Decision | What was decided | Why |
|---|---|---|
| Database | Separate Supabase project `ci-phlo` | CI is standalone — not inside GTM project |
| API keys | Phlo holds Anthropic API key — no customer BYOK for standard tier | Standard SaaS model |
| AI cost | Pre-compute AIInsight at write time — no live LLM on page load | Performance + cost |
| Opportunities | DB rules engine (SQL only) → writes cards. Claude enriches AIInsight separately | 99% DB, 1% AI |
| Classification | Stage 1 vector search (no LLM). Stage 2 LLM re-rank only if confidence < 0.90 | Cost efficiency |
| Xero write-back | Import duty as separate PO line item with dedicated account code | Correct accounting |
| Acumatica | Custom fields native — `UsrHSCode`, `UsrImportDutyPct` etc. on PO and StockItem | Cleaner than Xero |
| Email | Keyword pre-filter before Claude processes (~10–20% of emails only) | Privacy + cost |
| Email privacy | Raw email body never stored — structured extract only. Separate consent. | GDPR compliance |
| Context layers | 5 layers: onboarding → product upload → behaviour → ERP → email | Progressive enrichment |
| Natural PKs | No surrogate keys — CommodityCode + CountryCode as natural PK throughout | WTO standard codes |
| EffectiveTo | NULL = current rate. DB trigger writes TARIFF_RATE_HIST on UPDATE | Audit integrity |
| CIF vs FOB | ValuationBasis stored per country and per rate row | 8% cost difference |
| Brazil VAT | 5 taxes stack sequentially: II+IPI+PIS+COFINS+ICMS ≈ 45.75% | Cannot sum flat |

### Tables built (29 total)
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

### Countries in scope (17)
`AO` `AR` `AU` `BR` `CL` `DO` `GB` `MU` `MX` `NA` `OM` `PH` `SA` `TH` `AE` `UY` `ZA`

---

## Session: 25 Mar 2026 — Build Sprint 1

### What we built
- ZA tariff parser — full SARS Schedule 1 Part 1 PDF parsed (703 pages, 8,589 rows)
- NA tariff data — written from same SACU PDF (same 8,589 rows, `CountryCode='NA'`)
- `get_landed_cost()` — 10-step Postgres RPC function deployed to `ci-phlo`
- VAT seed — ZA standard 15% VAT seeded across all 8,589 commodity codes
- `TRADE_AGREEMENT` seed — 6 agreements: UK-SACU-EPA, EU-SACU-EPA, EFTA-SACU, SADC-FTA, SACU-MERCOSUR, AFCFTA
- `pref_rate_writer.py` — new module writing 35,946 preferential rate rows for ZA
- `orchestrator.py` updated — pref rate writer called after MFN write
- Supabase Edge Function `tariff-lookup` deployed — live REST API at `/functions/v1/tariff-lookup`
- Supabase CLI installed and linked to `ci-phlo`

### Key decisions made
| Decision | What was decided | Why |
|---|---|---|
| API layer | Supabase Edge Functions (Deno) | Zero infra, 2M free invocations/month, auto-scales |
| Landed cost logic | Postgres function `get_landed_cost()` called via RPC | All query logic close to data — no network hops |
| ZA-first strategy | Full ZA loaded before other countries | Unlocks complete import cost for any commodity into ZA |
| VAT seeding | Bulk INSERT from COMMODITY_CODE rather than parser | ZA VAT is flat 15% — faster to seed than parse |
| Pref rate writer | Separate module `pref_rate_writer.py` | Clean separation — reusable for other country parsers |
| API auth | Legacy JWT anon key for Edge Functions | New `sb_publishable_` keys not yet supported by Edge runtime |

### Data loaded (Supabase `ci-phlo`)
| Table | Rows | Notes |
|---|---|---|
| COMMODITY_CODE | 17,178 | 8,589 ZA + 8,589 NA |
| MFN_RATE | 17,178 | APPLIED rate, EffectiveTo=NULL |
| TARIFF_RATE | 17,178 | Summary rate table |
| VAT_RATE | 8,589 | ZA only — 15% standard, basis=CUSTOMS_VALUE_PLUS_DUTY |
| TRADE_AGREEMENT | 6 | UK-SACU-EPA, EU-SACU-EPA, EFTA-SACU, SADC-FTA, SACU-MERCOSUR, AFCFTA |
| PREFERENTIAL_RATE | 35,946 | ZA pref rates across 4 active agreements |

### Verified test result (GB → ZA, commodity 20041010, ZAR 10,000 CIF)
```
MFN rate:          20%
UK-SACU-EPA rate:  0%   (free under agreement)
Duty:              ZAR 0
VAT (15%):         ZAR 1,500
Total border cost: ZAR 1,500  (15%)
Total landed cost: ZAR 11,500
```

### Live endpoint
```
POST https://epytgmksddhvwziwxhuq.supabase.co/functions/v1/tariff-lookup
Authorization: Bearer <anon_jwt_key>
Content-Type: application/json

{
  "export_country": "GB",
  "import_country": "ZA",
  "commodity_code": "20041010",
  "customs_value": 10000,
  "currency": "ZAR"
}
```

### Build phases completed
| Phase | Task | Status |
|---|---|---|
| 1 | Run DDL against Supabase ci-phlo | ✅ |
| 2 | Seed static reference data (COUNTRY, VAT, trade agreements) | ✅ Partial — ZA/NA only |
| 3 | ZA + NA tariff sync worker | ✅ |
| 4 | `/v1/tariff/lookup` API endpoint (Edge Function) | ✅ |

---

## Next Session — What to do first

### Phase 5 — API auth + tenant isolation
Add API key validation to the Edge Function:
- Create `API_KEYS` table (or use Supabase's built-in key management)
- Validate `X-API-Key` header in `tariff-lookup/index.ts`
- Rate limit: 100 req/min per key
- Usage logging to `SOURCE_SYNC_JOB` or a new `API_USAGE_LOG` table

### Phase 6 — GB tariff parser
Build `tariff_parser/parsers/gb_parser.py`:
- Fetch from `https://www.trade-tariff.service.gov.uk/api/v2/commodities/{code}`
- Unlocks GB as an import country (currently only ZA/NA work as import destinations)
- Start with Chapter 20 (frozen potato products — known test case)

### Phase 7 — Onboarding + TENANT_CONTEXT Layer 1
Build the onboarding flow that populates `TENANT_CONTEXT`:
- Business type, primary HS chapters, target markets, volume range
- Required before intelligence engine can generate personalised opportunities

### Upcoming decisions needed
- [ ] API auth: custom `API_KEYS` table vs Supabase built-in key management
- [ ] Confirm first ERP integration: Xero (faster cert) or Acumatica (cleaner write-back)?
- [ ] Confirm paid tier pricing before Phase 5 (API auth)
- [ ] NA pref rates — should we also write PREFERENTIAL_RATE rows for NA import country?

### LAST_HASH_ZA (save this — skip re-download if PDF unchanged)
```
LAST_HASH_ZA=06efaac9c8e554edc17f2f32de71d6631fbab592478bb5070300bc7e8e07beb2
```
