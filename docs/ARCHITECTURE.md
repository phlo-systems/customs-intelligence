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
5. Provides trade feasibility data to the GTM app on demand via API
6. Can be sold as a standalone subscription with its own frontend

The output is a complete **landed cost** for any trade, plus a personalised intelligence feed of opportunities and risks specific to each trader's business.

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
│  │ App    │  │ Frontend  │  │ connector│  │connector │    │
│  └────────┘  └───────────┘  └──────────┘  └──────────┘    │
│                                                               │
│  ┌──────────────────┐  ┌────────────────────────────────┐   │
│  │ Sync Worker      │  │ Intelligence Engine             │   │
│  │ (tariff polling) │  │ DB rules + AI enrichment        │   │
│  └──────────────────┘  └────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

---

## API Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/tariff/lookup` | POST | Full landed cost — export/import country + commodity code |
| `/v1/classify` | POST | AI classification from product description |
| `/v1/commodity/search` | GET | Search HS codes by keyword or code |
| `/v1/updates/feed` | GET | Recent tariff changes — filterable by country and date |
| `/v1/opportunities` | GET | Personalised trade opportunities for tenant |
| `/v1/alerts` | GET | Active alerts for tenant's products and routes |
| `/v1/sanctions/check` | POST | Sanctions pre-check — fastest endpoint |
| `/v1/health` | GET | Sync job status — admin only |

### Authentication
API key per tenant in `X-API-Key` header. Usage metered: £0.10/lookup, £0.50/classification. Rate limiting and query logging per tenant.

---

## Two Trade Scenarios

### Scenario A — Existing Product (classification known)
GTM or ERP sends confirmed commodity code → CI runs tariff lookup directly. No AI needed.

### Scenario B — New Product (description only)
GTM or ERP sends product description → CI classifies (vector search + optional LLM re-ranking) → trader confirms code → tariff lookup runs.

---

## Intelligence Engine — Opportunities and Alerts

### How it Works — DB Rules + AI Enrichment

The intelligence engine is a **two-layer system**. The vast majority of the work is database query logic. AI is used selectively only for the contextual explanation.

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

Claude generates a 2-3 sentence contextual explanation using `TENANT_CONTEXT` as the prompt context. Result stored in `OPPORTUNITIES.AIInsight`. Page load reads from DB — no live LLM call.

Cost: ~£0.002 per opportunity card. Negligible relative to subscription value.

---

## Tenant Context — Five Layers

To answer "what this means for your business specifically", CI builds a rich business profile from five progressive sources. All stored in `TENANT_CONTEXT`.

### Layer 1 — Explicit onboarding (day one)
Short onboarding flow: business type, primary commodities (HS chapter multi-select), sourcing origins, sales destinations, annual volume range, markets being explored.

### Layer 2 — Product library upload
When tenant uploads Excel catalogue, CI automatically extracts: industry vertical, commodity categories (HS chapters), origin countries, destination countries, scale of operation. No form filling — context extracted during classification.

### Layer 3 — Behavioural signals (ongoing)
Every interaction is a context signal stored in `TENANT_BEHAVIOUR_LOG`:
- Frequent lookups for a country → active or target market
- Dismissed opportunity cards → not interested in that market
- Clicked "explore" on an opportunity → market is on their radar
- Search patterns → whether focus is cost, compliance or expansion

### Layer 4 — ERP integration (richest structured source)
When Xero or Acumatica is connected, CI reads (read-only):

| ERP data | Context extracted |
|---|---|
| Purchase orders | Real origin countries, volumes, suppliers, Incoterms |
| Sales orders | Real destination countries, customer geography |
| Invoice values | Average shipment size — calibrates £ impact calculations |
| Item/product records | SKUs mapped to HS codes |
| Supplier contacts | Supplier country and name |

With ERP data, opportunity cards show actual figures: "£4,200 saving based on your average GB→TH shipment of £42,000 over the last 6 months."

### Layer 5 — Email connection (richest unstructured source)

Email is the most valuable context source because it captures **commercial intent, negotiations and market exploration** — information that never enters an ERP system.

