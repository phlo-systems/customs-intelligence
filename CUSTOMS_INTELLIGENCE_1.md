# Customs Intelligence Module

**Module:** `customs_intelligence`  
**Platform:** tradePhlo / Omni GTM / ERP Add-on  
**Version:** v5.0  
**Last Updated:** March 2026  
**Owner:** Phlo Systems Limited  
**Contact:** saurabh.goyal@phlo.io

---

## Overview

Customs Intelligence (CI) is a **standalone SaaS microservice** that:

1. Provides complete customs and regulatory cost estimates for international commodity trades
2. Classifies products into the correct HS / commodity codes from free-text descriptions
3. Surfaces personalised **trade opportunities and alerts** based on the tenant's product catalogue, trade routes, ERP data and email context
4. Integrates with ERP systems (Xero, Acumatica and others) as a marketplace add-on
5. Connects to Gmail and Outlook to build tenant business context from trade emails
6. Provides trade feasibility data to the GTM app on demand via API
7. Can be sold as a standalone subscription with its own frontend

The output is a complete **landed cost** for any trade broken down into all duty, tax, regulatory and documentation components, plus a personalised intelligence feed of opportunities and risks specific to each trader's business.

Border logistics costs (freight, THC, demurrage) are handled by the **`logistics_intelligence`** module and combined at the application layer.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  CUSTOMS INTELLIGENCE  (Supabase project: ci-phlo)           │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Unified REST API  (versioned — /v1/)               │    │
│  └─────────────────────────────────────────────────────┘    │
│      │              │              │              │          │
│      ▼              ▼              ▼              ▼          │
│  ┌────────┐  ┌───────────┐  ┌──────────┐  ┌──────────┐    │
│  │ GTM    │  │ CI        │  │ Xero     │  │Acumatica │    │
│  │ App    │  │ Frontend  │  │connector │  │connector │    │
│  └────────┘  └───────────┘  └──────────┘  └──────────┘    │
│                                                               │
│  ┌──────────────────┐  ┌────────────────────────────────┐   │
│  │ Sync Worker      │  │ Intelligence Engine             │   │
│  │ (tariff polling) │  │ DB rules + AI enrichment        │   │
│  └──────────────────┘  └────────────────────────────────┘   │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Email Connectors  (Gmail · Outlook / Microsoft Graph) │   │
│  │ Keyword filter → Claude extract → EMAIL_CONTEXT_EXTRACT│  │
│  └──────────────────────────────────────────────────────┘   │
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
| `/v1/opportunities` | GET | Personalised trade opportunities for tenant |
| `/v1/alerts` | GET | Active alerts for tenant's products and routes |
| `/v1/sanctions/check` | POST | Sanctions check only — fastest endpoint, run as pre-check |
| `/v1/health` | GET | Sync job status — admin only |

### Authentication
API key per tenant in `X-API-Key` header. Usage metered per call: £0.10/lookup, £0.50/classification. Rate limiting per API key. Query logging includes TenantID for usage reporting.

---

## Two Trade Scenarios

### Scenario A — Existing Product (classification already known)
GTM or ERP has a confirmed commodity code. CI runs the tariff lookup directly — no classification needed:

```json
// GTM / ERP → CI
POST /v1/tariff/lookup
{
  "commodity_code": "2004100010",
  "export_country": "GB",
  "import_country": "BR",
  "goods_value": 10000,
  "valuation_basis": "FOB"
}
// CI returns full landed cost JSON immediately
```

### Scenario B — New Product (description only, no classification)
GTM or ERP has a product description but no code. CI classifies first, then the trader confirms before lookup:

```json
// Step 1 — Classify
POST /v1/classify
{
  "description": "frozen pre-fried potato strips 10mm food service",
  "export_country": "GB",
  "import_country": "BR"
}
// Returns top 3 HS code suggestions with confidence + reasoning

// Step 2 — Trader selects code, then:
POST /v1/tariff/lookup  // same as Scenario A
```

---

## AI Classification Engine

### Two-Stage Hybrid Approach

