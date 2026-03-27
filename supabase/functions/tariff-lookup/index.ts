// supabase/functions/tariff-lookup/index.ts
// Deploy: supabase functions deploy tariff-lookup --no-verify-jwt
//
// customs_value is now optional:
//   - Omit for rates-only response (duty %, VAT %, total border rate %)
//   - Include for full calculation with currency amounts

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
};

Deno.serve(async (req: Request) => {
  const startTime = Date.now();

  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json({ error: "POST required" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

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

  if (!tenantId) return json({ error: "Authentication required." }, 401);

  // ── Step 2: Parse request ──────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return json({ error: "Invalid JSON body" }, 400); }

  const exportCountry = str(body.export_country);
  const importCountry = str(body.import_country);
  const commodityCode = str(body.commodity_code);
  const customsValue  = body.customs_value !== undefined ? num(body.customs_value) : null;
  const currency      = str(body.currency) || "ZAR";

  if (exportCountry && exportCountry.length !== 2) return json({ error: "export_country must be a 2-letter ISO code" }, 400);
  if (!importCountry || importCountry.length !== 2) return json({ error: "import_country must be a 2-letter ISO code" }, 400);
  if (!commodityCode) return json({ error: "commodity_code is required" }, 400);
  if (body.customs_value !== undefined && (customsValue === null || customsValue <= 0)) {
    return json({ error: "customs_value must be a positive number" }, 400);
  }

  // ── Step 2b: Resolve commodity code to the country's national format ─────
  const resolvedCode = await resolveCode(supabase, commodityCode, importCountry.toUpperCase());
  if (!resolvedCode) {
    return json({
      status: "error",
      error: `Commodity code ${commodityCode} not found for ${importCountry.toUpperCase()}. Tried exact match, zero-padded, and prefix search.`,
    }, 404);
  }

  // ── Step 3: Call get_landed_cost() ────────────────────────────────────────
  const rpcParams: Record<string, unknown> = {
    p_import_country: importCountry.toUpperCase(),
    p_commodity_code: resolvedCode,
    p_export_country: exportCountry ? exportCountry.toUpperCase() : null,
    p_currency:       currency.toUpperCase(),
  };

  // Only pass customs_value if provided — NULL triggers rates-only mode
  if (customsValue !== null) {
    rpcParams.p_customs_value = customsValue;
  }

  const { data, error } = await supabase.rpc("get_landed_cost", rpcParams);

  if (error) {
    console.error("RPC error:", error);
    logUsage(supabase, tenantId, exportCountry, importCountry, commodityCode, "error", Date.now() - startTime);
    return json({ error: error.message }, 500);
  }

  const result = Array.isArray(data) ? data[0] : data;
  const status = result?.status ?? "error";

  // Add resolution info if input was transformed
  if (resolvedCode !== commodityCode && result?.input) {
    result.input.original_input = commodityCode;
    result.input.resolved_code = resolvedCode;
  }

  // ── Step 4: Log usage ──────────────────────────────────────────────────────
  logUsage(supabase, tenantId, exportCountry, importCountry, resolvedCode, status, Date.now() - startTime);

  if (status === "BLOCKED") return json(result, 403);
  if (status === "error")   return json(result, 404);
  return json(result, 200);
});


// ── Code resolution ──────────────────────────────────────────────────────────
// Accepts any length input and finds the matching national commodity code.
// Strategy: exact → zero-padded → zero-trimmed → best prefix match

async function resolveCode(
  supabase: ReturnType<typeof createClient>,
  input: string,
  country: string,
): Promise<string | null> {
  const clean = input.replace(/[^0-9]/g, "");
  if (!clean) return null;

  // 1. Exact match
  const { data: exact } = await supabase
    .from("commodity_code")
    .select("commoditycode")
    .eq("commoditycode", clean)
    .eq("countrycode", country)
    .eq("isactive", true)
    .maybeSingle();
  if (exact) return exact.commoditycode;

  // 2. Pad with trailing zeros (e.g. 8-digit input → 10-digit country)
  for (const len of [8, 10, 12]) {
    if (clean.length < len) {
      const padded = clean.padEnd(len, "0");
      const { data: pad } = await supabase
        .from("commodity_code")
        .select("commoditycode")
        .eq("commoditycode", padded)
        .eq("countrycode", country)
        .eq("isactive", true)
        .maybeSingle();
      if (pad) return pad.commoditycode;
    }
  }

  // 3. Trim trailing zeros (e.g. 10-digit input → 8-digit country)
  let trimmed = clean;
  while (trimmed.length > 6 && trimmed.endsWith("0")) {
    trimmed = trimmed.slice(0, -1);
    const { data: trim } = await supabase
      .from("commodity_code")
      .select("commoditycode")
      .eq("commoditycode", trimmed)
      .eq("countrycode", country)
      .eq("isactive", true)
      .maybeSingle();
    if (trim) return trim.commoditycode;
  }

  // 4. Prefix match — strip trailing zeros from input to find the core prefix,
  //    then find the first matching national code
  let prefix_input = clean;
  // Try the raw input as prefix first
  const { data: prefix } = await supabase
    .from("commodity_code")
    .select("commoditycode")
    .eq("countrycode", country)
    .eq("isactive", true)
    .like("commoditycode", prefix_input + "%")
    .order("commoditycode", { ascending: true })
    .limit(1);
  if (prefix?.length) return prefix[0].commoditycode;

  // 5. Strip trailing zeros and retry prefix (e.g. "880600" → "8806" prefix)
  let stripped = clean;
  while (stripped.length > 4 && stripped.endsWith("0")) {
    stripped = stripped.slice(0, -1);
  }
  if (stripped !== clean && stripped !== prefix_input) {
    const { data: strippedPrefix } = await supabase
      .from("commodity_code")
      .select("commoditycode")
      .eq("countrycode", country)
      .eq("isactive", true)
      .like("commoditycode", stripped + "%")
      .order("commoditycode", { ascending: true })
      .limit(1);
    if (strippedPrefix?.length) return strippedPrefix[0].commoditycode;
  }

  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return isFinite(n) ? n : null;
}

async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function logUsage(
  supabase: ReturnType<typeof createClient>,
  tid: string,
  exportCountry: string | null,
  importCountry: string | null,
  commodityCode: string | null,
  responseStatus: string,
  responseTimeMs: number,
): void {
  supabase.from("api_usage_log").insert({
    tenantid: tid,
    endpoint: "tariff-lookup",
    exportcountry: exportCountry?.toUpperCase(),
    importcountry: importCountry?.toUpperCase(),
    commoditycode: commodityCode,
    responsestatus: responseStatus,
    responsetimems: responseTimeMs,
  }).then(() => {}).catch((e: unknown) => console.error("Usage log failed:", e));
}
