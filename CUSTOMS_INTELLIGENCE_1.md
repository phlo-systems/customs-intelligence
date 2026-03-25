# Customs Intelligence Module

**Module:** `customs_intelligence`  
**Platform:** tradePhlo / Omni GTM / ERP Add-on  
**Version:** v4.0  
**Last Updated:** March 2026  
**Owner:** Phlo Systems Limited  
**Contact:** saurabh.goyal@phlo.io

---

## Overview

Customs Intelligence (CI) is a **standalone SaaS microservice** that:

1. Provides complete customs and regulatory cost estimates for international commodity trades
2. Classifies products into the correct HS / commodity codes from free-text descriptions
3. Integrates with ERP systems (Xero, Acumatica and others) as a marketplace add-on
4. Provides trade feasibility data to the GTM app on demand via API
5. Can be sold as a standalone subscription with its own frontend

The output is a complete **landed cost** for any trade broken down into all duty, tax, regulatory and documentation components.

Border logistics costs (freight, THC, demurrage) are handled by the **`logistics_intelligence`** module and combined at the application layer.

---

## Architecture — Three Consumer Types

```
┌──────────────────────────────────────────────────────────────┐
│  CUSTOMS INTELLIGENCE  (Supabase project: ci-phlo)           │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Unified REST API  (versioned — /v1/)               │    │
│  └─────────────────────────────────────────────────────┘    │
│         │                  │                  │              │
│         ▼                  ▼                  ▼              │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │  GTM App    │  │  CI Frontend │  │  ERP Connectors  │   │
│  │  (trade     │  │  (standalone │  │  Xero connector  │   │
│  │  feasibility│  │   product)   │  │  Acumatica conn. │   │
│  └─────────────┘  └──────────────┘  └──────────────────┘   │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Sync Worker  (Azure Function — daily tariff poll)  │    │
│  └─────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

Each consumer calls the same CI API with an API key. The connectors are thin adapters — the core API does not change per ERP.

---

## API Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/tariff/lookup` | POST | Core landed cost — export/import country + commodity code |
| `/v1/classify` | POST | AI commodity classification from product description |
| `/v1/commodity/search` | GET | Search HS codes by keyword or code |
| `/v1/commodity/{code}/rates` | GET | All rates for a code across countries |
| `/v1/countries` | GET | Supported jurisdictions |
| `/v1/updates/feed` | GET | Recent tariff changes — filterable by country and date |
| `/v1/sanctions/check` | POST | Sanctions check only — fastest endpoint, run as pre-check |
| `/v1/health` | GET | Sync job status — admin only |

### Authentication
- API key per tenant in `X-API-Key` header
- Usage metered per call: £0.10/lookup, £0.50/classification
- Rate limiting per API key
- Query logging includes TenantID for usage reporting

---

## Two Trade Scenarios

### Scenario A — Existing Product (classification already known)

GTM or ERP has a confirmed commodity code. CI runs the tariff lookup directly — no classification needed:

```javascript
// GTM / ERP → CI
POST /v1/tariff/lookup
{
  "commodity_code":   "2004100010",
  "export_country":   "GB",
  "import_country":   "BR",
  "goods_value":      10000,
  "valuation_basis":  "FOB"
}
// CI returns full landed cost JSON immediately
```

### Scenario B — New Product (description only, no classification)

GTM or ERP has a product description but no code. CI classifies first, then the trader confirms before lookup:

```javascript
// Step 1 — Classify
POST /v1/classify
{
  "description":    "frozen pre-fried potato strips 10mm food service",
  "export_country": "GB",
  "import_country": "BR"
}
// Returns top 3 HS code suggestions with confidence + reasoning

// Step 2 — Trader selects code, then:
POST /v1/tariff/lookup   // same as Scenario A
```

---

## AI Classification Engine

### Two-Stage Hybrid Approach

**Stage 1 — Vector similarity search (< 100ms):**
All HS subheading descriptions are pre-computed as vector embeddings stored in Supabase pgvector. The product description is embedded on each request and cosine similarity search returns the top 10 candidates. Handles ~80% of standard commodity descriptions well.

**Stage 2 — LLM re-ranking (< 2s, only when Stage 1 confidence < 0.90):**
Top 10 candidates passed to Claude with the original description. Claude ranks the top 3 and provides classification reasoning referencing WCO chapter notes. Returns explainable results — the trader can see why CI suggested that code.