A commodity trader's inbox contains: supplier quotes, customer RFQs, shipping confirmations, customs broker communications, trade inquiry threads, regulatory correspondence, LC and trade finance emails. This reveals active routes, target markets, competitor intelligence, pricing context and trade barriers.

**Architecture — extract and discard:**

```
Email arrives / history scanned
        ↓
Keyword pre-filter (only trade-related emails processed)
        ↓
Claude extracts structured context in memory
        ↓
Structured extract written to EMAIL_CONTEXT_EXTRACT
        ↓
Raw email content discarded — never stored
```

**Trade keyword filter (applied before any AI processing):**
```python
TRADE_KEYWORDS = [
    "HS code", "commodity code", "tariff", "duty", "CIF", "FOB",
    "DAP", "DDP", "Incoterms", "customs", "import", "export",
    "shipment", "bill of lading", "certificate of origin",
    "letter of credit", "LC", "freight", "forwarder",
    "commercial invoice", "packing list", "EUR.1", "fumigation"
]
```

This pre-filter ensures Claude only processes ~10-20% of emails — keeping API costs low and protecting user privacy on non-trade emails.

**What Claude extracts (structured JSON, no free text stored):**
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

**Supported platforms:**
- Gmail: OAuth 2.0, `gmail.readonly` scope, Gmail MCP
- Outlook / Microsoft 365: OAuth 2.0, `Mail.Read` scope, Microsoft Graph API

**Privacy requirements (non-negotiable):**
- Read-only OAuth scope only — CI can never send or modify emails
- Raw email body and subject never stored — structured extract only
- Extracted context shown to user for review before committing to profile
- User can delete any extract record at any time
- Separate explicit consent for email connection
- Processing only trade-related emails — keyword filter enforced
- Never share extracted context between tenants

**AI prompt structure for email extraction:**
```
Analyse this email from a commodity trading company.
Extract ONLY the following structured fields if clearly present.
Return null for any field not explicitly mentioned.
Do NOT invent or infer data not in the email.
[structured JSON schema]
```

---

## AI Classification Engine

### Two-Stage Hybrid

**Stage 1 — Vector similarity search (< 100ms, no LLM cost):**
Pre-computed embeddings of all HS subheading descriptions stored in Supabase pgvector. Product description embedded on request, cosine similarity search returns top 10. Handles ~80% of standard commodity descriptions.

**Stage 2 — LLM re-ranking (< 2s, only when Stage 1 confidence < 0.90):**
Top 10 candidates + original description sent to Claude. Returns ranked top 3 with WCO chapter note reasoning. Explainable output — trader can see why CI suggested that code.

### Confidence Thresholds

| Confidence | Action |
|---|---|
| > 0.90 | Single recommendation |
| 0.70 – 0.90 | Top 3 with reasoning — trader selects |
| < 0.70 | Flagged for expert review |

### API Key Model
Phlo holds the Anthropic API key. Customers pay Phlo a subscription or per-call fee. Customers never see, configure or provide an API key. This is identical to how Avalara, Notion and all other AI-powered SaaS products work.

### Tenant Learning
Confirmed classifications stored in `PRODUCT_CLASSIFICATION_CACHE` per tenant. Cache checked before running vector search. GTM product master is a free source of confirmed pairings — enriches cache on first use.

---

## ERP Integration

### Xero Connector

| Property | Detail |
|---|---|
| Auth | OAuth 2.0 — Authorization Code Flow |
| API base | `https://api.xero.com/api.xro/2.0/` |
| Webhooks | HMAC-SHA256 signed — respond within 5 seconds with HTTP 200 |
| Rate limits | 5 concurrent / 60 per minute / 5,000 per day |
| Marketplace | Xero App Store |
| Scopes (post Mar 2026) | `accounting.transactions`, `accounting.settings` |

**Webhook events:** `purchaseorder.created`, `purchaseorder.updated`, `item.created`, `item.updated`

