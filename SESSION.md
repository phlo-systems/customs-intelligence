# Session Log

---

## Session: 26 Mar 2026 — Build Sprint 3

### What we built
- **GB tariff parser** — `gb_parser.py` fetches UK Trade Tariff API, 13,567 commodities loaded across all 98 chapters in ~99 minutes
- **pgvector embeddings** — 16,814 HS description vectors (5,613 international from UN Comtrade + 11,201 national), HNSW cosine index
- **3-stage classification pipeline** — cache → vector search → Claude fallback, with source badges in UI
- **Admin upload** — PDF/CSV upload, Claude AI extracts commodity codes/MFN rates/VAT, writes to DB
- **Company Profile screen** — trade insights from ERP (top 10 suppliers/customers/products/countries, all in USD with FX footnotes), editable trade details, context document upload
- **Xero connector** — OAuth2, ACCPAY + ACCREC sync, incremental sync, live FX conversion, country inference from currencies
- **Acumatica connector** — OAuth2 + client credentials, PO + SO sync, vendor/customer country resolution
- **Email connector** — Gmail + Outlook OAuth2, trade keyword search, Claude extracts structured context, accept/reject review flow
- **Alerts screen** — AI-generated alerts based on tenant profile, severity filters, expandable detail, dismiss/action buttons
- **Inline setup guides** — step-by-step instructions for all connectors directly in the UI

### Key stats
- 20+ commits in one session
- 6 frontend screens (Opportunities, Lookup, Classify, Profile, Alerts, Admin)
- 14 Edge Functions deployed
- ~30,000 commodity codes loaded (ZA + NA + GB)
- 4,832 Xero invoices synced, 2 trade emails extracted

