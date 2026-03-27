// supabase/functions/admin/index.ts
// Deploy: supabase functions deploy admin --no-verify-jwt
//
// Admin-only endpoint for tenant management, usage stats, and KPIs.
// Requires is_admin=true in user metadata.
//
// POST /admin
//   { "action": "dashboard" }   — KPIs + summary stats
//   { "action": "tenants" }     — all tenants with details
//   { "action": "usage", "days": 30 }  — API usage breakdown
//   { "action": "set_admin", "user_id": "...", "is_admin": true/false }

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

  // ── Auth + admin check ─────────────────────────────────────────────────
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json({ error: "Authorization required" }, 401);
  }

  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return json({ error: "Invalid token" }, 401);
  if (!user.user_metadata?.is_admin) return json({ error: "Admin access required" }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const action = String(body.action || "dashboard");

  // ── Dashboard KPIs ─────────────────────────────────────────────────────
  if (action === "dashboard") {
    // Total tenants
    const { count: tenantCount } = await supabase
      .from("tenant_context")
      .select("*", { count: "exact", head: true });

    // Total users from auth
    const { data: { users: allUsers } } = await supabase.auth.admin.listUsers({ perPage: 1000 });

    // Active users (logged in within last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const activeUsers = (allUsers || []).filter(
      (u: any) => u.last_sign_in_at && u.last_sign_in_at > sevenDaysAgo
    ).length;

    // API calls (last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    const { count: apiCalls30d } = await supabase
      .from("api_usage_log")
      .select("*", { count: "exact", head: true })
      .gte("calledat", thirtyDaysAgo);

    // API calls (last 24h)
    const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
    const { count: apiCalls24h } = await supabase
      .from("api_usage_log")
      .select("*", { count: "exact", head: true })
      .gte("calledat", oneDayAgo);

    // Data stats
    const { count: commodityCount } = await supabase
      .from("commodity_code")
      .select("*", { count: "exact", head: true });

    const { count: opportunityCount } = await supabase
      .from("opportunities")
      .select("*", { count: "exact", head: true })
      .eq("isdismissed", false);

    const { count: alertCount } = await supabase
      .from("alerts")
      .select("*", { count: "exact", head: true })
      .eq("isdismissed", false);

    const { count: classificationCount } = await supabase
      .from("classification_request")
      .select("*", { count: "exact", head: true });

    const { count: embeddingCount } = await supabase
      .from("hs_description_embedding")
      .select("*", { count: "exact", head: true });

    // ERP connections
    const { count: erpCount } = await supabase
      .from("erp_integration")
      .select("*", { count: "exact", head: true })
      .eq("isactive", true);

    return json({
      kpis: {
        total_tenants: tenantCount || 0,
        total_users: allUsers?.length || 0,
        active_users_7d: activeUsers,
        api_calls_30d: apiCalls30d || 0,
        api_calls_24h: apiCalls24h || 0,
        commodity_codes: commodityCount || 0,
        opportunities: opportunityCount || 0,
        alerts: alertCount || 0,
        classifications: classificationCount || 0,
        embeddings: embeddingCount || 0,
        erp_connections: erpCount || 0,
      },
    });
  }

  // ── Tenant list ────────────────────────────────────────────────────────
  if (action === "tenants") {
    const { data: { users: allUsers } } = await supabase.auth.admin.listUsers({ perPage: 1000 });

    const { data: contexts } = await supabase
      .from("tenant_context")
      .select("tenantid, businesstype, annualvolumerange, primaryhschapters, targetmarkets, activeorigincountries, activedestcountries, updatedat");

    const { data: apiKeys } = await supabase
      .from("api_key")
      .select("tenantuid, isactive, createdat, lastuseda");

    const { data: erpIntegrations } = await supabase
      .from("erp_integration")
      .select("tenantid, erptype, isactive, lastsyncat");

    // API usage per tenant (last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data: usageLogs } = await supabase
      .from("api_usage_log")
      .select("tenantid, endpoint, calledat")
      .gte("calledat", thirtyDaysAgo);

    const contextMap = new Map((contexts || []).map((c: any) => [c.tenantid, c]));
    const keyMap = new Map<string, any[]>();
    for (const k of (apiKeys || [])) {
      if (!keyMap.has(k.tenantuid)) keyMap.set(k.tenantuid, []);
      keyMap.get(k.tenantuid)!.push(k);
    }
    const erpMap = new Map<string, any[]>();
    for (const e of (erpIntegrations || [])) {
      if (!erpMap.has(e.tenantid)) erpMap.set(e.tenantid, []);
      erpMap.get(e.tenantid)!.push(e);
    }
    const usageMap = new Map<string, number>();
    for (const u of (usageLogs || [])) {
      usageMap.set(u.tenantid, (usageMap.get(u.tenantid) || 0) + 1);
    }

    const tenants = (allUsers || []).map((u: any) => {
      const ctx = contextMap.get(u.id);
      const keys = keyMap.get(u.id) || [];
      const erps = erpMap.get(u.id) || [];
      const activeKey = keys.find((k: any) => k.isactive);

      return {
        id: u.id,
        email: u.email,
        company_name: u.user_metadata?.company_name || null,
        is_admin: u.user_metadata?.is_admin === true,
        created_at: u.created_at,
        last_sign_in: u.last_sign_in_at,
        business_type: ctx?.businesstype || null,
        volume_range: ctx?.annualvolumerange || null,
        hs_chapters: ctx?.primaryhschapters || [],
        target_markets: ctx?.targetmarkets || [],
        origins: ctx?.activeorigincountries || [],
        destinations: ctx?.activedestcountries || [],
        profile_updated: ctx?.updatedat || null,
        api_key_active: !!activeKey,
        api_key_last_used: activeKey?.lastuseda || null,
        erp_connections: erps.filter((e: any) => e.isactive).map((e: any) => ({
          type: e.erptype,
          last_sync: e.lastsyncat,
        })),
        api_calls_30d: usageMap.get(u.id) || 0,
      };
    });

    return json({ tenants });
  }

  // ── Usage analytics ────────────────────────────────────────────────────
  if (action === "usage") {
    const days = Math.min(Number(body.days) || 30, 90);
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const { data: logs } = await supabase
      .from("api_usage_log")
      .select("tenantid, endpoint, responsestatus, responsetimems, calledat")
      .gte("calledat", since)
      .order("calledat", { ascending: false })
      .limit(5000);

    // Aggregate by endpoint
    const byEndpoint: Record<string, number> = {};
    const byDay: Record<string, number> = {};
    const byTenant: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let totalTime = 0;

    for (const l of (logs || [])) {
      byEndpoint[l.endpoint] = (byEndpoint[l.endpoint] || 0) + 1;
      byTenant[l.tenantid] = (byTenant[l.tenantid] || 0) + 1;
      byStatus[l.responsestatus] = (byStatus[l.responsestatus] || 0) + 1;
      const day = l.calledat.substring(0, 10);
      byDay[day] = (byDay[day] || 0) + 1;
      totalTime += l.responsetimems || 0;
    }

    return json({
      period_days: days,
      total_calls: logs?.length || 0,
      avg_response_ms: logs?.length ? Math.round(totalTime / logs.length) : 0,
      by_endpoint: byEndpoint,
      by_day: byDay,
      by_tenant: byTenant,
      by_status: byStatus,
    });
  }

  // ── Set admin flag ─────────────────────────────────────────────────────
  if (action === "set_admin") {
    const userId = String(body.user_id || "");
    const isAdmin = body.is_admin === true;

    if (!userId) return json({ error: "user_id required" }, 400);

    const { error } = await supabase.auth.admin.updateUserById(userId, {
      user_metadata: { is_admin: isAdmin },
    });

    if (error) return json({ error: error.message }, 500);
    return json({ status: "ok", user_id: userId, is_admin: isAdmin });
  }

  // ── Suggestions (admin view) ────────────────────────────────────────────
  if (action === "suggestions") {
    const statusFilter = String(body.status || "");
    let query = supabase.from("suggestion").select("*").order("createdat", { ascending: false }).limit(200);
    if (statusFilter) query = query.eq("status", statusFilter);
    const { data: suggestions } = await query;

    // Resolve emails from tenant IDs
    const tids = [...new Set((suggestions || []).map((s: any) => s.tenantid))];
    const { data: { users: sugUsers } } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    const userMap = new Map((sugUsers || []).map((u: any) => [u.id, u]));

    return json({
      suggestions: (suggestions || []).map((s: any) => ({
        ...s,
        email: s.email || userMap.get(s.tenantid)?.email || null,
        company: userMap.get(s.tenantid)?.user_metadata?.company_name || null,
      })),
    });
  }

  // ── Update suggestion status + reward ──────────────────────────────────
  if (action === "update_suggestion") {
    const suggestionId = Number(body.suggestion_id);
    const newStatus = String(body.status || "");
    if (!suggestionId || !newStatus) return json({ error: "suggestion_id and status required" }, 400);

    const update: Record<string, unknown> = { status: newStatus };
    if (body.admin_response) update.adminresponse = String(body.admin_response);
    if (newStatus === "IMPLEMENTED") {
      update.resolvedat = new Date().toISOString();
      // Auto-assign reward from config
      const { data: reward } = await supabase.from("reward_config").select("value").eq("rewardtype", "SUGGESTION_IMPLEMENTED").eq("isactive", true).maybeSingle();
      if (reward) { update.rewardtype = "SUGGESTION_IMPLEMENTED"; update.rewardvalue = reward.value; }
    }

    await supabase.from("suggestion").update(update).eq("suggestionid", suggestionId);
    return json({ status: "ok" });
  }

  // ── Referrals (admin view) ─────────────────────────────────────────────
  if (action === "referrals") {
    const { data: referrals } = await supabase.from("referral").select("*").order("createdat", { ascending: false }).limit(200);
    return json({ referrals: referrals || [] });
  }

  // ── Reward config ──────────────────────────────────────────────────────
  if (action === "reward_config") {
    if (body.updates && Array.isArray(body.updates)) {
      for (const u of body.updates as any[]) {
        await supabase.from("reward_config").update({ value: u.value, isactive: u.isactive !== false, updatedat: new Date().toISOString() }).eq("rewardtype", u.rewardtype);
      }
      return json({ status: "ok" });
    }
    const { data: configs } = await supabase.from("reward_config").select("*").order("rewardtype");
    return json({ rewards: configs || [] });
  }

  // ── Data Freshness Report ──────────────────────────────────────────────
  if (action === "data_freshness") {
    const country = String(body.country || "IN");

    const { data: freshness } = await supabase
      .from("data_freshness")
      .select("*")
      .eq("countrycode", country);

    // Compute staleness
    const now = Date.now();
    const items = (freshness || []).map((f: any) => {
      const lastSync = f.lastsyncat ? new Date(f.lastsyncat).getTime() : 0;
      const ageHours = lastSync ? (now - lastSync) / 3600000 : Infinity;
      return {
        ...f,
        age_hours: Math.round(ageHours),
        is_stale: ageHours > (f.staleafterhours || 720),
      };
    });

    // Pending notifications
    const { count: pendingNotifs } = await supabase
      .from("notification_tracker")
      .select("*", { count: "exact", head: true })
      .eq("status", "NEW")
      .eq("countrycode", country);

    // Stale chapters
    const { data: staleChs } = await supabase
      .from("cbic_chapter_sync")
      .select("chapternum, cbicupdateddt, lastsyncdt, syncstatus, errormessage")
      .eq("countrycode", country)
      .eq("syncstatus", "STALE");

    // Error chapters
    const { data: errorChs } = await supabase
      .from("cbic_chapter_sync")
      .select("chapternum, errormessage, syncstatus")
      .eq("countrycode", country)
      .eq("syncstatus", "ERROR");

    return json({
      country,
      checked_at: new Date().toISOString(),
      items,
      stale_count: items.filter((i: any) => i.is_stale).length,
      pending_notifications: pendingNotifs || 0,
      stale_chapters: staleChs || [],
      error_chapters: errorChs || [],
    });
  }

  // ── Notification Tracker ──────────────────────────────────────────────
  if (action === "notifications") {
    const country = String(body.country || "IN");
    const status = body.status ? String(body.status) : null;
    const limit = Math.min(Number(body.limit) || 50, 200);

    let query = supabase
      .from("notification_tracker")
      .select("*")
      .eq("countrycode", country)
      .order("detectedat", { ascending: false })
      .limit(limit);

    if (status) query = query.eq("status", status);
    const { data: notifications } = await query;

    return json({ notifications: notifications || [] });
  }

  // ── Update Notification Status ────────────────────────────────────────
  if (action === "update_notification") {
    const nid = Number(body.notification_id);
    const newStatus = String(body.status || "");
    if (!nid || !newStatus) return json({ error: "notification_id and status required" }, 400);

    const update: Record<string, unknown> = {
      status: newStatus,
      reviewedby: user.email,
      reviewedat: new Date().toISOString(),
    };
    if (body.notes) update.appliednotes = String(body.notes);

    await supabase
      .from("notification_tracker")
      .update(update)
      .eq("notificationid", nid);

    return json({ status: "ok", notification_id: nid, new_status: newStatus });
  }

  // ── Run Monitor (ad-hoc check) ─────────────────────────────────────────
  if (action === "run_monitor") {
    const country = String(body.country || "IN");
    const checkType = String(body.check || "all"); // "all", "notifications", "chapters"
    const results: Record<string, unknown> = { started_at: new Date().toISOString(), country };

    // Check CBIC notifications via Tax Information Portal API
    if (checkType === "all" || checkType === "notifications") {
      try {
        const notifResp = await fetch(
          "https://taxinformation.cbic.gov.in/api/cbic-notification-msts/fetchUpdatesByTaxId/1000002",
        );
        if (notifResp.ok) {
          const notifData = await notifResp.json();
          const notifications = Array.isArray(notifData) ? notifData : (notifData.data || []);
          const newNotifs: string[] = [];

          for (const n of notifications.slice(0, 30)) {
            const ref = n.notificationNo || n.notNo || "";
            if (!ref) continue;

            const source = ref.includes("N.T") || ref.includes("NT") ? "CBIC_NT" : "CBIC_TARIFF";
            const { data: existing } = await supabase
              .from("notification_tracker")
              .select("notificationid")
              .eq("source", source)
              .eq("notificationref", ref)
              .maybeSingle();

            if (!existing) {
              let priority = "MEDIUM";
              const title = n.subject || n.title || "";
              if (title.toLowerCase().includes("50/2017")) priority = "CRITICAL";
              else if (/anti.dumping|safeguard|countervail/i.test(title)) priority = "HIGH";
              else if (/exchange rate|drawback/i.test(title)) priority = "HIGH";

              await supabase.from("notification_tracker").insert({
                source, notificationref: ref, title: title.substring(0, 500),
                publishdate: (n.notificationDate || n.issueDt || "").substring(0, 10) || null,
                status: "NEW", priority, countrycode: country,
              });
              newNotifs.push(`[${priority}] ${ref}`);
            }
          }
          results.new_notifications = newNotifs;
          results.notifications_checked = notifications.length;
        }
      } catch (e: unknown) {
        results.notification_error = String(e);
      }
    }

    // Check CBIC chapter updatedDt via API
    if (checkType === "all" || checkType === "chapters") {
      try {
        const b64encode = (id: number) => btoa(String(id));
        const tariffResp = await fetch(`https://www.cbic.gov.in/api/cbic-content-msts/${b64encode(172464)}`);
        if (tariffResp.ok) {
          const tariffData = await tariffResp.json();
          const sections = tariffData.childContentList || [];
          const staleChapters: number[] = [];
          let checked = 0;

          for (const sec of sections) {
            const secResp = await fetch(`https://www.cbic.gov.in/api/cbic-content-msts/${b64encode(sec.id)}`);
            if (!secResp.ok) continue;
            const secData = await secResp.json();

            for (const ch of (secData.childContentList || [])) {
              const chResp = await fetch(`https://www.cbic.gov.in/api/cbic-content-msts/${b64encode(ch.id)}`);
              if (!chResp.ok) continue;
              const chData = await chResp.json();
              const docs = chData.cbicDocMsts || [];
              const fp = docs[0]?.filePathEn || "";
              const chMatch = fp.match(/chap-(\d+)\.pdf/);
              if (!chMatch) continue;

              const chNum = parseInt(chMatch[1]);
              const cbicUpdated = chData.updatedDt;
              checked++;

              // Compare with stored
              const { data: stored } = await supabase
                .from("cbic_chapter_sync")
                .select("cbicupdateddt")
                .eq("chapternum", chNum)
                .eq("countrycode", country)
                .maybeSingle();

              const isNew = cbicUpdated && (!stored?.cbicupdateddt || cbicUpdated !== stored.cbicupdateddt);

              await supabase.from("cbic_chapter_sync").upsert({
                chapternum: chNum, countrycode: country,
                cbiccontentid: ch.id, filepath: fp,
                cbicupdateddt: cbicUpdated,
                syncstatus: isNew ? "STALE" : "CURRENT",
              });

              if (isNew) staleChapters.push(chNum);
            }
          }
          results.chapters_checked = checked;
          results.stale_chapters = staleChapters;
        }
      } catch (e: unknown) {
        results.chapter_error = String(e);
      }
    }

    // Get freshness summary
    const { data: freshness } = await supabase
      .from("data_freshness")
      .select("datatype, lastsyncat, staleafterhours")
      .eq("countrycode", country);

    const now = Date.now();
    const staleItems = (freshness || []).filter((f: any) => {
      const age = f.lastsyncat ? (now - new Date(f.lastsyncat).getTime()) / 3600000 : Infinity;
      return age > (f.staleafterhours || 720);
    }).map((f: any) => f.datatype);

    results.stale_data_types = staleItems;

    // Run rules engine to generate data-driven alerts & opportunities
    try {
      const { data: rulesResult } = await supabase.rpc("run_rules_engine", {
        p_lookback_days: 7,
        p_country: country,
      });
      results.rules_engine = rulesResult;
    } catch (e: unknown) {
      results.rules_engine_error = String(e);
    }

    results.completed_at = new Date().toISOString();

    return json(results);
  }

  return json({ error: "Unknown action. Use: dashboard, tenants, usage, set_admin, data_freshness, notifications, update_notification, run_monitor, suggestions, update_suggestion, referrals, reward_config" }, 400);
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
