# Changelog

## [0.2.0] — 25 Mar 2026 — Build Sprint 1

### Added
- `tariff_parser/parsers/za_parser.py` — SARS Schedule 1 PDF parser (703 pages, 8,589 rows)
- `tariff_parser/pref_rate_writer.py` — preferential rate writer for all 6 ZA pref columns
- `supabase/functions/tariff-lookup/index.ts` — Edge Function REST API for landed cost
- `database/functions/get_landed_cost.sql` — 10-step Postgres RPC function
- `database/seeds/seed_trade_agreements.sql` — 6 ZA trade agreements seeded
- `database/seeds/seed_za_vat.sql` — ZA 15% standard VAT across all commodity codes

### Changed
- `tariff_parser/orchestrator.py` — added pref rate writer call after MFN write

### Data loaded to Supabase `ci-phlo`
- 17,178 COMMODITY_CODE rows (ZA + NA)
- 17,178 MFN_RATE rows
- 17,178 TARIFF_RATE rows
- 8,589 VAT_RATE rows (ZA)
- 6 TRADE_AGREEMENT rows
- 35,946 PREFERENTIAL_RATE rows (ZA)

### Infrastructure
- Supabase CLI installed and linked to `ci-phlo`
- Edge Function `tariff-lookup` deployed and live
- Live endpoint: `POST https://epytgmksddhvwziwxhuq.supabase.co/functions/v1/tariff-lookup`

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
