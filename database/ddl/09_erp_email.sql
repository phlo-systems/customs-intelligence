-- Group 9: ERP & Email Integration
-- DEV NOTE: AuthTokenRef stores Azure Key Vault SECRET NAME only — never the OAuth token.
-- EMAIL_CONTEXT_EXTRACT: raw email body NEVER stored — structured extract only.
-- GDPR basis: legitimate interest for service personalisation.
-- OAuth scopes: gmail.readonly / Mail.Read — read-only, never send or modify.

CREATE TABLE ERP_INTEGRATION (
    IntegrationID       BIGSERIAL     PRIMARY KEY,
    TenantID            UUID          NOT NULL,
    ERPType             VARCHAR(20)   NOT NULL
        CHECK (ERPType IN ('XERO','ACUMATICA','SAGE','NAV','SAP','QUICKBOOKS','OTHER')),
    ERPTenantID         VARCHAR(255)  NOT NULL,
    AuthTokenRef        VARCHAR(255)  NOT NULL,
    WebhookURL          TEXT,
    MappingConfig       JSONB,
    SyncEnabled         BOOLEAN       NOT NULL DEFAULT TRUE,
    LastSyncAt          TIMESTAMPTZ,
    IsActive            BOOLEAN       NOT NULL DEFAULT TRUE,
    CreatedAt           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    UNIQUE (TenantID, ERPType, ERPTenantID)
);

CREATE TABLE EMAIL_CONTEXT_EXTRACT (
    ExtractID               BIGSERIAL     PRIMARY KEY,
    TenantID                UUID          NOT NULL,
    EmailPlatform           VARCHAR(10)   NOT NULL
        CHECK (EmailPlatform IN ('GMAIL','OUTLOOK')),
    EmailMessageID          VARCHAR(500)  NOT NULL,
    EmailDate               DATE          NOT NULL,
    EmailType               VARCHAR(20)   NOT NULL
        CHECK (EmailType IN ('SUPPLIER_QUOTE','CUSTOMER_RFQ','SHIPPING_CONF',
                             'CUSTOMS_ENTRY','TRADE_INQUIRY','REGULATORY',
                             'TRADE_FINANCE','FREIGHT','OTHER')),
    SubheadingCodes         TEXT[],
    OriginCountries         TEXT[],
    DestinationCountries    TEXT[],
    Commodities             TEXT[],
    CounterpartyName        VARCHAR(255),
    CounterpartyCountry     CHAR(2),
    VolumeMT                DECIMAL(12,3),
    Incoterm                VARCHAR(10),
    CompetitorOrigins       TEXT[],
    MarketInterest          TEXT[],
    ComplianceConcerns      TEXT[],
    TradeBarriers           TEXT[],
    ExtractedAt             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    ReviewedByUser          BOOLEAN       NOT NULL DEFAULT FALSE,
    UNIQUE (TenantID, EmailMessageID)
);
COMMENT ON TABLE EMAIL_CONTEXT_EXTRACT IS
    'PRIVACY: No email body, subject, sender address or recipient stored here. '
    'Structured extract only. User reviews before context is applied to their profile.';
