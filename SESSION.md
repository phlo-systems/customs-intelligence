# Session Log

---

## Session: 25 Mar 2026 — Database Deployment

### What we did
- Created Supabase project `ci-phlo` (eu-west-2, PhloCN org)
- Ran all 12 DDL files in order (`00_` → `11_`) — all 29 tables created successfully
- Added **India (IN)** to countries in scope — now 18 countries
- Seeded `COUNTRY` table — 18 rows, 13 CIF / 5 FOB

### Decisions made
| Decision | What was decided | Why |
|---|---|---|
| India added | `IN` added to COUNTRY — CIF, INR, CBIC | Large import market, GST complexity, growing FTA activity with UK/EU |
| India tariff source | HTML scraper — cbic.gov.in. No public API | Phase 18 alongside other HTML scrapers |
| India indirect tax | IGST stacks on BCD — 4 rates: 5/12/18/28% | Simpler than Brazil cascade but needs own VAT_RATE rows |

### Build phases completed
| Phase | Task | Status |
|---|---|---|
| 1 | Run DDL — all 29 tables | ✅ Done |
| 2 | Seed COUNTRY (18 rows) | ✅ Done |

### Countries in scope (18)
`AO` `AR` `AU` `BR` `CL` `DO` `GB` `IN` `MU` `MX` `NA` `OM` `PH` `SA` `TH` `AE` `UY` `ZA`

---

## Session: 25 Mar 2026 — Documentation & Data Model Update

### What we did
- Updated `Customs_Data_Model_WCO_v4.xlsx` — upgraded from v3.0 (21 tables, 6 groups) to v5.0 (29 tables, 9 groups)
  - Added 9 new table sheets: OPPORTUNITIES, ALERTS, TENANT_CONTEXT, TENANT_BEHAVIOUR_LOG, HS_DESCRIPTION_EMBEDDING, CLASSIFICATION_REQUEST, PRODUCT_CLASSIFICATION_CACHE, ERP_INTEGRATION, EMAIL_CONTEXT_EXTRACT
  - Deleted orphan Sheet1, updated README and DEVELOPER_NOTES headers
  - New tab colours: blue (Group 7), purple (Group 8), cyan (Group 9)
- Updated `CUSTOMS_INTELLIGENCE_1.md` — upgraded from v4.0 to v5.0
  - Added Intelligence Engine section (DB rules engine + AI enrichment pattern)
  - Added Tenant Context 5-layer section
  - Added Email Integration section (architecture, keyword filter, privacy)
  - Added /v1/opportunities and /v1/alerts to API endpoints table
  - Fixed SQL syntax: DATEADD/GETDATE → PostgreSQL NOW() - INTERVAL
  - Updated build sequence from 12 phases to 18 phases
  - Updated xlsx reference v3 → v4, architecture diagram updated

### Files changed
| File | Change |
|---|---|
| `Customs_Data_Model_WCO_v4.xlsx` | v3.0 → v5.0, 21 → 29 tables, 6 → 9 groups |
| `CUSTOMS_INTELLIGENCE_1.md` | v4.0 → v5.0, 3 new sections, SQL fixes, 18-phase build sequence |

---

## Session: 25 Mar 2026 — Initial Design Sprint

### What we built
- Complete data model — 29 tables across 9 groups (see `database/ddl/`)
- Full DDL scripts — all tables, indexes, RLS policies, DB trigger for TARIFF_RATE_HIST
- `CUSTOMS_INTELLIGENCE_1.md` v5.0 — complete developer reference
- `Customs_Data_Model_WCO_v4.xlsx` — 36 sheets with sample data and TARIFF_LOOKUP_QUERY sheet
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

### Countries in scope (18)
`AO` `AR` `AU` `BR` `CL` `DO` `GB` `IN` `MU` `MX` `NA` `OM` `PH` `SA` `TH` `AE` `UY` `ZA`

---

## Next Session — What to do first

### Immediate task (Phase 3)
Build `tariff_parser/gb_parser.py` — UK Trade Tariff API parser:
- Fetch from `https://www.trade-tariff.service.gov.uk/api/v2/commodities/{code}`
- Parse JSON → CommodityCodeRow, MFNRateRow, TariffRateRow dataclasses
- Write to Supabase via REST API
- Run for HS Chapter 20 first (frozen potato chips HS 2004.10 — our test case)

### Files to load for next session
```
README:  https://raw.githubusercontent.com/phlo-systems/customs-intelligence/main/README.md
Session: https://raw.githubusercontent.com/phlo-systems/customs-intelligence/main/SESSION.md
Ref:     https://raw.githubusercontent.com/phlo-systems/customs-intelligence/main/CUSTOMS_INTELLIGENCE_1.md
DDL:     https://raw.githubusercontent.com/phlo-systems/customs-intelligence/main/database/ddl/02_commodity_rates.sql
Parser:  https://raw.githubusercontent.com/phlo-systems/customs-intelligence/main/tariff_parser/PARSER.md
```

### India — future work notes
- **Tariff source:** CBIC HTML scraper — `cbic.gov.in`. Phase 18.
- **Indirect tax structure:** Basic Customs Duty (BCD) + IGST stacks sequentially on CIF value
  - IGST rates: 5% / 12% / 18% / 28% depending on HS chapter
  - Example HS 2004.10: BCD ~30% + IGST 12% = ~45.6% effective rate
- **Trade agreements:** UK-India FTA (UIFTA) under negotiation — monitor for preferential rates
- **Anti-dumping:** Active cases on several food/agri HS chapters — check AD_MEASURE on load

---

## Upcoming decisions needed
- [ ] Confirm Node.js or Python for the API server
- [ ] Confirm Azure Function vs other scheduler for sync worker
- [ ] Confirm first ERP integration: Xero (faster cert) or Acumatica (cleaner write-back)?
- [ ] Confirm paid tier pricing before Phase 5 (API auth)
