// supabase/functions/enrich-opportunities/index.ts
// Deploy: supabase functions deploy enrich-opportunities --no-verify-jwt
//
// Processes OPPORTUNITIES rows where AIInsight IS NULL.
// Calls Claude to generate a 2-3 sentence contextual insight per card.
// Cost: ~£0.002 per card.
//
// Can be called:
//   - Manually: POST /functions/v1/enrich-opportunities (X-API-Key required)
//   - After rules engine: called internally by run_rules_engine trigger
//
// Optional body:
//   { "batch_size": 20, "tenant_id": "uuid" }  — defaults: batch=10, all tenants

import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.27.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
};

const OPPORTUNITY_TYPE_CONTEXT: Record<string, string> = {
  DUTY_REDUCTION:          "a duty saving opportunity where a preferential trade agreement reduces the import duty rate",
  COMPETITOR_DISADVANTAGE: "a competitive advantage where anti-dumping measures target competing origins but not yours",
  NEW_MARKET:              "a new market opportunity where tariff data is available for a route you haven't explored yet",
  EXPIRING_PREFERENCE:     "an expiring preferential rate that needs attention before the deadline",
  QUOTA_OPENED:            "a tariff rate quota that has opened, allowing imports at a lower duty rate",
  COMPLIANCE_EASE:         "a regulatory simplification that reduces the compliance burden for this trade route",
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

  // ── Parse options ──────────────────────────────────────────────────────────
  let batchSize = 10;

  if (req.method === "POST") {
    try {
      const body = await req.json();
      if (body.batch_size) batchSize = Math.min(Number(body.batch_size), 50);
    } catch { /* ignore — use defaults */ }
  }

  // ── Fetch unenriched opportunities (scoped to authenticated tenant) ───────
  const query = supabase
    .from("opportunities")
    .select(`
      opportunityid, tenantid, opportunitytype,
      subheadingcode, importcountrycode, exportcountrycode,
      agreementcode, savingpct, savingamtper10k, headline
    `)
    .eq("tenantid", tenantId)
    .is("aiinsight", null)
    .eq("isdismissed", false)
    .order("savingamtper10k", { ascending: false, nullsFirst: false })
    .limit(batchSize);

  const { data: opps, error: oppsErr } = await query;
  if (oppsErr) return json({ error: oppsErr.message }, 500);
  if (!opps || opps.length === 0) return json({ status: "ok", message: "No opportunities to enrich", enriched: 0 });

  // ── Fetch tenant contexts for all unique tenants in this batch ─────────────
  const tenantIds = [...new Set(opps.map((o: any) => o.tenantid))];
  const { data: contexts } = await supabase
    .from("tenant_context")
    .select("*")
    .in("tenantid", tenantIds);

  const contextMap = new Map((contexts ?? []).map((c: any) => [c.tenantid, c]));

  // ── Initialise Claude ──────────────────────────────────────────────────────
  const anthropic = new Anthropic({
    apiKey: Deno.env.get("ANTHROPIC_API_KEY")!,
  });

  // ── Enrich each opportunity ────────────────────────────────────────────────
  let enriched = 0;
  let errors   = 0;

  for (const opp of opps as any[]) {
    try {
      const context = contextMap.get(opp.tenantid);
      const insight = await generateInsight(anthropic, opp, context);

      const { error: updateErr } = await supabase
        .from("opportunities")
        .update({
          aiinsight:            insight,
          aiinsightgeneratedat: new Date().toISOString(),
        })
        .eq("opportunityid", opp.opportunityid);

      if (updateErr) {
        console.error(`Update failed for opp ${opp.opportunityid}:`, updateErr);
        errors++;
      } else {
        enriched++;
      }
    } catch (e) {
      console.error(`Enrichment failed for opp ${opp.opportunityid}:`, e);
      errors++;
    }
  }

  return json({
    status:   "ok",
    enriched,
    errors,
    remaining: opps.length - enriched,
  });
});


// ── Generate insight via Claude ───────────────────────────────────────────────

