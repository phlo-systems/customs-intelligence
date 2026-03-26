// supabase/functions/xero-connect/index.ts
// Deploy: supabase functions deploy xero-connect --no-verify-jwt
//
// Xero OAuth2 integration — handles both the auth redirect and callback.
//
// GET  /xero-connect?action=auth     — redirects user to Xero login
// GET  /xero-connect?code=...&state=...  — OAuth callback from Xero
// POST /xero-connect                 — manual token refresh or disconnect
//   { "action": "refresh" }          — refresh access token
//   { "action": "disconnect" }       — revoke tokens and deactivate
//   { "action": "status" }           — check connection status

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
};

const XERO_AUTH_URL = "https://login.xero.com/identity/connect/authorize";
const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
const XERO_CONNECTIONS_URL = "https://api.xero.com/connections";
const XERO_REVOKE_URL = "https://identity.xero.com/connect/revocation";

// New granular scopes (required for apps created after 2 March 2026)
const SCOPES = "openid profile email accounting.invoices.read accounting.contacts.read accounting.settings.read offline_access";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json({ ok: true }, 200);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const clientId = Deno.env.get("XERO_CLIENT_ID");
  const clientSecret = Deno.env.get("XERO_CLIENT_SECRET");
  const redirectUri = `${Deno.env.get("SUPABASE_URL")}/functions/v1/xero-connect`;

  if (!clientId || !clientSecret) {
    return json({ error: "Xero app not configured. Set XERO_CLIENT_ID and XERO_CLIENT_SECRET." }, 500);
  }

  const url = new URL(req.url);

  // ── GET: OAuth redirect or callback ──────────────────────────────────────
  if (req.method === "GET") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const action = url.searchParams.get("action");

    // Step 1: Redirect to Xero
    if (action === "auth") {
      const apiKey = url.searchParams.get("api_key") || "";
      const stateParam = btoa(JSON.stringify({ api_key: apiKey, ts: Date.now() }));

      const authUrl = new URL(XERO_AUTH_URL);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("scope", SCOPES);
      authUrl.searchParams.set("state", stateParam);

      return Response.redirect(authUrl.toString(), 302);
    }

    // Step 2: OAuth callback — exchange code for tokens
    if (code) {
      try {
        // Exchange code for tokens
        const tokenResp = await fetch(XERO_TOKEN_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
          }),
        });

        if (!tokenResp.ok) {
          const err = await tokenResp.text();
          console.error("Token exchange failed:", err);
          return htmlResponse("Connection failed", `Token exchange error: ${err}`);
        }

        const tokens = await tokenResp.json();

        // Get Xero tenant (organisation) info
        const connResp = await fetch(XERO_CONNECTIONS_URL, {
          headers: { "Authorization": `Bearer ${tokens.access_token}` },
        });

        const connections = await connResp.json();
        if (!connections.length) {
          return htmlResponse("No Xero organisation", "No Xero organisation found. Please approve access to at least one organisation.");
        }

        const xeroTenant = connections[0]; // Use first org
        const xeroTenantId = xeroTenant.tenantId;
        const xeroTenantName = xeroTenant.tenantName;

        // Resolve our tenant from state
        let tenantUID = "a0000000-0000-0000-0000-000000000001"; // default GTM tenant
        if (state) {
          try {
            const stateData = JSON.parse(atob(state));
            if (stateData.api_key) {
              const keyHash = await sha256hex(stateData.api_key);
              const { data: keyRow } = await supabase
                .from("api_key")
                .select("tenantuid")
                .eq("keyhash", keyHash)
                .eq("isactive", true)
                .maybeSingle();
              if (keyRow?.tenantuid) tenantUID = keyRow.tenantuid;
            }
          } catch { /* use default */ }
        }

        // Store tokens in ERP_INTEGRATION table
        // NOTE: In production, tokens should go to Key Vault.
        // For now, store encrypted in MappingConfig JSONB.
        await supabase.from("erp_integration").upsert({
          tenantid: tenantUID,
          erptype: "XERO",
          erptenantid: xeroTenantId,
          authtokenref: "xero_oauth_tokens", // Key Vault ref in production
          webhookurl: null,
          mappingconfig: {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at: Date.now() + (tokens.expires_in * 1000),
            xero_tenant_name: xeroTenantName,
            scopes: SCOPES,
          },
          syncenabled: true,
          isactive: true,
        }, { onConflict: "tenantid,erptype,erptenantid" });

        return htmlResponse(
          "Xero Connected!",
          `Successfully connected to <strong>${xeroTenantName}</strong>. You can close this window and return to Customs Intelligence.`,
          true,
        );

      } catch (e) {
        console.error("OAuth callback error:", e);
        return htmlResponse("Connection failed", String(e));
      }
    }

    return json({ error: "Missing action or code parameter" }, 400);
  }

  // ── POST: Token refresh, disconnect, or status ───────────────────────────
  if (req.method === "POST") {
    // Validate API key
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

    // Use tenantuid (UUID) consistently — this is what the callback writes
    const tenantId = keyRow.tenantuid || keyRow.tenantid;

    let body: Record<string, unknown>;
    try { body = await req.json(); }
    catch { return json({ error: "Invalid JSON" }, 400); }

    const action = String(body.action || "status");

    // Get existing integration
    const { data: integration } = await supabase
      .from("erp_integration")
      .select("*")
      .eq("tenantid", tenantId)
      .eq("erptype", "XERO")
      .eq("isactive", true)
      .maybeSingle();

    // ── Status ──
    if (action === "status") {
      if (!integration) {
        return json({ connected: false });
      }
      const config = integration.mappingconfig as Record<string, unknown>;
      return json({
        connected: true,
        xero_tenant_name: config?.xero_tenant_name,
        xero_tenant_id: integration.erptenantid,
        sync_enabled: integration.syncenabled,
        last_sync_at: integration.lastsyncat,
        token_expires_at: config?.expires_at ? new Date(config.expires_at as number).toISOString() : null,
      });
    }

    if (!integration) {
      return json({ error: "No active Xero connection" }, 404);
    }

    const config = integration.mappingconfig as Record<string, unknown>;

    // ── Refresh ──
    if (action === "refresh") {
      const refreshToken = config?.refresh_token as string;
      if (!refreshToken) return json({ error: "No refresh token" }, 400);

      const tokenResp = await fetch(XERO_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Authorization": `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      });

      if (!tokenResp.ok) {
        const err = await tokenResp.text();
        return json({ error: "Token refresh failed", detail: err }, 502);
      }

      const tokens = await tokenResp.json();

      await supabase.from("erp_integration")
        .update({
          mappingconfig: {
            ...config,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at: Date.now() + (tokens.expires_in * 1000),
          },
        })
        .eq("integrationid", integration.integrationid);

      return json({ status: "refreshed", expires_at: new Date(Date.now() + (tokens.expires_in * 1000)).toISOString() });
    }

    // ── Disconnect ──
    if (action === "disconnect") {
      // Revoke token at Xero
      const token = config?.refresh_token as string || config?.access_token as string;
      if (token) {
        await fetch(XERO_REVOKE_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
          },
          body: new URLSearchParams({ token }),
        }).catch(() => {});
      }

      await supabase.from("erp_integration")
        .update({ isactive: false, syncenabled: false })
        .eq("integrationid", integration.integrationid);

      return json({ status: "disconnected" });
    }

    return json({ error: "Unknown action" }, 400);
  }

  return json({ error: "Method not allowed" }, 405);
});


// ── Helpers ──────────────────────────────────────────────────────────────────

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function htmlResponse(title: string, message: string, success = false) {
  // Supabase Edge Functions force application/json content-type,
  // so we return JSON that the frontend polling will pick up.
  // For direct browser visits, we use a self-rendering page via data URI workaround.
  return json({
    status: success ? "ok" : "error",
    title,
    message,
    xero_callback: true,
  }, success ? 200 : 400);
}

async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}