### Issues resolved
- Supabase Edge Functions force `application/json` content-type (can't serve HTML)
- IVFFlat pgvector index didn't work after bulk load — switched to HNSW
- Xero granular scopes (post-March 2026) — `accounting.invoices.read` replaces `accounting.transactions.read`
- `tenantid` vs `tenantuid` mismatch across all ERP functions
- `ERPType` CHECK constraint needed GMAIL/OUTLOOK added
- Email OAuth callback requires GET handler (not POST)

### Next task
- **Personalised opportunity generation from profile** — use Xero/email/context data to auto-generate trade opportunities

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

## Session: 25 Mar 2026 — Build Sprint 1 + 2

### What we built
- ZA + NA tariff parser — 8,589 rows each from SARS Schedule 1 PDF (703 pages)
- `pref_rate_writer.py` — 35,946 preferential rate rows across UK-SACU-EPA, SADC-FTA, SACU-MERCOSUR, AFCFTA
- `get_landed_cost()` Postgres RPC function — 10-step landed cost calculation
- VAT seed — ZA 15% standard VAT across all 8,589 commodity codes
- TRADE_AGREEMENT seed — 6 agreements seeded
- Supabase Edge Functions deployed:
  - `POST /tariff-lookup` — full landed cost or rates-only (customs_value optional)
  - `POST /onboard` + `GET /onboard` — tenant context Layer 1
  - `GET /opportunities` — AI-enriched opportunity feed
  - `POST /enrich-opportunities` — Claude AIInsight generation
  - `POST /classify` — top 3 HS code suggestions from product description
  - `POST /classify` (confirm) — writes confirmed code to cache
- Rules engine `run_rules_engine()` — 127 opportunities generated for GTM tenant
- AI enrichment — Claude 2-3 sentence personalised insight per opportunity card
- API auth — `API_KEY` + `API_USAGE_LOG` tables, X-API-Key validation, usage logging
- Onboarding — `TENANT_CONTEXT` Layer 1 for GTM tenant
- Frontend dashboard — `ui/index.html` — Opportunities feed, Tariff Lookup, Alerts screens
- Supabase CLI installed and linked to `ci-phlo`
- GTM API key issued and integration spec sent

### Key decisions made
| Decision | What was decided | Why |
|---|---|---|
| API layer | Supabase Edge Functions (Deno) | Zero infra, 2M free invocations/month, auto-scales |
| Landed cost logic | Postgres RPC `get_landed_cost()` | All query logic close to data — no network hops |
| customs_value optional | NULL triggers rates-only mode | GTM can query before invoice value is known |
| API auth | JWT disabled, custom X-API-Key validation | New sb_publishable_ keys not yet supported by Edge runtime |
| Intelligence engine | DB rules SQL → OPPORTUNITIES, Claude enriches AIInsight separately | 99% DB, 1% AI — no live LLM on page load |
| Classifier | Claude-only for now, upgrade to pgvector Stage 1 later | Embeddings not yet populated — Claude-only is working well |
| Frontend | Standalone HTML file served locally | No framework needed for internal demo; easy to iterate |

### Data loaded (Supabase `ci-phlo`)
| Table | Rows | Notes |
|---|---|---|
| COMMODITY_CODE | 17,178 | 8,589 ZA + 8,589 NA |
| MFN_RATE | 17,178 | APPLIED, EffectiveTo=NULL |
| TARIFF_RATE | 17,178 | Summary rate table |
| VAT_RATE | 8,589 | ZA 15% standard |
| TRADE_AGREEMENT | 6 | UK-SACU-EPA, EU-SACU-EPA, EFTA-SACU, SADC-FTA, SACU-MERCOSUR, AFCFTA |
| PREFERENTIAL_RATE | 35,946 | ZA pref rates |
| API_KEY | 1 | GTM key |
| TENANT_CONTEXT | 1 | GTM tenant — Layer 1 onboarded |
| OPPORTUNITIES | 127 | All DUTY_REDUCTION, all AI-enriched |

### Live endpoints
```
POST   /functions/v1/tariff-lookup          — landed cost (full or rates-only)
POST   /functions/v1/onboard                — write tenant context
GET    /functions/v1/onboard                — read tenant context
GET    /functions/v1/opportunities          — opportunity feed
POST   /functions/v1/enrich-opportunities   — generate AIInsight per card
POST   /functions/v1/classify              — top 3 HS code suggestions
```

### API key (GTM)
```
X-API-Key: ci_live_a7f3e2b1c9d4f8a2e6b0c3d7f1a4e8b2
TenantUID: a0000000-0000-0000-0000-000000000001
```

### LAST_HASH_ZA (skip re-download if PDF unchanged)
```
LAST_HASH_ZA=06efaac9c8e554edc17f2f32de71d6631fbab592478bb5070300bc7e8e07beb2
```

### Build phases completed
| Phase | Task | Status |
|---|---|---|
| 1 | DDL deployed to Supabase ci-phlo | ✅ |
| 2 | ZA + NA data loaded — MFN, VAT, pref rates | ✅ |
| 3 | ZA tariff sync worker | ✅ |
| 4 | /v1/tariff/lookup Edge Function | ✅ |
| 5 | API auth + usage logging | ✅ |
| 6 | Onboarding → TENANT_CONTEXT Layer 1 | ✅ |
| 8 | DB rules engine → OPPORTUNITIES | ✅ |
| 9 | AI enrichment → AIInsight per card | ✅ |
| 11 | /v1/classify — Claude classification | ✅ Partial (no pgvector yet) |
| 16 | CI frontend dashboard | ✅ Partial (3 screens, no classify screen yet) |

---

## Next Session — What to do first

### Priority 1 — Add classify screen to frontend
Add a 4th screen to `ui/index.html`:
- Text input for product description
- "Classify" button → calls `POST /v1/classify`
- Shows top 3 results with confidence bars and MFN rates
- "Confirm" button on each result → calls confirm endpoint, caches the result

### Priority 2 — GB tariff parser
Build `tariff_parser/parsers/gb_parser.py`:
- Fetch from `https://www.trade-tariff.service.gov.uk/api/v2/commodities/{code}`
- Unlocks GB as an import country
- Start with Chapter 20 (same test case)

### Priority 3 — pgvector embeddings for classification
- Pre-compute embeddings for all ZA HS subheading descriptions
- Load into `HS_DESCRIPTION_EMBEDDING` table
- Upgrade `/v1/classify` to Stage 1 vector search + Stage 2 LLM re-rank

### Upcoming decisions needed
- [ ] Confirm first ERP integration: Xero (faster cert) or Acumatica (cleaner write-back)?
- [ ] NA pref rates — write PREFERENTIAL_RATE rows for NA as import country too?
- [ ] Frontend hosting — keep as local HTML or deploy to Vercel/Netlify?
- [ ] Paid tier pricing before adding payment-gated features