**Stage 1 — Vector similarity search (< 100ms, no LLM cost):**
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
Every confirmed classification is stored in `PRODUCT_CLASSIFICATION_CACHE` per tenant. Next time the same description arrives for that tenant CI returns the cached result instantly with confidence = 1.0. GTM's existing product master is a free source of confirmed pairings — every existing product enriches the cache on first use.

### ClassificationType Values

| Value | Meaning |
|---|---|
| `EXISTING_PRODUCT` | Matched from GTM product master or cache — confidence 1.0 |
| `AI_INFERRED` | Stage 1 or Stage 2 AI suggestion — confidence varies |
| `MANUAL_OVERRIDE` | Trader overrode AI suggestion |

### API Key Model
Phlo holds the Anthropic API key. Customers pay Phlo a subscription or per-call fee. Customers never see, configure or provide an API key. Standard SaaS model — identical to Avalara, Notion and all other AI-powered SaaS products.

---

## Intelligence Engine

### How It Works — DB Rules + AI Enrichment

The intelligence engine is a **two-layer system**. The vast majority of the work is SQL. AI is used selectively only for the contextual explanation.

**Layer 1 — DB rules engine (runs after every tariff sync):**

| Trigger | Rule | Output |
|---|---|---|
| `TARIFF_RATE_HIST` DECREASE row | Tenant has matching product in library | "Duty reduced" opportunity |
| `PREFERENTIAL_RATE` new row | Tenant has that origin/destination pair | "New FTA preference" opportunity |
| `AD_MEASURE` status → PROVISIONAL | Tenant's origin NOT in targeted list | "Competitor disadvantage" opportunity |
| Low-cost country tenant doesn't trade | Tenant has the product, no route there | "New market signal" opportunity |
| `PREFERENTIAL_RATE.EffectiveTo` < 90 days | Tenant uses that route | "Expiring preference" opportunity |
| `TARIFF_RATE_HIST` INCREASE | Tenant has active route for commodity | Alert |
| `SANCTIONS_MEASURE` new IsActive=Y | Tenant's origin or destination affected | Critical alert |

All of this is SQL — no AI involved. Runs as a scheduled job after each sync cycle.

**Layer 2 — AI enrichment (runs once per new opportunity, pre-computed):**

Claude generates a 2–3 sentence contextual explanation using `TENANT_CONTEXT` as the prompt context. Result stored in `OPPORTUNITIES.AIInsight`. Dashboard reads from DB — no live LLM call on page load.

Cost: ~£0.002 per opportunity card. Negligible relative to subscription value.

---

## Tenant Context — Five Layers

To answer "what this means for your business specifically", CI builds a rich business profile from five progressive sources. All stored in `TENANT_CONTEXT`.

### Layer 1 — Explicit onboarding (day one)
Short onboarding form: business type, primary commodities (HS chapter multi-select), sourcing origins, sales destinations, annual volume range, markets being explored.

### Layer 2 — Product library upload
When tenant uploads their product catalogue, CI extracts: industry vertical, commodity categories (HS chapters), origin countries, destination countries, scale of operation. No form-filling — context extracted automatically during classification.

### Layer 3 — Behavioural signals (ongoing)
Every interaction logged in `TENANT_BEHAVIOUR_LOG` and aggregated nightly:
- Frequent lookups for a country → `HighInterestCountries`
- Dismissed opportunity cards → `DismissedCountries`
- Clicked "explore" on an opportunity → market is on their radar
- Search patterns → whether focus is cost, compliance or expansion

### Layer 4 — ERP integration (richest structured source)
When Xero or Acumatica is connected, CI reads (read-only):

| ERP data | Context extracted |
|---|---|
| Purchase orders | Real origin countries, volumes, suppliers, Incoterms |
| Sales orders | Real destination countries, customer geography |
| Invoice values | Average shipment size — calibrates £ impact calculations |
| Item / product records | SKUs mapped to HS codes |
| Supplier contacts | Supplier country and name |

With ERP data, opportunity cards show actual figures: *"£4,200 saving based on your average GB→TH shipment of £42,000 over the last 6 months."*

### Layer 5 — Email connection (richest unstructured source)
Email is the most valuable context source because it captures **commercial intent, negotiations and market exploration** — information that never enters an ERP system.