**Write-back:** Duty as separate PO line item with dedicated `ImportDuty` account code — correct accounting treatment, flows through to P&L.

### Acumatica Connector

| Property | Detail |
|---|---|
| Auth | OAuth 2.0 / OpenID |
| API base | `{instance}/entity/Default/24.200.001/` |
| Push notifications | Screen SM302000 — `PurchaseOrder` INSERTED, `StockItem` INSERTED |
| Custom fields | Native — add via customisation project |

**Custom fields:** `UsrHSCode`, `UsrCIClassifiedAt`, `UsrCIConfidence` on StockItem. `UsrImportDutyPct`, `UsrVATRate`, `UsrTotalBorderCost`, `UsrSanctionsChecked`, `UsrCILookupRef` on PurchaseOrder.

**Key advantage over Xero:** Custom fields are native — CI writes structured duty data directly into PO fields, not workarounds.

### ERP Trigger Events

| ERP event | CI action |
|---|---|
| New Item / Product created | Auto-classify → suggest HS code |
| Purchase Order created (foreign supplier) | Run tariff lookup → return landed cost |
| Supplier invoice received (import) | Validate duty paid matches CI estimate |
| New supplier added (foreign country) | Flag regulatory requirements for that origin |

---

## Commercial Model

| Tier | Customer | Pricing |
|---|---|---|
| API | Developers, enterprise self-integration | £0.10/lookup, £0.50/classification |
| Standalone | CI frontend subscription | £200–400/month per company |
| Xero Add-on | Xero SME users | £99–199/month via Xero App Store |
| Acumatica Add-on | Mid-market users | £199–399/month via Acumatica Marketplace |

---

## Core Tables Reference

Full DDL in `customs_intelligence_ddl.sql`. Full sample data in `Customs_Data_Model_WCO_v3.xlsx`.

### Group 1 — HS Hierarchy (static)
`COUNTRY` · `HS_SECTION` · `HS_HEADING` · `HS_SUBHEADING`

HS version rule: INSERT new rows for HS 2028 — never UPDATE existing rows.

### Group 2 — Commodity & Rates
`COMMODITY_CODE` (PK: CommodityCode + CountryCode — no surrogate) · `MFN_RATE` · `TARIFF_RATE` · `TARIFF_RATE_HIST` (DB trigger only)

`EffectiveTo IS NULL` = current rate. CIF vs FOB: at 14.4% on $10,800 CIF vs $10,000 FOB → $1,555 vs $1,440.

### Group 3 — Preferences
`TRADE_AGREEMENT` · `PREFERENTIAL_RATE` · `RULES_OF_ORIGIN` · `ORIGIN_DOCUMENT`

Always check all four in sequence: agreement exists → rate applies → goods qualify → document required.

### Group 4 — Regulatory
`REG_MEASURE` · `IMPORT_CONDITION` (UNCTAD TRAINS NTM codes) · `EXPORT_MEASURE` · `SANCTIONS_MEASURE`

**Sanctions always first.** `IsActive = Y` → stop, escalate. Administering bodies: OFAC / OTSI / EU CFSP / UNSC.

### Group 5 — Indirect Tax
`VAT_RATE` · `EXCISE` · `AD_MEASURE` · `DUTY_RELIEF`

Brazil cascade: II + IPI + PIS + COFINS + ICMS — calculate sequentially, NOT as flat sum. Total ≈ 45.75% for frozen potato chips.

### Group 6 — Sync & Audit
`TARIFF_SOURCE` · `SOURCE_SYNC_JOB` · `SOURCE_SYNC_CHANGE`

`AuthCredentialRef` = Azure Key Vault secret name only. Sync logic is application layer only — DB handles persistence.

### Group 7 — Intelligence (new in v5)
`OPPORTUNITIES` · `ALERTS` · `TENANT_CONTEXT` · `TENANT_BEHAVIOUR_LOG`

### Group 8 — Classification (new in v5)
`HS_DESCRIPTION_EMBEDDING` · `CLASSIFICATION_REQUEST` · `PRODUCT_CLASSIFICATION_CACHE`

