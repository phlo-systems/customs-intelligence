// supabase/functions/alerts/index.ts
// Deploy: supabase functions deploy alerts --no-verify-jwt
//
// GET  /alerts              — list active alerts
// POST /alerts              — dismiss or action an alert
//   { "action": "dismiss", "alert_id": 123 }
//   { "action": "actioned", "alert_id": 123 }
//   { "action": "generate" }  — run alert generation from current data

import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.27.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
};

const SEVERITY_ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json({ ok: true }, 200);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ── Auth ─────────────────────────────────────────────────────────────────
  const rawKey = req.headers.get("x-api-key");
  if (!rawKey) return json({ error: "Missing X-API-Key" }, 401);

  const keyHash = await sha256hex(rawKey);
  const { data: keyRow } = await supabase
    .from("api_key")
    .select("keyid, tenantid, tenantuid, isactive")
    .eq("keyhash", keyHash)
    .eq("isactive", true)
    .maybeSingle();

  if (!keyRow) return json({ error: "Invalid API key" }, 401);
  const tenantId = keyRow.tenantuid || keyRow.tenantid;

  // ── GET — list alerts ────────────────────────────────────────────────────
  if (req.method === "GET") {
    const url = new URL(req.url);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
    const severity = url.searchParams.get("severity");
    const type = url.searchParams.get("type");

    let query = supabase
      .from("alerts")
      .select("*")
      .eq("tenantid", tenantId)
      .eq("isdismissed", false)
      .order("detectedat", { ascending: false })
      .limit(limit);

    if (severity) query = query.eq("severity", severity);
    if (type) query = query.eq("alerttype", type);

    const { data: alerts, error } = await query;

    if (error) return json({ error: error.message }, 500);

    const counts = {
      total: (alerts || []).length,
      critical: (alerts || []).filter((a: any) => a.severity === "CRITICAL").length,
      high: (alerts || []).filter((a: any) => a.severity === "HIGH").length,
      medium: (alerts || []).filter((a: any) => a.severity === "MEDIUM").length,
      low: (alerts || []).filter((a: any) => a.severity === "LOW").length,
    };

    return json({ alerts: alerts || [], counts });
  }

  // ── POST — actions ───────────────────────────────────────────────────────
  if (req.method !== "POST") return json({ error: "GET or POST required" }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const action = String(body.action || "");

  if (action === "dismiss") {
    const alertId = Number(body.alert_id);
    if (!alertId) return json({ error: "alert_id required" }, 400);
    await supabase.from("alerts").update({ isdismissed: true }).eq("alertid", alertId).eq("tenantid", tenantId);
    return json({ status: "dismissed" });
  }

  if (action === "actioned") {
    const alertId = Number(body.alert_id);
    if (!alertId) return json({ error: "alert_id required" }, 400);
    await supabase.from("alerts").update({ isactioned: true }).eq("alertid", alertId).eq("tenantid", tenantId);
    return json({ status: "actioned" });
  }

  // ── Generate alerts from current data ──────────────────────────────────
  if (action === "generate") {
    const generated = await generateAlerts(supabase, tenantId);
    return json({ status: "ok", generated });
  }

  return json({ error: "Unknown action" }, 400);
});


// ── Alert generation ─────────────────────────────────────────────────────────