A commodity trader's inbox contains: supplier quotes, customer RFQs, shipping confirmations, customs broker communications, trade inquiry threads, regulatory correspondence, LC and trade finance emails. This reveals active routes, target markets, competitor intelligence, pricing context and trade barriers.

See **Email Integration** section below for architecture and privacy details.

---

## Email Integration

### Architecture — Extract and Discard

```
Email arrives / history scanned
        ↓
Keyword pre-filter  (only trade-related emails processed — ~10–20%)
        ↓
Claude extracts structured context in memory
        ↓
Structured extract written to EMAIL_CONTEXT_EXTRACT
        ↓
Raw email content discarded — never stored
```

### Trade Keyword Filter
Applied before any AI processing — keeps Claude API costs low and protects privacy on non-trade emails:

```python
TRADE_KEYWORDS = [
    "HS code", "commodity code", "tariff", "duty", "CIF", "FOB",
    "DAP", "DDP", "Incoterms", "customs", "import", "export",
    "shipment", "bill of lading", "certificate of origin",
    "letter of credit", "LC", "freight", "forwarder",
    "commercial invoice", "packing list", "EUR.1", "fumigation"
]
```

### What Claude Extracts (structured JSON — no free text stored)

```json
{
  "email_type": "SUPPLIER_QUOTE | CUSTOMER_RFQ | SHIPPING_CONF | CUSTOMS_ENTRY | TRADE_INQUIRY",
  "commodities": [],
  "hs_codes": [],
  "origin_countries": [],
  "destination_countries": [],
  "counterparty_name": "",
  "counterparty_country": "",
  "volume_mt": null,
  "incoterm": "",
  "competitor_origins": [],
  "market_interest": [],
  "trade_barriers": [],
  "compliance_concerns": []
}
```

### Supported Platforms

| Platform | Auth | Scope |
|---|---|---|
| Gmail | OAuth 2.0 | `gmail.readonly` — read-only, never send or modify |
| Outlook / Microsoft 365 | OAuth 2.0 | `Mail.Read` — read-only, never send or modify |

### Privacy Requirements (non-negotiable)
- Raw email body and subject **never stored** — structured extract only
- Extracted context shown to user for review before committing to profile
- User can delete any extract record at any time
- Separate explicit consent required for email connection
- Processing only trade-related emails — keyword filter enforced
- Extracted context never shared between tenants
- GDPR basis: legitimate interest for service personalisation

---

## Database — 29 Tables across 9 Groups

Full DDL in `database/ddl/` (files `00_` through `11_`). Full sample data in `Customs_Data_Model_WCO_v4.xlsx`.

### Group 1 — HS Hierarchy (tab: teal)

| Table | PK | Notes |
|---|---|---|
| `COUNTRY` | CountryCode | Includes ValuationBasis (CIF/FOB) — critical for landed cost |
| `HS_SECTION` | SectionCode | WCO Sections I–XXI |
| `HS_HEADING` | (HeadingCode, HSVersion) | 4-digit |
| `HS_SUBHEADING` | (SubheadingCode, HSVersion) | Insert new rows for HS 2028 — never update |

### Group 2 — Commodity & Rates (tab: pink)

| Table | PK | Notes |
|---|---|---|
| `COMMODITY_CODE` | (CommodityCode, CountryCode) | No surrogate key |
| `MFN_RATE` | (CommodityCode, CountryCode, RateCategory, EffectiveFrom) | APPLIED / BOUND / TRQ — see below |
| `TARIFF_RATE` | (CommodityCode, CountryCode, EffectiveFrom) | Summary — EffectiveTo IS NULL = current |
| `TARIFF_RATE_HIST` | HistoryID (auto) | DB trigger only — app never writes here |

CIF vs FOB: UK/EU = CIF. Americas (BR/AR/MX/UY) = FOB. At 14.4% on $10,800 CIF vs $10,000 FOB: $1,555 vs $1,440 — an 8% difference. Always capture ValuationBasis correctly.

MFN RateCategory: `APPLIED` (current charged rate) / `BOUND` (WTO ceiling — Applied ≤ Bound always) / `TRQ_IN_QUOTA` / `TRQ_OUT_QUOTA`

