// supabase/functions/email-sync/index.ts
// Deploy: supabase functions deploy email-sync --no-verify-jwt
//
// Reads trade-related emails from Gmail or Outlook, extracts structured
// context using Claude, stores in EMAIL_CONTEXT_EXTRACT.
// PRIVACY: Raw email body is NEVER stored — only structured extracts.
//
// POST /email-sync
//   { "platform": "GMAIL" | "OUTLOOK", "days": 30 }

import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.27.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
};

const TRADE_KEYWORDS = "invoice OR tariff OR customs OR shipment OR \"bill of lading\" OR \"commercial invoice\" OR \"packing list\" OR \"certificate of origin\" OR duty OR import OR export OR HS code OR freight OR consignment";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json({ ok: true }, 200);
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

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

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch {}

  const platform = String(body.platform || "GMAIL").toUpperCase();
  const days = Math.min(Number(body.days || 30), 90);

  if (!["GMAIL", "OUTLOOK"].includes(platform)) {
    return json({ error: "platform must be GMAIL or OUTLOOK" }, 400);
  }

  // Get integration
  const { data: integration } = await supabase
    .from("erp_integration")
    .select("*")
    .eq("tenantid", tenantId)
    .eq("erptype", platform)
    .eq("isactive", true)
    .maybeSingle();

  if (!integration) {
    return json({ error: `No active ${platform} connection. Connect via Profile tab.` }, 404);
  }

  const config = integration.mappingconfig as Record<string, unknown>;
  let accessToken = config.access_token as string;

  // Refresh token if needed
  const expiresAt = config.expires_at as number || 0;
  if (Date.now() > expiresAt - 60000) {
    const refreshed = await refreshToken(platform, config, integration, supabase);
    if (refreshed.error) return json({ error: "Token refresh failed", detail: refreshed.error }, 502);
    accessToken = refreshed.access_token!;
  }

  const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const stats = { emails_found: 0, emails_processed: 0, extracts_saved: 0, errors: [] as string[] };

  // ── Fetch emails ───────────────────────────────────────────────────────
  let emails: Array<{ id: string; subject: string; from: string; date: string; body: string }> = [];

  if (platform === "GMAIL") {
    emails = await fetchGmailEmails(accessToken, sinceDate, stats);
  } else {
    emails = await fetchOutlookEmails(accessToken, sinceDate, stats);
  }

  stats.emails_found = emails.length;

  // ── Process emails with Claude ─────────────────────────────────────────
  const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });

  // Process in batches of 5 emails per Claude call
  const batchSize = 5;
  for (let i = 0; i < emails.length; i += batchSize) {
    const batch = emails.slice(i, i + batchSize);

    const emailSummaries = batch.map((e, j) => {
      // Truncate body for Claude — NEVER store raw body
      const bodyPreview = e.body.substring(0, 1500);
      return `Email ${j + 1}:
Subject: ${e.subject}
From: ${e.from}
Date: ${e.date}
Body preview: ${bodyPreview}`;
    }).join("\n\n---\n\n");

    try {
      const msg = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: `Extract trade intelligence from these emails. For each email, determine if it's trade-related and extract structured data. Return ONLY a JSON array (one object per email). Non-trade emails should have email_type "OTHER". No markdown.

${emailSummaries}

For each email return:
{
  "email_index": 0,
  "email_type": "SUPPLIER_QUOTE|CUSTOMER_RFQ|SHIPPING_CONF|CUSTOMS_ENTRY|TRADE_INQUIRY|REGULATORY|TRADE_FINANCE|FREIGHT|OTHER",
  "is_trade_related": true/false,
  "subheading_codes": ["200410"],
  "origin_countries": ["GB"],
  "destination_countries": ["ZA"],
  "commodities": ["frozen potato chips"],
  "counterparty_name": "Acme Ltd",
  "counterparty_country": "GB",
  "volume_mt": null,
  "incoterm": "CIF",
  "competitor_origins": [],
  "market_interest": [],
  "compliance_concerns": [],
  "trade_barriers": []
}`,
        }],
      });

      let extracts: any[] = [];
      const raw = msg.content[0].type === "text" ? msg.content[0].text.trim() : "[]";
      try {
        const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
        extracts = JSON.parse(cleaned);
      } catch { continue; }

      for (const extract of extracts) {
        if (!extract.is_trade_related) continue;

        const emailIdx = extract.email_index ?? 0;
        const email = batch[emailIdx];
        if (!email) continue;

        stats.emails_processed++;

        // Store in EMAIL_CONTEXT_EXTRACT — NO raw body stored (GDPR)
        const { error } = await supabase.from("email_context_extract").upsert({
          tenantid: tenantId,
          emailplatform: platform,
          emailmessageid: email.id,
          emaildate: email.date.split("T")[0],
          emailtype: extract.email_type || "OTHER",
          subheadingcodes: extract.subheading_codes || [],
          origincountries: extract.origin_countries || [],
          destinationcountries: extract.destination_countries || [],
          commodities: extract.commodities || [],
          counterpartyname: extract.counterparty_name || null,
          counterpartycountry: extract.counterparty_country || null,
          volumemt: extract.volume_mt || null,
          incoterm: extract.incoterm || null,
          competitororigins: extract.competitor_origins || [],
          marketinterest: extract.market_interest || [],
          complianceconcerns: extract.compliance_concerns || [],
          tradebarriers: extract.trade_barriers || [],
          reviewedbyuser: false,
        }, { onConflict: "tenantid,emailmessageid" });

        if (!error) stats.extracts_saved++;
      }
    } catch (e) {
      stats.errors.push(String(e).substring(0, 100));
    }

    await sleep(500); // Pace Claude calls
  }

  // Update last sync
  await supabase.from("erp_integration")
    .update({ lastsyncat: new Date().toISOString() })
    .eq("integrationid", integration.integrationid);

  // Update tenant context
  await supabase.from("tenant_context")
    .update({
      emailconnected: true,
      emailplatform: platform,
      emaillastscannedat: new Date().toISOString(),
    })
    .eq("tenantid", tenantId);

  return json({ status: "ok", platform, stats });
});


