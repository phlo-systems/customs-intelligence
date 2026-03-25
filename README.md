# Customs Intelligence

**Product:** Standalone SaaS microservice for international commodity trade customs intelligence  
**Owner:** Phlo Systems Limited — saurabh.goyal@phlo.io  
**Repo:** github.com/phlo-systems/customs-intelligence  
**Stack:** Node.js API · Supabase (PostgreSQL + pgvector) · Azure Functions (sync worker)  
**Supabase project:** ci-phlo  

---

## What it does

1. Calculates complete landed cost for any trade (export country + import country + commodity code)
2. Classifies products into HS codes from free-text descriptions (vector search + Claude LLM)
3. Surfaces personalised trade opportunities and alerts based on the tenant's product catalogue
4. Integrates with Xero and Acumatica as marketplace add-ons
5. Connects to Gmail and Outlook to build tenant business context from trade emails
6. Provides trade feasibility data to the GTM app on demand via API

---

## How to use this repo with Claude

At the start of each session paste these two URLs:
```
README:  https://raw.githubusercontent.com/phlo-systems/customs-intelligence/main/README.md
Session: https://raw.githubusercontent.com/phlo-systems/customs-intelligence/main/SESSION.md
```

Then paste only the specific file(s) relevant to the day's task.  
Claude does not need the full codebase — only the files for the current task.

---

## File Index

### Root
| File | Purpose | Status |
|---|---|---|
| `README.md` | This file — project anchor | ✅ |
| `SESSION.md` | Running session log — what was done, what's next | ✅ |
| `CHANGELOG.md` | Decisions and changes log | ✅ |

### docs/
| File | Purpose | Status |
|---|---|---|
| `ARCHITECTURE.md` | System design, three consumer types, API overview | ✅ Designed |
| `DATA_MODEL.md` | 29 tables across 9 groups, key design decisions | ✅ Designed |
| `INTELLIGENCE.md` | Opportunities/alerts rules engine + AI enrichment | ✅ Designed |
| `CLASSIFICATION.md` | Vector search, embeddings, two-stage hybrid | ✅ Designed |
| `TENANT_CONTEXT.md` | Five context layers + AI prompt structure | ✅ Designed |
| `ERP_INTEGRATION.md` | Xero + Acumatica technical specs | ✅ Designed |
| `EMAIL_INTEGRATION.md` | Email extraction, privacy, GDPR | ✅ Designed |
| `SYNC_ARCHITECTURE.md` | Tariff polling, diff engine, change management | ✅ Designed |

### database/ddl/
| File | Tables | Status |
|---|---|---|
| `01_hs_hierarchy.sql` | COUNTRY, HS_SECTION, HS_HEADING, HS_SUBHEADING | ✅ Written |
| `02_commodity_rates.sql` | COMMODITY_CODE, MFN_RATE, TARIFF_RATE, TARIFF_RATE_HIST + trigger | ✅ Written |
| `03_preferences.sql` | TRADE_AGREEMENT, PREFERENTIAL_RATE, RULES_OF_ORIGIN, ORIGIN_DOCUMENT | ✅ Written |
| `04_regulatory.sql` | REG_MEASURE, IMPORT_CONDITION, EXPORT_MEASURE, SANCTIONS_MEASURE | ✅ Written |
| `05_indirect_tax.sql` | VAT_RATE, EXCISE, AD_MEASURE, DUTY_RELIEF | ✅ Written |
| `06_sync_audit.sql` | TARIFF_SOURCE, SOURCE_SYNC_JOB, SOURCE_SYNC_CHANGE | ✅ Written |
| `07_intelligence.sql` | OPPORTUNITIES, ALERTS, TENANT_CONTEXT, TENANT_BEHAVIOUR_LOG | ✅ Written |
| `08_classification.sql` | HS_DESCRIPTION_EMBEDDING, CLASSIFICATION_REQUEST, PRODUCT_CLASSIFICATION_CACHE | ✅ Written |
| `09_erp_email.sql` | ERP_INTEGRATION, EMAIL_CONTEXT_EXTRACT | ✅ Written |
| `10_indexes.sql` | All 16 performance indexes | ✅ Written |
| `11_rls_policies.sql` | Row Level Security — 8 tenant isolation policies | ✅ Written |