DutyBasisType: `AD_VALOREM` (% of value) / `SPECIFIC` (fixed per kg/unit) / `COMPOUND` (both) / `MIXED` (higher of)

### Group 3 — Preferences (tab: green)

Always check all four tables in sequence — finding a rate in `PREFERENTIAL_RATE` is not enough, goods must qualify under `RULES_OF_ORIGIN`:

`TRADE_AGREEMENT` → `PREFERENTIAL_RATE` → `RULES_OF_ORIGIN` → `ORIGIN_DOCUMENT`

Origin criteria: `WO` (wholly obtained) / `CTH` (change in 4-digit heading) / `CTSH` (change in subheading) / `RVC` (regional value content %) / `SP` (sufficient processing)

### Group 4 — Regulatory (tab: amber/red)

**Always query `SANCTIONS_MEASURE` first.** If `IsActive = Y` → stop, escalate. Administering bodies: OFAC / OTSI / EU CFSP / UNSC.

`IMPORT_CONDITION` NTM codes: A11=phytosanitary / A14=fumigation / B31=labelling / B32=ISPM 15 packaging / C1=pre-shipment inspection. TimingRequirement: `PRE_SHIPMENT` / `AT_BORDER` / `POST_ARRIVAL`.

### Group 5 — Indirect Tax (tab: olive)

Brazil cascade — calculate **sequentially, NOT as a flat sum:**
`II` (16% FOB) + `IPI` (0%) + `PIS` (2.1%) + `COFINS` (9.65%) + `ICMS` (18% of total) ≈ **45.75%**

`AD_MEASURE`: Stacks on top of MFN. `ExporterName = NULL` = country residual. Safeguard: `ExportingCountryCode = NULL` = all origins. `ADStatus`: INVESTIGATION → PROVISIONAL → DEFINITIVE → REVIEW → EXPIRED.

`DUTY_RELIEF` types: `IPR` (process + re-export) / `CW` (warehouse = defer) / `TA` (temp admission) / `EUR` (end use) / `OPR` (outward processing)

### Group 6 — Sync & Audit (tab: orange)

`TARIFF_SOURCE.AuthCredentialRef` = Azure Key Vault secret name only. `AutoApplyThresholdPct` default 5.0 — changes above this + `NEW_CODE`/`DELETED_CODE` always → `PENDING_REVIEW`.

### Group 7 — Intelligence Engine (tab: blue)

| Table | Purpose |
|---|---|
| `OPPORTUNITIES` | Personalised opportunity cards per tenant — populated by DB rules engine |
| `ALERTS` | Duty increases, new sanctions, AD investigations, expiry warnings |
| `TENANT_CONTEXT` | 5-layer business profile — onboarding / products / behaviour / ERP / email |
| `TENANT_BEHAVIOUR_LOG` | Every user interaction — aggregated nightly into TENANT_CONTEXT arrays |

`OPPORTUNITIES.AIInsight` = Claude-generated 2–3 sentence explanation. Pre-computed at write time, ~£0.002/card. Never generated live on page load.

### Group 8 — Classification Engine (tab: purple)

| Table | Purpose |
|---|---|
| `HS_DESCRIPTION_EMBEDDING` | Pre-computed pgvector 1536-dim embeddings for Stage 1 similarity search |
| `CLASSIFICATION_REQUEST` | Full audit trail of every classification attempt — feedback loop for AI |
| `PRODUCT_CLASSIFICATION_CACHE` | Confirmed description → code per tenant — checked before vector search |

```sql
-- IVFFlat index for fast cosine similarity search
CREATE INDEX idx_hs_embedding_cosine ON HS_DESCRIPTION_EMBEDDING
    USING ivfflat (Embedding vector_cosine_ops) WITH (lists = 100);
```

### Group 9 — ERP & Email Integration (tab: cyan)

| Table | Purpose |
|---|---|
| `ERP_INTEGRATION` | Connector config per tenant — AuthTokenRef = Key Vault name only |
| `EMAIL_CONTEXT_EXTRACT` | Structured trade intelligence from email — no raw email body stored |