### Confidence Thresholds

| Confidence | Action |
|---|---|
| > 0.90 | Single recommendation returned |
| 0.70 – 0.90 | Top 3 returned with reasoning — trader selects |
| < 0.70 | Flagged as needing expert review |

### Tenant Learning Layer
Every confirmed classification is stored in `PRODUCT_CLASSIFICATION_CACHE` per tenant. Next time the same description arrives for that tenant CI returns the cached result instantly with `confidence = 1.0`. GTM's existing product master is a free source of confirmed pairings — every existing product enriches the cache on first use.

### ClassificationType Values

| Value | Meaning |
|---|---|
| `EXISTING_PRODUCT` | Matched from GTM product master or cache — confidence 1.0 |
| `AI_INFERRED` | Stage 1 or Stage 2 AI suggestion — confidence varies |
| `MANUAL_OVERRIDE` | Trader overrode AI suggestion |

---

## Database — 21 Core Tables + 4 Classification/ERP Tables

Full table definitions with sample data and SQL in `Customs_Data_Model_WCO_v3.xlsx`.

### Classification Tables (new — not in v3 Excel)

#### `HS_DESCRIPTION_EMBEDDING`
Pre-computed vector embeddings for semantic search.

```sql
CREATE TABLE HS_DESCRIPTION_EMBEDDING (
    SubheadingCode   VARCHAR(10)   NOT NULL,  -- FK → HS_SUBHEADING
    HSVersion        VARCHAR(10)   NOT NULL,
    CountryCode      VARCHAR(2),              -- NULL = global WCO
    DescriptionText  TEXT          NOT NULL,
    Embedding        vector(1536)  NOT NULL,  -- Supabase pgvector
    EmbeddingModel   VARCHAR(50)   NOT NULL,
    ComputedAt       TIMESTAMPTZ   NOT NULL,
    PRIMARY KEY (SubheadingCode, HSVersion, CountryCode)
);
CREATE INDEX ON HS_DESCRIPTION_EMBEDDING
    USING ivfflat (Embedding vector_cosine_ops);
```

#### `CLASSIFICATION_REQUEST`
Audit trail of every classify call — feeds accuracy feedback loop.

```sql
CREATE TABLE CLASSIFICATION_REQUEST (
    RequestID              BIGSERIAL    PRIMARY KEY,
    TenantID               UUID         NOT NULL,
    ERPSource              VARCHAR(20),     -- XERO / ACUMATICA / GTM / API / CI_FRONTEND
    ProductDescription     TEXT         NOT NULL,
    NormalisedDescription  TEXT         NOT NULL,
    RequestedAt            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    ResponseTimeMs         INTEGER,
    ModelUsed              VARCHAR(50),
    TopSuggestionCode      VARCHAR(15),
    TopConfidence          DECIMAL(5,4),
    ClassificationType     VARCHAR(20),     -- EXISTING_PRODUCT / AI_INFERRED / MANUAL_OVERRIDE
    UserSelectedCode       VARCHAR(15),     -- NULL until trader confirms
    FeedbackCorrect        BOOLEAN          -- NULL until confirmed
);
```

#### `PRODUCT_CLASSIFICATION_CACHE`
Per-tenant confirmed description → code mappings.

```sql
CREATE TABLE PRODUCT_CLASSIFICATION_CACHE (
    CacheID               BIGSERIAL    PRIMARY KEY,
    TenantID              UUID         NOT NULL,
    ProductDescription    TEXT         NOT NULL,
    NormalisedDescription TEXT         NOT NULL,
    SubheadingCode        VARCHAR(10)  NOT NULL,
    CommodityCode         VARCHAR(15),
    ConfirmedBy           VARCHAR(20)  NOT NULL,  -- EXISTING_PRODUCT / TRADER_CONFIRMED / ADMIN_VERIFIED
    ConfirmedAt           TIMESTAMPTZ  NOT NULL,
    UseCount              INTEGER      NOT NULL DEFAULT 1,
    LastUsedAt            TIMESTAMPTZ  NOT NULL,
    UNIQUE (TenantID, NormalisedDescription)
);
```

#### `ERP_INTEGRATION`
One row per connected ERP tenant.

