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
  try { body = await req.json(); } catch { /* empty body ok */ }

  // Use last sync time for incremental sync; manual override via body.since; body.full=true forces full refresh
  let sinceDate = body.since ? String(body.since) : null;

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

  // Auto-set sinceDate from last sync if not manually provided and not a full refresh
  if (!sinceDate && !body.full && integration.lastsyncat) {
    sinceDate = integration.lastsyncat.split("T")[0]; // YYYY-MM-DD
    console.log("Incremental sync since:", sinceDate);
  }

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

  // ── Fetch FX rates ──────────────────────────────────────────────────────
  let fxRates: Record<string, number> = { USD: 1 };
  let fxDate = "";
  try {
    const fxResp = await fetch("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(10000) });
    if (fxResp.ok) {
      const fxData = await fxResp.json();
      fxRates = fxData.rates || { USD: 1 };
      fxDate = fxData.time_last_update_utc || "";
    }
  } catch { /* use defaults */ }

  const toUSD = (amount: number, currency: string): number => {
    if (currency === "USD") return amount;
    const rate = fxRates[currency];
    return rate ? amount / rate : amount; // If no rate, return as-is
  };

  // ── Fetch invoices (both ACCPAY and ACCREC) ────────────────────────────
  const stats = {
    purchase_invoices: 0,
    sales_invoices: 0,
    line_items_found: 0,
    suppliers_mapped: 0,
    errors: [] as string[],
  };

  const fetchInvoices = async (type: string): Promise<any[]> => {
    const all: any[] = [];
    let page = 1;
    while (true) {
      let url = `${XERO_API_BASE}/Invoices?where=Type=="${type}"&page=${page}`;
      if (sinceDate) url += `&ModifiedAfter=${sinceDate}T00:00:00`;

      const resp = await fetch(url, { headers: xeroHeaders });

      if (resp.status === 429) {
        const retryAfter = Number(resp.headers.get("Retry-After") || "60");
        await sleep(retryAfter * 1000);
        continue;
      }
      if (!resp.ok) {
        stats.errors.push(`${type} page ${page}: ${resp.status}`);
        break;
      }

      const data = await resp.json();
      const invoices = data.Invoices || [];
      all.push(...invoices);
      if (invoices.length < 100) break;
      page++;
      await sleep(1000);
    }
    return all;
  };

  const purchaseInvoices = await fetchInvoices("ACCPAY");
  stats.purchase_invoices = purchaseInvoices.length;
  console.log(`Fetched ${purchaseInvoices.length} ACCPAY invoices`);

  const salesInvoices = await fetchInvoices("ACCREC");
  stats.sales_invoices = salesInvoices.length;
  console.log(`Fetched ${salesInvoices.length} ACCREC invoices`);

  // ── Process invoices ─────────────────────────────────────────────────────
  type ContactInfo = { name: string; country: string | null };
  const contacts = new Map<string, ContactInfo>();

  const processInvoices = (invoices: any[]) => {
    const spendByContact = new Map<string, number>();
    const spendByProduct = new Map<string, { total_usd: number; count: number }>();
    const spendByCurrency = new Map<string, { original: number; usd: number }>();
    const items: Array<{ description: string; amount_usd: number; contact: string; currency: string }> = [];

    for (const inv of invoices) {
      const currency = inv.CurrencyCode || "GBP";
      const contact = inv.Contact || {};
      const contactId = contact.ContactID || "";
      const contactName = contact.Name || "Unknown";

      // Resolve contact country
      if (!contacts.has(contactId)) {
        let country: string | null = null;
        if (contact.Addresses) {
          for (const addr of contact.Addresses) {
            if (addr.Country) {
              country = resolveCountryCode(addr.Country);
              if (country) break;
            }
          }
        }
        contacts.set(contactId, { name: contactName, country });
      }

      // Aggregate by contact
      const invTotal = inv.Total || 0;
      const invUSD = toUSD(invTotal, currency);
      spendByContact.set(contactId, (spendByContact.get(contactId) || 0) + invUSD);

      // Currency totals
      const existing = spendByCurrency.get(currency) || { original: 0, usd: 0 };
      existing.original += invTotal;
      existing.usd += invUSD;
      spendByCurrency.set(currency, existing);

      // Line items
      for (const item of (inv.LineItems || [])) {
        stats.line_items_found++;
        const desc = item.Description || "";
        const lineAmt = item.LineAmount || 0;
        const lineUSD = toUSD(lineAmt, currency);

        if (desc.length >= 5) {
          items.push({ description: desc, amount_usd: lineUSD, contact: contactName, currency });

          const key = desc.substring(0, 60).toLowerCase().trim();
          const ep = spendByProduct.get(key) || { total_usd: 0, count: 0 };
          ep.total_usd += lineUSD;
          ep.count++;
          spendByProduct.set(key, ep);
        }
      }
    }

    // Build top contacts
    const topContacts = Array.from(spendByContact.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, usd]) => ({
        name: contacts.get(id)?.name || "Unknown",
        country: contacts.get(id)?.country || null,
        total_spend_usd: Math.round(usd),
      }));

    // Build top products
    const topProducts = Array.from(spendByProduct.entries())
      .sort((a, b) => b[1].total_usd - a[1].total_usd)
      .slice(0, 10)
      .map(([desc, data]) => ({
        description: desc,
        total_spend_usd: Math.round(data.total_usd),
        invoice_count: data.count,
      }));

    // Build currencies
    const currencies = Array.from(spendByCurrency.entries())
      .sort((a, b) => b[1].usd - a[1].usd)
      .map(([code, data]) => ({
        currency: code,
        total_original: Math.round(data.original),
        total_usd: Math.round(data.usd),
        fx_rate: fxRates[code] || null,
      }));

    return { topContacts, topProducts, currencies, items };
  };

  const purchases = processInvoices(purchaseInvoices);
  const sales = processInvoices(salesInvoices);

  // ── Build country breakdown from currencies ─────────────────────────────
  const CURRENCY_COUNTRY: Record<string, string> = {
    GBP: "GB", USD: "US", EUR: "EU", INR: "IN", ZAR: "ZA", NGN: "NG",
    BRL: "BR", AUD: "AU", THB: "TH", MXN: "MX", CLP: "CL", PHP: "PH",
    ARS: "AR", UYU: "UY", SAR: "SA", AED: "AE", OMR: "OM", AOA: "AO",
    MUR: "MU", NAD: "NA", DOP: "DO", GHS: "GH", KES: "KE", SGD: "SG",
    MYR: "MY", IDR: "ID", JPY: "JP", KRW: "KR", CNY: "CN", CAD: "CA",
    NZD: "NZ", CHF: "CH", SEK: "SE", NOK: "NO", DKK: "DK", PLN: "PL",
    TRY: "TR", EGP: "EG", BGN: "BG", RON: "RO", CZK: "CZ", HUF: "HU",
  };

  const buildCountries = (currencies: Array<{ currency: string; total_usd: number }>) => {
    const map = new Map<string, number>();
    for (const c of currencies) {
      const country = CURRENCY_COUNTRY[c.currency];
      if (country) map.set(country, (map.get(country) || 0) + c.total_usd);
    }
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([code, usd]) => ({ country: code, total_spend_usd: Math.round(usd) }));
  };

  // Build FX footnote
  const usedCurrencies = new Set([
    ...purchases.currencies.map(c => c.currency),
    ...sales.currencies.map(c => c.currency),
  ]);
  const fxFootnote: Record<string, number> = {};
  for (const curr of usedCurrencies) {
    if (curr !== "USD" && fxRates[curr]) fxFootnote[curr] = fxRates[curr];
  }

  const tradeInsights = {
    purchase_invoices: stats.purchase_invoices,
    sales_invoices: stats.sales_invoices,
    total_line_items: stats.line_items_found,
    total_contacts: contacts.size,
    top_suppliers: purchases.topContacts,
    top_products_purchased: purchases.topProducts,
    top_customers: sales.topContacts,
    top_products_sold: sales.topProducts,
    buying_countries: buildCountries(purchases.currencies),
    selling_countries: buildCountries(sales.currencies),
    purchase_currencies: purchases.currencies,
    sales_currencies: sales.currencies,
    fx_rates: fxFootnote,
    fx_date: fxDate,
    synced_at: new Date().toISOString(),
  };

  // ── Update last sync timestamp ───────────────────────────────────────────
  await supabase.from("erp_integration")
    .update({ lastsyncat: new Date().toISOString() })
    .eq("integrationid", integration.integrationid);

  // ── Store trade insights ─────────────────────────────────────────────────
  // For incremental syncs with few results, merge with existing insights
  const existingConfig = integration.mappingconfig as Record<string, unknown> || {};
  const existingInsights = existingConfig.trade_insights as Record<string, unknown> || null;

  let finalInsights = tradeInsights;
  if (sinceDate && existingInsights && (stats.purchase_invoices + stats.sales_invoices) < 50) {
    // Small incremental — keep existing, just update sync time
    finalInsights = { ...existingInsights, synced_at: tradeInsights.synced_at, fx_rates: tradeInsights.fx_rates, fx_date: tradeInsights.fx_date };
    console.log("Incremental: keeping existing insights, updating FX + timestamp");
  }

  await supabase.from("erp_integration")
    .update({
      mappingconfig: {
        ...existingConfig,
        trade_insights: finalInsights,
      },
    })
    .eq("integrationid", integration.integrationid);

  return json({
    status: "ok",
    stats,
    trade_insights: tradeInsights,
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