`EMAIL_CONTEXT_EXTRACT`: raw email body, subject, sender address and recipient **never stored**. Structured extract only. `UNIQUE(TenantID, EmailMessageID)`.

---

## ERP Integration Layer

### What Each Connector Does

ERP connectors are thin adapters that do three things only:
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

### Xero Connector

| Property | Detail |
|---|---|
| Auth | OAuth 2.0 — Authorization Code Flow |
| API base | `https://api.xero.com/api.xro/2.0/` |
| Webhooks | HMAC-SHA256 signed — respond within 5 seconds with HTTP 200 |
| Rate limits | 5 concurrent / 60 per minute / 5,000 per day |
| Marketplace | Xero App Store |
| Scopes (post Mar 2026) | `accounting.transactions`, `accounting.settings` |
| SDK | Official: Python, Node.js, PHP, .NET, Java |

**Webhook events to subscribe:**
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

**Key Xero objects:**

| Object | Endpoint | CI Use |
|---|---|---|
| Items | `/Items` | Product catalogue — trigger classify on new item |
| PurchaseOrders | `/PurchaseOrders` | Trigger tariff lookup on PO creation |
| Contacts | `/Contacts` | Get supplier country for export_country |
| Accounts | `/Accounts` | Map duty cost to correct Xero account code |

**Data mapping — Xero PO → CI request:**
```json
{
  "commodity_code": "LineItems[0].ItemCode",
  "export_country": "Contact.Addresses[POBOX].Country",
  "import_country": "from Xero org settings (COUNTRY)",
  "goods_value": "LineItems[0].UnitAmount × LineItems[0].Quantity"
}
```

**Writing CI results back to Xero:** Xero has no native import duty fields. Add duty as a separate PO line item with a dedicated `ImportDuty` account code. This creates a proper accounting entry that flows through to P&L correctly.

**Xero OAuth flow:**
1. User clicks "Connect to Xero" in CI frontend
2. CI redirects to Xero auth URL with `client_id` + scopes
3. User grants consent in Xero
4. Xero redirects back with `authorization_code`
5. CI exchanges code for `access_token` + `refresh_token`
6. Store `refresh_token` in Azure Key Vault → `ERP_INTEGRATION.AuthTokenRef` = vault secret name
7. CI uses `access_token` for API calls, refreshes automatically

### Acumatica Connector

| Property | Detail |
|---|---|
| Auth | OAuth 2.0 / OpenID — Authorization Code Flow |
| API base | `{instance}/entity/Default/24.200.001/` (versioned contract-based) |
| Push notifications | Built-in — configure on SM302000 screen |
| Custom fields | Native support — add to any entity without code changes |
| Marketplace | Acumatica Marketplace |
| SDK | C# NuGet: `Acumatica.RESTClient`, `Acumatica.Default_24.200.001` |

**Key advantage over Xero:** Acumatica supports custom fields natively on any entity. CI writes HS code, duty rate, VAT rate and total border cost back into the PO as proper structured fields — not workarounds.

**Push notification setup (SM302000):**
- Entity: `PurchaseOrder` — Event: `INSERTED`
- Entity: `StockItem` — Event: `INSERTED`
- Destination URL: `https://api.customs.phlo.io/v1/webhooks/acumatica`

**Custom fields to add (Acumatica customisation project):**

| Entity | Field | Type | Purpose |
|---|---|---|---|
| StockItem | `UsrHSCode` | String(15) | WCO commodity code |
| StockItem | `UsrCIClassifiedAt` | DateTime | When CI last classified |
| StockItem | `UsrCIConfidence` | Decimal | Classification confidence |
| PurchaseOrder | `UsrImportDutyPct` | Decimal | MFN or preferential duty rate |
| PurchaseOrder | `UsrVATRate` | Decimal | Total indirect tax rate |
| PurchaseOrder | `UsrTotalBorderCost` | Decimal | Calculated border cost amount |
| PurchaseOrder | `UsrSanctionsChecked` | Boolean | Sanctions check passed |
| PurchaseOrder | `UsrCILookupRef` | String(50) | CI request ID for audit |

### Xero vs Acumatica — Key Differences

