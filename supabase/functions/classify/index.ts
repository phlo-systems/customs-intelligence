// supabase/functions/classify/index.ts
// Deploy: supabase functions deploy classify --no-verify-jwt
//
// POST /functions/v1/classify
// Takes a product description, returns top 3 ZA commodity code matches.
//
// Stage 1: Check PRODUCT_CLASSIFICATION_CACHE (instant, confidence=1.0)
// Stage 2: Claude LLM classification (< 3s)
// Logs every request to CLASSIFICATION_REQUEST for accuracy tracking.
//
// Request:
// {
//   "description": "frozen potato chips for retail sale",
//   "confirm_code": "20041010"   // optional — confirms a previous suggestion, writes to cache
// }
//
// Response:
// {
//   "status": "ok",
//   "source": "cache" | "ai",
//   "request_id": 42,
//   "suggestions": [
//     {
//       "rank": 1,
//       "commodity_code": "20041010",
//       "subheading_code": "200410",
//       "description": "Frozen potato products...",
//       "confidence": 0.95,
//       "reasoning": "Frozen potato chips for retail sale...",
//       "mfn_rate_pct": 20
//     }
//   ]
// }

import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.27.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  const startTime = Date.now();

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ── Validate API key ───────────────────────────────────────────────────────
  const rawKey = req.headers.get("x-api-key");
  if (!rawKey) return json({ error: "Missing X-API-Key header" }, 401);

  const keyHash = await sha256hex(rawKey);
  const { data: keyRow, error: keyErr } = await supabase
    .from("api_key")
    .select("keyid, tenantuid, tenantid, isactive")
    .eq("keyhash", keyHash)
    .eq("isactive", true)
    .maybeSingle();

  if (keyErr || !keyRow) return json({ error: "Invalid API key" }, 401);

  // ── Parse request ──────────────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return json({ error: "Invalid JSON body" }, 400); }

  const description  = str(body.description);
  const confirmCode  = str(body.confirm_code);
  const importCountry = str(body.import_country) ?? "ZA";

  if (!description) return json({ error: "description is required" }, 400);

  // Normalise: lowercase, strip punctuation
  const normalised = description.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();

  // ── Handle confirmation (writes confirmed code to cache) ───────────────────
  if (confirmCode) {
    await supabase.from("product_classification_cache").upsert({
      tenantid:             keyRow.tenantuid,
      productdescription:   description,
      normaliseddescription: normalised,
      subheadingcode:       confirmCode.substring(0, 6),
      commoditycode:        confirmCode,
      confirmedby:          "TRADER_CONFIRMED",
      confirmedat:          new Date().toISOString(),
      usecount:             1,
      lastusedsat:          new Date().toISOString(),
    }, { onConflict: "tenantid,normaliseddescription" });

    return json({ status: "ok", message: "Classification confirmed and cached", commodity_code: confirmCode });
  }

  // ── Stage 1: Check cache ───────────────────────────────────────────────────
  const { data: cached } = await supabase
    .from("product_classification_cache")
    .select("commoditycode, subheadingcode, confirmedby, usecount")
    .eq("tenantid", keyRow.tenantuid)
    .eq("normaliseddescription", normalised)
    .maybeSingle();

  if (cached) {
    // Increment use count
    await supabase
      .from("product_classification_cache")
      .update({ usecount: cached.usecount + 1, lastusedsat: new Date().toISOString() })
      .eq("tenantid", keyRow.tenantuid)
      .eq("normaliseddescription", normalised);

    // Fetch rate for the cached code
    const { data: rateRow } = await supabase
      .from("mfn_rate")
      .select("appliedmfnrate, dutyexpression")
      .eq("commoditycode", cached.commoditycode)
      .eq("countrycode", importCountry)
      .eq("ratecategory", "APPLIED")
      .is("effectiveto", null)
      .maybeSingle();

    return json({
      status:     "ok",
      source:     "cache",
      request_id: null,
      suggestions: [{
        rank:            1,
        commodity_code:  cached.commoditycode,
        subheading_code: cached.subheadingcode,
        confidence:      1.0,
        confirmed_by:    cached.confirmedby,
        reasoning:       "Previously confirmed classification",
        mfn_rate_pct:    rateRow?.appliedmfnrate ?? null,
        duty_expression: rateRow?.dutyexpression ?? null,
      }],
    });
  }

  // ── Stage 2: Claude classification ────────────────────────────────────────
  const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });

  // Fetch all ZA commodity codes for context (sample of relevant ones)
  // We get codes that might match the description based on simple keyword matching
  const keywords = normalised.split(" ").filter(w => w.length > 3).slice(0, 5);
  let commoditySample: any[] = [];

  for (const kw of keywords) {
    const { data } = await supabase
      .from("commodity_code")
      .select("commoditycode, subheadingcode, nationaldescription")
      .eq("countrycode", importCountry)
      .ilike("nationaldescription", `%${kw}%`)
      .limit(20);
    if (data) commoditySample = [...commoditySample, ...data];
  }

  // Deduplicate
  const seen = new Set<string>();
  const uniqueCodes = commoditySample.filter(c => {
    if (seen.has(c.commoditycode)) return false;
    seen.add(c.commoditycode);
    return true;
  }).slice(0, 60);

  const codeListText = uniqueCodes.length > 0
    ? uniqueCodes.map(c => `${c.commoditycode} — ${c.nationaldescription}`).join("\n")
    : "No pre-filtered codes available — use your HS classification knowledge.";

  const prompt = `You are an expert customs classifier specialising in the South African tariff schedule (SARS Schedule 1 Part 1).

Product description to classify: "${description}"

Relevant ZA commodity codes from the tariff schedule:
${codeListText}

Classify this product and return ONLY a valid JSON array with exactly 3 objects, ranked by confidence. No other text.

Each object must have exactly these fields:
{
  "rank": 1,
  "commodity_code": "20041010",
  "subheading_code": "200410",
  "confidence": 0.95,
  "reasoning": "One sentence explaining why this code applies."
}

Rules:
- commodity_code must be 8 digits
- subheading_code must be the first 6 digits of commodity_code
- confidence is a decimal between 0 and 1
- Prefer codes from the provided list when they match
- If none match well, use your HS knowledge to suggest the correct codes
- Return exactly 3 suggestions, even if confidence is low for ranks 2 and 3
- Return ONLY the JSON array, no markdown, no explanation`;

  const message = await anthropic.messages.create({
    model:      "claude-sonnet-4-20250514",
    max_tokens: 500,
    messages:   [{ role: "user", content: prompt }],
  });

  const raw = message.content[0].type === "text" ? message.content[0].text.trim() : "[]";

  let suggestions: any[] = [];
  try {
    suggestions = JSON.parse(raw);
    if (!Array.isArray(suggestions)) suggestions = [];
  } catch {
    return json({ error: "Classification failed — could not parse AI response", raw }, 500);
  }

  const topCode = suggestions[0]?.commodity_code ?? null;
  const topConf = suggestions[0]?.confidence ?? null;

  // Enrich with MFN rates
  const enriched = await Promise.all(suggestions.map(async (s: any) => {
    const { data: rateRow } = await supabase
      .from("mfn_rate")
      .select("appliedmfnrate, dutyexpression")
      .eq("commoditycode", s.commodity_code)
      .eq("countrycode", importCountry)
      .eq("ratecategory", "APPLIED")
      .is("effectiveto", null)
      .maybeSingle();

    return {
      ...s,
      mfn_rate_pct:    rateRow?.appliedmfnrate ?? null,
      duty_expression: rateRow?.dutyexpression ?? null,
    };
  }));

  // ── Log to CLASSIFICATION_REQUEST ──────────────────────────────────────────
  const { data: logRow } = await supabase
    .from("classification_request")
    .insert({
      tenantid:              keyRow.tenantuid,
      erpsource:             "CI_FRONTEND",
      productdescription:    description,
      normaliseddescription: normalised,
      requestedat:           new Date().toISOString(),
      responsetimems:        Date.now() - startTime,
      modelused:             "claude-sonnet",
      topsuggestioncode:     topCode,
      topconfidence:         topConf,
      classificationtype:    "AI_INFERRED",
    })
    .select("requestid")
    .single();

  return json({
    status:     "ok",
    source:     "ai",
    request_id: logRow?.requestid ?? null,
    suggestions: enriched,
    note: `To confirm a code, POST with confirm_code: "${topCode}" and request_id: ${logRow?.requestid}`,
  });
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