// ── Gmail fetcher ────────────────────────────────────────────────────────────

async function fetchGmailEmails(
  accessToken: string,
  sinceDate: Date,
  stats: any,
): Promise<Array<{ id: string; subject: string; from: string; date: string; body: string }>> {
  const sinceEpoch = Math.floor(sinceDate.getTime() / 1000);
  const query = `${TRADE_KEYWORDS} after:${sinceEpoch}`;

  // List message IDs
  const listResp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=50`,
    { headers: { Authorization: "Bearer " + accessToken } },
  );

  if (!listResp.ok) {
    stats.errors.push("Gmail list: " + listResp.status);
    return [];
  }

  const listData = await listResp.json();
  const messageIds = (listData.messages || []).map((m: any) => m.id);

  // Fetch each message
  const emails = [];
  for (const id of messageIds.slice(0, 30)) { // Cap at 30 per sync
    try {
      const msgResp = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
        { headers: { Authorization: "Bearer " + accessToken } },
      );

      if (!msgResp.ok) continue;
      const msg = await msgResp.json();

      const headers = msg.payload?.headers || [];
      const getHeader = (name: string) => headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

      const subject = getHeader("Subject");
      const from = getHeader("From");
      const date = getHeader("Date");

      // Extract body text
      let body = "";
      const extractText = (part: any): string => {
        if (part.mimeType === "text/plain" && part.body?.data) {
          return atob(part.body.data.replace(/-/g, "+").replace(/_/g, "/"));
        }
        if (part.parts) {
          for (const p of part.parts) {
            const t = extractText(p);
            if (t) return t;
          }
        }
        return "";
      };
      body = extractText(msg.payload);

      if (body || subject) {
        emails.push({ id, subject, from, date, body: body.substring(0, 3000) });
      }

      await sleep(100);
    } catch {}
  }

  return emails;
}


// ── Outlook fetcher ──────────────────────────────────────────────────────────

async function fetchOutlookEmails(
  accessToken: string,
  sinceDate: Date,
  stats: any,
): Promise<Array<{ id: string; subject: string; from: string; date: string; body: string }>> {
  const sinceISO = sinceDate.toISOString();

  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages?$filter=receivedDateTime ge ${sinceISO}&$select=id,subject,from,receivedDateTime,bodyPreview,body&$top=50&$orderby=receivedDateTime desc`,
    {
      headers: {
        Authorization: "Bearer " + accessToken,
        Prefer: 'outlook.body-content-type="text"',
      },
    },
  );

  if (!resp.ok) {
    stats.errors.push("Outlook list: " + resp.status);
    return [];
  }

  const data = await resp.json();
  const messages = data.value || [];

  // Filter for trade-related by subject/preview
  const tradePattern = /invoice|tariff|customs|shipment|bill of lading|commercial invoice|packing list|certificate of origin|duty|import|export|hs code|freight|consignment/i;

  return messages
    .filter((m: any) => tradePattern.test(m.subject || "") || tradePattern.test(m.bodyPreview || ""))
    .slice(0, 30)
    .map((m: any) => ({
      id: m.id,
      subject: m.subject || "",
      from: m.from?.emailAddress?.address || "",
      date: m.receivedDateTime || "",
      body: (m.body?.content || m.bodyPreview || "").substring(0, 3000),
    }));
}


// ── Helpers ──────────────────────────────────────────────────────────────────

async function refreshToken(
  platform: string,
  config: Record<string, unknown>,
  integration: any,
  supabase: ReturnType<typeof createClient>,
): Promise<{ access_token?: string; error?: string }> {
  const refreshTokenVal = config.refresh_token as string;
  if (!refreshTokenVal) return { error: "No refresh token" };

  let tokenUrl: string;
  let params: Record<string, string>;

  if (platform === "GMAIL") {
    tokenUrl = "https://oauth2.googleapis.com/token";
    params = {
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: refreshTokenVal,
      grant_type: "refresh_token",
    };
  } else {
    tokenUrl = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
    params = {
      client_id: Deno.env.get("OUTLOOK_CLIENT_ID")!,
      client_secret: Deno.env.get("OUTLOOK_CLIENT_SECRET")!,
      refresh_token: refreshTokenVal,
      grant_type: "refresh_token",
      scope: "https://graph.microsoft.com/Mail.Read offline_access",
    };
  }

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });

  if (!resp.ok) return { error: await resp.text() };
  const tokens = await resp.json();

  await supabase.from("erp_integration").update({
    mappingconfig: {
      ...config,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || refreshTokenVal,
      expires_at: Date.now() + ((tokens.expires_in || 3600) * 1000),
    },
  }).eq("integrationid", integration.integrationid);

  return { access_token: tokens.access_token };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}
