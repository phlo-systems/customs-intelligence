-- Group 13: Subscription & Billing
-- Tracks tenant subscription plans, Stripe customer/subscription IDs, and usage limits.

CREATE TABLE SUBSCRIPTION (
    SubscriptionID      BIGSERIAL       PRIMARY KEY,
    TenantID            UUID            NOT NULL UNIQUE,
    PlanCode            VARCHAR(20)     NOT NULL DEFAULT 'FREE'
        CHECK (PlanCode IN ('FREE','PRO','BUSINESS','ENTERPRISE')),
    StripeCustomerID    VARCHAR(255),
    StripeSubscriptionID VARCHAR(255),
    StripePriceID       VARCHAR(255),
    Status              VARCHAR(20)     NOT NULL DEFAULT 'ACTIVE'
        CHECK (Status IN ('ACTIVE','PAST_DUE','CANCELLED','TRIALING','INCOMPLETE')),
    TrialEndsAt         TIMESTAMPTZ,
    CurrentPeriodStart  TIMESTAMPTZ,
    CurrentPeriodEnd    TIMESTAMPTZ,
    CancelAtPeriodEnd   BOOLEAN         NOT NULL DEFAULT FALSE,
    -- Usage tracking for FREE tier limits
    LookupCount         INTEGER         NOT NULL DEFAULT 0,
    ClassifyCount       INTEGER         NOT NULL DEFAULT 0,
    LookupResetAt       TIMESTAMPTZ     NOT NULL DEFAULT date_trunc('month', NOW()) + INTERVAL '1 month',
    CreatedAt           TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    UpdatedAt           TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- Plan limits reference (not a table — enforced in edge functions)
-- FREE:       10 lookups/mo, 5 classifications/mo, 1 user, no ERP, no API, no alerts
-- PRO:        unlimited lookups, unlimited classify, 3 users, 1 ERP, alerts, PDF export
-- BUSINESS:   unlimited everything, 10 users, unlimited ERP, API access, ERP intelligence
-- ENTERPRISE: unlimited everything, unlimited users, custom integrations, SLA

CREATE INDEX idx_subscription_tenant ON SUBSCRIPTION (TenantID);
CREATE INDEX idx_subscription_stripe ON SUBSCRIPTION (StripeCustomerID);

COMMENT ON TABLE SUBSCRIPTION IS
    'Tracks tenant billing plan and Stripe subscription state. '
    'FREE tier has usage limits enforced by edge functions. '
    'Stripe webhook updates Status, CurrentPeriodEnd, CancelAtPeriodEnd.';