### Group 9 — ERP & Email Integration (new in v5)
`ERP_INTEGRATION` · `EMAIL_CONTEXT_EXTRACT`

---

## Sync Architecture

**Application layer (sync worker):** HTTP polling, parsing, SHA-256 hash comparison, field-level diff, auto-apply threshold, retry logic. Writes SOURCE_SYNC_JOB and SOURCE_SYNC_CHANGE. Never writes TARIFF_RATE_HIST directly.

**DB trigger:** `AFTER UPDATE` on `TARIFF_RATE` → INSERT to `TARIFF_RATE_HIST`. Guaranteed audit trail regardless of code path.

**Intelligence engine** (runs after each sync): SQL rules engine writes OPPORTUNITIES and ALERTS. Separate enrichment job calls Claude for AIInsight text per new opportunity row.

---

## Tariff Sources by Country

| Country | Type | Notes |
|---|---|---|
| GB | API (JSON) | trade-tariff.service.gov.uk/api/v2/ — no auth, 1 req/sec |
| BR | API (JSON) | Full NCM ~50MB — hash full file then diff |
| CL | API (Excel) | Annual update — weekly poll |
| AU/TH/MX/AR/UY | HTML | Country-specific scrapers |
| ZA/NA | PDF | Alert admin on hash change — SACU shared format |
| SA/AE/OM | HTML | GCC CET — shared tariff, separate VAT rates |
| PH | API (JSON) | AD investigation open HS 2004.10 — weekly poll |
| MU | HTML | Threshold 3% — duty changed 15%→30% Jun 2024 |
| AO/DO | PDF | May be scanned — OCR fallback |
| OFAC/OTSI | API | Daily — threshold=0, all changes PENDING_REVIEW |

---

## Landed Cost Formula

```
Total Border Cost =
    Customs Value                     (CIF or FOB — COUNTRY.ValuationBasis)
  + MFN Duty OR Preferential Rate     (MFN_RATE / PREFERENTIAL_RATE)
  + AD Surcharge if applicable        (AD_MEASURE — stacks on MFN)
  + SUM(VAT_RATE rows)                (Brazil: 5 rows — sequential calculation)
  + Excise if applicable              (EXCISE)
  + Export Duty from origin           (EXPORT_MEASURE)
  ± Duty Relief offset                (DUTY_RELIEF)
  + Logistics costs                   (logistics_intelligence module)
```

---

## Core 10-Step Tariff Lookup

Full SQL in `TARIFF_LOOKUP_QUERY` sheet of `Customs_Data_Model_WCO_v3.xlsx`.

| Step | What | Stop if |
|---|---|---|
| 1 | Sanctions | IsActive = Y → STOP |
| 2 | MFN duty rate | — |
| 3 | Trade agreement + pref rate (LEFT JOIN — returns even with no agreement) | — |
| 4 | VAT & indirect taxes (all rows) | — |
| 5 | AD / CVD / safeguard | — |
| 6 | Excise | — |
| 7 | Regulatory measures | IsProhibited = Y → STOP |
| 8 | Import conditions (NTM) | — |
| 9 | Export measures from origin | — |
| 10 | Duty relief schemes | — |

---

## Build Sequence

| Phase | What | Priority |
|---|---|---|
| 1 | Supabase DDL — all tables | Foundation |
| 2 | UK tariff sync worker | Real data in DB |
| 3 | `/v1/tariff/lookup` endpoint | Core product value |
| 4 | API auth — keys, rate limiting, tenant isolation | Required before external access |
| 5 | Onboarding flow → TENANT_CONTEXT Layer 1 | Context foundation |
| 6 | Product upload + classification → Layer 2 | Personalisation |
| 7 | DB rules engine → OPPORTUNITIES and ALERTS | Intelligence feed |
| 8 | AI enrichment → AIInsight per opportunity | Contextual quality |
| 9 | Precompute HS embeddings → pgvector | Classification |
| 10 | `/v1/classify` — vector search + LLM re-ranking | New product flow |
| 11 | Xero connector | First ERP integration + Layer 4 context |
| 12 | Acumatica connector | Second ERP integration |
| 13 | Email connection (Gmail + Outlook) | Layer 5 — richest context |
| 14 | Behavioural signals → Layer 3 | Ongoing context refinement |
| 15 | Admin panel + CI frontend | Operational + standalone product |
| 16 | Remaining 16 countries | Coverage expansion |