```sql
CREATE TABLE ERP_INTEGRATION (
    IntegrationID   BIGSERIAL    PRIMARY KEY,
    TenantID        UUID         NOT NULL,
    ERPType         VARCHAR(20)  NOT NULL,     -- XERO / ACUMATICA / SAGE / NAV / SAP
    ERPTenantID     VARCHAR(255) NOT NULL,     -- ERP's own org/tenant identifier
    AuthTokenRef    VARCHAR(255) NOT NULL,     -- Azure Key Vault reference ONLY — never store token
    WebhookURL      TEXT,                      -- ERP endpoint for CI to push results back
    MappingConfig   JSONB,                     -- field mapping rules
    SyncEnabled     BOOLEAN      NOT NULL DEFAULT TRUE,
    LastSyncAt      TIMESTAMPTZ,
    IsActive        BOOLEAN      NOT NULL DEFAULT TRUE,
    CreatedAt       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

---

## Core Table Reference

### Group 1 — HS Hierarchy (static, tab: teal)

| Table | PK | Notes |
|---|---|---|
| `COUNTRY` | `CountryCode` | Includes `ValuationBasis` (CIF/FOB) — critical for landed cost |
| `HS_SECTION` | `SectionCode` | WCO Sections I–XXI |
| `HS_HEADING` | `HeadingCode` | 4-digit |
| `HS_SUBHEADING` | `(SubheadingCode, HSVersion)` | Insert new rows for HS 2028 — never update |

### Group 2 — Commodity & Rates (tab: pink)

| Table | PK | Notes |
|---|---|---|
| `COMMODITY_CODE` | `(CommodityCode, CountryCode)` | No surrogate key |
| `MFN_RATE` | `(CommodityCode, CountryCode, RateCategory, EffectiveFrom)` | APPLIED / BOUND / TRQ — see below |
| `TARIFF_RATE` | `(CommodityCode, CountryCode, EffectiveFrom)` | Summary — `EffectiveTo IS NULL` = current |
| `TARIFF_RATE_HIST` | `HistoryID` (auto) | DB trigger only — app never writes here |

**CIF vs FOB:** UK/EU = CIF. Americas (BR/AR/MX/UY) = FOB. At 14.4% on $10,800 CIF vs $10,000 FOB: $1,555 vs $1,440 — an 8% difference. Always capture `ValuationBasis` correctly.

**MFN RateCategory:** `APPLIED` (current charged rate) / `BOUND` (WTO ceiling — Applied ≤ Bound always) / `TRQ_IN_QUOTA` / `TRQ_OUT_QUOTA`

**DutyBasisType:** `AD_VALOREM` (% of value) / `SPECIFIC` (fixed per kg/unit) / `COMPOUND` (both) / `MIXED` (higher of)

### Group 3 — Preferences (tab: green)

Always check all four tables in sequence — finding a rate in `PREFERENTIAL_RATE` is not enough, goods must qualify under `RULES_OF_ORIGIN`:

```
TRADE_AGREEMENT → PREFERENTIAL_RATE → RULES_OF_ORIGIN → ORIGIN_DOCUMENT
```

**Origin criteria:** `WO` (wholly obtained) / `CTH` (change in 4-digit heading) / `CTSH` (change in subheading) / `RVC` (regional value content %) / `SP` (sufficient processing)

### Group 4 — Regulatory (tab: amber/red)

**Always query `SANCTIONS_MEASURE` first.** If `IsActive = Y` → stop, escalate. Administering bodies: OFAC / OTSI / EU CFSP / UNSC.

**IMPORT_CONDITION NTM codes:** A11=phytosanitary / A14=fumigation / B31=labelling / B32=ISPM 15 packaging / C1=pre-shipment inspection. `TimingRequirement`: `PRE_SHIPMENT` / `AT_BORDER` / `POST_ARRIVAL`.

### Group 5 — Indirect Tax (tab: olive)

**Brazil cascade — calculate sequentially, NOT as flat sum:**
```
II (16% FOB) + IPI (0%) + PIS (2.1%) + COFINS (9.65%) + ICMS (18% of total) ≈ 45.75%
```

**AD_MEASURE:** Stacks on top of MFN. `ExporterName = NULL` = country residual. Safeguard: `ExportingCountryCode = NULL` = all origins. ADStatus: `INVESTIGATION → PROVISIONAL → DEFINITIVE → REVIEW → EXPIRED`.

**DUTY_RELIEF types:** `IPR` (process + re-export) / `CW` (warehouse = defer) / `TA` (temp admission) / `EUR` (end use) / `OPR` (outward processing)

### Group 6 — Sync & Audit (tab: orange)

`TARIFF_SOURCE.AuthCredentialRef` = Azure Key Vault secret name only. `AutoApplyThresholdPct` default 5.0 — changes above this + NEW_CODE/DELETED_CODE always → `PENDING_REVIEW`.

---

## ERP Integration Layer

### What Each Connector Does

ERP connectors are **thin adapters** that do three things only:
1. **Map inbound** — extract product/PO fields from ERP format → CI API request
2. **Bridge auth** — ERP user authorises via ERP OAuth → connector exchanges for CI API key
3. **Write back** — CI response fields → ERP record fields

### ERP Trigger Events

| ERP Event | CI Action |
|---|---|
| New Item / Product created | Auto-classify → suggest HS code |
| Purchase Order created (foreign supplier) | Run tariff lookup → return landed cost |
| Supplier invoice received (import) | Validate duty paid matches CI estimate |
| New supplier added (foreign country) | Flag regulatory requirements for origin |

---

## Xero Connector

### Key Facts

| Property | Detail |
|---|---|
| Auth | OAuth 2.0 — Authorization Code Flow |
| API base | `https://api.xero.com/api.xro/2.0/` |
| Webhooks | HMAC-SHA256 signed — respond within 5 seconds with HTTP 200 |
| Rate limits | 5 concurrent / 60 per minute / 5,000 per day |
| Marketplace | Xero App Store |
| Scopes (post Mar 2026) | Granular — `accounting.transactions`, `accounting.settings` |
| SDK | Official: Python, Node.js, PHP, .NET, Java |