| Aspect | Xero | Acumatica |
|---|---|---|
| Custom fields | No — workaround needed | Full native support |
| Write-back | PO line item | Clean custom fields on PO/Item |
| Target customer | SME commodity traders | Mid-size trading companies |
| Certification time | ~4–6 weeks | ~3–4 months |
| Marketplace | Xero App Store | Acumatica Marketplace |
| Revenue share | ~15–25% | ~20–25% |

---

## Commercial Model

| Tier | Customer | Pricing |
|---|---|---|
| API | Developers, enterprise self-integration | £0.10/lookup, £0.50/classification |
| Standalone | Traders using CI frontend directly | £200–400/month per company |
| Xero Add-on | Xero SME users | £99–199/month via Xero App Store |
| Acumatica Add-on | Acumatica mid-market users | £199–399/month via Acumatica Marketplace |

---

## Sync Architecture

**Application layer (sync worker — NOT in DB):**
HTTP polling, HTML/JSON/XML/PDF parsing, SHA-256 hash comparison (`LastSnapshotHash`), field-level diff, retry with exponential backoff, auto-apply threshold check, write to `SOURCE_SYNC_JOB` and `SOURCE_SYNC_CHANGE`.

**Database layer (persistence only):**
All 29 tables. `TARIFF_RATE_HIST` written exclusively by DB trigger on `TARIFF_RATE` UPDATE — application never writes here directly.

**Intelligence engine** (runs after each sync):
SQL rules engine writes `OPPORTUNITIES` and `ALERTS`. Separate enrichment job calls Claude for `AIInsight` text per new opportunity row.

### Sync Flow

```
1. FETCH        → HTTP GET TARIFF_SOURCE.SourceURL
2. HASH COMPARE → SHA-256 vs LastSnapshotHash — if match: NO_CHANGE, stop
3. PARSE        → Extract field-level values from changed response
4. DIFF         → Compare to current TARIFF_RATE rows in DB
5. THRESHOLD    → Change ≤ AutoApplyThresholdPct   → AUTO_APPLIED
                  Change > threshold or NEW_CODE/DELETED_CODE → PENDING_REVIEW
6. WRITE        → INSERT SOURCE_SYNC_CHANGE
                  UPDATE TARIFF_RATE (if AUTO_APPLIED)
                  DB trigger fires → INSERT TARIFF_RATE_HIST
7. JOB LOG      → INSERT SOURCE_SYNC_JOB with status, counts, duration
8. ALERT        → Notify admin if PENDING_REVIEW rows exist
```

### Tariff Sources by Country

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
| MX/AR/UY | HTML | — |
| AO/NA/DO | PDF | May be scanned — OCR fallback needed |
| OFAC | API (TXT) | Daily — threshold=0, all changes PENDING_REVIEW |
| OTSI | API (CSV) | Daily — UK consolidated sanctions |

### Tariff Parser Module Structure

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
│   ├── gb_parser.py            # UK Trade Tariff API — build first
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

Build sequence: GB API → BR JSON → CL Excel → ZA PDF (template for all PDF countries) → GCC → remaining HTML → AO/NA/DO (OCR)

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

For `:export_country`, `:import_country`, `:subheading`. Full SQL in `TARIFF_LOOKUP_QUERY` sheet of `Customs_Data_Model_WCO_v4.xlsx`.

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
| 1 | Supabase DDL — all 29 tables | Foundation |
| 2 | Seed static reference data (COUNTRY, HS hierarchy) | Real data in DB |
| 3 | UK tariff sync worker (`gb_parser.py`) | First live data |
| 4 | `/v1/tariff/lookup` endpoint | Core product value |
| 5 | API auth — keys, rate limiting, tenant isolation | Required before external access |
| 6 | Onboarding flow → TENANT_CONTEXT Layer 1 | Context foundation |
| 7 | Product upload + classification → Layer 2 | Personalisation |
| 8 | DB rules engine → OPPORTUNITIES + ALERTS | Intelligence feed |
| 9 | AI enrichment → AIInsight per opportunity | Contextual quality |
| 10 | Precompute HS embeddings → pgvector | Classification foundation |
| 11 | `/v1/classify` — vector search + LLM re-ranking | New product flow |
| 12 | Xero connector | First ERP integration + Layer 4 context |
| 13 | Acumatica connector | Second ERP integration |
| 14 | Email connection (Gmail + Outlook) | Layer 5 — richest context |
| 15 | Behavioural signals → Layer 3 | Ongoing context refinement |
| 16 | Admin panel + CI frontend | Operational + standalone product |
| 17 | Brazil, Chile, South Africa parsers | Priority markets |
| 18 | Remaining 14 countries | Full coverage |

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
WHERE h.RateType = 'VAT'
  AND h.ChangeType = 'INCREASE'
  AND h.EffectiveFrom >= NOW() - INTERVAL '6 months';

