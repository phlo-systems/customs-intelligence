-- Group 8: AI Classification Engine
-- DEV NOTE: Phlo holds the Anthropic API key — customers never configure this.
-- Stage 1: vector similarity search (no LLM, < 100ms).
-- Stage 2: LLM re-ranking via Claude only when Stage 1 confidence < 0.90.
-- PRODUCT_CLASSIFICATION_CACHE checked before vector search — returns instantly at confidence=1.0.

CREATE TABLE HS_DESCRIPTION_EMBEDDING (
    SubheadingCode      CHAR(6)       NOT NULL,
    HSVersion           VARCHAR(10)   NOT NULL DEFAULT 'HS 2022',
    CountryCode         VARCHAR(2)    REFERENCES COUNTRY(CountryCode),
    DescriptionText     TEXT          NOT NULL,
    Embedding           vector(1536)  NOT NULL,
    EmbeddingModel      VARCHAR(50)   NOT NULL,
    ComputedAt          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (SubheadingCode, HSVersion, CountryCode)
);
CREATE INDEX idx_hs_embedding_cosine ON HS_DESCRIPTION_EMBEDDING
    USING ivfflat (Embedding vector_cosine_ops) WITH (lists = 100);

CREATE TABLE CLASSIFICATION_REQUEST (
    RequestID               BIGSERIAL     PRIMARY KEY,
    TenantID                UUID          NOT NULL,
    ERPSource               VARCHAR(20),
    ProductDescription      TEXT          NOT NULL,
    NormalisedDescription   TEXT          NOT NULL,
    RequestedAt             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    ResponseTimeMs          INTEGER,
    ModelUsed               VARCHAR(50),
    TopSuggestionCode       VARCHAR(15),
    TopConfidence           DECIMAL(5,4),
    ClassificationType      VARCHAR(20)
        CHECK (ClassificationType IN ('EXISTING_PRODUCT','AI_INFERRED','MANUAL_OVERRIDE')),
    UserSelectedCode        VARCHAR(15),
    FeedbackCorrect         BOOLEAN
);

CREATE TABLE PRODUCT_CLASSIFICATION_CACHE (
    CacheID                 BIGSERIAL     PRIMARY KEY,
    TenantID                UUID          NOT NULL,
    ProductDescription      TEXT          NOT NULL,
    NormalisedDescription   TEXT          NOT NULL,
    SubheadingCode          CHAR(6)       NOT NULL,
    CommodityCode           VARCHAR(15),
    ConfirmedBy             VARCHAR(20)   NOT NULL
        CHECK (ConfirmedBy IN ('EXISTING_PRODUCT','TRADER_CONFIRMED','ADMIN_VERIFIED')),
    ConfirmedAt             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    UseCount                INTEGER       NOT NULL DEFAULT 1,
    LastUsedAt              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    UNIQUE (TenantID, NormalisedDescription)
);
