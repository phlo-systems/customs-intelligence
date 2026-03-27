// supabase/functions/acumatica-sync/index.ts
// Deploy: supabase functions deploy acumatica-sync --no-verify-jwt
//
// Pulls Purchase Orders + Sales Orders from Acumatica, aggregates trade
// insights (top suppliers, customers, products, countries), converts to USD.
//
// POST /acumatica-sync
//   { "full": true }  — force full refresh (ignores lastsyncat)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
};

const COUNTRY_MAP: Record<string, string> = {
  "south africa": "ZA", "united kingdom": "GB", "uk": "GB", "india": "IN",
  "brazil": "BR", "australia": "AU", "thailand": "TH", "mexico": "MX",
  "chile": "CL", "philippines": "PH", "argentina": "AR", "uruguay": "UY",
  "saudi arabia": "SA", "united arab emirates": "AE", "uae": "AE",
  "oman": "OM", "angola": "AO", "mauritius": "MU", "namibia": "NA",
  "china": "CN", "germany": "DE", "france": "FR", "united states": "US",
  "usa": "US", "canada": "CA", "singapore": "SG", "japan": "JP",
  "nigeria": "NG", "ghana": "GH", "kenya": "KE",
};

const CURRENCY_COUNTRY: Record<string, string> = {
  GBP: "GB", USD: "US", EUR: "EU", INR: "IN", ZAR: "ZA", NGN: "NG",
  BRL: "BR", AUD: "AU", THB: "TH", MXN: "MX", CLP: "CL", PHP: "PH",
  ARS: "AR", UYU: "UY", SAR: "SA", AED: "AE", OMR: "OM", AOA: "AO",
  MUR: "MU", NAD: "NA", GHS: "GH", SGD: "SG", JPY: "JP", CNY: "CN",
  CAD: "CA", CHF: "CH", KES: "KE", NZD: "NZ",
};

