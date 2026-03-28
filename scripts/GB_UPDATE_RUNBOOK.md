# United Kingdom Tariff Data — Update Runbook

## Data Source
- **UK Trade Tariff API** — `https://www.trade-tariff.service.gov.uk/api/v2/`
- No auth required. Rate limit: ~1 req/sec
- 98 chapters, ~13,500 commodity codes (10-digit)
- Updated by HMRC — changes can happen any time (often follows Budget or trade policy updates)

## Automated Monitoring
```bash
python3 -m scripts.gb_tariff_monitor             # check API for changes
python3 -m scripts.gb_tariff_monitor --full-reload  # trigger full 98-chapter reload (~90 min)
```
The monitor checks the sections structure and sample commodities for changes. Full reload fetches all chapters via the API.

## Manual Update Scenarios

### Scenario 1: UK Budget / Autumn Statement
1. UK Budget (March) or Autumn Statement (November) may change tariff rates
2. Changes take effect on the announced date
3. UK Trade Tariff API updates within 24-48 hours
4. Run: `python3 -m scripts.gb_tariff_monitor --full-reload`

### Scenario 2: Trade Agreement Changes
1. UK signs or amends FTAs (UK-Australia, UK-NZ, CPTPP, etc.)
2. Preferential rates may change
3. The API reflects new rates automatically
4. Full reload captures all changes

### Scenario 3: Trade Remedies (Anti-Dumping)
1. UK Trade Remedies Authority (TRA) publishes measures
2. Monitor: `https://www.gov.uk/government/organisations/trade-remedies-authority`
3. Manually add to AD_MEASURE table if significant

### Scenario 4: Post-Brexit Tariff Changes
1. UK can now set tariffs independently of EU
2. UKGT (UK Global Tariff) replaces EU CET
3. Changes announced via HMRC notices
4. API updates automatically — run full reload to capture

## Key Scripts
```bash
# Full load (all 98 chapters — ~90 minutes)
python3 -m tariff_parser.gb_full_load

# Resume from a specific chapter
python3 -m tariff_parser.gb_full_load --resume-from 44

# Specific chapters only
python3 -m tariff_parser.gb_full_load --chapters 01 02 03

# Dry run (count only)
python3 -m tariff_parser.gb_full_load --dry-run
```

## Contacts & Resources
- HMRC Tariff Classification: https://www.gov.uk/trade-tariff
- UK Trade Tariff API docs: https://api.trade-tariff.service.gov.uk/
- TRA: https://www.gov.uk/government/organisations/trade-remedies-authority
- UK FTA tracker: https://www.gov.uk/government/collections/the-uks-trade-agreements
