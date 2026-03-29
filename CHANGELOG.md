# Changelog

## [0.6.0] — 29 Mar 2026 — EU Expansion, ERP Intelligence, GTM

### Added
- **EU 27 countries** — Common External Tariff loaded for all member states (13,565 codes each, country-specific VAT 17-27%)
- **13 EU FTAs** registered (EU-UK TCA, EU-Japan EPA, EU-Korea, EU-Canada CETA, EU-Vietnam, EU-Singapore, EU-Mercosur, EU-EFTA, EU-Turkey CU, EU-SADC EPA, EU-GSP, EU-Chile, EU-Mexico, EU-Australia)
- **ERP intelligence layer** — `database/ddl/17_erp_line_item.sql` universal line item storage
- `database/functions/analyse_erp_intelligence.sql` — supplier concentration, spending trends, FX exposure alerts
- **Acumatica ROPC auth** — Resource Owner Password Credentials flow for Acumatica instances using `grant_type=password`
- Xero + Acumatica sync: persist line items to `erp_line_item`, 12-month first sync cap, deferred auto-classification
- `admin/classify_erp_items` action — deferred HS classification of ERP line items
- **13 sanctions measures** — Russia (EU/UK/US), Belarus, Iran (US/EU), North Korea (UNSC), Syria, Myanmar, Cuba, Venezuela, plus commodity-specific (Russian oil HS 2709, Russian gold HS 7108)
- **Landing page** — `ui/landing.html` with dual persona (traders + ops), pricing tiers (Free/$99/$299/Enterprise)
- **83 SEO pages** — 50 product duty pages, 73 route pages (incl. EU), 5 tool landing pages
- `ui/sitemap.xml` (131 URLs), `ui/robots.txt`, `ui/llms.txt` + `ui/llms-full.txt` for AI discoverability
- **535 import conditions** across 45 countries (12 per EU member, 8-24 per non-EU)
- Mexico: 8,122 national TIGIE codes from INEGI API

### Changed
- `supabase/functions/xero-sync/index.ts` — line item persistence, 12-month cap, deferred classify
- `supabase/functions/acumatica-sync/index.ts` — ROPC refresh, line items, 12-month cap
- `supabase/functions/acumatica-connect/index.ts` — added `connect_ropc` action
- `supabase/functions/alerts/index.ts` — ERP intelligence alerts (SUPPLIER_CONCENTRATION, SPENDING_TREND, FX_EXPOSURE)
- `supabase/functions/admin/index.ts` — added `classify_erp_items` action
- `scripts/run_daily_monitor.sh` — added ERP intelligence + deferred classify to daily cron
- `vercel.json` — routing for landing page, SEO pages, sitemap, llms.txt

### Fixed
- 260 invalid preferential rates deleted (ZA pref > MFN violations)
- EU CET data verified consistent across all 27 members
- Acumatica line item persistence: fixed `desc.substring` TypeError, unique constraint with line numbers

### Data
- 45 countries with tariff data (18 original + 27 EU)
- 523K+ commodity codes, 865K+ MFN rates, 622K+ preferential rates
- 60 trade agreements, 535 import conditions, 22 AD measures, 13 sanctions
- Acumatica connected: 452 POs, 268 SOs, 667 line items, 20 products auto-classified

---

## [0.5.0] — 28 Mar 2026 — 18-Country Expansion + Monitoring

### Added
- 18 countries loaded with national tariff data + preferential rates
- Import document requirements for all 18 countries (211 conditions)
- Anti-dumping measures: IN 10, ZA 3, BR 3, AU 2, MX 2, AR 2 (22 total)
- India preferential rates: 147,209 entries across 13 FTAs
- GB preferential rates: 141,419 entries across 13 FTAs (from UK Tariff SQLite)
- MERCOSUR + Chile preferential rates (BR/AR/UY/CL ~120K entries)
- Unified daily cron `scripts/run_daily_monitor.sh` for all countries
- `scripts/country_monitors.py` — monitor for 11 additional countries

---

## [0.4.0] — 26 Mar 2026 — Build Sprint 3

