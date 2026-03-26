// supabase/functions/acumatica-connect/index.ts
// Deploy: supabase functions deploy acumatica-connect --no-verify-jwt
//
// Acumatica ERP OAuth2 integration.
//
// POST /acumatica-connect
//   { "action": "auth", "instance_url": "https://acme.acumatica.com", "client_id": "...", "client_secret": "..." }
//     — returns redirect URL for OAuth2 flow
//   { "action": "callback", "code": "...", "instance_url": "..." }
//     — exchange auth code for tokens
//   { "action": "connect_credentials", "instance_url": "...", "client_id": "...", "client_secret": "..." }
//     — client credentials flow (no user redirect needed)
//   { "action": "status" }
//   { "action": "refresh" }
//   { "action": "disconnect" }

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

  // ── Status ───────────────────────────────────────────────────────────────
  if (action === "status") {
    const { data: integration } = await supabase
      .from("erp_integration")
      .select("*")
      .eq("tenantid", tenantId)
      .eq("erptype", "ACUMATICA")
      .eq("isactive", true)
      .maybeSingle();

    if (!integration) return json({ connected: false });

    const config = integration.mappingconfig as Record<string, unknown> || {};
    return json({
      connected: true,
      instance_url: config.instance_url,
      company_name: config.company_name || config.instance_url,
      last_sync_at: integration.lastsyncat,
      auth_method: config.auth_method || "oauth2",
    });
  }

  // ── Connect via Client Credentials (simplest — no redirect) ──────────────
  if (action === "connect_credentials") {
    const instanceUrl = String(body.instance_url || "").replace(/\/+$/, "");
    const clientId = String(body.client_id || "");
    const clientSecret = String(body.client_secret || "");
    const companyName = String(body.company_name || "");

    if (!instanceUrl || !clientId || !clientSecret) {
      return json({ error: "instance_url, client_id, and client_secret are required" }, 400);
    }

    // Exchange client credentials for access token
    try {
      const tokenResp = await fetch(`${instanceUrl}/identity/connect/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret,
          scope: "api",
        }),
      });

      if (!tokenResp.ok) {
        const err = await tokenResp.text();
        return json({ error: "Token exchange failed", detail: err.substring(0, 200) }, 502);
      }

      const tokens = await tokenResp.json();

      // Test the connection by fetching company info
      const testResp = await fetch(`${instanceUrl}/entity/Default/24.200.001/Branch?$top=1`, {
        headers: { "Authorization": `Bearer ${tokens.access_token}` },
      });

      let detectedCompany = companyName;
      if (testResp.ok) {
        const branches = await testResp.json();
        if (branches.length > 0) {
          detectedCompany = branches[0].BranchID?.value || companyName;
        }
      }

      // Store integration
      await supabase.from("erp_integration").upsert({
        tenantid: tenantId,
        erptype: "ACUMATICA",
        erptenantid: instanceUrl,
        authtokenref: "acumatica_credentials",
        syncenabled: true,
        isactive: true,
        mappingconfig: {
          instance_url: instanceUrl,
          client_id: clientId,
          client_secret: clientSecret,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token || null,
          expires_at: Date.now() + ((tokens.expires_in || 3600) * 1000),
          auth_method: "client_credentials",
          company_name: detectedCompany || instanceUrl,
          api_version: "24.200.001",
        },
      }, { onConflict: "tenantid,erptype,erptenantid" });

      return json({
        status: "ok",
        connected: true,
        company_name: detectedCompany,
        instance_url: instanceUrl,
      });

    } catch (e) {
      return json({ error: "Connection failed", detail: String(e) }, 502);
    }
  }

  // ── OAuth2 redirect URL ──────────────────────────────────────────────────
  if (action === "auth") {
    const instanceUrl = String(body.instance_url || "").replace(/\/+$/, "");
    const clientId = String(body.client_id || "");

    if (!instanceUrl || !clientId) {
      return json({ error: "instance_url and client_id are required" }, 400);
    }

    const redirectUri = `${Deno.env.get("SUPABASE_URL")}/functions/v1/acumatica-connect`;
    const state = btoa(JSON.stringify({
      api_key: rawKey,
      instance_url: instanceUrl,
      client_id: clientId,
    }));

    const authUrl = `${instanceUrl}/identity/connect/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=api+offline_access&state=${encodeURIComponent(state)}`;

    return json({ redirect_url: authUrl });
  }

  // ── OAuth2 callback ──────────────────────────────────────────────────────
  if (action === "callback") {
    const code = String(body.code || "");
    const stateRaw = String(body.state || "");

    if (!code) return json({ error: "code is required" }, 400);

    let stateData: Record<string, string>;
    try {
      stateData = JSON.parse(atob(stateRaw));
    } catch {
      return json({ error: "Invalid state parameter" }, 400);
    }

    const instanceUrl = stateData.instance_url;
    const clientId = stateData.client_id;
    const clientSecret = String(body.client_secret || "");
    const redirectUri = `${Deno.env.get("SUPABASE_URL")}/functions/v1/acumatica-connect`;

    const tokenResp = await fetch(`${instanceUrl}/identity/connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenResp.ok) {
      const err = await tokenResp.text();
      return json({ error: "Token exchange failed", detail: err.substring(0, 200) }, 502);
    }

    const tokens = await tokenResp.json();

    await supabase.from("erp_integration").upsert({
      tenantid: tenantId,
      erptype: "ACUMATICA",
      erptenantid: instanceUrl,
      authtokenref: "acumatica_oauth",
      syncenabled: true,
      isactive: true,
      mappingconfig: {
        instance_url: instanceUrl,
        client_id: clientId,
        client_secret: clientSecret,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + ((tokens.expires_in || 3600) * 1000),
        auth_method: "oauth2",
        api_version: "24.200.001",
      },
    }, { onConflict: "tenantid,erptype,erptenantid" });

    return json({ status: "ok", connected: true });
  }

  // ── Refresh ──────────────────────────────────────────────────────────────
  if (action === "refresh") {
    const { data: integration } = await supabase
      .from("erp_integration")
      .select("*")
      .eq("tenantid", tenantId)
      .eq("erptype", "ACUMATICA")
      .eq("isactive", true)
      .maybeSingle();

    if (!integration) return json({ error: "No active Acumatica connection" }, 404);

    const config = integration.mappingconfig as Record<string, unknown>;
    const instanceUrl = config.instance_url as string;

    // For client_credentials, just get a new token
    if (config.auth_method === "client_credentials") {
      const tokenResp = await fetch(`${instanceUrl}/identity/connect/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: config.client_id as string,
          client_secret: config.client_secret as string,
          scope: "api",
        }),
      });

      if (!tokenResp.ok) return json({ error: "Token refresh failed" }, 502);
      const tokens = await tokenResp.json();

      await supabase.from("erp_integration").update({
        mappingconfig: { ...config, access_token: tokens.access_token, expires_at: Date.now() + ((tokens.expires_in || 3600) * 1000) },
      }).eq("integrationid", integration.integrationid);

      return json({ status: "refreshed" });
    }

    // For OAuth2, use refresh token
    const tokenResp = await fetch(`${instanceUrl}/identity/connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: config.refresh_token as string,
        client_id: config.client_id as string,
        client_secret: config.client_secret as string,
      }),
    });

    if (!tokenResp.ok) return json({ error: "Token refresh failed" }, 502);
    const tokens = await tokenResp.json();

    await supabase.from("erp_integration").update({
      mappingconfig: { ...config, access_token: tokens.access_token, refresh_token: tokens.refresh_token || config.refresh_token, expires_at: Date.now() + ((tokens.expires_in || 3600) * 1000) },
    }).eq("integrationid", integration.integrationid);

    return json({ status: "refreshed" });
  }

  // ── Disconnect ───────────────────────────────────────────────────────────
  if (action === "disconnect") {
    await supabase.from("erp_integration")
      .update({ isactive: false, syncenabled: false })
      .eq("tenantid", tenantId)
      .eq("erptype", "ACUMATICA");

    return json({ status: "disconnected" });
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
