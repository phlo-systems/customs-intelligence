// supabase/functions/classify/index.ts
// Deploy: supabase functions deploy classify --no-verify-jwt
//
// POST /functions/v1/classify
// Takes a product description, returns top 3 commodity code matches.
//
// Pipeline:
//   Stage 0: Check PRODUCT_CLASSIFICATION_CACHE (instant, confidence=1.0)
//   Stage 1: pgvector similarity search on HS_DESCRIPTION_EMBEDDING (< 100ms)
//            → Returns if top match similarity >= 0.90
//   Stage 2: Claude LLM classification (< 3s) — fallback when vector confidence low
//
// Logs every request to CLASSIFICATION_REQUEST for accuracy tracking.

import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.27.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
};

const VECTOR_CONFIDENCE_THRESHOLD = 0.75;
const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIM = 1536;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  const startTime = Date.now();

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

  // ── Check subscription usage limits ─────────────────────────────────────
  const { data: sub } = await supabase
    .from("subscription")
    .select("plancode, status, classifycount, lookupresetat")
    .eq("tenantid", tenantId)
    .maybeSingle();

  const CLASSIFY_LIMITS: Record<string, number> = { FREE: 5, STARTER: 50 };
  const classifyLimit = CLASSIFY_LIMITS[sub?.plancode || "FREE"];

  if (sub && classifyLimit && sub.status === "ACTIVE") {
    if (new Date(sub.lookupresetat) <= new Date()) {
      const nextReset = new Date();
      nextReset.setMonth(nextReset.getMonth() + 1, 1);
      nextReset.setHours(0, 0, 0, 0);
      await supabase.from("subscription")
        .update({ classifycount: 0, lookupresetat: nextReset.toISOString() })
        .eq("tenantid", tenantId);
      sub.classifycount = 0;
    }
    if (sub.classifycount >= classifyLimit) {
      return json({
        error: `${sub.plancode} plan limit reached (${classifyLimit} classifications/month). Upgrade for more.`,
        upgrade_url: "https://customs-compliance.ai/#pricing",
        usage: { classifies_used: sub.classifycount, limit: classifyLimit },
      }, 429);
    }
  }

  if (sub) {
    supabase.from("subscription")
      .update({ classifycount: (sub.classifycount || 0) + 1 })
      .eq("tenantid", tenantId)
      .then(() => {});
  }

  // ── Parse request ──────────────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return json({ error: "Invalid JSON body" }, 400); }

  const description  = str(body.description);
  const confirmCode  = str(body.confirm_code);
  const importCountry = str(body.import_country) ?? "ZA";
  const document     = body.document as Record<string, unknown> | null;

  // Extract text from uploaded document if present
  let documentText = "";
  let documentImage: { type: string; media_type: string; data: string } | null = null;

  if (document) {
    if (document.type === "text") {
      documentText = String(document.data || "").substring(0, 10000);
    } else if (document.type === "image") {
      // Store for multimodal Claude call
      documentImage = {
        type: "image",
        media_type: String(document.media_type || "image/jpeg"),
        data: String(document.data || ""),
      };
    } else if (document.type === "pdf") {
      // For PDF: we can't easily extract text in edge function,
      // so we'll tell Claude about it and pass what we have
      documentText = `[PDF document uploaded: ${document.name || "unknown.pdf"}. Content analysis requested.]`;
    }
  }

  if (!description && !documentText && !documentImage) return json({ error: "description or document is required" }, 400);

  // Normalise: lowercase, strip punctuation
  const normalised = description.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();

  // ── Handle confirmation (writes confirmed code to cache) ───────────────────
  if (confirmCode) {
    await supabase.from("product_classification_cache").upsert({
      tenantid:             tenantId,
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

  // ── Stage 0: Check cache ─────────────────────────────────────────────────
  const { data: cached } = await supabase
    .from("product_classification_cache")
    .select("commoditycode, subheadingcode, confirmedby, usecount")
    .eq("tenantid", tenantId)
    .eq("normaliseddescription", normalised)
    .maybeSingle();

  if (cached) {
    await supabase
      .from("product_classification_cache")
      .update({ usecount: cached.usecount + 1, lastusedsat: new Date().toISOString() })
      .eq("tenantid", tenantId)
      .eq("normaliseddescription", normalised);

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

  // ── Stage 1: Vector similarity search ────────────────────────────────────
  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  let vectorMatches: any[] = [];
  let usedVector = false;

  if (openaiKey) {
    try {
      // Compute embedding for the query description
      const queryEmbedding = await computeEmbedding(description, openaiKey);

      if (queryEmbedding) {
        // Call the match_hs_codes SQL function
        const { data: matches, error: matchErr } = await supabase.rpc("match_hs_codes", {
          query_embedding: queryEmbedding,
          match_count: 10,
          min_similarity: 0.5,
        });

        if (!matchErr && matches && matches.length > 0) {
          vectorMatches = matches;
          const topSimilarity = matches[0].similarity;

          console.log(`Vector search: ${matches.length} matches, top=${topSimilarity.toFixed(3)}`);

          // If top match is high-confidence, return vector results directly
          if (topSimilarity >= VECTOR_CONFIDENCE_THRESHOLD) {
            usedVector = true;

            // Deduplicate by subheading, take top 3
            const seen = new Set<string>();
            const top3 = matches.filter((m: any) => {
              if (seen.has(m.subheading_code)) return false;
              seen.add(m.subheading_code);
              return true;
            }).slice(0, 3);

            // Enrich with MFN rates and find best commodity code per subheading
            const suggestions = await Promise.all(top3.map(async (m: any, i: number) => {
              // Find best matching commodity code for this subheading
              const { data: commRow } = await supabase
                .from("commodity_code")
                .select("commoditycode, nationaldescription")
                .eq("countrycode", importCountry)
                .eq("subheadingcode", m.subheading_code)
                .eq("isactive", true)
                .limit(1)
                .maybeSingle();

              const commodityCode = commRow?.commoditycode ?? (m.subheading_code + "00");

              const { data: rateRow } = await supabase
                .from("mfn_rate")
                .select("appliedmfnrate, dutyexpression")
                .eq("commoditycode", commodityCode)
                .eq("countrycode", importCountry)
                .eq("ratecategory", "APPLIED")
                .is("effectiveto", null)
                .maybeSingle();

              return {
                rank:            i + 1,
                commodity_code:  commodityCode,
                subheading_code: m.subheading_code,
                confidence:      Math.round(m.similarity * 100) / 100,
                reasoning:       m.description_text,
                mfn_rate_pct:    rateRow?.appliedmfnrate ?? null,
                duty_expression: rateRow?.dutyexpression ?? null,
              };
            }));

            // Log request
            const { data: logRow } = await supabase
              .from("classification_request")
              .insert({
                tenantid:              tenantId,
                erpsource:             "CI_FRONTEND",
                productdescription:    description,
                normaliseddescription: normalised,
                requestedat:           new Date().toISOString(),
                responsetimems:        Date.now() - startTime,
                modelused:             "pgvector",
                topsuggestioncode:     suggestions[0]?.commodity_code,
                topconfidence:         suggestions[0]?.confidence,
                classificationtype:    "AI_INFERRED",
              })
              .select("requestid")
              .single();

            return json({
              status:     "ok",
              source:     "vector",
              request_id: logRow?.requestid ?? null,
              suggestions,
              note: `To confirm a code, POST with confirm_code: "${suggestions[0]?.commodity_code}"`,
            });
          }
        }
      }
    } catch (e) {
      console.error("Vector search failed, falling back to Claude:", e);
    }
  }

  // ── Stage 2: Claude classification (fallback) ───────────────────────────
  const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });

  // Use vector matches as context if available, otherwise fall back to keyword search
  let codeListText: string;

  if (vectorMatches.length > 0) {
    // Use vector search results as context for Claude
    const vectorContext = vectorMatches.slice(0, 20).map(
      (m: any) => `${m.subheading_code} (similarity: ${m.similarity.toFixed(2)}) — ${m.description_text}`
    ).join("\n");
    codeListText = vectorContext;
  } else {
    // Fallback: keyword-based search
    const keywords = normalised.split(" ").filter((w: string) => w.length > 3).slice(0, 5);
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

    const seen = new Set<string>();
    const uniqueCodes = commoditySample.filter(c => {
      if (seen.has(c.commoditycode)) return false;
      seen.add(c.commoditycode);
      return true;
    }).slice(0, 60);

    codeListText = uniqueCodes.length > 0
      ? uniqueCodes.map(c => `${c.commoditycode} — ${c.nationaldescription}`).join("\n")
      : "No pre-filtered codes available — use your HS classification knowledge.";
  }

  const docContext = documentText
    ? `\n\nAdditional context from uploaded document:\n${documentText.substring(0, 5000)}`
    : "";

  const prompt = `You are an expert customs classifier. The import country is ${importCountry}.

Product description to classify: "${description || 'See uploaded document'}"${docContext}

Relevant commodity codes from the tariff schedule:
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

  // Build message content — multimodal if image uploaded
  const messageContent: any[] = [];
  if (documentImage) {
    messageContent.push({
      type: "image",
      source: { type: "base64", media_type: documentImage.media_type, data: documentImage.data },
    });
    messageContent.push({ type: "text", text: "The above image is a product photo, spec sheet, or label. Use it to help classify this product.\n\n" + prompt });
  } else {
    messageContent.push({ type: "text", text: prompt });
  }

  const message = await anthropic.messages.create({
    model:      "claude-sonnet-4-20250514",
    max_tokens: 500,
    messages:   [{ role: "user", content: messageContent }],
  });

  let raw = message.content[0].type === "text" ? message.content[0].text.trim() : "[]";

  // Strip markdown fences if present (```json ... ```)
  raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

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
      tenantid:              tenantId,
      erpsource:             "CI_FRONTEND",
      productdescription:    description,
      normaliseddescription: normalised,
      requestedat:           new Date().toISOString(),
      responsetimems:        Date.now() - startTime,
      modelused:             vectorMatches.length > 0 ? "claude-sonnet+vector" : "claude-sonnet",
      topsuggestioncode:     topCode,
      topconfidence:         topConf,
      classificationtype:    "AI_INFERRED",
    })
    .select("requestid")
    .single();

  return json({
    status:     "ok",
    source:     vectorMatches.length > 0 ? "vector+ai" : "ai",
    request_id: logRow?.requestid ?? null,
    suggestions: enriched,
    note: `To confirm a code, POST with confirm_code: "${topCode}" and request_id: ${logRow?.requestid}`,
  });
});


// ── Helpers ───────────────────────────────────────────────────────────────────

async function computeEmbedding(text: string, openaiKey: string): Promise<number[] | null> {
  try {
    const resp = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_EMBEDDING_MODEL,
        input: text,
        dimensions: EMBEDDING_DIM,
      }),
    });

    if (!resp.ok) {
      console.error("OpenAI embedding error:", resp.status, await resp.text());
      return null;
    }

    const data = await resp.json();
    return data.data?.[0]?.embedding ?? null;
  } catch (e) {
    console.error("Embedding computation failed:", e);
    return null;
  }
}

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