### Added
- `tariff_parser/parsers/gb_parser.py` — UK Trade Tariff API parser (13,567 commodities)
- `tariff_parser/gb_full_load.py` — batch loader for all 98 GB chapters
- `tariff_parser/embedding_loader.py` — HS description embeddings (UN Comtrade + national)
- `database/functions/match_hs_codes.sql` — pgvector cosine similarity search (HNSW index)
- `supabase/functions/upload-tariff/index.ts` — admin PDF/CSV upload + Claude AI extraction
- `supabase/functions/xero-connect/index.ts` — Xero OAuth2 (connect, callback, status, refresh, disconnect)
- `supabase/functions/xero-sync/index.ts` — pull ACCPAY + ACCREC, USD conversion, FX rates
- `supabase/functions/acumatica-connect/index.ts` — Acumatica OAuth2 + client credentials
- `supabase/functions/acumatica-sync/index.ts` — pull POs + SOs, vendor/customer country resolution
- `supabase/functions/email-connect/index.ts` — Gmail + Outlook OAuth2 + extract accept/reject
- `supabase/functions/email-sync/index.ts` — trade email scan, Claude extraction to EMAIL_CONTEXT_EXTRACT
- `supabase/functions/alerts/index.ts` — trade alerts with AI generation
- `supabase/functions/tenant-profile/index.ts` — full profile + context document upload
- Profile screen — trade insights (suppliers, customers, products, countries in USD), ERP/email connections, context doc upload
- Alerts screen — severity filters, expandable cards, dismiss/action buttons
- Admin screen — tariff document upload with Claude extraction
- Source badge on classify results (Vector / AI / Cached)
- Inline setup guides for all connectors (Xero, Acumatica, Gmail, Outlook)

### Changed
- `supabase/functions/classify/index.ts` — 3-stage pipeline: cache → pgvector → Claude
- `tariff_parser/orchestrator.py` — added GB parser + --headings CLI flag
- `tariff_parser/writers/db_writer.py` — added write_gb_rows() for GB data
- `tariff_parser/requirements.txt` — added openai dependency

### Data
- 13,567 GB commodity codes loaded (all 98 chapters)
- 16,814 HS description embeddings (5,613 international + 11,201 national)
- Xero connected: Phlo Systems Ltd (4,832 invoices, 7,476 line items)
- Outlook connected: trade email scanning active
- Trade insights: top suppliers/customers/products/countries in USD with FX footnotes
- AI-generated trade alerts

---

## [0.3.0] — 25 Mar 2026 — Build Sprint 2

### Added
- `supabase/functions/opportunities/index.ts` — GET opportunities feed endpoint
- `supabase/functions/enrich-opportunities/index.ts` — Claude AIInsight generation
- `supabase/functions/classify/index.ts` — top 3 HS code classification via Claude
- `supabase/functions/onboard/index.ts` — tenant onboarding GET + POST
- `database/functions/run_rules_engine.sql` — 7-rule DB intelligence engine
- `ui/index.html` — frontend dashboard (Opportunities, Tariff Lookup, Alerts)

### Changed
- `supabase/functions/tariff-lookup/index.ts` — `customs_value` now optional (rates-only mode)
- `database/functions/get_landed_cost.sql` — v2, supports NULL customs_value

### Data
- 127 OPPORTUNITIES generated for GTM tenant
- All 127 enriched with Claude AIInsight
- 1 TENANT_CONTEXT row (GTM, Layer 1)
- 1 API_KEY row (GTM)

---

## [0.2.0] — 25 Mar 2026 — Build Sprint 1

### Added
- `tariff_parser/parsers/za_parser.py` — SARS Schedule 1 PDF parser
- `tariff_parser/pref_rate_writer.py` — preferential rate writer
- `supabase/functions/tariff-lookup/index.ts` — Edge Function REST API
- `database/functions/get_landed_cost.sql` — 10-step Postgres RPC function
- `database/seeds/seed_trade_agreements.sql` — 6 ZA trade agreements
- `database/seeds/seed_za_vat.sql` — ZA 15% standard VAT
- `database/auth/api_auth_setup.sql` — API_KEY + API_USAGE_LOG tables

### Changed
- `tariff_parser/orchestrator.py` — added pref rate writer call

### Data loaded
- 17,178 COMMODITY_CODE rows (ZA + NA)
- 17,178 MFN_RATE rows
- 17,178 TARIFF_RATE rows
- 8,589 VAT_RATE rows (ZA)
- 6 TRADE_AGREEMENT rows
- 35,946 PREFERENTIAL_RATE rows

---

## [0.1.0] — 25 Mar 2026 — Initial design sprint
- Complete 29-table data model designed across 9 groups
- Full DDL scripts written and split by group
- CUSTOMS_INTELLIGENCE.md v5.0 completed
- Customs_Data_Model_WCO_v3.xlsx with sample data and queries
- UI mockups designed — 8 screens
- GitHub repo structure established
- Intelligence engine design: DB rules + AI enrichment pattern
- Tenant context: 5-layer progressive enrichment design
- ERP connectors: Xero + Acumatica specs
- Email integration: Gmail + Outlook extraction design