### Webhook Events to Subscribe

```json
{
  "events": [
    "com.xero.purchaseorder.created",
    "com.xero.purchaseorder.updated",
    "com.xero.item.created",
    "com.xero.item.updated"
  ]
}
```

### Key Xero Objects

| Object | Endpoint | CI Use |
|---|---|---|
| `Items` | `/Items` | Product catalogue — trigger classify on new item |
| `PurchaseOrders` | `/PurchaseOrders` | Trigger tariff lookup on PO creation |
| `Contacts` | `/Contacts` | Get supplier country for `export_country` |
| `Accounts` | `/Accounts` | Map duty cost to correct Xero account code |
| `TrackingCategories` | `/TrackingCategories` | Store HS code as tracking dimension |

### Data Mapping — Xero PO → CI Request

```json
{
  "commodity_code":   "LineItems[0].ItemCode",
  "export_country":   "Contact.Addresses[POBOX].Country",
  "import_country":   "from Xero org settings (COUNTRY)",
  "goods_value":      "LineItems[0].UnitAmount × LineItems[0].Quantity"
}
```

### Writing CI Results Back to Xero

Xero has no native import duty fields. Recommended approach — **add duty as a separate PO line item** with a dedicated `ImportDuty` account code. This creates a proper accounting entry that flows through to P&L correctly.

### Xero OAuth Flow

```
1. User clicks "Connect to Xero" in CI frontend or ERP settings
2. CI redirects to Xero auth URL with client_id + scopes
3. User grants consent in Xero
4. Xero redirects back with authorization_code
5. CI exchanges code for access_token + refresh_token
6. Store refresh_token reference in Azure Key Vault
   → ERP_INTEGRATION.AuthTokenRef = vault secret name
7. CI uses access_token for API calls, refreshes automatically
```

---

## Acumatica Connector

### Key Facts

| Property | Detail |
|---|---|
| Auth | OAuth 2.0 / OpenID — Authorization Code Flow |
| API base | `{instance}/entity/Default/24.200.001/` (versioned contract-based) |
| Push notifications | Built-in — configure on SM302000 screen |
| Custom fields | Native support — add to any entity without code changes |
| Custom endpoints | Supported — expose custom fields via endpoint extension |
| Marketplace | Acumatica Marketplace |
| SDK | C# NuGet: `Acumatica.RESTClient`, `Acumatica.Default_24.200.001` |