-- Sources not polled in last 48 hours
SELECT SourceID, CountryCode, SourceName, LastPolledAt
FROM TARIFF_SOURCE
WHERE IsActive = TRUE
  AND LastPolledAt < NOW() - INTERVAL '48 hours';

-- Classification accuracy by tenant (last 30 days)
SELECT TenantID, ERPSource,
       COUNT(*) AS TotalRequests,
       SUM(CASE WHEN UserSelectedCode = TopSuggestionCode THEN 1 ELSE 0 END) AS Correct,
       ROUND(AVG(TopConfidence) * 100, 1) AS AvgConfidence_Pct
FROM CLASSIFICATION_REQUEST
WHERE RequestedAt >= NOW() - INTERVAL '30 days'
GROUP BY TenantID, ERPSource;

-- Active opportunities by tenant
SELECT o.TenantID, o.OpportunityType, o.SubheadingCode,
       o.ImportCountryCode, o.SavingAmtPer10K, o.Headline
FROM OPPORTUNITIES o
WHERE o.IsDismissed = FALSE AND o.IsActioned = FALSE
ORDER BY o.SavingAmtPer10K DESC NULLS LAST;

-- Email context coverage per tenant
SELECT TenantID,
       COUNT(*) AS ExtractsTotal,
       COUNT(DISTINCT UNNEST(OriginCountries)) AS UniqueOrigins,
       COUNT(DISTINCT UNNEST(DestinationCountries)) AS UniqueDestinations
FROM EMAIL_CONTEXT_EXTRACT
WHERE ReviewedByUser = TRUE
GROUP BY TenantID;
```

---

## Key Files

| File | Description |
|---|---|
| `CUSTOMS_INTELLIGENCE_1.md` | This file — developer reference |
| `database/ddl/` | Full Supabase DDL — 12 files, all 29 tables |
| `Customs_Data_Model_WCO_v4.xlsx` | Data model — 36 sheets with sample data and SQL queries |
| `tariff_parser/orchestrator.py` | Tariff sync worker entry point |
| `intelligence_engine/rules_engine.py` | DB rules → OPPORTUNITIES and ALERTS |
| `intelligence_engine/enrichment.py` | Claude AI insight generation |
| `connectors/xero/connector.js` | Xero OAuth, webhooks, field mapping, PO write-back |
| `connectors/acumatica/connector.js` | Acumatica OAuth, push notifications, custom field write-back |
| `connectors/email/gmail_connector.py` | Gmail OAuth, keyword filter, extraction |
| `connectors/email/outlook_connector.py` | Microsoft Graph, keyword filter, extraction |
| `LOGISTICS_INTELLIGENCE.md` | Border logistics costs — separate module |

---

## Security Notes

- `TARIFF_SOURCE.AuthCredentialRef` and `ERP_INTEGRATION.AuthTokenRef` store Azure Key Vault **secret names only** — never actual tokens or keys
- OAuth tokens (Xero, Acumatica, Gmail, Outlook) stored in Key Vault only — retrieved at runtime via managed identity
- Email: read-only OAuth scope only. Raw email body **never stored**. Structured extract only.
- `SANCTIONS_MEASURE` must be queried on **every** trade evaluation — do not cache results
- API keys for external customers stored hashed — never in plaintext
- Xero webhook requests validated using HMAC-SHA256 signature on `x-xero-signature` header

---

*Phlo Systems Limited — Customs Intelligence / tradePhlo*  
*saurabh.goyal@phlo.io*
