// supabase/functions/upload-tariff/index.ts
// Deploy: supabase functions deploy upload-tariff --no-verify-jwt
//
// Admin endpoint: upload a customs tariff document (PDF/Excel/CSV)
// for a country. The document is parsed using Claude to extract
// commodity codes, MFN rates, and VAT rates, then written to the DB.
//
// POST multipart/form-data:
//   - file: the tariff document (PDF, XLSX, CSV)
//   - country_code: 2-letter ISO (e.g. IN, BR, TH)
//   - document_type: TARIFF_SCHEDULE | NOTIFICATION | AMENDMENT
//   - notes: optional free-text notes

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json({ ok: true }, 200);
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ── Auth ─────────────────────────────────────────────────────────────────
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
  if (keyRow.expiresat && new Date(keyRow.expiresat) < new Date())
    return json({ error: "API key expired" }, 401);

  // ── Parse multipart form ─────────────────────────────────────────────────
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return json({ error: "Expected multipart/form-data" }, 400);
  }

  const file = formData.get("file") as File | null;
  const countryCode = (formData.get("country_code") as string || "").toUpperCase().trim();
  const documentType = (formData.get("document_type") as string || "TARIFF_SCHEDULE").toUpperCase().trim();
  const notes = (formData.get("notes") as string || "").trim();

  if (!file) return json({ error: "file is required" }, 400);
  if (!countryCode || countryCode.length !== 2)
    return json({ error: "country_code must be a 2-letter ISO code" }, 400);

  const allowedTypes = ["application/pdf", "text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"];
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (!allowedTypes.includes(file.type) && !["pdf", "csv", "xlsx"].includes(ext || "")) {
    return json({ error: "Unsupported file type. Upload PDF, CSV, or XLSX." }, 400);
  }

  // Read file bytes
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const fileSizeMB = (fileBytes.length / (1024 * 1024)).toFixed(2);

  if (fileBytes.length > 50 * 1024 * 1024) {
    return json({ error: "File too large. Maximum 50MB." }, 400);
  }

  console.log(`Upload: ${file.name} (${fileSizeMB} MB) for ${countryCode}, type=${documentType}`);

  // ── Store file in Supabase Storage ───────────────────────────────────────
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const storagePath = `tariff-uploads/${countryCode}/${timestamp}_${file.name}`;

  const { error: uploadErr } = await supabase.storage
    .from("documents")
    .upload(storagePath, fileBytes, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });

  if (uploadErr) {
    console.error("Storage upload error:", uploadErr);
    // Continue even if storage fails — we still have the bytes in memory
  }

  // ── Extract text from PDF using pdftotext-style approach ─────────────────
  // For PDFs, we'll base64-encode and send to Claude for structured extraction.
  // For CSV, we parse directly.

  let extractedRows: TariffRow[] = [];
  let parseStatus = "PENDING";
  let parseError = "";

  try {
    if (ext === "csv" || file.type === "text/csv") {
      extractedRows = parseCSV(new TextDecoder().decode(fileBytes), countryCode);
      parseStatus = "SUCCESS";
    } else {
      // PDF or XLSX — use Claude to extract structured tariff data
      extractedRows = await extractWithClaude(fileBytes, countryCode, file.name, documentType);
      parseStatus = "SUCCESS";
    }
  } catch (e) {
    console.error("Parse error:", e);
    parseStatus = "FAILED";
    parseError = String(e);
  }

  // ── Write to DB ──────────────────────────────────────────────────────────
  let writeStats = { commodity_code: 0, mfn_rate: 0, vat_rate: 0, tariff_rate: 0 };

  if (extractedRows.length > 0) {
    writeStats = await writeRows(supabase, extractedRows, countryCode);
  }

  // ── Log the upload ───────────────────────────────────────────────────────
  await supabase.from("source_sync_job").insert({
    countrycode: countryCode,
    sourcetype: "MANUAL_UPLOAD",
    status: parseStatus,
    rowsparsed: extractedRows.length,
    rowswritten: writeStats.commodity_code,
    filename: file.name,
    notes: notes || `Manual upload: ${file.name}`,
    startedat: new Date().toISOString(),
    completedat: new Date().toISOString(),
  }).then(() => {});

  return json({
    status: parseStatus,
    country_code: countryCode,
    file_name: file.name,
    file_size_mb: fileSizeMB,
    document_type: documentType,
    rows_extracted: extractedRows.length,
    rows_written: writeStats,
    storage_path: storagePath,
    error: parseError || undefined,
    sample: extractedRows.slice(0, 5).map(r => ({
      commodity_code: r.commodityCode,
      description: r.description?.substring(0, 80),
      mfn_rate: r.mfnRate,
      vat_rate: r.vatRate,
    })),
  }, 200);
});


// ── Types ────────────────────────────────────────────────────────────────────

