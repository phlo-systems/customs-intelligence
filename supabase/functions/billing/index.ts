// supabase/functions/billing/index.ts
// Deploy: supabase functions deploy billing --no-verify-jwt
//
// Handles Stripe subscription billing:
//   POST { "action": "checkout", "plan": "PRO" }     — create Stripe Checkout session
//   POST { "action": "portal" }                       — create Stripe Customer Portal session
//   POST { "action": "status" }                       — get current subscription status + usage
//   POST { "action": "webhook" }                      — Stripe webhook handler (no auth)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type, stripe-signature",
};

const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY") || "";
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";
const APP_URL = "https://customs-compliance.ai";

// Price IDs — set these after creating products in Stripe Dashboard
const PRICE_MAP: Record<string, string> = {
  STARTER_MONTHLY: Deno.env.get("STRIPE_PRICE_STARTER_MONTHLY") || "",
  STARTER_ANNUAL: Deno.env.get("STRIPE_PRICE_STARTER_ANNUAL") || "",
  PRO_MONTHLY: Deno.env.get("STRIPE_PRICE_PRO_MONTHLY") || "",
  PRO_ANNUAL: Deno.env.get("STRIPE_PRICE_PRO_ANNUAL") || "",
  BUSINESS_MONTHLY: Deno.env.get("STRIPE_PRICE_BUSINESS_MONTHLY") || "",
  BUSINESS_ANNUAL: Deno.env.get("STRIPE_PRICE_BUSINESS_ANNUAL") || "",
};

