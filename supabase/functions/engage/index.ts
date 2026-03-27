// supabase/functions/engage/index.ts
// Deploy: supabase functions deploy engage --no-verify-jwt
//
// User-facing engagement: referrals, suggestions, rewards.
//
// POST /engage
//   { "action": "refer", "referee_email": "...", "referee_name": "..." }
//   { "action": "my_referrals" }
//   { "action": "suggest", "suggestion": "...", "category": "FEATURE|BUG|UX|GENERAL" }
//   { "action": "my_suggestions" }
//   { "action": "my_rewards" }
//   { "action": "should_prompt_referral" }

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

  // Auth
  let tenantId: string | null = null;
  let userEmail: string | null = null;
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.replace("Bearer ", "");
    const { data: { user } } = await supabase.auth.getUser(token);
    if (user) { tenantId = user.id; userEmail = user.email || null; }
  }
  if (!tenantId) {
    const rawKey = req.headers.get("x-api-key");
    if (rawKey) {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawKey));
      const keyHash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
      const { data: keyRow } = await supabase.from("api_key").select("tenantuid").eq("keyhash", keyHash).eq("isactive", true).maybeSingle();
      if (keyRow?.tenantuid) tenantId = keyRow.tenantuid;
    }
  }
  if (!tenantId) return json({ error: "Authentication required" }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const action = String(body.action || "");

  // ── Submit referral ────────────────────────────────────────────────────
  if (action === "refer") {
    const refereeEmail = String(body.referee_email || "").trim().toLowerCase();
    const refereeName = String(body.referee_name || "").trim();
    if (!refereeEmail) return json({ error: "referee_email required" }, 400);

    // Get reward config
    const { data: reward } = await supabase.from("reward_config").select("value").eq("rewardtype", "REFERRAL_SIGNUP").eq("isactive", true).maybeSingle();

    await supabase.from("referral").insert({
      tenantid: tenantId,
      referrername: userEmail,
      refereeemail: refereeEmail,
      refereename: refereeName || null,
      status: "PENDING",
      rewardtype: "REFERRAL_SIGNUP",
      rewardvalue: reward?.value || null,
    });

    // Send referral invite email via Supabase Auth invite
    const referrerName = userEmail?.split("@")[0] || "A colleague";
    try {
      await supabase.auth.admin.inviteUserByEmail(refereeEmail, {
        data: {
          referred_by: tenantId,
          referrer_email: userEmail,
          company_name: refereeName || "",
        },
        redirectTo: "https://customs-intelligence.vercel.app",
      });
    } catch (emailErr) {
      console.error("Invite email failed (user may already exist):", emailErr);
    }

    return json({ status: "ok", message: "Referral sent! " + refereeEmail + " will receive an invite email. You earn a reward when they sign up.", reward: reward?.value || null });
  }

  // ── My referrals ──────────────────────────────────────────────────────
  if (action === "my_referrals") {
    const { data: referrals } = await supabase.from("referral").select("refereeemail, refereename, status, rewardvalue, createdat, convertedat").eq("tenantid", tenantId).order("createdat", { ascending: false });
    return json({ referrals: referrals || [] });
  }

  // ── Submit suggestion ─────────────────────────────────────────────────
  if (action === "suggest") {
    const suggestion = String(body.suggestion || "").trim();
    const category = String(body.category || "GENERAL").toUpperCase();
    if (!suggestion) return json({ error: "suggestion text required" }, 400);
    if (!["FEATURE", "BUG", "UX", "GENERAL"].includes(category)) return json({ error: "category must be FEATURE, BUG, UX, or GENERAL" }, 400);

    await supabase.from("suggestion").insert({
      tenantid: tenantId,
      email: userEmail,
      category,
      suggestion,
      status: "NEW",
    });

    return json({ status: "ok", message: "Thanks for your suggestion! If implemented, you'll earn a reward." });
  }

  // ── My suggestions ────────────────────────────────────────────────────
  if (action === "my_suggestions") {
    const { data: suggestions } = await supabase.from("suggestion").select("suggestionid, category, suggestion, status, adminresponse, rewardvalue, createdat, resolvedat").eq("tenantid", tenantId).order("createdat", { ascending: false });
    return json({ suggestions: suggestions || [] });
  }

  // ── My rewards ────────────────────────────────────────────────────────
  if (action === "my_rewards") {
    const { data: refRewards } = await supabase.from("referral").select("rewardvalue, convertedat").eq("tenantid", tenantId).eq("status", "CONVERTED").not("rewardvalue", "is", null);
    const { data: sugRewards } = await supabase.from("suggestion").select("rewardvalue, resolvedat").eq("tenantid", tenantId).eq("status", "IMPLEMENTED").not("rewardvalue", "is", null);

    return json({
      rewards: [
        ...(refRewards || []).map((r: any) => ({ type: "Referral", value: r.rewardvalue, date: r.convertedat })),
        ...(sugRewards || []).map((s: any) => ({ type: "Suggestion Implemented", value: s.rewardvalue, date: s.resolvedat })),
      ],
    });
  }

  // ── Should prompt referral (after 3+ sessions) ────────────────────────
  if (action === "should_prompt_referral") {
    // Check if user has already been prompted or already referred someone
    const { count: referralCount } = await supabase.from("referral").select("*", { count: "exact", head: true }).eq("tenantid", tenantId);
    return json({ should_prompt: (referralCount || 0) === 0 });
  }

  return json({ error: "Unknown action" }, 400);
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
