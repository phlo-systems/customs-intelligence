# India Tariff Data — Update Runbook

> This runbook is for human operators who need to update India customs data
> when the automated monitor detects changes or when manual intervention is required.

---

## Quick Reference — Scripts

```bash
# Load environment
export $(grep -v '^#' .env | xargs)

# Daily monitoring (run this first)
python3 -m scripts.india_tariff_monitor

# Auto-update stale chapters (safe — only touches chapters flagged STALE)
python3 -m scripts.india_chapter_updater

# Force-update specific chapters
python3 -m scripts.india_chapter_updater --chapters 1 28 72

# Re-parse all chapters from local PDFs
python3 -m tariff_parser.in_full_load --pdf-dir ~/Downloads --upload-pdfs

# Re-parse specific chapters
python3 -m tariff_parser.in_full_load --pdf-dir ~/Downloads --chapters 1 28

# Dry-run (no DB writes)
python3 -m scripts.india_chapter_updater --dry-run
```

---

## Scenario 1: New CBIC Tariff Notification (BCD Rate Change)

**Trigger:** Monitor detects new `XX/YYYY-Customs` notification, or you see it on `taxinformation.cbic.gov.in`

**Steps:**
1. Read the notification text — it will say something like:
   *"In Notification No. 50/2017-Customs, in the Table, against S.No. 345, for the entry in column (4), the entry '7.5%' shall be substituted"*
2. Identify the affected HS codes and new rates
3. If the notification amends the **tariff schedule itself** (chapter PDFs updated on cbic.gov.in):
   ```bash
   python3 -m scripts.india_chapter_updater --chapters <affected chapters>
   ```
4. If it's an **exemption notification** (like 50/2017 amendments) — these override the standard BCD:
   - Note the affected codes and concessional rates
   - Currently no table for exemption notifications — update MFN_RATE directly or log for future schema update
5. Mark the notification as APPLIED in the admin dashboard

**Priority:** CRITICAL if it amends Notification 50/2017

---

## Scenario 2: New Anti-Dumping / Safeguard Duty

**Trigger:** Monitor detects new DGTR case or CBIC ADD notification

**Steps:**
1. Read the notification for: product name, HS codes, exporting countries, duty amount, duration
2. Insert into AD_MEASURE table:
   ```sql
   INSERT INTO ad_measure (commoditycode, importcountrycode, exportingcountrycode,
     exportername, measuretype, adratetype, adrate, specificamt, specificuom,
     adstatus, definitivefrom, sunsetreviewdate, investigatingbody, adcaseref, notes)
   VALUES ('HSCODE', 'IN', 'CN', 'Producer name', 'ANTI_DUMPING', 'SPECIFIC',
     NULL, 121.55, 'USD/MT', 'DEFINITIVE', '2025-01-01', '2030-01-01',
     'DGTR', 'XX/2025-Customs (ADD)', 'Description of the measure');
   ```
3. Mark notification as APPLIED

**Priority:** HIGH

---

## Scenario 3: Exchange Rate Update (Fortnightly)

**Trigger:** New Customs (NT) notification with exchange rates

**Steps:**
1. Check `https://foservices.icegate.gov.in/#/services/viewExchangeRate`
2. Note the new rates for USD, EUR, GBP, JPY, etc.
3. Currently no EXCHANGE_RATE table — log the notification and note rates for manual reference
4. **Future:** Build EXCHANGE_RATE table and auto-scraper

**Priority:** HIGH (affects all CIF calculations)

---

## Scenario 4: GST/IGST Rate Change

**Trigger:** GST Council meeting followed by IGST (Rate) notification

**Steps:**
1. Read the notification to identify affected HS codes and new IGST rates
2. Update VAT_RATE table:
   ```bash
   # For bulk chapter-level changes, update the chapter mapping in the monitor script
   # and re-run the IGST loader
   ```
3. For specific heading-level changes:
   ```sql
   UPDATE vat_rate SET rate = 18.0, taxcategory = 'STANDARD',
     legalbasis = 'Notification XX/2025-IGST(Rate)'
   WHERE commoditycode = 'HSCODE' AND countrycode = 'IN' AND taxtype = 'GST';
   ```
4. Update data_freshness table with new sync timestamp

**Priority:** HIGH

---

## Scenario 5: Drawback Schedule Update (Annual)

**Trigger:** New Customs (NT) notification (typically Oct/Nov each year)

**Steps:**
1. Download the new drawback schedule PDF from CBIC
2. Re-run the drawback parser:
   ```bash
   python3 -c "
   from tariff_parser.parsers.in_drawback_parser import INDrawbackParser
   # ... parse and upload (see in_full_load.py for pattern)
   "
   ```
3. Or use the admin upload screen to upload the PDF and trigger extraction

**Priority:** MEDIUM (annual update)

---

## Scenario 6: Budget Day (February 1)

**Trigger:** Union Budget presentation

**Steps:**
1. **Block 2 hours** after budget speech
2. Watch for Finance Bill provisions — these take immediate effect
3. Expect multiple simultaneous changes:
   - BCD rate changes (new tariff notifications)
   - New exemptions or withdrawal of exemptions
   - New cess or surcharge
   - Anti-dumping/safeguard changes
4. Process each notification type per the scenarios above
5. CBIC usually uploads updated chapter PDFs within 1-2 weeks — run auto-updater after that

**Priority:** CRITICAL (all-hands)

---

## Scenario 7: DGFT Import/Export Policy Change

**Trigger:** DGFT Notification or Public Notice

**Steps:**
1. Read the notification — identifies HS codes changing from Free → Restricted → Prohibited or vice versa
2. Currently maps to REG_MEASURE and IMPORT_CONDITION tables
3. Insert appropriate regulatory measures:
   ```sql
   INSERT INTO reg_measure (commoditycode, countrycode, measuretype,
     measuredescription, licencerequired, isprohibited, effectivefrom, legalbasis)
   VALUES ('HSCODE', 'IN', 'IMPORT_LICENCE', 'Restricted — DGFT licence required',
     TRUE, FALSE, '2025-01-01', 'DGFT Notification XX/2025');
   ```
4. Mark notification as APPLIED

**Priority:** HIGH (can block imports overnight)

---

## Data Freshness Checks

Run this to see what's stale:
```bash
python3 -m scripts.india_tariff_monitor --report-only
```

Or check the admin dashboard → Data Freshness section.

### Expected Update Frequencies
| Data Type | Expected Frequency | Stale After |
|---|---|---|
| BCD Rates | On notification (anytime) | 30 days |
| IGST Rates | On GST Council decision | 90 days |
| Drawback | Annual (Sep/Oct) | 365 days |
| Anti-Dumping | Weekly new cases | 7 days |
| Exchange Rates | Fortnightly | 15 days |
| Chapter PDFs | On notification | 30 days |

---

## Contacts & Resources
- CBIC Help: 1800-1200-232
- CBIC Portal: https://taxinformation.cbic.gov.in/
- DGTR: https://www.dgtr.gov.in/
- DGFT: https://www.dgft.gov.in/
- ICEGATE: https://www.icegate.gov.in/