> **Key advantage over Xero:** Acumatica supports **custom fields natively** on any entity. CI can write HS code, duty rate, VAT rate and total border cost back into the PO as proper structured fields — not workarounds. This makes the Acumatica integration significantly cleaner and more useful.

### Push Notification Setup (Acumatica's webhooks)

```
Screen: SM302000 (Push Notifications)
Subscribe to:
  Entity: PurchaseOrder — Event: INSERTED
  Entity: StockItem     — Event: INSERTED
Destination URL: https://api.customs.phlo.io/v1/webhooks/acumatica
```

### Custom Fields to Add (Acumatica Customisation Project)

| Entity | Field | Type | Purpose |
|---|---|---|---|
| `StockItem` | `UsrHSCode` | String(15) | WCO commodity code |
| `StockItem` | `UsrCIClassifiedAt` | DateTime | When CI last classified |
| `StockItem` | `UsrCIConfidence` | Decimal | Classification confidence |
| `PurchaseOrder` | `UsrImportDutyPct` | Decimal | MFN or preferential duty rate |
| `PurchaseOrder` | `UsrVATRate` | Decimal | Total indirect tax rate |
| `PurchaseOrder` | `UsrTotalBorderCost` | Decimal | Calculated border cost amount |
| `PurchaseOrder` | `UsrSanctionsChecked` | Boolean | Sanctions check passed |
| `PurchaseOrder` | `UsrCILookupRef` | String(50) | CI request ID for audit |

### Data Mapping — Acumatica PO → CI Request

```json
{
  "commodity_code":   "Details[0].InventoryID → StockItem.UsrHSCode",
  "export_country":   "VendorID → Vendor.Country",
  "import_country":   "BranchID → Branch.Country",
  "goods_value":      "Details[0].OrderQty × Details[0].UnitCost"
}
```

### Xero vs Acumatica — Key Differences

| Aspect | Xero | Acumatica |
|---|---|---|
| Custom fields | No — workaround needed | Full native support |
| Write-back | PO line item or note | Clean custom fields on PO/Item |
| Target customer | SME commodity traders | Mid-size trading companies |
| Certification time | ~4–6 weeks | ~3–4 months |
| Marketplace | Xero App Store | Acumatica Marketplace |
| Revenue share | ~15–25% | ~20–25% |

---

## Commercial Model

| Tier | Customer | Pricing |
|---|---|---|
| **API** | Developers, enterprise self-integration | £0.10/lookup, £0.50/classification |
| **Standalone** | Traders using CI frontend directly | £200–400/month per company |
| **Xero Add-on** | Xero SME users | £99–199/month via Xero App Store |
| **Acumatica Add-on** | Acumatica mid-market users | £199–399/month via Acumatica Marketplace |

---

## Sync Architecture

**Application layer (sync worker — NOT in DB):**
HTTP polling, HTML/JSON/XML/PDF parsing, SHA-256 hash comparison (`LastSnapshotHash`), field-level diff, retry with exponential backoff, auto-apply threshold check, write to SOURCE_SYNC_JOB and SOURCE_SYNC_CHANGE.

**Database layer (persistence only):**
All 25 tables. `TARIFF_RATE_HIST` written exclusively by DB trigger on `TARIFF_RATE` UPDATE — application never writes here.

### Sync Flow
```
1. FETCH          → HTTP GET TARIFF_SOURCE.SourceURL
2. HASH COMPARE   → SHA-256 vs LastSnapshotHash — if match: NO_CHANGE, stop
3. PARSE          → Extract field-level values from changed response
4. DIFF           → Compare to current TARIFF_RATE rows in DB
5. THRESHOLD      → Change ≤ AutoApplyThresholdPct → AUTO_APPLIED
                    Change > threshold or NEW_CODE/DELETED_CODE → PENDING_REVIEW
6. WRITE          → INSERT SOURCE_SYNC_CHANGE
                    UPDATE TARIFF_RATE (if AUTO_APPLIED)
                    DB trigger fires → INSERT TARIFF_RATE_HIST
7. JOB LOG        → INSERT SOURCE_SYNC_JOB with status, counts, duration
8. ALERT          → Notify admin if PENDING_REVIEW rows exist
```

---

## Tariff Sources by Country

