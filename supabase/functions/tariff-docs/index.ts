// supabase/functions/tariff-docs/index.ts
// Deploy: supabase functions deploy tariff-docs --no-verify-jwt
//
// Admin-only document management for tariff files.
//
// POST /tariff-docs  (multipart/form-data)
//   Upload a new document. Fields: file, country_code, document_type, hs_chapter, title, effective_date, source_url, notes
//
// POST /tariff-docs  (JSON)
//   { "action": "list", "country_code": "IN" }                    — list docs for a country
//   { "action": "list_all" }                                       — list all docs
//   { "action": "download", "document_id": 123 }                  — get signed download URL
//   { "action": "delete", "document_id": 123 }                    — soft-delete (mark inactive)
//   { "action": "parse", "document_id": 123 }                     — trigger tariff extraction

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
};

const MAX_VERSIONS = 3;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json({ ok: true }, 200);
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ── Auth + admin check ─────────────────────────────────────────────────
  let userId: string | null = null;
  let isAdmin = false;
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.replace("Bearer ", "");
    const { data: { user } } = await supabase.auth.getUser(token);
    if (user) {
      userId = user.id;
      isAdmin = user.user_metadata?.is_admin === true;
    }
  }
  if (!userId) {
    const rawKey = req.headers.get("x-api-key");
    if (rawKey) {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawKey));
      const keyHash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
      const { data: keyRow } = await supabase.from("api_key").select("tenantuid").eq("keyhash", keyHash).eq("isactive", true).maybeSingle();
      if (keyRow?.tenantuid) userId = keyRow.tenantuid;
    }
  }
  if (!userId) return json({ error: "Authentication required" }, 401);
  if (!isAdmin) return json({ error: "Admin access required" }, 403);

  const contentType = req.headers.get("content-type") || "";

  // ── File upload (multipart) ────────────────────────────────────────────
  if (contentType.includes("multipart/form-data")) {
    let formData: FormData;
    try { formData = await req.formData(); }
    catch { return json({ error: "Invalid form data" }, 400); }

    const file = formData.get("file") as File | null;
    const countryCode = (formData.get("country_code") as string || "").toUpperCase().trim();
    const documentType = (formData.get("document_type") as string || "TARIFF_SCHEDULE").toUpperCase().trim();
    const hsChapter = (formData.get("hs_chapter") as string || "").trim() || null;
    const title = (formData.get("title") as string || "").trim();
    const effectiveDate = (formData.get("effective_date") as string || "").trim() || null;
    const sourceUrl = (formData.get("source_url") as string || "").trim() || null;
    const notes = (formData.get("notes") as string || "").trim() || null;

    if (!file) return json({ error: "file is required" }, 400);
    if (!countryCode || countryCode.length !== 2) return json({ error: "country_code must be 2-letter ISO" }, 400);
    if (!title) return json({ error: "title is required" }, 400);

    const fileBytes = new Uint8Array(await file.arrayBuffer());
    if (fileBytes.length > 50 * 1024 * 1024) return json({ error: "File too large (max 50MB)" }, 400);

    // Check for exact filename duplicate (already uploaded & parsed)
    const { data: dupeByName } = await supabase
      .from("tariff_document")
      .select("documentid, filename, parsestatus, version, createdat")
      .eq("countrycode", countryCode)
      .eq("filename", file.name)
      .eq("isactive", true)
      .order("version", { ascending: false })
      .limit(1);

    if (dupeByName && dupeByName.length > 0) {
      const dupe = dupeByName[0];
      return json({
        status: "duplicate",
        message: `This file (${file.name}) has already been uploaded for ${countryCode} as version ${dupe.version} (${dupe.parsestatus}). Upload with a different filename or delete the existing version first.`,
        existing_document: dupe,
      }, 409);
    }

    // Determine version number for this country+type+chapter combo
    let versionQuery = supabase
      .from("tariff_document")
      .select("documentid, version")
      .eq("countrycode", countryCode)
      .eq("documenttype", documentType)
      .eq("isactive", true)
      .order("version", { ascending: false });

    if (hsChapter) {
      versionQuery = versionQuery.eq("hschapter", hsChapter);
    } else {
      versionQuery = versionQuery.is("hschapter", null);
    }

    const { data: existing } = await versionQuery;

    const nextVersion = ((existing || [])[0]?.version || 0) + 1;

    // If we'd exceed MAX_VERSIONS, deactivate the oldest
    if (existing && existing.length >= MAX_VERSIONS) {
      const toDeactivate = existing.slice(MAX_VERSIONS - 1);
      for (const old of toDeactivate) {
        await supabase.from("tariff_document").update({ isactive: false }).eq("documentid", old.documentid);
      }
    }

    // Upload to storage
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const storagePath = `${countryCode}/${documentType}${hsChapter ? '/ch' + hsChapter : ''}/${timestamp}_${file.name}`;

    const { error: uploadErr } = await supabase.storage
      .from("tariff-documents")
      .upload(storagePath, fileBytes, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });

    if (uploadErr) {
      console.error("Storage upload error:", uploadErr);
      return json({ error: "File storage failed: " + uploadErr.message }, 500);
    }

    // Save metadata
    const { data: doc, error: insertErr } = await supabase
      .from("tariff_document")
      .insert({
        countrycode: countryCode,
        documenttype: documentType,
        hschapter: hsChapter,
        title,
        filename: file.name,
        filesize: fileBytes.length,
        mimetype: file.type || "application/octet-stream",
        storagepath: storagePath,
        version: nextVersion,
        effectivedate: effectiveDate,
        sourceurl: sourceUrl,
        notes,
        uploadedby: userId,
        parsestatus: "PENDING",
      })
      .select()
      .single();

    if (insertErr) return json({ error: insertErr.message }, 500);

    return json({
      status: "ok",
      message: `Document uploaded as version ${nextVersion}`,
      document: doc,
    });
  }

  // ── JSON actions ───────────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const action = String(body.action || "list_all");

  // ── List documents ─────────────────────────────────────────────────────
  if (action === "list" || action === "list_all") {
    let query = supabase
      .from("tariff_document")
      .select("*")
      .eq("isactive", true)
      .order("countrycode")
      .order("documenttype")
      .order("hschapter")
      .order("version", { ascending: false });

    if (action === "list" && body.country_code) {
      query = query.eq("countrycode", String(body.country_code).toUpperCase());
    }

    const { data: docs, error } = await query;
    if (error) return json({ error: error.message }, 500);

    // Group by country → document_type → hs_chapter
    const grouped: Record<string, any> = {};
    for (const doc of (docs || [])) {
      const key = doc.countrycode;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push({
        ...doc,
        filesize_mb: (doc.filesize / (1024 * 1024)).toFixed(2),
      });
    }

    return json({ documents: docs || [], by_country: grouped });
  }

  // ── Download (signed URL) ──────────────────────────────────────────────
  if (action === "download") {
    const docId = Number(body.document_id);
    if (!docId) return json({ error: "document_id required" }, 400);

    const { data: doc } = await supabase.from("tariff_document").select("storagepath, filename").eq("documentid", docId).maybeSingle();
    if (!doc) return json({ error: "Document not found" }, 404);

    const { data: signed, error: signErr } = await supabase.storage
      .from("tariff-documents")
      .createSignedUrl(doc.storagepath, 3600); // 1 hour expiry

    if (signErr) return json({ error: "Could not generate download link: " + signErr.message }, 500);

    return json({ url: signed.signedUrl, filename: doc.filename, expires_in: 3600 });
  }

  // ── Delete (soft) ──────────────────────────────────────────────────────
  if (action === "delete") {
    const docId = Number(body.document_id);
    if (!docId) return json({ error: "document_id required" }, 400);

    await supabase.from("tariff_document").update({ isactive: false }).eq("documentid", docId);
    return json({ status: "ok", message: "Document archived" });
  }

  // ── Trigger parse ──────────────────────────────────────────────────────
  if (action === "parse") {
    const docId = Number(body.document_id);
    if (!docId) return json({ error: "document_id required" }, 400);

    const { data: doc } = await supabase.from("tariff_document").select("*").eq("documentid", docId).maybeSingle();
    if (!doc) return json({ error: "Document not found" }, 404);

    // Download the file from storage
    const { data: fileData, error: dlErr } = await supabase.storage
      .from("tariff-documents")
      .download(doc.storagepath);

    if (dlErr || !fileData) return json({ error: "Could not download file: " + (dlErr?.message || "unknown") }, 500);

    // Forward to upload-tariff for parsing (reuse existing Claude extraction)
    const form = new FormData();
    form.append("file", fileData, doc.filename);
    form.append("country_code", doc.countrycode);
    form.append("document_type", doc.documenttype);
    if (doc.notes) form.append("notes", doc.notes);

    const parseResp = await fetch(Deno.env.get("SUPABASE_URL") + "/functions/v1/upload-tariff", {
      method: "POST",
      headers: { "Authorization": authHeader || "" },
      body: form,
    });

    const parseResult = await parseResp.json();

    // Update document parse status
    await supabase.from("tariff_document").update({
      parsestatus: parseResult.status === "SUCCESS" ? "SUCCESS" : "FAILED",
      rowsextracted: parseResult.rows_extracted || 0,
    }).eq("documentid", docId);

    return json({ status: "ok", parse_result: parseResult });
  }

  // ── AI metadata suggestion ──────────────────────────────────────────────
  if (action === "suggest_metadata") {
    const fileName = String(body.file_name || "");
    const fileTextPreview = String(body.text_preview || "");
    if (!fileName && !fileTextPreview) return json({ error: "file_name or text_preview required" }, 400);

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!anthropicKey) return json({ error: "ANTHROPIC_API_KEY not configured" }, 500);

    const prompt = `You are a customs tariff document analyst. Analyse this filename and any content preview to suggest metadata.

Filename: ${fileName}
Content preview (first ~500 chars): ${fileTextPreview.substring(0, 500) || "(no preview available — PDF)"}

Country name/code clues: "CBIC" or "BCD" or "IGST" = India (IN), "HMRC" or "UK trade tariff" = GB, "SARS" = South Africa (ZA), "NCM" = Brazil (BR), "ABS" = Australia (AU), etc.

Return ONLY a valid JSON object with these fields:
{
  "country_code": "XX",
  "document_type": "TARIFF_SCHEDULE or CHAPTER or NOTIFICATION or RATE_CHANGE or FTA_SCHEDULE",
  "hs_chapter": "chapter number or null",
  "title": "suggested descriptive title",
  "effective_date": "YYYY-MM-DD or null"
}`;

    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 300, messages: [{ role: "user", content: prompt }] }),
      });
      if (!resp.ok) throw new Error("Claude API error: " + resp.status);
      const result = await resp.json();
      const text = result.content?.[0]?.text || "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return json({ suggestion: JSON.parse(jsonMatch[0]) });
      }
    } catch (e) { console.error("AI metadata error:", e); }

    return json({ suggestion: null });
  }

  return json({ error: "Unknown action. Use: list, list_all, download, delete, parse, suggest_metadata" }, 400);
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
