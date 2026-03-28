# South Africa / SACU Tariff Data — Update Runbook

## Data Source
- **SARS Schedule 1 Part 1** — single PDF covering all 99 chapters
- URL: `https://www.sars.gov.za/wp-content/uploads/Legal/SCEA1964/Legal-LPrim-CE-Sch1P1Chpt1-to-99-Schedule-No-1-Part-1-Chapters-1-to-99.pdf`
- Also covers **Namibia** (SACU shared tariff)
- Updated irregularly by SARS — typically after budget or tariff amendments

## Automated Monitoring
```bash
python3 -m scripts.za_tariff_monitor          # check for PDF changes
python3 -m scripts.za_tariff_monitor --force-download  # force re-download + parse
```
The monitor checks HTTP headers (Last-Modified, Content-Length, ETag) against stored values. If changed, auto-downloads and re-parses.

## Manual Update Scenarios

### Scenario 1: SARS Tariff Amendment
1. SARS publishes new Schedule 1 PDF on their website
2. Monitor detects the change (or you notice via SARS mailing list)
3. Run: `python3 -m scripts.za_tariff_monitor --force-download`
4. This downloads, parses all chapters, and updates both ZA and NA

### Scenario 2: Budget Speech (February)
1. South Africa's Budget Speech (February) may announce tariff changes
2. SARS usually updates the PDF within 1-2 weeks after budget
3. Check `https://www.sars.gov.za/legal-counsel/primary-legislation/schedules/` for new PDF
4. Run force-download when new PDF appears

### Scenario 3: ITAC Tariff Investigation
1. ITAC (International Trade Administration Commission) may recommend tariff changes
2. Monitor ITAC gazette notices: `http://www.itac.org.za/`
3. Changes take effect via amendment to Schedule 1
4. SARS PDF will be updated — monitor will detect

### Scenario 4: Preferential Rate Changes (Trade Agreements)
1. ZA has 6 FTAs: UK-SACU-EPA, EU-SACU-EPA, EFTA-SACU, SADC-FTA, SACU-MERCOSUR, AfCFTA
2. Preferential rate changes come via SARS notices
3. Re-run pref rate parser: `python3 -m tariff_parser.pref_rate_writer`

## Contacts & Resources
- SARS Customs: 0800 007 277
- SARS Tariff page: https://www.sars.gov.za/legal-counsel/primary-legislation/schedules/
- ITAC: http://www.itac.org.za/
- SACU Secretariat: https://www.sacu.int/
