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

## Next Session — What to do first

### Immediate task (Phase 1 + 2)
1. Run DDL against Supabase `ci-phlo` project in order: `01_` → `11_`
2. Verify all 29 tables created — check in Supabase dashboard
3. Seed `COUNTRY` table (17 rows — data in `Customs_Data_Model_WCO_v3.xlsx` COUNTRY sheet)
4. Seed `HS_SECTION`, `HS_HEADING`, `HS_SUBHEADING` (WCO HS 2022 — static reference data)

### Files to load for next session
```
README:  https://raw.githubusercontent.com/phlo-systems/customs-intelligence/main/README.md
Session: https://raw.githubusercontent.com/phlo-systems/customs-intelligence/main/SESSION.md
DDL:     https://raw.githubusercontent.com/phlo-systems/customs-intelligence/main/database/ddl/01_hs_hierarchy.sql
         https://raw.githubusercontent.com/phlo-systems/customs-intelligence/main/database/ddl/02_commodity_rates.sql
```

### After DDL is deployed — Phase 3
Build the UK tariff parser (`tariff_parser/gb_parser.py`):
- Fetch from `https://www.trade-tariff.service.gov.uk/api/v2/commodities/{code}`
- Parse JSON response → CommodityCodeRow, MFNRateRow, TariffRateRow dataclasses
- Write to Supabase via REST API
- Run for HS subheadings in Chapter 20 first (frozen potato chips — our test case)
- Load `database/ddl/02_commodity_rates.sql` and `tariff_parser/PARSER.md` for this task

---

## Upcoming decisions needed
- [ ] Confirm Node.js or Python for the API server
- [ ] Confirm Azure Function vs other scheduler for sync worker
- [ ] Confirm first ERP integration: Xero (faster cert) or Acumatica (cleaner write-back)?
- [ ] Confirm paid tier pricing before Phase 5 (API auth)