async function generateAlerts(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
): Promise<number> {
  // Fetch tenant context for relevance
  const { data: ctx } = await supabase
    .from("tenant_context")
    .select("primaryhschapters, activeorigincountries, activedestcountries")
    .eq("tenantid", tenantId)
    .maybeSingle();

  const hsChapters = ctx?.primaryhschapters || [];
  const origins = ctx?.activeorigincountries || [];
  const destinations = ctx?.activedestcountries || [];

  let alertCount = 0;

  // 1. Check for expiring preferential rates
  const { data: expiringPrefs } = await supabase
    .from("preferential_rate")
    .select("commoditycode, importcountrycode, exportcountrycode, agreementcode, effectiveto, prefrate")
    .not("effectiveto", "is", null)
    .lte("effectiveto", new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()) // within 90 days
    .gte("effectiveto", new Date().toISOString()) // not yet expired
    .limit(50);

  for (const pref of (expiringPrefs || [])) {
    const subheading = pref.commoditycode?.substring(0, 6);
    const chapter = subheading?.substring(0, 2);

    // Only alert if relevant to tenant
    if (hsChapters.length > 0 && !hsChapters.includes(chapter)) continue;

    const { error } = await supabase.from("alerts").upsert({
      tenantid: tenantId,
      alerttype: "EXPIRY_WARNING",
      severity: "HIGH",
      subheadingcode: subheading,
      countrycode: pref.importcountrycode,
      headline: `Preferential rate under ${pref.agreementcode} expires ${new Date(pref.effectiveto).toLocaleDateString()} for HS ${subheading} (${pref.exportcountrycode} → ${pref.importcountrycode})`,
      detail: `Current preferential rate: ${pref.prefrate}%. Review alternative sourcing or stock up before expiry.`,
      isdismissed: false,
      isactioned: false,
    }, { onConflict: "tenantid,alerttype,subheadingcode,countrycode" }).then(() => {});

    alertCount++;
  }

  // 2. Check for high MFN rates on active trade routes (duty reduction opportunities disguised as alerts)
  for (const origin of origins) {
    for (const dest of destinations) {
      const { data: highDuty } = await supabase
        .from("mfn_rate")
        .select("commoditycode, appliedmfnrate, dutyexpression")
        .eq("countrycode", dest)
        .eq("ratecategory", "APPLIED")
        .is("effectiveto", null)
        .gte("appliedmfnrate", 25)
        .limit(10);

      for (const rate of (highDuty || [])) {
        const subheading = rate.commoditycode?.substring(0, 6);
        const chapter = subheading?.substring(0, 2);
        if (hsChapters.length > 0 && !hsChapters.includes(chapter)) continue;

        await supabase.from("alerts").upsert({
          tenantid: tenantId,
          alerttype: "DUTY_INCREASE",
          severity: "MEDIUM",
          subheadingcode: subheading,
          countrycode: dest,
          headline: `High MFN duty ${rate.appliedmfnrate}% on HS ${subheading} importing into ${dest}`,
          detail: `MFN rate: ${rate.dutyexpression}. Check if a preferential rate is available under an active trade agreement for ${origin} → ${dest}.`,
          isdismissed: false,
          isactioned: false,
        }, { onConflict: "tenantid,alerttype,subheadingcode,countrycode" }).then(() => {});

        alertCount++;
      }
    }
  }

  // 3. Sanctions check on active routes
  const { data: sanctions } = await supabase
    .from("sanctions_measure")
    .select("countrycode, measuretype, description, effectivefrom")
    .eq("isactive", true)
    .limit(50);

  for (const sanction of (sanctions || [])) {
    if (origins.includes(sanction.countrycode) || destinations.includes(sanction.countrycode)) {
      await supabase.from("alerts").upsert({
        tenantid: tenantId,
        alerttype: "SANCTIONS_NEW",
        severity: "CRITICAL",
        countrycode: sanction.countrycode,
        headline: `Active sanctions on ${sanction.countrycode}: ${sanction.measuretype}`,
        detail: sanction.description || `Sanctions measure active since ${sanction.effectivefrom}. All trade must be checked for compliance.`,
        isdismissed: false,
        isactioned: false,
      }, { onConflict: "tenantid,alerttype,subheadingcode,countrycode" }).then(() => {});

      alertCount++;
    }
  }

  // 4. Generate AI-powered alerts using Claude based on tenant context
  if (hsChapters.length > 0 && origins.length > 0) {
    try {
      const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });

      const msg = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: `You are a customs trade intelligence analyst. Generate 3-5 alerts for a company with this profile:
- Business type: trader/importer
- HS chapters of interest: ${hsChapters.join(", ")}
- Source countries: ${origins.join(", ")}
- Destination countries: ${destinations.join(", ")}

Generate realistic, actionable trade alerts. Return ONLY a JSON array, no markdown. Each alert:
{
  "alert_type": "REGULATORY_CHANGE|DUTY_INCREASE|AD_INVESTIGATION|EXPIRY_WARNING",
  "severity": "CRITICAL|HIGH|MEDIUM|LOW",
  "subheading_code": "6-digit HS code or null",
  "country_code": "2-letter ISO",
  "headline": "Short alert headline",
  "detail": "2-3 sentence explanation with actionable advice"
}`,
        }],
      });

      let aiAlerts: any[] = [];
      const raw = msg.content[0].type === "text" ? msg.content[0].text.trim() : "[]";
      try {
        const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
        aiAlerts = JSON.parse(cleaned);
      } catch {}

      for (const alert of aiAlerts) {
        await supabase.from("alerts").insert({
          tenantid: tenantId,
          alerttype: alert.alert_type || "REGULATORY_CHANGE",
          severity: alert.severity || "MEDIUM",
          subheadingcode: alert.subheading_code || null,
          countrycode: alert.country_code || null,
          headline: alert.headline || "Trade alert",
          detail: alert.detail || "",
          isdismissed: false,
          isactioned: false,
        }).then(() => {});
        alertCount++;
      }
    } catch (e) {
      console.error("AI alert generation failed:", e);
    }
  }

  return alertCount;
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