interface TariffRow {
  commodityCode: string;
  subheadingCode: string;
  description: string;
  mfnRate: number | null;
  dutyExpression: string;
  dutyType: string;   // AD_VALOREM | SPECIFIC | COMPOUND | FREE
  specificAmt: number | null;
  specificUom: string | null;
  vatRate: number | null;
  unit: string | null;
}


// ── Claude extraction ────────────────────────────────────────────────────────

async function extractWithClaude(
  fileBytes: Uint8Array,
  countryCode: string,
  fileName: string,
  documentType: string,
): Promise<TariffRow[]> {
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY not configured");

  // Base64 encode the PDF for Claude
  const base64 = btoa(String.fromCharCode(...fileBytes));

  const systemPrompt = `You are a customs tariff data extraction specialist. Extract structured tariff data from the uploaded document.

The document is a ${documentType} for country ${countryCode}.

Extract EVERY commodity/tariff line you can find. For each line, extract:
- commodity_code: the full national tariff code (8 or 10 digits, no dots/spaces)
- subheading_code: first 6 digits of the commodity code
- description: the commodity/article description
- mfn_rate: the MFN/applied/basic customs duty rate as a number (e.g. 15 for 15%). null if not found.
- duty_expression: the raw duty expression as written (e.g. "15%", "free", "Rs 50/kg")
- duty_type: one of AD_VALOREM, SPECIFIC, COMPOUND, FREE
- specific_amt: specific duty amount if applicable, null otherwise
- specific_uom: specific duty unit (e.g. "INR/kg") if applicable, null otherwise
- vat_rate: VAT/GST/IGST rate as a number. null if not in this document.
- unit: statistical/supplementary unit (e.g. "kg", "l", "u")

Country-specific guidance:
- India (IN): BCD = Basic Customs Duty (this is the MFN rate). SWS = 10% of BCD (do NOT include in mfn_rate). IGST = VAT rate.
- Brazil (BR): II = Import Tax (MFN rate). IPI, PIS, COFINS, ICMS are separate — only extract II as mfn_rate.
- General: If the document has multiple duty columns, use the General/MFN/Third-country column for mfn_rate.

Return ONLY a JSON array of objects. No markdown, no explanation. Example:
[{"commodity_code":"20041000","subheading_code":"200410","description":"Potatoes, prepared frozen","mfn_rate":30,"duty_expression":"30%","duty_type":"AD_VALOREM","specific_amt":null,"specific_uom":null,"vat_rate":12,"unit":"kg"}]`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 16000,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: base64,
              },
            },
            {
              type: "text",
              text: `Extract all tariff lines from this ${countryCode} customs document. Return JSON array only.`,
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error ${response.status}: ${errText.substring(0, 200)}`);
  }

  const result = await response.json();
  const text = result.content?.[0]?.text || "";

  // Parse the JSON array from Claude's response
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error("Claude did not return a valid JSON array");
  }

  const parsed = JSON.parse(jsonMatch[0]) as Array<Record<string, unknown>>;

  return parsed.map((r) => ({
    commodityCode: String(r.commodity_code || "").replace(/[.\s-]/g, ""),
    subheadingCode: String(r.subheading_code || String(r.commodity_code || "").replace(/[.\s-]/g, "").substring(0, 6)),
    description: String(r.description || ""),
    mfnRate: r.mfn_rate != null ? Number(r.mfn_rate) : null,
    dutyExpression: String(r.duty_expression || ""),
    dutyType: String(r.duty_type || "AD_VALOREM"),
    specificAmt: r.specific_amt != null ? Number(r.specific_amt) : null,
    specificUom: r.specific_uom != null ? String(r.specific_uom) : null,
    vatRate: r.vat_rate != null ? Number(r.vat_rate) : null,
    unit: r.unit != null ? String(r.unit) : null,
  }));
}


// ── CSV parser ───────────────────────────────────────────────────────────────

function parseCSV(text: string, countryCode: string): TariffRow[] {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  // Parse header to find column indices
  const header = lines[0].toLowerCase().split(",").map(h => h.trim().replace(/"/g, ""));

  const colMap: Record<string, number> = {};
  const aliases: Record<string, string[]> = {
    commodityCode: ["commodity_code", "cth", "tariff_code", "hs_code", "code", "hscode"],
    description: ["description", "desc", "article_description", "commodity_description", "goods_description"],
    mfnRate: ["mfn_rate", "bcd", "duty_rate", "mfn", "basic_duty", "applied_rate", "general"],
    vatRate: ["vat_rate", "vat", "igst", "gst", "vat_pct"],
    unit: ["unit", "uqc", "statistical_unit", "supplementary_unit"],
  };

  for (const [field, names] of Object.entries(aliases)) {
    for (const name of names) {
      const idx = header.indexOf(name);
      if (idx >= 0) { colMap[field] = idx; break; }
    }
  }

  if (colMap.commodityCode === undefined) {
    throw new Error("CSV must have a commodity_code/cth/hs_code column");
  }

  const rows: TariffRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map(c => c.trim().replace(/"/g, ""));
    const code = cols[colMap.commodityCode]?.replace(/[.\s-]/g, "") || "";
    if (!code || code.length < 6) continue;

    const mfnRaw = colMap.mfnRate !== undefined ? cols[colMap.mfnRate] : "";
    const mfn = mfnRaw ? parseFloat(mfnRaw.replace("%", "")) : null;
    const vatRaw = colMap.vatRate !== undefined ? cols[colMap.vatRate] : "";
    const vat = vatRaw ? parseFloat(vatRaw.replace("%", "")) : null;

    rows.push({
      commodityCode: code.padEnd(8, "0"),
      subheadingCode: code.substring(0, 6),
      description: colMap.description !== undefined ? cols[colMap.description] || "" : "",
      mfnRate: mfn,
      dutyExpression: mfn != null ? `${mfn}%` : "",
      dutyType: mfn === 0 ? "FREE" : mfn != null ? "AD_VALOREM" : "AD_VALOREM",
      specificAmt: null,
      specificUom: null,
      vatRate: vat,
      unit: colMap.unit !== undefined ? cols[colMap.unit] || null : null,
    });
  }

  return rows;
}


// ── DB writer ────────────────────────────────────────────────────────────────

async function writeRows(
  supabase: ReturnType<typeof createClient>,
  rows: TariffRow[],
  countryCode: string,
): Promise<{ commodity_code: number; mfn_rate: number; vat_rate: number; tariff_rate: number }> {
  const stats = { commodity_code: 0, mfn_rate: 0, vat_rate: 0, tariff_rate: 0 };
  const today = new Date().toISOString().split("T")[0];
  const batchSize = 200;

  // Determine valuation basis
  const cifCountries = new Set(["IN", "BR", "ZA", "NA", "GB", "TH", "MX", "PH", "AE", "SA", "OM"]);
  const valuation = cifCountries.has(countryCode) ? "CIF" : "FOB";

  // Build batches
  const commodityBatch = rows.map(r => ({
    commoditycode: r.commodityCode,
    countrycode: countryCode,
    subheadingcode: r.subheadingCode,
    hsversion: "HS 2022",
    nationaldescription: r.description.substring(0, 500),
    supplementaryunit: r.unit,
    codelength: r.commodityCode.length <= 8 ? "8-digit" : "10-digit",
    isactive: true,
  }));

  const mfnBatch = rows.filter(r => r.mfnRate !== null).map(r => ({
    commoditycode: r.commodityCode,
    countrycode: countryCode,
    ratecategory: "APPLIED",
    dutybasistype: r.dutyType === "FREE" ? "AD_VALOREM" : r.dutyType,
    appliedmfnrate: r.mfnRate,
    specificdutyamt: r.specificAmt,
    specificdutyuom: r.specificUom,
    dutyexpression: r.dutyExpression,
    valuationbasis: valuation,
    effectivefrom: today,
    effectiveto: null,
  }));

  const tariffBatch = rows.filter(r => r.mfnRate !== null).map(r => ({
    commoditycode: r.commodityCode,
    countrycode: countryCode,
    subheadingcode: r.subheadingCode,
    appliedmfnrate: r.mfnRate,
    valuationbasis: valuation,
    dutyexpression: r.dutyExpression,
    effectivefrom: today,
    effectiveto: null,
    lastreviewedat: today,
  }));

  const vatBatch = rows.filter(r => r.vatRate !== null).map(r => ({
    commoditycode: r.commodityCode,
    countrycode: countryCode,
    vatrate: r.vatRate,
    vatcategory: r.vatRate === 0 ? "ZERO" : "STANDARD",
    effectivefrom: today,
    effectiveto: null,
  }));

  // Upsert in batches
  const upsert = async (table: string, records: Record<string, unknown>[]) => {
    let count = 0;
    for (let i = 0; i < records.length; i += batchSize) {
      const chunk = records.slice(i, i + batchSize);
      const { error } = await supabase.from(table).upsert(chunk, { onConflict: undefined });
      if (error) console.error(`Upsert ${table} batch error:`, error.message);
      else count += chunk.length;
    }
    return count;
  };

  stats.commodity_code = await upsert("commodity_code", commodityBatch);
  stats.mfn_rate = await upsert("mfn_rate", mfnBatch);
  stats.tariff_rate = await upsert("tariff_rate", tariffBatch);
  stats.vat_rate = await upsert("vat_rate", vatBatch);

  console.log(`Wrote ${countryCode}: commodity=${stats.commodity_code} mfn=${stats.mfn_rate} tariff=${stats.tariff_rate} vat=${stats.vat_rate}`);
  return stats;
}


// ── Helpers ──────────────────────────────────────────────────────────────────

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function sha256hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}
