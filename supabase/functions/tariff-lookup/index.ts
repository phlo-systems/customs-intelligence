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

  // ── Step 1: Validate API key ───────────────────────────────────────────────
  const rawKey = req.headers.get("x-api-key");
  if (!rawKey) return json({ error: "Missing X-API-Key header" }, 401);

  const keyHash = await sha256hex(rawKey);

  const { data: keyRow, error: keyErr } = await supabase
    .from("api_key")
    .select("keyid, tenantid, scopes, isactive, expiresat")
    .eq("keyhash", keyHash)
    .eq("isactive", true)
    .maybeSingle();

  if (keyErr || !keyRow) return json({ error: "Invalid API key" }, 401);
  if (keyRow.expiresat && new Date(keyRow.expiresat) < new Date()) return json({ error: "API key expired" }, 401);
  if (!keyRow.scopes?.includes("tariff:lookup")) return json({ error: "Insufficient scope" }, 403);

  supabase.from("api_key").update({ lastuseda: new Date().toISOString() }).eq("keyid", keyRow.keyid).then(() => {});

  // ── Step 2: Parse request ──────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return json({ error: "Invalid JSON body" }, 400); }

  const exportCountry = str(body.export_country);
  const importCountry = str(body.import_country);
  const commodityCode = str(body.commodity_code);
  const customsValue  = body.customs_value !== undefined ? num(body.customs_value) : null;
  const currency      = str(body.currency) || "ZAR";

  if (!exportCountry || exportCountry.length !== 2) return json({ error: "export_country must be a 2-letter ISO code" }, 400);
  if (!importCountry || importCountry.length !== 2) return json({ error: "import_country must be a 2-letter ISO code" }, 400);
  if (!commodityCode) return json({ error: "commodity_code is required" }, 400);
  if (body.customs_value !== undefined && (customsValue === null || customsValue <= 0)) {
    return json({ error: "customs_value must be a positive number" }, 400);
  }

  // ── Step 3: Call get_landed_cost() ────────────────────────────────────────
  const rpcParams: Record<string, unknown> = {
    p_export_country: exportCountry.toUpperCase(),
    p_import_country: importCountry.toUpperCase(),
    p_commodity_code: commodityCode,
    p_currency:       currency.toUpperCase(),
  };

  // Only pass customs_value if provided — NULL triggers rates-only mode
  if (customsValue !== null) {
    rpcParams.p_customs_value = customsValue;
  }

  const { data, error } = await supabase.rpc("get_landed_cost", rpcParams);

  if (error) {
    console.error("RPC error:", error);
    await logUsage(supabase, keyRow, exportCountry, importCountry, commodityCode, "error", Date.now() - startTime);
    return json({ error: error.message }, 500);
  }

  const result = Array.isArray(data) ? data[0] : data;
  const status = result?.status ?? "error";

  // ── Step 4: Log usage ──────────────────────────────────────────────────────
  await logUsage(supabase, keyRow, exportCountry, importCountry, commodityCode, status, Date.now() - startTime);

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

async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function logUsage(
  supabase: ReturnType<typeof createClient>,
  keyRow: { keyid: number; tenantid: string },
  exportCountry: string | null,
  importCountry: string | null,
  commodityCode: string | null,
  responseStatus: string,
  responseTimeMs: number,
): Promise<void> {
  try {
    await supabase.from("api_usage_log").insert({
      keyid: keyRow.keyid, tenantid: keyRow.tenantid,
      endpoint: "tariff-lookup",
      exportcountry: exportCountry?.toUpperCase(),
      importcountry: importCountry?.toUpperCase(),
      commoditycode: commodityCode,
      responsestatus: responseStatus,
      responsetimems: responseTimeMs,
    });
  } catch (e) { console.error("Usage log failed:", e); }
}