// Plan limits
const PLAN_LIMITS: Record<string, { lookups: number; classifies: number; users: number; erp: number; api: boolean }> = {
  FREE:       { lookups: 10,       classifies: 5,        users: 1,  erp: 0,  api: false },
  STARTER:    { lookups: 100,      classifies: 50,       users: 1,  erp: 0,  api: false },
  PRO:        { lookups: 999999,   classifies: 999999,   users: 5,  erp: 1,  api: false },
  BUSINESS:   { lookups: 999999,   classifies: 999999,   users: 15, erp: 99, api: true },
  ENTERPRISE: { lookups: 999999,   classifies: 999999,   users: 999, erp: 99, api: true },
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json({ ok: true }, 200);
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ── Check if this is a Stripe webhook (no auth needed) ──────────────────
  const stripeSignature = req.headers.get("stripe-signature");
  if (stripeSignature) {
    return handleWebhook(req, stripeSignature, supabase);
  }

  // ── Auth ─────────────────────────────────────────────────────────────────
  let tenantId: string | null = null;

  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.replace("Bearer ", "");
    const { data: { user } } = await supabase.auth.getUser(token);
    if (user) tenantId = user.id;
  }

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

  if (!tenantId) return json({ error: "Authentication required" }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch {}

  const action = String(body.action || "status");

  // ── Ensure subscription record exists ───────────────────────────────────
  let { data: sub } = await supabase
    .from("subscription")
    .select("*")
    .eq("tenantid", tenantId)
    .maybeSingle();

  if (!sub) {
    await supabase.from("subscription").insert({
      tenantid: tenantId,
      plancode: "FREE",
      status: "ACTIVE",
    });
    const { data: newSub } = await supabase
      .from("subscription")
      .select("*")
      .eq("tenantid", tenantId)
      .maybeSingle();
    sub = newSub;
  }

  // ── Status ──────────────────────────────────────────────────────────────
  if (action === "status") {
    const limits = PLAN_LIMITS[sub.plancode] || PLAN_LIMITS.FREE;

    // Reset usage counters if past reset date
    if (new Date(sub.lookupresetat) <= new Date()) {
      const nextReset = new Date();
      nextReset.setMonth(nextReset.getMonth() + 1, 1);
      nextReset.setHours(0, 0, 0, 0);
      await supabase.from("subscription")
        .update({ lookupcount: 0, classifycount: 0, lookupresetat: nextReset.toISOString() })
        .eq("tenantid", tenantId);
      sub.lookupcount = 0;
      sub.classifycount = 0;
    }

    return json({
      plan: sub.plancode,
      status: sub.status,
      trial_ends_at: sub.trialendsat,
      current_period_end: sub.currentperiodend,
      cancel_at_period_end: sub.cancelatperiodend,
      usage: {
        lookups: { used: sub.lookupcount, limit: limits.lookups, remaining: Math.max(0, limits.lookups - sub.lookupcount) },
        classifies: { used: sub.classifycount, limit: limits.classifies, remaining: Math.max(0, limits.classifies - sub.classifycount) },
      },
      limits,
      stripe_customer_id: sub.stripecustomerid || null,
    });
  }

  // ── Checkout (create Stripe Checkout session) ───────────────────────────
  if (action === "checkout") {
    if (!STRIPE_SECRET) return json({ error: "Stripe not configured" }, 500);

    const plan = String(body.plan || "PRO").toUpperCase();
    const annual = body.annual === true;
    const priceKey = `${plan}_${annual ? "ANNUAL" : "MONTHLY"}`;
    const priceId = PRICE_MAP[priceKey];

    if (!priceId) {
      return json({ error: `Price not configured for ${priceKey}. Set STRIPE_PRICE_${priceKey} env var.` }, 400);
    }

    // Get or create Stripe customer
    let customerId = sub.stripecustomerid;
    if (!customerId) {
      // Get user email
      const { data: { user } } = await supabase.auth.admin.getUserById(tenantId);
      const email = user?.email || "";

      const customerResp = await stripeRequest("POST", "/v1/customers", {
        email,
        metadata: { tenant_id: tenantId },
      });
      customerId = customerResp.id;

      await supabase.from("subscription")
        .update({ stripecustomerid: customerId })
        .eq("tenantid", tenantId);
    }

    // Create Checkout session
    const session = await stripeRequest("POST", "/v1/checkout/sessions", {
      customer: customerId,
      mode: "subscription",
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      success_url: `${APP_URL}/app?billing=success&plan=${plan}`,
      cancel_url: `${APP_URL}/app?billing=cancelled`,
      subscription_data: {
        trial_period_days: "14",
        metadata: { tenant_id: tenantId, plan_code: plan },
      },
      allow_promotion_codes: "true",
    });

    return json({ checkout_url: session.url, session_id: session.id });
  }

  // ── Customer Portal (manage subscription, invoices, cancel) ─────────────
  if (action === "portal") {
    if (!STRIPE_SECRET) return json({ error: "Stripe not configured" }, 500);
    if (!sub.stripecustomerid) return json({ error: "No billing account. Subscribe to a plan first." }, 400);

    const session = await stripeRequest("POST", "/v1/billing_portal/sessions", {
      customer: sub.stripecustomerid,
      return_url: `${APP_URL}/app`,
    });

    return json({ portal_url: session.url });
  }

  // ── Increment usage (called by tariff-lookup and classify) ──────────────
  if (action === "increment_lookup") {
    await supabase.from("subscription")
      .update({ lookupcount: (sub.lookupcount || 0) + 1 })
      .eq("tenantid", tenantId);
    return json({ ok: true });
  }

  if (action === "increment_classify") {
    await supabase.from("subscription")
      .update({ classifycount: (sub.classifycount || 0) + 1 })
      .eq("tenantid", tenantId);
    return json({ ok: true });
  }

  return json({ error: "Unknown action. Use: status, checkout, portal" }, 400);
});


// ── Stripe Webhook Handler ────────────────────────────────────────────────────

