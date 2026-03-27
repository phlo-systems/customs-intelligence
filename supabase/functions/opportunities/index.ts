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

import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.27.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
};

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

  // ── POST: dismiss / dismiss_all ─────────────────────────────────────────
  if (req.method === "POST") {
    let body: Record<string, unknown>;
    try { body = await req.json(); }
    catch { return json({ error: "Invalid JSON" }, 400); }

    const action = String(body.action || "");

    if (action === "dismiss") {
      const ids = body.opportunity_ids;
      if (!Array.isArray(ids) || !ids.length) return json({ error: "opportunity_ids array required" }, 400);
      const { error } = await supabase
        .from("opportunities")
        .update({ isdismissed: true })
        .eq("tenantid", tenantId)
        .in("opportunityid", ids);
      if (error) return json({ error: error.message }, 500);
      return json({ status: "ok", dismissed: ids.length });
    }

    if (action === "dismiss_all") {
      const { error } = await supabase
        .from("opportunities")
        .update({ isdismissed: true })
        .eq("tenantid", tenantId)
        .eq("isdismissed", false);
      if (error) return json({ error: error.message }, 500);
      return json({ status: "ok", message: "All opportunities dismissed" });
    }

    if (action === "action") {
      const id = body.opportunity_id;
      if (!id) return json({ error: "opportunity_id required" }, 400);
      await supabase.from("opportunities").update({ isactioned: true }).eq("opportunityid", id).eq("tenantid", tenantId);
      return json({ status: "ok" });
    }

    if (action === "log_behaviour") {
      await supabase.from("tenant_behaviour_log").insert({
        tenantid: tenantId,
        actiontype: String(body.action_type || "OPPORTUNITY_VIEWED"),
        subheadingcode: body.subheading_code || null,
        importcountrycode: body.import_country || null,
        exportcountrycode: body.export_country || null,
        referenceid: body.reference_id || null,
      });
      return json({ status: "ok" });
    }

    if (action === "generate") {
      // Fetch tenant context
      const { data: ctx } = await supabase
        .from("tenant_context")
        .select("*")
        .eq("tenantid", tenantId)
        .maybeSingle();

      const hsChapters = ctx?.primaryhschapters || [];
      const origins = ctx?.activeorigincountries || [];
      const destinations = ctx?.activedestcountries || [];
      const markets = ctx?.targetmarkets || [];
      const businessType = ctx?.businesstype || "trader";
      const topSuppliers = ctx?.topsuppliercountries || [];
      const topCustomers = ctx?.topcustomercountries || [];

      if (hsChapters.length === 0 && origins.length === 0) {
        return json({ status: "ok", generated: 0, message: "Set up your trade profile first to generate opportunities." });
      }

      try {
        const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });
        const msg = await anthropic.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1500,
          messages: [{ role: "user", content: `You are a customs and trade intelligence analyst. Today is ${new Date().toISOString().split("T")[0]}.

Generate 5-8 trade OPPORTUNITIES for this company:
- Business type: ${businessType}
- Products (HS chapters): ${hsChapters.join(", ")}
- Buy from: ${origins.join(", ")}
- Sell to: ${destinations.join(", ")}
- Target markets: ${markets.join(", ")}
- Top supplier countries: ${topSuppliers.join(", ") || "unknown"}
- Top customer countries: ${topCustomers.join(", ") || "unknown"}

Focus on ACTIONABLE opportunities:
- Duty savings through FTAs or exemptions
- New markets with lower tariffs for their products
- Competitor disadvantages (where their origin has preferential access)
- Upcoming trade agreement benefits
- Drawback or duty relief schemes they could claim

Return ONLY a JSON array. Each opportunity:
{
  "opportunity_type": "DUTY_REDUCTION|NEW_FTA|COMPETITOR_DISADVANTAGE|NEW_MARKET|COMPLIANCE_EASE",
  "subheading_code": "6-digit HS or null",
  "import_country": "2-letter ISO",
  "export_country": "2-letter ISO or null",
  "saving_pct": number or null,
  "headline": "One-line headline",
  "insight": "2-3 sentences of actionable advice for this specific business"
}` }],
        });

        let aiOpps: any[] = [];
        const raw = msg.content[0].type === "text" ? msg.content[0].text.trim() : "[]";
        try {
          const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
          aiOpps = JSON.parse(cleaned);
        } catch { /* parse failed */ }

        let created = 0;
        for (const opp of aiOpps) {
          const headline = (opp.headline || "Trade opportunity").substring(0, 200);
          // Tag as AI-generated
          const insight = "[AI-GENERATED] " + (opp.insight || "");

          await supabase.from("opportunities").insert({
            tenantid: tenantId,
            opportunitytype: opp.opportunity_type || "NEW_MARKET",
            subheadingcode: opp.subheading_code || null,
            importcountrycode: opp.import_country || null,
            exportcountrycode: opp.export_country || null,
            savingpct: opp.saving_pct || null,
            savingamtper10k: opp.saving_pct ? Math.round(opp.saving_pct * 100) : null,
            headline: headline,
            aiinsight: insight,
            aiinsightgeneratedat: new Date().toISOString(),
            isdismissed: false,
            isactioned: false,
          });
          created++;
        }

        return json({ status: "ok", generated: created });
      } catch (e: unknown) {
        console.error("AI opportunity generation failed:", e);
        return json({ status: "ok", generated: 0, error: String(e) });
      }
    }

    return json({ error: "Unknown action. Use: dismiss, dismiss_all, generate, action, log_behaviour" }, 400);
  }

  if (req.method !== "GET") return json({ error: "GET or POST required" }, 405);

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