---

## Admin Dashboard Queries

```sql
-- Job health today
SELECT sj.JobID, ts.CountryCode, ts.SourceName, sj.JobStatus,
       sj.RecordsChecked, sj.RecordsChanged, sj.ErrorMessage
FROM SOURCE_SYNC_JOB sj JOIN TARIFF_SOURCE ts ON sj.SourceID = ts.SourceID
WHERE DATE(sj.JobStartedAt) = CURRENT_DATE ORDER BY sj.JobStartedAt DESC;

-- Pending changes awaiting review
SELECT sc.ChangeID, sc.CountryCode, sc.SubheadingCode,
       sc.FieldChanged, sc.OldValue, sc.NewValue, sc.SourceURL
FROM SOURCE_SYNC_CHANGE sc WHERE sc.ChangeStatus = 'PENDING_REVIEW'
ORDER BY sc.ChangeDetectedAt DESC;

-- Active opportunities by tenant
SELECT o.TenantID, o.OpportunityType, o.SubheadingCode,
       o.ImportCountryCode, o.SavingAmtPer10K, o.Headline
FROM OPPORTUNITIES o WHERE o.IsDismissed = FALSE AND o.IsActioned = FALSE
ORDER BY o.SavingAmtPer10K DESC NULLS LAST;

-- Classification accuracy last 30 days
SELECT TenantID, ERPSource, COUNT(*) AS Total,
       SUM(CASE WHEN UserSelectedCode = TopSuggestionCode THEN 1 ELSE 0 END) AS Correct,
       ROUND(AVG(TopConfidence) * 100, 1) AS AvgConfidence
FROM CLASSIFICATION_REQUEST
WHERE RequestedAt >= NOW() - INTERVAL '30 days'
GROUP BY TenantID, ERPSource;

-- Email context coverage per tenant
SELECT TenantID, COUNT(*) AS ExtractsTotal,
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
| `CUSTOMS_INTELLIGENCE.md` | This file — developer reference |
| `customs_intelligence_ddl.sql` | Full Supabase DDL — all 29 tables |
| `Customs_Data_Model_WCO_v3.xlsx` | Data model with sample data and SQL queries |
| `tariff_parser/orchestrator.py` | Tariff sync worker entry point |
| `intelligence_engine/rules_engine.py` | DB rules → OPPORTUNITIES and ALERTS |
| `intelligence_engine/enrichment.py` | Claude AI insight generation |
| `connectors/xero/connector.js` | Xero OAuth, webhooks, field mapping |
| `connectors/acumatica/connector.js` | Acumatica custom fields, push notifications |
| `connectors/email/gmail_connector.py` | Gmail OAuth, keyword filter, extraction |
| `connectors/email/outlook_connector.py` | Microsoft Graph, keyword filter, extraction |
| `LOGISTICS_INTELLIGENCE.md` | Separate module — border logistics costs |

---

## Security Notes

- `TARIFF_SOURCE.AuthCredentialRef`, `ERP_INTEGRATION.AuthTokenRef`, `EMAIL_CONTEXT_EXTRACT` platform tokens — all stored as Azure Key Vault secret names only
- OAuth tokens (Xero, Acumatica, Gmail, Outlook) in Key Vault only — never in DB
- Email: read-only OAuth scope only. Raw email body never stored. Structured extract only
- `SANCTIONS_MEASURE` — never cache results. Query on every trade evaluation
- API keys for external customers stored hashed — never in plaintext
- Xero webhook requests validated using HMAC-SHA256 on `x-xero-signature` header

---

*Phlo Systems Limited — Customs Intelligence / tradePhlo*  
*saurabh.goyal@phlo.io*