| Country | Type | Notes |
|---|---|---|
| GB | API (JSON) | trade-tariff.service.gov.uk/api/v2/ — no auth, 1 req/sec |
| BR | API (JSON) | Full NCM ~50MB — hash full file then diff |
| CL | API (Excel) | Annual update — weekly poll |
| AU | HTML | Annual update |
| TH | HTML | POST request with HS code param |
| ZA | PDF | Alert admin on any hash change |
| SA | HTML | VAT 15% differs from AE/OM |
| AE/OM | HTML | GCC CET — one source covers both |
| PH | API (JSON) | AD investigation open HS 2004.10 — weekly poll |
| MU | HTML | Threshold 3% — duty changed 15%→30% Jun 2024 |
| MX/AR/UY | HTML | |
| AO/NA/DO | PDF | May be scanned — OCR fallback needed |
| OFAC | API (TXT) | Daily — threshold=0, all changes PENDING_REVIEW |
| OTSI | API (CSV) | Daily — UK consolidated sanctions |

---

## Tariff Parser Module Structure

```
tariff_parser/
├── config/
│   └── country_config.py       # Source type, URL, column mapping, valuation basis per country
├── fetchers/
│   ├── base_fetcher.py         # Abstract — fetch(), get_hash()
│   ├── api_fetcher.py          # JSON (GB, PH, BR)
│   ├── excel_fetcher.py        # xlsx (CL)
│   ├── html_fetcher.py         # HTML (AU, TH, MX, SA, AE, MU, AR, UY)
│   └── pdf_fetcher.py          # pdfplumber/camelot/pytesseract (ZA, AO, DO, NA)
├── parsers/
│   ├── base_parser.py          # Abstract: parse() → ParseResult dataclass
│   ├── gb_parser.py            # UK Trade Tariff API
│   ├── br_parser.py            # Brazil NCM JSON
│   ├── cl_parser.py            # Chile Excel
│   ├── za_parser.py            # SACU PDF — template for NA
│   ├── gcc_parser.py           # AE/SA/OM shared GCC format
│   └── generic_pdf_parser.py   # Config-driven (MU, AO, DO, UY, AR)
├── validators/
│   └── row_validator.py        # HS format, rate range 0–200%, duplicates
├── writers/
│   ├── db_writer.py            # Writes COMMODITY_CODE, MFN_RATE, TARIFF_RATE
│   └── diff_engine.py          # SOURCE_SYNC_CHANGE rows + threshold logic
└── orchestrator.py             # --mode initial_load|daily_sync --country GB|ALL
```

**Build sequence:** GB API → BR JSON → CL Excel → ZA PDF (template for all PDF countries) → GCC → remaining HTML → AO/NA/DO (OCR)

---

## Landed Cost Formula

```
Total Border Cost =
    Customs Value                     (CIF or FOB — COUNTRY.ValuationBasis)
  + MFN Duty OR Preferential Rate     (MFN_RATE APPLIED / PREFERENTIAL_RATE)
  + AD Surcharge if applicable        (AD_MEASURE — stacks on top of MFN)
  + SUM(VAT_RATE rows)                (Brazil: 5 rows — calculate sequentially)
  + Excise if applicable              (EXCISE)
  + Export Duty from origin           (EXPORT_MEASURE)
  ± Duty Relief offset                (DUTY_RELIEF)
  + Logistics costs                   (from logistics_intelligence module)
```

---

## Core 10-Step Lookup Query

For `:export_country`, `:import_country`, `:subheading`. Full SQL in `TARIFF_LOOKUP_QUERY` sheet of `Customs_Data_Model_WCO_v3.xlsx`.

| Step | What | Stop if |
|---|---|---|
| 1 | Sanctions | `IsActive = Y` → STOP |
| 2 | MFN duty rate | — |
| 3 | Trade agreement + pref rate (LEFT JOIN — returns result even with no agreement) | — |
| 4 | VAT & indirect taxes (all rows — Brazil returns 5) | — |
| 5 | AD / CVD / safeguard | — |
| 6 | Excise | — |
| 7 | Regulatory measures | `IsProhibited = Y` → STOP |
| 8 | Import conditions (NTM) | — |
| 9 | Export measures from origin | — |
| 10 | Duty relief schemes | — |

---

## Build Sequence

