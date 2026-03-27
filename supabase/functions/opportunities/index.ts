// supabase/functions/opportunities/index.ts
// Deploy: supabase functions deploy opportunities --no-verify-jwt
//
// GET /functions/v1/opportunities
// Returns opportunity cards for the authenticated tenant
//
// Query params:
//   ?limit=50          (default 50, max 200)
//   ?type=DUTY_REDUCTION  (filter by opportunity type)
//   ?min_saving=1000   (filter by minimum ZAR saving per 10K)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "GET required" }, 405);

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

  // ── Parse query params ─────────────────────────────────────────────────────
  const url        = new URL(req.url);
  const limit      = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const typeFilter = url.searchParams.get("type");
  const minSaving  = Number(url.searchParams.get("min_saving") ?? 0);

  // ── Fetch opportunities ────────────────────────────────────────────────────
  let query = supabase
    .from("opportunities")
    .select(`
      opportunityid, opportunitytype, subheadingcode,
      importcountrycode, exportcountrycode, agreementcode,
      savingpct, savingamtper10k, headline, aiinsight,
      aiinsightgeneratedat, isactioned, isdismissed,
      expiresat, detectedat
    `)
    .eq("tenantid", tenantId)
    .eq("isdismissed", false)
    .gte("savingamtper10k", minSaving)
    .order("savingamtper10k", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (typeFilter) {
    query = query.eq("opportunitytype", typeFilter.toUpperCase());
  }

  const { data: opps, error: oppsErr } = await query;
  if (oppsErr) return json({ error: oppsErr.message }, 500);

  // ── Summary stats ──────────────────────────────────────────────────────────
  const total     = opps?.length ?? 0;
  const topSaving = opps?.[0]?.savingamtper10k ?? 0;
  const types     = [...new Set(opps?.map((o: any) => o.opportunitytype))];

  return json({
    status:  "ok",
    summary: { total, top_saving_per_10k: topSaving, types },
    opportunities: opps ?? [],
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}