// Helper: unwrap Acumatica's {"value": x} pattern
const v = (field: any): any => field?.value ?? field ?? null;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json({ ok: true }, 200);
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ── Auth ─────────────────────────────────────────────────────────────────
  // ── Resolve tenant (JWT or API key) ─────────────────────────────────────
  let tenantId: string | null = null;

  // Try JWT first (from frontend login)
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.replace("Bearer ", "");
    const { data: { user } } = await supabase.auth.getUser(token);
    if (user) tenantId = user.id;
  }

  // Fall back to X-API-Key (programmatic access)
  if (!tenantId) {
    const rawKey = req.headers.get("x-api-key");
    if (rawKey) {
      const keyHash = await sha256hex(rawKey);
      const { data: keyRow } = await supabase
        .from("api_key")
        .select("tenantuid")
        .eq("keyhash", keyHash)
        .eq("isactive", true)
        .maybeSingle();
      if (keyRow?.tenantuid) tenantId = keyRow.tenantuid;
    }
  }

  if (!tenantId) return json({ error: "Authentication required. Provide Authorization: Bearer <token> or X-API-Key header." }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch {}

  // ── Get Acumatica integration ──────────────────────────────────────────
  const { data: integration } = await supabase
    .from("erp_integration")
    .select("*")
    .eq("tenantid", tenantId)
    .eq("erptype", "ACUMATICA")
    .eq("isactive", true)
    .maybeSingle();

  if (!integration) {
    return json({ error: "No active Acumatica connection. Connect via Profile tab first." }, 404);
  }

  const config = integration.mappingconfig as Record<string, unknown>;
  const instanceUrl = (config.instance_url as string).replace(/\/+$/, "");
  const apiVersion = (config.api_version as string) || "24.200.001";
  let accessToken = config.access_token as string;

  // Check token expiry and refresh if needed
  const expiresAt = config.expires_at as number || 0;
  if (Date.now() > expiresAt - 60000) {
    const refreshResult = await refreshToken(integration, supabase);
    if (refreshResult.error) {
      return json({ error: "Token refresh failed", detail: refreshResult.error }, 502);
    }
    accessToken = refreshResult.access_token!;
  }

  // Incremental sync
  let sinceFilter = "";
  if (!body.full && integration.lastsyncat) {
    const since = integration.lastsyncat as string;
    sinceFilter = ` and LastModifiedDateTime gt datetimeoffset'${since}'`;
    console.log("Incremental sync since:", since);
  }

  const apiHeaders = {
    "Authorization": `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
  const apiBase = `${instanceUrl}/entity/Default/${apiVersion}`;

  // ── Fetch FX rates ─────────────────────────────────────────────────────
  let fxRates: Record<string, number> = { USD: 1 };
  let fxDate = "";
  try {
    const fxResp = await fetch("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(10000) });
    if (fxResp.ok) {
      const fxData = await fxResp.json();
      fxRates = fxData.rates || { USD: 1 };
      fxDate = fxData.time_last_update_utc || "";
    }
  } catch {}

  const toUSD = (amount: number, currency: string): number => {
    if (currency === "USD") return amount;
    const rate = fxRates[currency];
    return rate ? amount / rate : amount;
  };

  const stats = { purchase_orders: 0, sales_orders: 0, line_items: 0, errors: [] as string[] };

  // ── Fetch paginated data ───────────────────────────────────────────────
  const fetchAll = async (entity: string, filter: string): Promise<any[]> => {
    const all: any[] = [];
    let skip = 0;
    const top = 200;

    while (true) {
      const url = `${apiBase}/${entity}?$expand=Details&$top=${top}&$skip=${skip}&$filter=${encodeURIComponent(filter)}`;

      const resp = await fetch(url, { headers: apiHeaders });
      if (!resp.ok) {
        const err = await resp.text();
        stats.errors.push(`${entity} skip=${skip}: ${resp.status} ${err.substring(0, 100)}`);
        break;
      }

      const data = await resp.json();
      if (!Array.isArray(data) || data.length === 0) break;

      all.push(...data);
      if (data.length < top) break;
      skip += top;

      await sleep(500);
    }
    return all;
  };

  // Fetch Purchase Orders
  const poFilter = `Status ne 'Cancelled'${sinceFilter}`;
  const purchaseOrders = await fetchAll("PurchaseOrder", poFilter);
  stats.purchase_orders = purchaseOrders.length;

  // Fetch Sales Orders
  const soFilter = `Status ne 'Cancelled'${sinceFilter}`;
  const salesOrders = await fetchAll("SalesOrder", soFilter);
  stats.sales_orders = salesOrders.length;

  // ── Vendor/Customer country cache ──────────────────────────────────────
  const vendorCountry = new Map<string, string>();
  const customerCountry = new Map<string, string>();

  const resolveVendorCountry = async (vendorId: string): Promise<string | null> => {
    if (!vendorId) return null;
    if (vendorCountry.has(vendorId)) return vendorCountry.get(vendorId)!;

    try {
      const resp = await fetch(`${apiBase}/Vendor/${encodeURIComponent(vendorId)}?$select=VendorID,VendorName,MainContact`, { headers: apiHeaders });
      if (resp.ok) {
        const data = await resp.json();
        const country = v(data?.MainContact?.Address?.Country);
        if (country) {
          const code = country.length === 2 ? country.toUpperCase() : (COUNTRY_MAP[country.toLowerCase()] || null);
          if (code) { vendorCountry.set(vendorId, code); return code; }
        }
      }
      await sleep(300);
    } catch {}
    return null;
  };

  const resolveCustomerCountry = async (customerId: string): Promise<string | null> => {
    if (!customerId) return null;
    if (customerCountry.has(customerId)) return customerCountry.get(customerId)!;

    try {
      const resp = await fetch(`${apiBase}/Customer/${encodeURIComponent(customerId)}?$select=CustomerID,CustomerName,MainContact`, { headers: apiHeaders });
      if (resp.ok) {
        const data = await resp.json();
        const country = v(data?.MainContact?.Address?.Country);
        if (country) {
          const code = country.length === 2 ? country.toUpperCase() : (COUNTRY_MAP[country.toLowerCase()] || null);
          if (code) { customerCountry.set(customerId, code); return code; }
        }
      }
      await sleep(300);
    } catch {}
    return null;
  };

  // ── Process orders ─────────────────────────────────────────────────────
  type SpendMap = Map<string, number>;

  const processOrders = async (
    orders: any[],
    contactField: string,
    resolveCountry: (id: string) => Promise<string | null>,
  ) => {
    const contactSpend: SpendMap = new Map();
    const contactNames = new Map<string, string>();
    const contactCountries = new Map<string, string | null>();
    const productSpend = new Map<string, { usd: number; count: number }>();
    const currencyTotals = new Map<string, { original: number; usd: number }>();

    for (const order of orders) {
      const currency = v(order.CurrencyID) || "USD";
      const contactId = v(order[contactField]) || "Unknown";
      const total = v(order.OrderTotal) || 0;
      const totalUSD = toUSD(total, currency);

      contactNames.set(contactId, contactId); // Use ID as name fallback
      contactSpend.set(contactId, (contactSpend.get(contactId) || 0) + totalUSD);

      const ce = currencyTotals.get(currency) || { original: 0, usd: 0 };
      ce.original += total;
      ce.usd += totalUSD;
      currencyTotals.set(currency, ce);

      // Resolve country (limit to first 50 unique contacts to avoid rate limits)
      if (!contactCountries.has(contactId) && contactCountries.size < 50) {
        const country = await resolveCountry(contactId);
        contactCountries.set(contactId, country);
      }

      // Line items
      for (const line of (order.Details || [])) {
        stats.line_items++;
        const desc = v(line.LineDescription) || v(line.Description) || "";
        const lineAmt = v(line.ExtendedCost) || v(line.ExtendedPrice) || 0;
        const lineUSD = toUSD(lineAmt, currency);

        if (desc.length >= 5) {
          const key = desc.substring(0, 60).toLowerCase().trim();
          const ep = productSpend.get(key) || { usd: 0, count: 0 };
          ep.usd += lineUSD;
          ep.count++;
          productSpend.set(key, ep);
        }
      }
    }

    const topContacts = Array.from(contactSpend.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, usd]) => ({
        name: contactNames.get(id) || id,
        country: contactCountries.get(id) || null,
        total_spend_usd: Math.round(usd),
      }));

    const topProducts = Array.from(productSpend.entries())
      .sort((a, b) => b[1].usd - a[1].usd)
      .slice(0, 10)
      .map(([desc, data]) => ({
        description: desc,
        total_spend_usd: Math.round(data.usd),
        invoice_count: data.count,
      }));

    const currencies = Array.from(currencyTotals.entries())
      .sort((a, b) => b[1].usd - a[1].usd)
      .map(([code, data]) => ({ currency: code, total_original: Math.round(data.original), total_usd: Math.round(data.usd), fx_rate: fxRates[code] || null }));

    // Countries from contacts + currencies
    const countrySpend = new Map<string, number>();
    for (const [id, usd] of contactSpend) {
      const country = contactCountries.get(id);
      if (country) countrySpend.set(country, (countrySpend.get(country) || 0) + usd);
    }
    for (const c of currencies) {
      const country = CURRENCY_COUNTRY[c.currency];
      if (country && !countrySpend.has(country)) countrySpend.set(country, c.total_usd);
    }
    const countries = Array.from(countrySpend.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([code, usd]) => ({ country: code, total_spend_usd: Math.round(usd) }));

    return { topContacts, topProducts, currencies, countries };
  };

  const purchases = await processOrders(purchaseOrders, "VendorID", resolveVendorCountry);
  const sales = await processOrders(salesOrders, "CustomerID", resolveCustomerCountry);

  // FX footnote
  const usedCurrencies = new Set([
    ...purchases.currencies.map(c => c.currency),
    ...sales.currencies.map(c => c.currency),
  ]);
  const fxFootnote: Record<string, number> = {};
  for (const curr of usedCurrencies) {
    if (curr !== "USD" && fxRates[curr]) fxFootnote[curr] = fxRates[curr];
  }

  const tradeInsights = {
    purchase_invoices: stats.purchase_orders,
    sales_invoices: stats.sales_orders,
    total_line_items: stats.line_items,
    total_contacts: vendorCountry.size + customerCountry.size,
    top_suppliers: purchases.topContacts,
    top_products_purchased: purchases.topProducts,
    top_customers: sales.topContacts,
    top_products_sold: sales.topProducts,
    buying_countries: purchases.countries,
    selling_countries: sales.countries,
    purchase_currencies: purchases.currencies,
    sales_currencies: sales.currencies,
    fx_rates: fxFootnote,
    fx_date: fxDate,
    synced_at: new Date().toISOString(),
  };

  // ── Store insights ─────────────────────────────────────────────────────
  const existingConfig = integration.mappingconfig as Record<string, unknown> || {};
  const existingInsights = existingConfig.trade_insights as Record<string, unknown> || null;

  let finalInsights = tradeInsights;
  if (sinceFilter && existingInsights && (stats.purchase_orders + stats.sales_orders) < 50) {
    finalInsights = { ...existingInsights as any, synced_at: tradeInsights.synced_at, fx_rates: tradeInsights.fx_rates, fx_date: tradeInsights.fx_date };
  }

  await supabase.from("erp_integration").update({
    lastsyncat: new Date().toISOString(),
    mappingconfig: { ...existingConfig, trade_insights: finalInsights },
  }).eq("integrationid", integration.integrationid);

  return json({ status: "ok", stats, trade_insights: tradeInsights });
});


// ── Helpers ──────────────────────────────────────────────────────────────────

async function refreshToken(
  integration: any,
  supabase: ReturnType<typeof createClient>,
): Promise<{ access_token?: string; error?: string }> {
  const config = integration.mappingconfig as Record<string, unknown>;
  const instanceUrl = (config.instance_url as string).replace(/\/+$/, "");

  const params: Record<string, string> = {
    client_id: config.client_id as string,
    client_secret: config.client_secret as string,
  };

  if (config.auth_method === "client_credentials") {
    params.grant_type = "client_credentials";
    params.scope = "api";
  } else {
    params.grant_type = "refresh_token";
    params.refresh_token = config.refresh_token as string;
  }

  const resp = await fetch(`${instanceUrl}/identity/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });

  if (!resp.ok) return { error: await resp.text() };

  const tokens = await resp.json();
  await supabase.from("erp_integration").update({
    mappingconfig: {
      ...config,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || config.refresh_token,
      expires_at: Date.now() + ((tokens.expires_in || 3600) * 1000),
    },
  }).eq("integrationid", integration.integrationid);

  return { access_token: tokens.access_token };
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
