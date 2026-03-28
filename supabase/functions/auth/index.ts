// supabase/functions/auth/index.ts
// Deploy: supabase functions deploy auth --no-verify-jwt
//
// Tenant authentication and provisioning.
//
// POST /auth
//   { "action": "signup", "email": "...", "password": "...", "company_name": "..." }
//   { "action": "login", "email": "...", "password": "..." }
//   { "action": "logout" }
//   { "action": "me" }   — returns current user + tenant info (requires Authorization header)
//   { "action": "refresh", "refresh_token": "..." }
//   { "action": "api_key" }  — generate/retrieve API key for current tenant

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json({ ok: true }, 200);
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  // Service role client (for admin operations)
  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Anon client (for auth operations — respects RLS)
  const supabaseAnon = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const action = String(body.action || "");

  // ── Signup ─────────────────────────────────────────────────────────────
  if (action === "signup") {
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const companyName = String(body.company_name || "").trim();

    if (!email || !password) return json({ error: "email and password required" }, 400);
    if (password.length < 8) return json({ error: "Password must be at least 8 characters" }, 400);
    if (!companyName) return json({ error: "company_name required" }, 400);

    // 1. Create Supabase Auth user
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // Auto-confirm for now
      user_metadata: { company_name: companyName },
    });

    if (authError) {
      if (authError.message?.includes("already registered")) {
        return json({ error: "Email already registered. Please login." }, 409);
      }
      return json({ error: authError.message }, 400);
    }

    const userId = authData.user.id; // UUID

    // 2. Create tenant context
    await supabaseAdmin.from("tenant_context").upsert({
      tenantid: userId,
      businesstype: null,
      updatedat: new Date().toISOString(),
    }, { onConflict: "tenantid" });

    // 3. Generate API key
    const rawKey = generateApiKey();
    const keyHash = await sha256hex(rawKey);

    await supabaseAdmin.from("api_key").insert({
      keyhash: keyHash,
      tenantid: companyName.toLowerCase().replace(/[^a-z0-9]/g, "_"),
      tenantuid: userId,
      scopes: ["tariff:lookup", "classify", "opportunities", "alerts"],
      isactive: true,
      createdby: email,
    });

    // 4. Sign in to get JWT
    const { data: session, error: loginError } = await supabaseAnon.auth.signInWithPassword({
      email, password,
    });

    if (loginError) {
      return json({ error: "Account created but login failed: " + loginError.message }, 500);
    }

    return json({
      status: "ok",
      user: {
        id: userId,
        email,
        company_name: companyName,
        is_admin: false,
      },
      session: {
        access_token: session.session?.access_token,
        refresh_token: session.session?.refresh_token,
        expires_at: session.session?.expires_at,
      },
      api_key: rawKey, // Show once — user must save it
      message: "Account created. Save your API key — it won't be shown again.",
    });
  }

  // ── Login ──────────────────────────────────────────────────────────────
  if (action === "login") {
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    if (!email || !password) return json({ error: "email and password required" }, 400);

    const { data: session, error } = await supabaseAnon.auth.signInWithPassword({
      email, password,
    });

    if (error) return json({ error: error.message }, 401);

    const userId = session.user?.id;

    // Get tenant info
    const { data: ctx } = await supabaseAdmin
      .from("tenant_context")
      .select("businesstype, annualvolumerange")
      .eq("tenantid", userId)
      .maybeSingle();

    return json({
      status: "ok",
      user: {
        id: userId,
        email: session.user?.email,
        company_name: session.user?.user_metadata?.company_name || null,
        is_admin: session.user?.user_metadata?.is_admin === true,
      },
      session: {
        access_token: session.session?.access_token,
        refresh_token: session.session?.refresh_token,
        expires_at: session.session?.expires_at,
      },
      tenant: ctx || null,
    });
  }

  // ── Refresh ────────────────────────────────────────────────────────────
  if (action === "refresh") {
    const refreshToken = String(body.refresh_token || "");
    if (!refreshToken) return json({ error: "refresh_token required" }, 400);

    const { data, error } = await supabaseAnon.auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (error) return json({ error: error.message }, 401);

    return json({
      status: "ok",
      session: {
        access_token: data.session?.access_token,
        refresh_token: data.session?.refresh_token,
        expires_at: data.session?.expires_at,
      },
    });
  }

  // ── Me (requires Authorization: Bearer JWT) ────────────────────────────
  if (action === "me") {
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json({ error: "Authorization: Bearer <token> required" }, 401);
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !user) return json({ error: "Invalid or expired token" }, 401);

    const { data: ctx } = await supabaseAdmin
      .from("tenant_context")
      .select("*")
      .eq("tenantid", user.id)
      .maybeSingle();

    // Check ERP connections
    const { data: erps } = await supabaseAdmin
      .from("erp_integration")
      .select("erptype, isactive, lastsyncat")
      .eq("tenantid", user.id)
      .eq("isactive", true);

    return json({
      user: {
        id: user.id,
        email: user.email,
        company_name: user.user_metadata?.company_name || null,
        is_admin: user.user_metadata?.is_admin === true,
        created_at: user.created_at,
      },
      tenant: ctx || null,
      connections: (erps || []).map((e: any) => ({
        type: e.erptype,
        last_sync: e.lastsyncat,
      })),
    });
  }

  // ── API Key (retrieve or regenerate) ───────────────────────────────────
  if (action === "api_key") {
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json({ error: "Authorization: Bearer <token> required" }, 401);
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !user) return json({ error: "Invalid token" }, 401);

    const regenerate = body.regenerate === true;

    if (regenerate) {
      // Deactivate old keys
      await supabaseAdmin.from("api_key")
        .update({ isactive: false })
        .eq("tenantuid", user.id);

      // Generate new key
      const rawKey = generateApiKey();
      const keyHash = await sha256hex(rawKey);

      await supabaseAdmin.from("api_key").insert({
        keyhash: keyHash,
        tenantid: (user.user_metadata?.company_name || "tenant").toLowerCase().replace(/[^a-z0-9]/g, "_"),
        tenantuid: user.id,
        scopes: ["tariff:lookup", "classify", "opportunities", "alerts"],
        isactive: true,
        createdby: user.email,
      });

      return json({ api_key: rawKey, message: "New key generated. Old keys deactivated." });
    }

    // Can't retrieve the raw key (only hash stored). Tell user to regenerate.
    return json({ message: "API keys cannot be retrieved — only regenerated. Set regenerate: true to create a new one." });
  }

  // ── Reset Password (send email) ──────────────────────────────────────
  if (action === "reset_password") {
    const email = String(body.email || "").trim().toLowerCase();
    if (!email) return json({ error: "email required" }, 400);

    const redirectTo = String(body.redirect_to || "https://customs-intelligence.vercel.app");

    const { error } = await supabaseAdmin.auth.resetPasswordForEmail(email, {
      redirectTo: redirectTo + "?type=recovery",
    });

    if (error) return json({ error: error.message }, 400);

    return json({ status: "ok", message: "Password reset email sent. Check your inbox." });
  }

  // ── Update Password (after reset link click) ───────────────────────
  if (action === "update_password") {
    const accessToken = String(body.access_token || "");
    const newPassword = String(body.new_password || "");

    if (!accessToken) return json({ error: "access_token required" }, 400);
    if (!newPassword || newPassword.length < 8) return json({ error: "Password must be at least 8 characters" }, 400);

    // Verify the token is valid
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(accessToken);
    if (userError || !user) return json({ error: "Invalid or expired reset token" }, 401);

    // Update the password
    const { error } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
      password: newPassword,
    });

    if (error) return json({ error: error.message }, 500);

    return json({ status: "ok", message: "Password updated. You can now sign in." });
  }

  // ── Logout ─────────────────────────────────────────────────────────────
  if (action === "logout") {
    return json({ status: "ok", message: "Logged out. Discard client-side tokens." });
  }

  // ── Fast HS code search (keyword match on commodity descriptions) ──────
  if (action === "search_hs") {
    const query = String(body.query || "").trim();
    const country = String(body.country || "IN").toUpperCase();
    if (!query || query.length < 3) return json({ results: [] });

    // Split query into keywords and search
    const keywords = query.toLowerCase().split(/\s+/).filter((w: string) => w.length >= 3).slice(0, 3);
    if (!keywords.length) return json({ results: [] });

    // Search using ilike for each keyword
    let queryBuilder = supabaseAdmin
      .from("commodity_code")
      .select("commoditycode, nationaldescription, subheadingcode")
      .eq("countrycode", country)
      .eq("isactive", true);

    // Apply all keywords as AND filters
    for (const kw of keywords) {
      queryBuilder = queryBuilder.ilike("nationaldescription", `%${kw}%`);
    }

    const { data: matches } = await queryBuilder.order("commoditycode").limit(8);

    let results = (matches || []).map((r: any) => ({
      commoditycode: r.commoditycode,
      nationaldescription: (r.nationaldescription || "").replace(/^[\s\-]+/, "").substring(0, 60),
    }));

    // If no results from national descriptions, search WCO universal descriptions
    // (countrycode=XX in hs_description_embedding table — works for every country)
    if (results.length === 0) {
      let wcoQuery = supabaseAdmin
        .from("hs_description_embedding")
        .select("subheadingcode, descriptiontext")
        .eq("countrycode", "XX");
      for (const kw of keywords) {
        wcoQuery = wcoQuery.ilike("descriptiontext", `%${kw}%`);
      }
      const { data: wcoMatches } = await wcoQuery.order("subheadingcode").limit(10);

      if (wcoMatches?.length) {
        // Map WCO subheadings to target country's commodity codes
        const seen = new Set<string>();
        for (const wco of wcoMatches) {
          if (seen.has(wco.subheadingcode)) continue;
          seen.add(wco.subheadingcode);

          const { data: targetCodes } = await supabaseAdmin
            .from("commodity_code")
            .select("commoditycode, nationaldescription")
            .eq("countrycode", country)
            .eq("subheadingcode", wco.subheadingcode)
            .eq("isactive", true)
            .order("commoditycode")
            .limit(1);

          if (targetCodes?.length) {
            // Extract clean heading description from WCO text
            // Format: "Chapter 02: Meat and edible meat offal > Heading 0201: Meat of bovine..."
            const wcoDesc = wco.descriptiontext || "";
            const headingMatch = wcoDesc.match(/Heading \d+:\s*(.+?)(?:\s*>|$)/);
            const cleanDesc = headingMatch ? headingMatch[1].trim() : wcoDesc.substring(0, 60);

            results.push({
              commoditycode: targetCodes[0].commoditycode,
              nationaldescription: cleanDesc,
            });
          }
          if (results.length >= 8) break;
        }
      }
    }

    return json({ results: results.slice(0, 8) });
  }

  return json({ error: "Unknown action. Use: signup, login, refresh, me, api_key, search_hs, reset_password, update_password, logout" }, 400);
});


// ── Helpers ──────────────────────────────────────────────────────────────────

function generateApiKey(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let key = "ci_live_";
  for (let i = 0; i < 32; i++) {
    key += chars[Math.floor(Math.random() * chars.length)];
  }
  return key;
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