async function generateInsight(
  anthropic: Anthropic,
  opp: any,
  context: any,
): Promise<string> {

  const oppTypeDesc = OPPORTUNITY_TYPE_CONTEXT[opp.opportunitytype] ?? "a trade opportunity";

  // Build rich tenant context from all 5 layers
  let tenantDesc = "No detailed context available.";
  if (context) {
    const parts: string[] = [];
    // Layer 1: Onboarding
    parts.push(`Business type: ${context.businesstype ?? "trader"}`);
    if (context.primaryhschapters?.length) parts.push(`Primary HS chapters: ${context.primaryhschapters.join(", ")}`);
    if (context.annualvolumerange) parts.push(`Annual volume: ${context.annualvolumerange}`);
    // Layer 2: Product library
    if (context.activeorigincountries?.length) parts.push(`Source countries: ${context.activeorigincountries.join(", ")}`);
    if (context.activedestcountries?.length) parts.push(`Destination countries: ${context.activedestcountries.join(", ")}`);
    if (context.targetmarkets?.length) parts.push(`Target markets: ${context.targetmarkets.join(", ")}`);
    // Layer 3: Behavioral signals
    if (context.highinterestcountries?.length) parts.push(`High-interest countries (recent searches): ${context.highinterestcountries.join(", ")}`);
    if (context.primaryfocus) parts.push(`Primary focus: ${context.primaryfocus}`);
    // Layer 4: ERP data
    if (context.erpconnected) {
      parts.push(`ERP connected: ${context.erptype}`);
      if (context.topsuppliercountries?.length) parts.push(`Top supplier countries (from invoices): ${context.topsuppliercountries.join(", ")}`);
      if (context.topcustomercountries?.length) parts.push(`Top customer countries (from invoices): ${context.topcustomercountries.join(", ")}`);
      if (context.avgpovaluegbp) parts.push(`Avg PO value: GBP ${context.avgpovaluegbp}`);
    }
    // Layer 5: Email context
    if (context.emailconnected) {
      if (context.knowncompetitororigins?.length) parts.push(`Known competitor origins (from emails): ${context.knowncompetitororigins.join(", ")}`);
      if (context.knowntradebarriers?.length) parts.push(`Known trade barriers (from emails): ${context.knowntradebarriers.join(", ")}`);
    }
    tenantDesc = parts.join("\n");
  }

  const prompt = `You are a customs and trade intelligence analyst writing personalised insights for a specific trader.

TRADER PROFILE:
${tenantDesc}

OPPORTUNITY:
- Type: ${opp.opportunitytype} — ${oppTypeDesc}
- Headline: ${opp.headline ?? ""}
- HS subheading: ${opp.subheadingcode}
- Route: ${opp.exportcountrycode ?? "?"} → ${opp.importcountrycode ?? "?"}
- Agreement: ${opp.agreementcode ?? "N/A"}
- Duty saving: ${opp.savingpct ?? 0} percentage points
- Estimated saving per 10,000 shipment: ${opp.savingamtper10k ?? 0}

Write exactly 2-3 sentences that:
1. Connect this opportunity to the trader's SPECIFIC business — reference their trade routes, supplier countries, or product categories where relevant
2. Quantify the impact: use their avg PO value if available, otherwise use the saving percentage
3. Give ONE concrete next step (e.g. "request a Certificate of Origin from your GB supplier", "contact your freight forwarder about routing via...", "review the Rules of Origin for...")

RULES:
- Be direct and specific to THIS trader's situation
- If their ERP/email data reveals relevant supplier or competitor info, reference it
- If the opportunity involves a country they're already active in, acknowledge that
- If it involves a new market, frame it as expansion potential
- Start with the commodity or the route, never with "This opportunity" or "As a"
- No bullet points, no headings, plain English`;

  const message = await anthropic.messages.create({
    model:      "claude-sonnet-4-20250514",
    max_tokens: 150,
    messages: [{ role: "user", content: prompt }],
  });

  const content = message.content[0];
  if (content.type !== "text") throw new Error("Unexpected response type");
  return content.text.trim();
}


// ── Helpers ───────────────────────────────────────────────────────────────────

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
