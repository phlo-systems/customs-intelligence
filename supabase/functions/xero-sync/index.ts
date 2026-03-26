// supabase/functions/xero-sync/index.ts
// Deploy: supabase functions deploy xero-sync --no-verify-jwt
//
// Pulls purchase invoices (ACCPAY) from Xero, extracts line items,
// classifies products via /classify, and maps supplier countries.
//
// POST /xero-sync
//   { "since": "2026-01-01" }    — optional: only sync invoices modified after this date
//
// Returns: summary of synced invoices, classified items, and discovered trade routes.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
};

const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";

// Country name → ISO 2-letter mapping (common variants)
const COUNTRY_MAP: Record<string, string> = {
  "south africa": "ZA", "united kingdom": "GB", "uk": "GB", "india": "IN",
  "brazil": "BR", "australia": "AU", "thailand": "TH", "mexico": "MX",
  "chile": "CL", "philippines": "PH", "argentina": "AR", "uruguay": "UY",
  "saudi arabia": "SA", "united arab emirates": "AE", "uae": "AE",
  "oman": "OM", "angola": "AO", "mauritius": "MU", "namibia": "NA",
  "dominican republic": "DO", "china": "CN", "germany": "DE", "france": "FR",
  "italy": "IT", "spain": "ES", "netherlands": "NL", "belgium": "BE",
  "japan": "JP", "south korea": "KR", "korea": "KR", "taiwan": "TW",
  "united states": "US", "usa": "US", "canada": "CA", "new zealand": "NZ",
  "singapore": "SG", "malaysia": "MY", "indonesia": "ID", "vietnam": "VN",
  "portugal": "PT", "poland": "PL", "ireland": "IE", "sweden": "SE",
  "norway": "NO", "denmark": "DK", "finland": "FI", "switzerland": "CH",
  "austria": "AT", "turkey": "TR", "egypt": "EG", "nigeria": "NG",
  "kenya": "KE", "ghana": "GH", "tanzania": "TZ", "mozambique": "MZ",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json({ ok: true }, 200);
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ── Auth ─────────────────────────────────────────────────────────────────
  const rawKey = req.headers.get("x-api-key");
  if (!rawKey) return json({ error: "Missing X-API-Key" }, 401);

  const keyHash = await sha256hex(rawKey);
  const { data: keyRow } = await supabase
    .from("api_key")
    .select("keyid, tenantid, tenantuid, isactive")
    .eq("keyhash", keyHash)
    .eq("isactive", true)
    .maybeSingle();

  if (!keyRow) return json({ error: "Invalid API key" }, 401);

  const tenantId = keyRow.tenantuid || keyRow.tenantid;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  const sinceDate = body.since ? String(body.since) : null;

  // ── Get Xero integration ─────────────────────────────────────────────────
  const { data: integration } = await supabase
    .from("erp_integration")
    .select("*")
    .eq("tenantid", tenantId)
    .eq("erptype", "XERO")
    .eq("isactive", true)
    .maybeSingle();

  if (!integration) {
    return json({ error: "No active Xero connection. Connect via Admin tab first." }, 404);
  }

  const config = integration.mappingconfig as Record<string, unknown>;
  let accessToken = config?.access_token as string;
  const xeroTenantId = integration.erptenantid;

  // Check if token needs refresh
  const expiresAt = config?.expires_at as number || 0;
  if (Date.now() > expiresAt - 60000) { // Refresh 1 min before expiry
    const refreshResult = await refreshToken(integration, supabase);
    if (refreshResult.error) {
      return json({ error: "Token refresh failed", detail: refreshResult.error }, 502);
    }
    accessToken = refreshResult.access_token!;
  }

  const xeroHeaders = {
    "Authorization": `Bearer ${accessToken}`,
    "Xero-Tenant-Id": xeroTenantId,
    "Accept": "application/json",
  };

  // ── Fetch purchase invoices (ACCPAY) ─────────────────────────────────────
  const stats = {
    invoices_fetched: 0,
    line_items_found: 0,
    items_classified: 0,
    trade_routes_found: 0,
    suppliers_mapped: 0,
    errors: [] as string[],
  };

  let allInvoices: any[] = [];
  let page = 1;

  try {
    while (true) {
      let url = `${XERO_API_BASE}/Invoices?where=Type=="ACCPAY"&page=${page}`;
      if (sinceDate) {
        url += `&ModifiedAfter=${sinceDate}T00:00:00`;
      }

      const resp = await fetch(url, { headers: xeroHeaders });

      if (resp.status === 429) {
        // Rate limited — wait and retry
        const retryAfter = Number(resp.headers.get("Retry-After") || "60");
        console.log(`Rate limited, waiting ${retryAfter}s`);
        await sleep(retryAfter * 1000);
        continue;
      }

      if (!resp.ok) {
        const err = await resp.text();
        stats.errors.push(`Invoice fetch page ${page}: ${resp.status} ${err.substring(0, 100)}`);
        break;
      }

      const data = await resp.json();
      const invoices = data.Invoices || [];
      allInvoices = [...allInvoices, ...invoices];
      stats.invoices_fetched += invoices.length;

      if (invoices.length < 100) break; // Last page
      page++;

      await sleep(1000); // Respect rate limits
    }
  } catch (e) {
    stats.errors.push(`Invoice fetch error: ${String(e)}`);
  }

  console.log(`Fetched ${allInvoices.length} ACCPAY invoices`);

  // ── Process invoices (lightweight — no per-item classification) ──────────
  const supplierCountries = new Map<string, string>();
  const supplierNames = new Map<string, string>();
  const lineItems: Array<{ description: string; amount: number; currency: string; supplier: string; supplier_country: string | null }> = [];

  for (const inv of allInvoices) {
    const currency = inv.CurrencyCode || "ZAR";
    const contact = inv.Contact || {};
    const contactId = contact.ContactID || "";
    const supplierName = contact.Name || "Unknown";
    supplierNames.set(contactId, supplierName);

    // Map supplier country
    let supplierCountry = supplierCountries.get(contactId) || null;
    if (!supplierCountry && contact.Addresses) {
      for (const addr of contact.Addresses) {
        if (addr.Country) {
          supplierCountry = resolveCountryCode(addr.Country);
          if (supplierCountry) {
            supplierCountries.set(contactId, supplierCountry);
            stats.suppliers_mapped++;
            break;
          }
        }
      }
    }

    const items = inv.LineItems || [];
    for (const item of items) {
      stats.line_items_found++;
      const description = item.Description || "";
      const lineAmount = item.LineAmount || 0;
      if (description.length >= 5) {
        lineItems.push({ description, amount: lineAmount, currency, supplier: supplierName, supplier_country: supplierCountry });
      }
    }
  }

  // ── Build supplier summary ───────────────────────────────────────────────
  const supplierSummary = Array.from(supplierNames.entries()).map(([id, name]) => ({
    name,
    country: supplierCountries.get(id) || null,
  }));

  // ── Top line items by value (for user to classify in UI) ─────────────────
  const topItems = lineItems
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 20)
    .map(item => ({
      description: item.description.substring(0, 120),
      amount: item.amount,
      currency: item.currency,
      supplier: item.supplier,
      supplier_country: item.supplier_country,
    }));

  // ── Aggregate trade insights ─────────────────────────────────────────────
  // Top sellers by total spend
  const sellerSpend = new Map<string, number>();
  for (const item of lineItems) {
    sellerSpend.set(item.supplier, (sellerSpend.get(item.supplier) || 0) + item.amount);
  }
  const topSellers = Array.from(sellerSpend.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, total]) => ({ name, total_spend: total }));

  // Top products by total spend (group similar descriptions)
  const productSpend = new Map<string, { total: number; count: number }>();
  for (const item of lineItems) {
    const key = item.description.substring(0, 60).toLowerCase().trim();
    const existing = productSpend.get(key) || { total: 0, count: 0 };
    existing.total += item.amount;
    existing.count++;
    productSpend.set(key, existing);
  }
  const topProducts = Array.from(productSpend.entries())
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 10)
    .map(([desc, data]) => ({ description: desc, total_spend: data.total, invoice_count: data.count }));

  // Currency breakdown
  const currencyTotals = new Map<string, number>();
  for (const inv of allInvoices) {
    const curr = inv.CurrencyCode || "GBP";
    currencyTotals.set(curr, (currencyTotals.get(curr) || 0) + (inv.Total || 0));
  }
  const currencies = Array.from(currencyTotals.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([code, total]) => ({ currency: code, total }));

  // Countries from supplier addresses
  const countryCounts = new Map<string, number>();
  for (const c of supplierCountries.values()) {
    countryCounts.set(c, (countryCounts.get(c) || 0) + 1);
  }
  const buyingCountries = Array.from(countryCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => ({ country: code, supplier_count: count }));

  const tradeInsights = {
    total_invoices: stats.invoices_fetched,
    total_line_items: stats.line_items_found,
    total_suppliers: supplierNames.size,
    top_sellers: topSellers,
    top_products: topProducts,
    buying_countries: buyingCountries,
    currencies,
    synced_at: new Date().toISOString(),
  };

  // ── Update last sync timestamp ───────────────────────────────────────────
  await supabase.from("erp_integration")
    .update({ lastsyncat: new Date().toISOString() })
    .eq("integrationid", integration.integrationid);

  // ── Store trade insights ───────────────────────────────────────────────
  await supabase.from("tenant_behaviour_log").insert({
    tenantid: tenantId,
    eventtype: "TRADE_INSIGHTS",
    eventdata: tradeInsights,
  }).then(() => {});

  // ── Log sync event ─────────────────────────────────────────────────────
  await supabase.from("tenant_behaviour_log").insert({
    tenantid: tenantId,
    eventtype: "XERO_SYNC",
    eventdata: {
      invoices: stats.invoices_fetched,
      line_items: stats.line_items_found,
    },
  }).then(() => {});

  return json({
    status: "ok",
    stats,
    suppliers: supplierSummary,
    top_line_items: topItems,
    suppliers_by_country: Object.fromEntries(
      Array.from(new Set(supplierCountries.values()))
        .map(c => [c, [...supplierCountries.values()].filter(v => v === c).length])
    ),
  });
});


// ── Helpers ──────────────────────────────────────────────────────────────────

async function refreshToken(
  integration: any,
  supabase: ReturnType<typeof createClient>,
): Promise<{ access_token?: string; error?: string }> {
  const config = integration.mappingconfig as Record<string, unknown>;
  const refreshTokenVal = config?.refresh_token as string;

  const clientId = Deno.env.get("XERO_CLIENT_ID")!;
  const clientSecret = Deno.env.get("XERO_CLIENT_SECRET")!;

  const resp = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshTokenVal,
    }),
  });

  if (!resp.ok) {
    return { error: await resp.text() };
  }

  const tokens = await resp.json();

  await supabase.from("erp_integration")
    .update({
      mappingconfig: {
        ...config,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + (tokens.expires_in * 1000),
      },
    })
    .eq("integrationid", integration.integrationid);

  return { access_token: tokens.access_token };
}

function resolveCountryCode(countryName: string): string | null {
  const normalized = countryName.toLowerCase().trim();
  return COUNTRY_MAP[normalized] || null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}
