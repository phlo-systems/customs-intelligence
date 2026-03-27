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
    const ids = body.alert_ids;
    if (Array.isArray(ids) && ids.length) {
      await supabase.from("alerts").update({ isdismissed: true }).eq("tenantid", tenantId).in("alertid", ids);
      return json({ status: "dismissed", count: ids.length });
    }
    const alertId = Number(body.alert_id);
    if (!alertId) return json({ error: "alert_id or alert_ids required" }, 400);
    await supabase.from("alerts").update({ isdismissed: true }).eq("alertid", alertId).eq("tenantid", tenantId);
    return json({ status: "dismissed" });
  }

  if (action === "dismiss_all") {
    const { error } = await supabase
      .from("alerts")
      .update({ isdismissed: true })
      .eq("tenantid", tenantId)
      .eq("isdismissed", false);
    if (error) return json({ error: error.message }, 500);
    return json({ status: "ok", message: "All alerts dismissed" });
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
          content: `You are a customs trade intelligence analyst. Today is ${new Date().toISOString().split("T")[0]}. Generate 3-5 CURRENT alerts for a company with this profile:
- Business type: trader/importer
- HS chapters of interest: ${hsChapters.join(", ")}
- Source countries: ${origins.join(", ")}
- Destination countries: ${destinations.join(", ")}

IMPORTANT: All alerts must be about current or upcoming events (March 2026 onwards). Do NOT reference past events. Focus on:
- Upcoming regulatory changes or duty reviews
- Current anti-dumping investigations
- Trade agreements under negotiation
- Seasonal quota openings
- Recent or imminent tariff schedule changes

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

      // Guardrail: verify each AI-proposed alert against actual DB data
      for (const alert of aiAlerts) {
        const hsCode = alert.subheading_code || null;
        const countryCode = alert.country_code || null;
        let verified = false;
        let verificationNote = "";

        if (hsCode && countryCode) {
          // Check 1: Does this HS code exist in our DB for this country?
          const { data: codeExists } = await supabase
            .from("commodity_code")
            .select("commoditycode, nationaldescription")
            .eq("countrycode", countryCode)
            .like("commoditycode", hsCode + "%")
            .eq("isactive", true)
            .limit(1)
            .maybeSingle();

          if (codeExists) {
            verified = true;
            verificationNote = `HS code verified: ${codeExists.commoditycode} — ${(codeExists.nationaldescription || "").substring(0, 60)}`;

            // Check 2: If alert mentions a rate, verify it
            if (alert.alert_type === "DUTY_INCREASE" || alert.alert_type === "REGULATORY_CHANGE") {
              const { data: rateData } = await supabase
                .from("mfn_rate")
                .select("appliedmfnrate, dutyexpression")
                .eq("countrycode", countryCode)
                .like("commoditycode", hsCode + "%")
                .is("effectiveto", null)
                .limit(1)
                .maybeSingle();

              if (rateData) {
                verificationNote += `. Current MFN rate: ${rateData.appliedmfnrate}%`;
              }
            }

            // Check 3: If alert is about AD, verify we have a matching measure
            if (alert.alert_type === "AD_INVESTIGATION") {
              const { data: adData } = await supabase
                .from("ad_measure")
                .select("admeasureid, adstatus, adcaseref")
                .eq("importcountrycode", countryCode)
                .like("commoditycode", hsCode + "%")
                .limit(1)
                .maybeSingle();

              if (adData) {
                verificationNote += `. AD measure confirmed: ${adData.adcaseref} (${adData.adstatus})`;
              } else {
                verificationNote += ". NOTE: No matching AD measure found in DB — AI claim unverified";
                verified = false;
              }
            }
          } else {
            verificationNote = `HS code ${hsCode} not found in DB for ${countryCode} — AI claim unverified`;
          }
        }

        // Build detail with verification tag
        const taggedDetail = (verified ? "[VERIFIED] " : "[AI-GENERATED] ") +
          (alert.detail || "") +
          (verificationNote ? "\n\n— Verification: " + verificationNote : "");

        await supabase.from("alerts").insert({
          tenantid: tenantId,
          alerttype: alert.alert_type || "REGULATORY_CHANGE",
          severity: verified ? (alert.severity || "MEDIUM") : "LOW",  // downgrade unverified
          subheadingcode: hsCode,
          countrycode: countryCode,
          headline: (verified ? "" : "⚠ ") + (alert.headline || "Trade alert"),
          detail: taggedDetail,
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
