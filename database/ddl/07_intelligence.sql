-- Group 7: Intelligence Engine — Opportunities, Alerts and Tenant Context
-- DEV NOTE: OPPORTUNITIES and ALERTS are populated by the DB rules engine (SQL only)
-- after each tariff sync. AIInsight is populated separately by the AI enrichment job.
-- Dashboard reads from these tables — no live LLM call on page load.
-- AI cost ~£0.002 per opportunity card generated.

CREATE TABLE OPPORTUNITIES (
    OpportunityID       BIGSERIAL     PRIMARY KEY,
    TenantID            UUID          NOT NULL,
    OpportunityType     VARCHAR(30)   NOT NULL
        CHECK (OpportunityType IN ('DUTY_REDUCTION','NEW_FTA','COMPETITOR_DISADVANTAGE',
                                   'NEW_MARKET','EXPIRING_PREFERENCE','QUOTA_OPENED',
                                   'COMPLIANCE_EASE')),
    SubheadingCode      CHAR(6),
    ImportCountryCode   VARCHAR(2)    REFERENCES COUNTRY(CountryCode),
    ExportCountryCode   VARCHAR(2)    REFERENCES COUNTRY(CountryCode),
    AgreementCode       VARCHAR(30)   REFERENCES TRADE_AGREEMENT(AgreementCode),
    SavingPct           DECIMAL(5,2),
    SavingAmtPer10K     DECIMAL(10,2),
    Headline            TEXT          NOT NULL,
    AIInsight           TEXT,
    AIInsightGeneratedAt TIMESTAMPTZ,
    SourceChangeID      BIGINT        REFERENCES SOURCE_SYNC_CHANGE(ChangeID),
    IsActioned          BOOLEAN       NOT NULL DEFAULT FALSE,
    IsDismissed         BOOLEAN       NOT NULL DEFAULT FALSE,
    ExpiresAt           TIMESTAMPTZ,
    DetectedAt          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE ALERTS (
    AlertID             BIGSERIAL     PRIMARY KEY,
    TenantID            UUID          NOT NULL,
    AlertType           VARCHAR(30)   NOT NULL
        CHECK (AlertType IN ('DUTY_INCREASE','SANCTIONS_NEW','AD_INVESTIGATION',
                             'REGULATORY_CHANGE','EXPIRY_WARNING','SYNC_FAILURE')),
    Severity            VARCHAR(10)   NOT NULL
        CHECK (Severity IN ('CRITICAL','HIGH','MEDIUM','LOW')),
    SubheadingCode      CHAR(6),
    CountryCode         VARCHAR(2)    REFERENCES COUNTRY(CountryCode),
    Headline            TEXT          NOT NULL,
    Detail              TEXT,
    IsDismissed         BOOLEAN       NOT NULL DEFAULT FALSE,
    IsActioned          BOOLEAN       NOT NULL DEFAULT FALSE,
    SourceChangeID      BIGINT        REFERENCES SOURCE_SYNC_CHANGE(ChangeID),
    DetectedAt          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    ExpiresAt           TIMESTAMPTZ
);

CREATE TABLE TENANT_CONTEXT (
    TenantID                UUID          PRIMARY KEY,
    -- Layer 1: Explicit onboarding
    BusinessType            VARCHAR(30),
    PrimaryHSChapters       TEXT[],
    AnnualVolumeRange       VARCHAR(20),
    TargetMarkets           TEXT[],
    -- Layer 2: From product library
    ActiveOriginCountries   TEXT[],
    ActiveDestCountries     TEXT[],
    ProductCount            INTEGER       NOT NULL DEFAULT 0,
    AvgShipmentValueGBP     DECIMAL(12,2),
    -- Layer 3: Behavioural signals
    HighInterestCountries   TEXT[],
    DismissedCountries      TEXT[],
    PrimaryFocus            VARCHAR(25),
    LastActiveAt            TIMESTAMPTZ,
    -- Layer 4: ERP-derived
    ERPConnected            BOOLEAN       NOT NULL DEFAULT FALSE,
    ERPType                 VARCHAR(20),
    AvgPOValueGBP           DECIMAL(12,2),
    TopSupplierCountries    TEXT[],
    TopCustomerCountries    TEXT[],
    -- Layer 5: Email-derived
    EmailConnected          BOOLEAN       NOT NULL DEFAULT FALSE,
    EmailPlatform           VARCHAR(10),
    EmailContextSince       DATE,
    KnownCompetitorOrigins  TEXT[],
    KnownTradeBarriers      TEXT[],
    EmailLastScannedAt      TIMESTAMPTZ,
    -- Conversation memory
    ConversationContext     JSONB,
    UpdatedAt               TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE TENANT_CONTEXT IS
    'Built progressively from 5 layers: '
    '(1) Onboarding, (2) Product upload, (3) Behaviour, (4) ERP, (5) Email. '
    'Used as context for Claude AI insight generation.';

CREATE TABLE TENANT_BEHAVIOUR_LOG (
    LogID               BIGSERIAL     PRIMARY KEY,
    TenantID            UUID          NOT NULL,
    ActionType          VARCHAR(30)   NOT NULL
        CHECK (ActionType IN ('TARIFF_LOOKUP','CLASSIFY','COMPARE_COUNTRIES',
                              'OPPORTUNITY_VIEWED','OPPORTUNITY_ACTIONED','OPPORTUNITY_DISMISSED',
                              'ALERT_VIEWED','ALERT_DISMISSED','COUNTRY_SEARCH','PRODUCT_SEARCH')),
    SubheadingCode      CHAR(6),
    ImportCountryCode   VARCHAR(2),
    ExportCountryCode   VARCHAR(2),
    ReferenceID         BIGINT,
    OccurredAt          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
