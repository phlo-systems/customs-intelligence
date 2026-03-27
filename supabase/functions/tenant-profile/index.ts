// supabase/functions/tenant-profile/index.ts
// Deploy: supabase functions deploy tenant-profile --no-verify-jwt
//
// GET  /tenant-profile  — full profile: company info + Xero-derived insights + docs
// POST /tenant-profile  — update profile fields or upload context document
//
// POST body options:
//   { "action": "update", ...profile fields }
//   { "action": "upload_context", "document_text": "...", "document_name": "..." }
//     — Claude extracts trade context from document text

import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.27.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json({ ok: true }, 200);

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

  // ── GET — return full profile ────────────────────────────────────────────
  if (req.method === "GET") {
    // Fetch tenant context
    const { data: ctx } = await supabase
      .from("tenant_context")
      .select("*")
      .eq("tenantid", tenantId)
      .maybeSingle();

    // Fetch all active ERP connections
    const { data: erps } = await supabase
      .from("erp_integration")
      .select("erptype, erptenantid, mappingconfig, lastsyncat, isactive")
      .eq("tenantid", tenantId)
      .eq("isactive", true);

    const xeroErp = (erps || []).find((e: any) => e.erptype === "XERO");
    const acumaticaErp = (erps || []).find((e: any) => e.erptype === "ACUMATICA");

    // Get trade insights from whichever ERP has them
    const xeroConfig = xeroErp?.mappingconfig as Record<string, unknown> || {};
    const acuConfig = acumaticaErp?.mappingconfig as Record<string, unknown> || {};
    const tradeInsights = (xeroConfig?.trade_insights || acuConfig?.trade_insights || null) as Record<string, unknown> | null;

    // Context documents stored in tenant_context.conversationcontext
    const contextDocs = (ctx?.conversationcontext as any)?.documents || [];

    return json({
      profile: {
        business_type: ctx?.businesstype || null,
        annual_volume_range: ctx?.annualvolumerange || null,
        primary_hs_chapters: ctx?.primaryhschapters || [],
        active_origins: ctx?.activeorigincountries || [],
        active_destinations: ctx?.activedestcountries || [],
        target_markets: ctx?.targetmarkets || [],
        updated_at: ctx?.updatedat || null,
      },
      xero: {
        connected: !!xeroErp?.isactive,
        tenant_name: xeroConfig?.xero_tenant_name || null,
        last_sync_at: xeroErp?.lastsyncat || null,
      },
      acumatica: {
        connected: !!acumaticaErp?.isactive,
        company_name: acuConfig?.company_name || acuConfig?.instance_url || null,
        last_sync_at: acumaticaErp?.lastsyncat || null,
      },
      trade_insights: tradeInsights,
      context_documents: contextDocs,
    });
  }

  // ── POST — update profile or upload context ──────────────────────────────
  if (req.method !== "POST") return json({ error: "GET or POST required" }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const action = String(body.action || "update");

  // ── Update profile fields ──
  if (action === "update") {
    const payload: Record<string, unknown> = {
      tenantid: tenantId,
      updatedat: new Date().toISOString(),
    };

    if (body.business_type !== undefined) payload.businesstype = body.business_type;
    if (body.annual_volume_range !== undefined) payload.annualvolumerange = body.annual_volume_range;
    if (body.primary_hs_chapters !== undefined) payload.primaryhschapters = body.primary_hs_chapters;
    if (body.active_origins !== undefined) payload.activeorigincountries = body.active_origins;
    if (body.active_destinations !== undefined) payload.activedestcountries = body.active_destinations;
    if (body.target_markets !== undefined) payload.targetmarkets = body.target_markets;

    const { error } = await supabase
      .from("tenant_context")
      .upsert(payload, { onConflict: "tenantid" });

    if (error) return json({ error: error.message }, 500);
    return json({ status: "ok", message: "Profile updated" });
  }

  // ── Upload context document ──
  if (action === "upload_context") {
    const docText = String(body.document_text || "");
    const docName = String(body.document_name || "Untitled");

    if (!docText || docText.length < 20) {
      return json({ error: "document_text must be at least 20 characters" }, 400);
    }

    // Use Claude to extract trade context
    const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      messages: [{
        role: "user",
        content: `Extract trade intelligence context from this document. Return a JSON object with these fields:
- "summary": one paragraph summary of what this document tells us about the company's trade activities
- "products": array of product descriptions mentioned (e.g. "frozen potato chips", "stainless steel coils")
- "hs_chapters": array of likely HS chapter numbers (2-digit) based on the products
- "countries": array of country ISO codes mentioned or implied
- "suppliers": array of supplier/company names mentioned
- "buyers": array of buyer/customer names mentioned
- "trade_routes": array of objects {from: "XX", to: "YY"} for trade routes mentioned
- "key_facts": array of important facts about the company's trade (volumes, values, frequencies)

Return ONLY the JSON object, no markdown.

Document "${docName}":
${docText.substring(0, 8000)}`,
      }],
    });

    let extracted: Record<string, unknown> = {};
    const raw = message.content[0].type === "text" ? message.content[0].text.trim() : "{}";
    try {
      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      extracted = JSON.parse(cleaned);
    } catch {
      extracted = { summary: raw, error: "Could not parse structured extraction" };
    }

    // Store context document + auto-enrich tenant context
    const { data: existingCtx } = await supabase
      .from("tenant_context")
      .select("*")
      .eq("tenantid", tenantId)
      .maybeSingle();

    const existingDocs = (existingCtx?.conversationcontext as any)?.documents || [];
    const newDoc = {
      name: docName,
      summary: extracted.summary || "",
      products: extracted.products || [],
      hs_chapters: extracted.hs_chapters || [],
      countries: extracted.countries || [],
      suppliers: extracted.suppliers || [],
      buyers: extracted.buyers || [],
      trade_routes: extracted.trade_routes || [],
      key_facts: extracted.key_facts || [],
      extracted_at: new Date().toISOString(),
    };

    const mergedChapters = [...new Set([
      ...(existingCtx?.primaryhschapters || []),
      ...((extracted.hs_chapters as string[]) || []).map(String),
    ])];
    const mergedOrigins = [...new Set([
      ...(existingCtx?.activeorigincountries || []),
      ...((extracted.countries as string[]) || []),
    ])];

    await supabase.from("tenant_context").update({
      primaryhschapters: mergedChapters,
      activeorigincountries: mergedOrigins,
      conversationcontext: { documents: [newDoc, ...existingDocs].slice(0, 20) },
      updatedat: new Date().toISOString(),
    }).eq("tenantid", tenantId);

    return json({
      status: "ok",
      extracted,
    });
  }

  return json({ error: "Unknown action" }, 400);
});

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
