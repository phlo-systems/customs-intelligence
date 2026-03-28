# Customs Intelligence API

**Base URL:** `https://epytgmksddhvwziwxhuq.supabase.co/functions/v1`

Trade tariff intelligence for international commodity trade. Covers India, South Africa, Namibia, United Kingdom, and Brazil.

## Authentication

All API requests require authentication via one of:

**API Key** (recommended for programmatic access):
```
X-API-Key: ci_live_your_key_here
```

**JWT Token** (for logged-in users):
```
Authorization: Bearer <jwt_token>
```

Contact admin to get an API key, or sign up at [customs-intelligence.vercel.app](https://customs-intelligence.vercel.app).

---

## Endpoints

### 1. Classify — Product Description → HS Code

Given a product description in plain English, returns the universal HS code and country-specific commodity code with confidence scores.

**`POST /classify`**

#### Request
```json
{
  "description": "Frozen potato chips, pre-cooked, in 25kg bags",
  "country": "IN"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `description` | string | Yes | Product description in plain English. More detail = better accuracy. |
| `country` | string | No | 2-letter ISO country code (e.g. `IN`, `ZA`, `GB`, `BR`). Defaults to `ZA`. Returns country-specific commodity code and MFN rate. |

#### Response
```json
{
  "status": "ok",
  "suggestions": [
    {
      "commodity_code": "20041010",
      "subheading_code": "200410",
      "confidence": 0.94,
      "reasoning": "Frozen potato products, prepared or preserved",
      "mfn_rate": 30.0,
      "description": "Frozen potato products: chips, fries"
    },
    {
      "commodity_code": "20041090",
      "subheading_code": "200410",
      "confidence": 0.87,
      "reasoning": "Other frozen potato preparations",
      "mfn_rate": 30.0
    }
  ],
  "note": "To confirm a code, POST with confirm_code: \"20041010\""
}
```

| Field | Description |
|---|---|
| `suggestions` | Array of up to 3 HS code matches, ranked by confidence |
| `commodity_code` | Country-specific tariff code (8 or 10 digit) |
| `subheading_code` | Universal 6-digit HS subheading |
| `confidence` | 0.0 – 1.0 match confidence |
| `mfn_rate` | MFN (Most Favoured Nation) duty rate for this code in the selected country |

#### Confirm a Classification
```json
{
  "confirm_code": "20041010",
  "description": "Frozen potato chips, pre-cooked, in 25kg bags",
  "country": "IN"
}
```
Confirmed codes are cached for instant lookup on future requests.

---

### 2. Tariff Lookup — Landed Cost Calculator

For a given commodity code and import country, returns the complete landed cost breakdown including all duties, taxes, trade remedies, exemptions, drawback rates, and required documents.

**`POST /tariff-lookup`**

#### Request — Rates Only
```json
{
  "commodity_code": "85051110",
  "import_country": "IN",
  "export_country": "CN"
}
```

#### Request — Full Calculation with Amounts
```json
{
  "commodity_code": "85051110",
  "import_country": "IN",
  "export_country": "CN",
  "customs_value": 10000,
  "currency": "USD"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `commodity_code` | string | Yes | HS code (any length — auto-matched to country's national format) |
| `import_country` | string | Yes | 2-letter ISO code of importing country |
| `export_country` | string | No | 2-letter ISO code of exporting country. Required for preferential rates, anti-dumping duties, and origin-specific measures. |
| `customs_value` | number | No | CIF value. Omit for rates-only response. |
| `currency` | string | No | Currency code (default: `ZAR`). Supported: `USD`, `EUR`, `GBP`, `INR`, `ZAR`, `BRL`, `CNY`, `JPY`, `AED`. |

#### Response — Rates Only
```json
{
  "status": "OK",
  "mode": "rates_only",
  "input": {
    "commodity_code": "85051110",
    "import_country_code": "IN",
    "import_country_name": "India",
    "export_country_code": "CN",
    "export_country_name": "China",
    "commodity_description": "Ferrite cores",
    "valuation_basis": "CIF"
  },
  "duty": {
    "mfn_rate_pct": 7.5,
    "effective_rate_pct": 0.0,
    "exemption_rate_pct": 0.0,
    "exemption_ref": "50/2017-Customs",
    "sws_rate_pct": 0.0,
    "pref_rate_pct": null,
    "pref_agreement": null
  },
  "indirect_tax": {
    "taxes": [
      {
        "tax_type": "GST",
        "category": "STANDARD",
        "rate_pct": 18.0,
        "basis": "CUSTOMS_VALUE_PLUS_DUTY"
      }
    ],
    "vat_rate_pct": 18.0
  },
  "trade_remedies": {
    "measures": [
      {
        "type": "ANTI_DUMPING",
        "rate_pct": 35.0,
        "status": "DEFINITIVE",
        "case_ref": "04/2025-Customs (ADD)"
      }
    ]
  },
  "drawback": {
    "drawback_rate_pct": 2.9,
    "drawback_cap_amt": 24.20,
    "drawback_cap_currency": "INR",
    "drawback_unit": "kg"
  },
  "import_conditions": [
    {
      "document_code": "BOE",
      "description": "Bill of Entry (ICEGATE)",
      "category": "DOCUMENTARY",
      "timing": "AT_BORDER",
      "mandatory": true,
      "authority": "Indian Customs (CBIC)"
    },
    {
      "document_code": "BIS-CRS",
      "description": "BIS Registration (Compulsory Registration Scheme)",
      "category": "TBT",
      "timing": "PRE_SHIPMENT",
      "mandatory": true,
      "authority": "Bureau of Indian Standards"
    }
  ],
  "summary": {
    "effective_duty_rate_pct": 0.0,
    "sws_rate_pct": 0.0,
    "vat_rate_pct": 18.0,
    "total_border_rate_pct": 18.0
  }
}
```

#### Response — Full Calculation
When `customs_value` is provided, the `summary` section includes currency amounts:

```json
{
  "summary": {
    "mode": "full_calculation",
    "customs_value": 10000,
    "duty_amount": 0.00,
    "sws_amount": 0.00,
    "ad_surcharge": 3500.00,
    "vat_amount": 1800.00,
    "total_border_cost": 5300.00,
    "total_landed_cost": 15300.00,
    "border_cost_pct": 53.0,
    "currency": "USD"
  }
}
```

#### Response Fields Reference

| Section | Field | Description |
|---|---|---|
| **duty** | `mfn_rate_pct` | Standard MFN / BCD rate from tariff schedule |
| | `effective_rate_pct` | Rate actually applied (may be lower due to exemption or FTA) |
| | `exemption_rate_pct` | Concessional rate from exemption notification (India: Notif 50/2017) |
| | `pref_rate_pct` | Preferential rate under trade agreement (if export_country provided) |
| | `pref_agreement` | Trade agreement code (e.g. `UK-SACU-EPA`, `SADC-FTA`) |
| | `sws_rate_pct` | Social Welfare Surcharge (India only — 10% of BCD) |
| **indirect_tax** | `taxes[]` | Array of applicable taxes with rate, basis, and type |
| | `tax_type` | `VAT`, `GST`, `IPI`, `PIS`, `COFINS`, `ICMS` |
| | `basis` | What the tax is calculated on: `CUSTOMS_VALUE_PLUS_DUTY`, `CUSTOMS_VALUE_ONLY`, `TOTAL_IMPORT_VALUE` |
| **trade_remedies** | `measures[]` | Anti-dumping, countervailing, or safeguard duties |
| | `type` | `ANTI_DUMPING`, `COUNTERVAILING`, `SAFEGUARD` |
| | `status` | `INVESTIGATION`, `PROVISIONAL`, `DEFINITIVE`, `REVIEW` |
| **drawback** | `drawback_rate_pct` | Duty drawback refund rate (% of FOB export value) |
| | `drawback_cap_amt` | Maximum refund per unit |
| **import_conditions** | Array of required documents with timing (`PRE_SHIPMENT`, `AT_BORDER`, `POST_ARRIVAL`) |
| **summary** | `total_border_rate_pct` | Sum of all duty + tax rates |
| | `total_landed_cost` | CIF + all duties + all taxes |
| | `border_cost_pct` | Total border cost as % of CIF value |

---

## Countries Supported

| Code | Country | Commodity Codes | Duty Stack |
|---|---|---|---|
| `IN` | India | 12,083 | BCD + Exemptions + SWS + IGST + Anti-dumping + Drawback |
| `ZA` | South Africa | ~17,000 | MFN + Preferential (6 FTAs) + VAT 15% |
| `NA` | Namibia | ~17,000 | Same as ZA (SACU shared tariff) |
| `GB` | United Kingdom | 13,562 | MFN + VAT 0%/20% |
| `BR` | Brazil | 10,515 | II + IPI + PIS + COFINS + ICMS (sequential stacking) |

## Commodity Code Resolution

You don't need to know the exact national code format. The API accepts:
- **8-digit code:** `85051110` → exact match
- **6-digit subheading:** `850511` → resolves to best national match
- **4-digit heading:** `8505` → resolves to first leaf commodity
- **10-digit code:** `8505111000` → trimmed to match

The `input.resolved_code` field in the response shows which national code was matched.

## Brazil Tax Stacking

Brazil's 5 import taxes are calculated **sequentially** (not summed flat):

```
CIF Value
  + II  (Import Tax)        on CIF
  + IPI (Industrial Products Tax) on CIF + II
  + PIS                     on CIF
  + COFINS                  on CIF
  + ICMS (State VAT)        on (CIF + II + IPI + PIS + COFINS + ICMS)  ← "por dentro"
```

The API handles this stacking automatically. The `indirect_tax.taxes[]` array shows each tax with its basis.

## Rate Limits

- No hard rate limit currently enforced
- Please keep requests under 10/second
- Each request is logged for usage analytics

## Error Responses

```json
{
  "status": "error",
  "error": "Commodity code 99999999 not found for IN"
}
```

```json
{
  "status": "BLOCKED",
  "blocked_reason": "SANCTIONS",
  "message": "This trade route is subject to active sanctions. Do not proceed."
}
```

## Example: Full Workflow

```bash
# Step 1: Classify a product
curl -X POST https://epytgmksddhvwziwxhuq.supabase.co/functions/v1/classify \
  -H "X-API-Key: ci_live_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{"description": "copper wire, refined, 2mm diameter", "country": "IN"}'

# Step 2: Get landed cost for the classified code
curl -X POST https://epytgmksddhvwziwxhuq.supabase.co/functions/v1/tariff-lookup \
  -H "X-API-Key: ci_live_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "commodity_code": "74081110",
    "import_country": "IN",
    "export_country": "ZA",
    "customs_value": 15000,
    "currency": "USD"
  }'
```

---

Built by [Phlo Systems](https://phlo.io) · Powered by Claude AI