async function handleWebhook(
  req: Request,
  signature: string,
  supabase: ReturnType<typeof createClient>,
): Promise<Response> {
  const body = await req.text();

  // Verify webhook signature
  if (STRIPE_WEBHOOK_SECRET) {
    const isValid = await verifyStripeSignature(body, signature, STRIPE_WEBHOOK_SECRET);
    if (!isValid) return json({ error: "Invalid signature" }, 400);
  }

  const event = JSON.parse(body);
  const type = event.type;
  const obj = event.data?.object;

  console.log(`Stripe webhook: ${type}`);

  // ── checkout.session.completed — subscription just created ──
  if (type === "checkout.session.completed" && obj.mode === "subscription") {
    const tenantId = obj.subscription_details?.metadata?.tenant_id || obj.metadata?.tenant_id;
    const planCode = obj.subscription_details?.metadata?.plan_code || obj.metadata?.plan_code || "PRO";

    if (tenantId) {
      await supabase.from("subscription").update({
        plancode: planCode,
        stripecustomerid: obj.customer,
        stripesubscriptionid: obj.subscription,
        status: "ACTIVE",
        updatedat: new Date().toISOString(),
      }).eq("tenantid", tenantId);

      console.log(`Subscription activated: ${tenantId} → ${planCode}`);
    }
  }

  // ── customer.subscription.updated — plan change, renewal, trial end ──
  if (type === "customer.subscription.updated") {
    const subId = obj.id;
    const status = mapStripeStatus(obj.status);
    const cancelAtEnd = obj.cancel_at_period_end || false;
    const periodEnd = obj.current_period_end ? new Date(obj.current_period_end * 1000).toISOString() : null;
    const periodStart = obj.current_period_start ? new Date(obj.current_period_start * 1000).toISOString() : null;
    const trialEnd = obj.trial_end ? new Date(obj.trial_end * 1000).toISOString() : null;
    const priceId = obj.items?.data?.[0]?.price?.id;

    await supabase.from("subscription").update({
      status,
      cancelatperiodend: cancelAtEnd,
      currentperiodstart: periodStart,
      currentperiodend: periodEnd,
      trialendsat: trialEnd,
      stripepriceid: priceId,
      updatedat: new Date().toISOString(),
    }).eq("stripesubscriptionid", subId);
  }

  // ── customer.subscription.deleted — subscription cancelled ──
  if (type === "customer.subscription.deleted") {
    const subId = obj.id;
    await supabase.from("subscription").update({
      status: "CANCELLED",
      plancode: "FREE",
      cancelatperiodend: false,
      updatedat: new Date().toISOString(),
    }).eq("stripesubscriptionid", subId);

    console.log(`Subscription cancelled: ${subId}`);
  }

  // ── invoice.payment_failed — payment issue ──
  if (type === "invoice.payment_failed") {
    const customerId = obj.customer;
    await supabase.from("subscription").update({
      status: "PAST_DUE",
      updatedat: new Date().toISOString(),
    }).eq("stripecustomerid", customerId);
  }

  return json({ received: true });
}


// ── Stripe API helpers ────────────────────────────────────────────────────────

async function stripeRequest(method: string, path: string, params?: Record<string, unknown>): Promise<any> {
  const url = `https://api.stripe.com${path}`;
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${STRIPE_SECRET}`,
  };

  let bodyStr: string | undefined;
  if (params) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    bodyStr = buildFormBody(params);
  }

  const resp = await fetch(url, { method, headers, body: bodyStr });
  const data = await resp.json();

  if (!resp.ok) {
    console.error("Stripe error:", JSON.stringify(data));
    throw new Error(data.error?.message || "Stripe request failed");
  }

  return data;
}

function buildFormBody(params: Record<string, unknown>, prefix = ""): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (value !== null && value !== undefined) {
      if (typeof value === "object" && !Array.isArray(value)) {
        parts.push(buildFormBody(value as Record<string, unknown>, fullKey));
      } else {
        parts.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(String(value))}`);
      }
    }
  }
  return parts.filter(Boolean).join("&");
}

function mapStripeStatus(s: string): string {
  const map: Record<string, string> = {
    active: "ACTIVE",
    past_due: "PAST_DUE",
    canceled: "CANCELLED",
    trialing: "TRIALING",
    incomplete: "INCOMPLETE",
    incomplete_expired: "CANCELLED",
    unpaid: "PAST_DUE",
  };
  return map[s] || "ACTIVE";
}

async function verifyStripeSignature(payload: string, header: string, secret: string): Promise<boolean> {
  try {
    const parts = header.split(",").reduce((acc, part) => {
      const [k, v] = part.split("=");
      acc[k.trim()] = v;
      return acc;
    }, {} as Record<string, string>);

    const timestamp = parts["t"];
    const signature = parts["v1"];
    if (!timestamp || !signature) return false;

    // Check timestamp tolerance (5 minutes)
    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (age > 300) return false;

    const signedPayload = `${timestamp}.${payload}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
    const expected = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");

    return expected === signature;
  } catch {
    return false;
  }
}


// ── Helpers ───────────────────────────────────────────────────────────────────

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
