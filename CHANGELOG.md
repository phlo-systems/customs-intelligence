# Changelog

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