| Phase | What to Build | Priority |
|---|---|---|
| 1 | Supabase DDL — all 25 tables including classification and ERP tables | Foundation |
| 2 | UK tariff sync worker (GB API parser) | Real data in DB |
| 3 | `/v1/tariff/lookup` endpoint | Core product value |
| 4 | API auth — keys, rate limiting, tenant isolation | Required before external access |
| 5 | Precompute HS embeddings → pgvector | Classification foundation |
| 6 | `/v1/classify` — vector search + LLM re-ranking | New product flow |
| 7 | `PRODUCT_CLASSIFICATION_CACHE` — tenant learning | Accuracy improvement |
| 8 | Xero connector — OAuth, webhooks, PO line item write-back | First ERP integration |
| 9 | Acumatica connector — custom fields, push notifications | Second ERP integration |
| 10 | Admin panel — sync monitoring, pending changes | Operational reliability |
| 11 | CI customer-facing frontend | Standalone product |
| 12 | Remaining 16 countries | Coverage expansion |

---

## Admin Dashboard Queries

```sql
-- Job health today
SELECT sj.JobID, ts.CountryCode, ts.SourceName, sj.JobStatus,
       sj.RecordsChecked, sj.RecordsChanged, sj.ErrorMessage
FROM SOURCE_SYNC_JOB sj
JOIN TARIFF_SOURCE ts ON sj.SourceID = ts.SourceID
WHERE DATE(sj.JobStartedAt) = CURRENT_DATE
ORDER BY sj.JobStartedAt DESC;

-- Pending changes awaiting review
SELECT sc.ChangeID, sc.CountryCode, sc.SubheadingCode,
       sc.FieldChanged, sc.OldValue, sc.NewValue, sc.SourceURL
FROM SOURCE_SYNC_CHANGE sc
WHERE sc.ChangeStatus = 'PENDING_REVIEW'
ORDER BY sc.ChangeDetectedAt DESC;

-- VAT increases last 6 months
SELECT c.CountryName, h.SubheadingCode, h.OldRate, h.NewRate, h.EffectiveFrom
FROM TARIFF_RATE_HIST h
JOIN COUNTRY c ON h.CountryCode = c.CountryCode
WHERE h.RateType = 'VAT' AND h.ChangeType = 'INCREASE'
  AND h.EffectiveFrom >= DATEADD(month, -6, GETDATE());

-- Sources not polled in last 48 hours
SELECT SourceID, CountryCode, SourceName, LastPolledAt
FROM TARIFF_SOURCE
WHERE IsActive = 'Y' AND LastPolledAt < DATEADD(hour, -48, GETDATE());

-- Classification accuracy by tenant (last 30 days)
SELECT TenantID, ERPSource,
       COUNT(*) AS TotalRequests,
       SUM(CASE WHEN UserSelectedCode = TopSuggestionCode THEN 1 ELSE 0 END) AS Correct,
       ROUND(AVG(TopConfidence) * 100, 1) AS AvgConfidence_Pct
FROM CLASSIFICATION_REQUEST
WHERE RequestedAt >= DATEADD(day, -30, GETDATE())
GROUP BY TenantID, ERPSource;
```

---

## Key Files

| File | Description |
|---|---|
| `Customs_Data_Model_WCO_v3.xlsx` | Full data model — 27 sheets with sample data and SQL |
| `tariff_parser/orchestrator.py` | Main entry point — initial load and daily sync |
| `tariff_parser/config/country_config.py` | Per-country source config and column mappings |
| `tariff_parser/writers/diff_engine.py` | Change detection and threshold logic |
| `connectors/xero/connector.js` | Xero OAuth, webhooks, field mapping, PO write-back |
| `connectors/acumatica/connector.js` | Acumatica OAuth, push notifications, custom field write-back |
| `LOGISTICS_INTELLIGENCE.md` | Border logistics costs — separate module |

---

## Security Notes

- `ERP_INTEGRATION.AuthTokenRef` and `TARIFF_SOURCE.AuthCredentialRef` store Azure Key Vault **secret names only** — never actual tokens or keys
- OAuth tokens (Xero, Acumatica) stored in Key Vault only — retrieved at runtime via managed identity
- `SANCTIONS_MEASURE` must be queried on every trade evaluation — **do not cache results**
- API keys for external customers stored hashed — never in plaintext
- Xero webhook requests validated using HMAC-SHA256 signature on `x-xero-signature` header

---

*Phlo Systems Limited — Customs Intelligence / tradePhlo*  
*saurabh.goyal@phlo.io*
