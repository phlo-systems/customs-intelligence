// supabase/functions/email-connect/index.ts
// Deploy: supabase functions deploy email-connect --no-verify-jwt
//
// Gmail + Outlook OAuth2 connection.
//
// POST /email-connect
//   { "action": "auth_gmail" }              — returns Gmail OAuth redirect URL
//   { "action": "auth_outlook" }            — returns Outlook OAuth redirect URL
//   { "action": "callback_gmail", "code": "..." }   — exchange Gmail auth code
//   { "action": "callback_outlook", "code": "..." } — exchange Outlook auth code
//   { "action": "status" }
//   { "action": "disconnect" }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
};

// Gmail
const GMAIL_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GMAIL_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

// Outlook
const OUTLOOK_AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const OUTLOOK_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const OUTLOOK_SCOPE = "https://graph.microsoft.com/Mail.Read offline_access";

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

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const action = String(body.action || "status");
  const redirectBase = Deno.env.get("SUPABASE_URL") + "/functions/v1/email-connect";

  // ── Status ───────────────────────────────────────────────────────────────
  if (action === "status") {
    const { data: gmail } = await supabase.from("erp_integration")
      .select("mappingconfig, lastsyncat, isactive")
      .eq("tenantid", tenantId).eq("erptype", "GMAIL").eq("isactive", true).maybeSingle();

    const { data: outlook } = await supabase.from("erp_integration")
      .select("mappingconfig, lastsyncat, isactive")
      .eq("tenantid", tenantId).eq("erptype", "OUTLOOK").eq("isactive", true).maybeSingle();

    const gmailConfig = gmail?.mappingconfig as Record<string, unknown> || {};
    const outlookConfig = outlook?.mappingconfig as Record<string, unknown> || {};

    return json({
      gmail: { connected: !!gmail?.isactive, email: gmailConfig.email || null, last_sync_at: gmail?.lastsyncat },
      outlook: { connected: !!outlook?.isactive, email: outlookConfig.email || null, last_sync_at: outlook?.lastsyncat },
    });
  }

  // ── Gmail Auth ───────────────────────────────────────────────────────────
  if (action === "auth_gmail") {
    const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
    if (!clientId) return json({ error: "GOOGLE_CLIENT_ID not configured" }, 500);

    const state = btoa(JSON.stringify({ platform: "gmail", api_key: rawKey }));
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectBase,
      response_type: "code",
      scope: GMAIL_SCOPE,
      access_type: "offline",
      prompt: "consent",
      state,
    });

    return json({ redirect_url: GMAIL_AUTH_URL + "?" + params.toString() });
  }

  // ── Gmail Callback ─────────────────────────────────────────────────────
  if (action === "callback_gmail") {
    const code = String(body.code || "");
    if (!code) return json({ error: "code required" }, 400);

    const clientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
    const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

    const tokenResp = await fetch(GMAIL_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectBase,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResp.ok) {
      return json({ error: "Gmail token exchange failed", detail: (await tokenResp.text()).substring(0, 200) }, 502);
    }

    const tokens = await tokenResp.json();

    // Get user email
    const profileResp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: "Bearer " + tokens.access_token },
    });
    const profile = profileResp.ok ? await profileResp.json() : {};

    await supabase.from("erp_integration").upsert({
      tenantid: tenantId,
      erptype: "GMAIL",
      erptenantid: profile.emailAddress || "gmail",
      authtokenref: "gmail_oauth",
      syncenabled: true,
      isactive: true,
      mappingconfig: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + ((tokens.expires_in || 3600) * 1000),
        email: profile.emailAddress,
        history_id: profile.historyId,
      },
    }, { onConflict: "tenantid,erptype,erptenantid" });

    return json({ status: "ok", connected: true, email: profile.emailAddress });
  }

  // ── Outlook Auth ─────────────────────────────────────────────────────────
  if (action === "auth_outlook") {
    const clientId = Deno.env.get("OUTLOOK_CLIENT_ID");
    if (!clientId) return json({ error: "OUTLOOK_CLIENT_ID not configured" }, 500);

    const state = btoa(JSON.stringify({ platform: "outlook", api_key: rawKey }));
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectBase,
      response_type: "code",
      scope: OUTLOOK_SCOPE,
      state,
    });

    return json({ redirect_url: OUTLOOK_AUTH_URL + "?" + params.toString() });
  }

  // ── Outlook Callback ───────────────────────────────────────────────────
  if (action === "callback_outlook") {
    const code = String(body.code || "");
    if (!code) return json({ error: "code required" }, 400);

    const clientId = Deno.env.get("OUTLOOK_CLIENT_ID")!;
    const clientSecret = Deno.env.get("OUTLOOK_CLIENT_SECRET")!;

    const tokenResp = await fetch(OUTLOOK_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectBase,
        grant_type: "authorization_code",
        scope: OUTLOOK_SCOPE,
      }),
    });

    if (!tokenResp.ok) {
      return json({ error: "Outlook token exchange failed", detail: (await tokenResp.text()).substring(0, 200) }, 502);
    }

    const tokens = await tokenResp.json();

    // Get user info
    const meResp = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: "Bearer " + tokens.access_token },
    });
    const me = meResp.ok ? await meResp.json() : {};

    await supabase.from("erp_integration").upsert({
      tenantid: tenantId,
      erptype: "OUTLOOK",
      erptenantid: me.mail || me.userPrincipalName || "outlook",
      authtokenref: "outlook_oauth",
      syncenabled: true,
      isactive: true,
      mappingconfig: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + ((tokens.expires_in || 3600) * 1000),
        email: me.mail || me.userPrincipalName,
        delta_link: null,
      },
    }, { onConflict: "tenantid,erptype,erptenantid" });

    return json({ status: "ok", connected: true, email: me.mail || me.userPrincipalName });
  }

  // ── Disconnect ───────────────────────────────────────────────────────────
  if (action === "disconnect") {
    const platform = String(body.platform || "").toUpperCase();
    if (!["GMAIL", "OUTLOOK"].includes(platform)) return json({ error: "platform must be GMAIL or OUTLOOK" }, 400);

    await supabase.from("erp_integration")
      .update({ isactive: false, syncenabled: false })
      .eq("tenantid", tenantId).eq("erptype", platform);

    return json({ status: "disconnected" });
  }

  return json({ error: "Unknown action" }, 400);
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}