### tariff_parser/
| File | Purpose | Status |
|---|---|---|
| `PARSER.md` | Parser module spec, country configs, build sequence | ✅ Designed |
| `orchestrator.py` | Main entry point | ⬜ Not started |
| `config/country_config.py` | Per-country source config | ⬜ Not started |
| `parsers/gb_parser.py` | UK Trade Tariff API parser — build first | ⬜ Not started |

### intelligence_engine/
| File | Purpose | Status |
|---|---|---|
| `RULES.md` | SQL rules engine spec — all opportunity/alert triggers | ✅ Designed |
| `rules_engine.py` | DB rules → OPPORTUNITIES + ALERTS | ⬜ Not started |
| `enrichment.py` | Claude AI insight generation | ⬜ Not started |

### connectors/
| File | Purpose | Status |
|---|---|---|
| `xero/XERO.md` | Xero OAuth, webhooks, field mapping, write-back | ✅ Designed |
| `xero/connector.js` | Xero connector implementation | ⬜ Not started |
| `acumatica/ACUMATICA.md` | Acumatica auth, push notifications, custom fields | ✅ Designed |
| `acumatica/connector.js` | Acumatica connector implementation | ⬜ Not started |
| `email/EMAIL.md` | Email extraction, keyword filter, privacy | ✅ Designed |
| `email/gmail_connector.py` | Gmail OAuth + extraction | ⬜ Not started |
| `email/outlook_connector.py` | Outlook / Microsoft Graph + extraction | ⬜ Not started |

### api/
| File | Purpose | Status |
|---|---|---|
| `ENDPOINTS.md` | All /v1/ endpoints, request/response schemas | ✅ Designed |
| `server.js` | API entry point | ⬜ Not started |

### ui/
| File | Purpose | Status |
|---|---|---|
| `SCREENS.md` | 8 screen specs — Dashboard, Lookup, Classify, Products, Opportunities, Alerts, Admin, ERP Settings | ✅ Designed |

---

## Build Sequence

| Phase | Task | Status |
|---|---|---|
| 1 | Run DDL against Supabase ci-phlo | ⬜ |
| 2 | Seed static reference data (COUNTRY, HS hierarchy) | ⬜ |
| 3 | UK GB tariff sync worker (gb_parser.py) | ⬜ |
| 4 | `/v1/tariff/lookup` API endpoint | ⬜ |
| 5 | API auth — keys, rate limiting, tenant isolation | ⬜ |
| 6 | Onboarding flow → TENANT_CONTEXT Layer 1 | ⬜ |
| 7 | Product upload + classification → Layer 2 | ⬜ |
| 8 | DB rules engine → OPPORTUNITIES + ALERTS | ⬜ |
| 9 | AI enrichment → AIInsight per opportunity | ⬜ |
| 10 | HS embeddings → pgvector | ⬜ |
| 11 | `/v1/classify` — vector search + LLM re-ranking | ⬜ |
| 12 | Xero connector | ⬜ |
| 13 | Acumatica connector | ⬜ |
| 14 | Email connection (Gmail + Outlook) | ⬜ |
| 15 | Behavioural signals → Layer 3 | ⬜ |
| 16 | Admin panel + CI frontend | ⬜ |
| 17 | Brazil, Chile, South Africa parsers | ⬜ |
| 18 | Remaining 14 countries | ⬜ |

---

## Key Reference Files (not in this repo)
- `Customs_Data_Model_WCO_v3.xlsx` — full data model with sample data and SQL queries
- `CUSTOMS_INTELLIGENCE.md` — complete developer reference v5.0
