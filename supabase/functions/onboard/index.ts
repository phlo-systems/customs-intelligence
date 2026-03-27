// supabase/functions/onboard/index.ts
// Deploy: supabase functions deploy onboard --no-verify-jwt
//
// POST /functions/v1/onboard  — write/update tenant context (Layer 1)
// GET  /functions/v1/onboard  — read current tenant context
//
// Auth: X-API-Key header (same key as tariff-lookup)
//
// POST body (all fields optional — only provided fields are updated):
// {
//   "business_type":       "IMPORTER",          // TRADER|IMPORTER|EXPORTER|MANUFACTURER
//   "primary_hs_chapters": ["20", "74", "18"],  // HS chapter numbers
//   "annual_volume_range": "2M-10M",            // <500K|500K-2M|2M-10M|10M-50M|50M+
//   "target_markets":      ["ZA", "MU", "NA"],  // ISO country codes
//   "active_origins":      ["GB", "BR"],        // countries they source FROM
//   "active_destinations": ["ZA", "AO"]         // countries they sell TO
// }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
};

const VALID_BUSINESS_TYPES = ["TRADER", "IMPORTER", "EXPORTER", "MANUFACTURER"];
const VALID_VOLUME_RANGES   = ["<500K", "500K-2M", "2M-10M", "10M-50M", "50M+"];

Deno.serve(async (req: Request) => {

  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

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

  const tenantUID: string = tenantId;

  // ── GET — return current context ───────────────────────────────────────────
  if (req.method === "GET") {
    const { data, error } = await supabase
      .from("tenant_context")
      .select("*")
      .eq("tenantid", tenantUID)
      .maybeSingle();

    if (error) return json({ error: error.message }, 500);
    if (!data)  return json({ message: "No context found. POST to /onboard to set up your profile." }, 404);
    return json(data, 200);
  }

  // ── POST — write/update context ────────────────────────────────────────────
  if (req.method !== "POST") return json({ error: "GET or POST required" }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return json({ error: "Invalid JSON body" }, 400); }

  // Validate fields if provided
  if (body.business_type && !VALID_BUSINESS_TYPES.includes(str(body.business_type)!)) {
    return json({ error: `business_type must be one of: ${VALID_BUSINESS_TYPES.join(", ")}` }, 400);
  }
  if (body.annual_volume_range && !VALID_VOLUME_RANGES.includes(str(body.annual_volume_range)!)) {
    return json({ error: `annual_volume_range must be one of: ${VALID_VOLUME_RANGES.join(", ")}` }, 400);
  }
  if (body.primary_hs_chapters && !Array.isArray(body.primary_hs_chapters)) {
    return json({ error: "primary_hs_chapters must be an array" }, 400);
  }
  if (body.target_markets && !Array.isArray(body.target_markets)) {
    return json({ error: "target_markets must be an array of ISO country codes" }, 400);
  }
  if (body.active_origins && !Array.isArray(body.active_origins)) {
    return json({ error: "active_origins must be an array of ISO country codes" }, 400);
  }
  if (body.active_destinations && !Array.isArray(body.active_destinations)) {
    return json({ error: "active_destinations must be an array of ISO country codes" }, 400);
  }

  // Build upsert payload — only include fields that were provided
  const payload: Record<string, unknown> = {
    tenantid:  tenantUID,
    updatedat: new Date().toISOString(),
  };

  if (body.business_type       !== undefined) payload.businesstype          = str(body.business_type);
  if (body.primary_hs_chapters !== undefined) payload.primaryhschapters     = body.primary_hs_chapters;
  if (body.annual_volume_range !== undefined) payload.annualvolumerange      = str(body.annual_volume_range);
  if (body.target_markets      !== undefined) payload.targetmarkets          = body.target_markets;
  if (body.active_origins      !== undefined) payload.activeorigincountries  = body.active_origins;
  if (body.active_destinations !== undefined) payload.activedestcountries    = body.active_destinations;

  const { data, error } = await supabase
    .from("tenant_context")
    .upsert(payload, { onConflict: "tenantid" })
    .select()
    .single();

  if (error) {
    console.error("Upsert error:", error);
    return json({ error: error.message }, 500);
  }

  return json({
    status:  "ok",
    message: "Tenant context updated",
    tenant_id: tenantUID,
    context: data,
  }, 200);
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

async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}
