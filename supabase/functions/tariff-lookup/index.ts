// supabase/functions/tariff-lookup/index.ts
// Deploy: supabase functions deploy tariff-lookup
// Call:   POST /functions/v1/tariff-lookup
//
// Request body:
// {
//   "export_country":  "GB",
//   "import_country":  "ZA",
//   "commodity_code":  "20041010",
//   "customs_value":   10000,
//   "currency":        "ZAR"   // optional, default ZAR
// }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
};

Deno.serve(async (req: Request) => {

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "POST required" }, 405);
  }

  // ── Parse and validate request body ──────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const exportCountry = str(body.export_country);
  const importCountry = str(body.import_country);
  const commodityCode = str(body.commodity_code);
  const customsValue  = num(body.customs_value);
  const currency      = str(body.currency) || "ZAR";

  if (!exportCountry || exportCountry.length !== 2) {
    return json({ error: "export_country must be a 2-letter ISO code" }, 400);
  }
  if (!importCountry || importCountry.length !== 2) {
    return json({ error: "import_country must be a 2-letter ISO code" }, 400);
  }
  if (!commodityCode) {
    return json({ error: "commodity_code is required" }, 400);
  }
  if (customsValue === null || customsValue <= 0) {
    return json({ error: "customs_value must be a positive number" }, 400);
  }

  // ── Supabase client (service role — bypasses RLS for tariff reference data) ─
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ── Call get_landed_cost() Postgres function ──────────────────────────────
  const { data, error } = await supabase.rpc("get_landed_cost", {
    p_export_country: exportCountry.toUpperCase(),
    p_import_country: importCountry.toUpperCase(),
    p_commodity_code: commodityCode,
    p_customs_value:  customsValue,
    p_currency:       currency.toUpperCase(),
  });

  if (error) {
    console.error("RPC error:", error);
    return json({ error: error.message }, 500);
  }

  // get_landed_cost returns a single JSONB object
  const result = Array.isArray(data) ? data[0] : data;

  // Map status to HTTP code
  const status = result?.status;
  if (status === "BLOCKED") return json(result, 403);
  if (status === "error")   return json(result, 404);

  return json(result, 200);
});


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
