-- 12_api_key.sql
-- API key table for programmatic tenant authentication

CREATE TABLE IF NOT EXISTS api_key (
    keyid       BIGSERIAL PRIMARY KEY,
    keyhash     VARCHAR(64)  NOT NULL UNIQUE,
    tenantid    VARCHAR(255) NOT NULL,           -- normalised company name
    tenantuid   UUID         NOT NULL,           -- Supabase auth user ID
    scopes      TEXT[]       NOT NULL DEFAULT '{"tariff:lookup","classify","opportunities","alerts"}',
    isactive    BOOLEAN      NOT NULL DEFAULT TRUE,
    createdby   VARCHAR(255) NOT NULL,
    createdat   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    lastuseda   TIMESTAMPTZ,
    expiresat   TIMESTAMPTZ
);

-- Index for fast key lookup (auth hot path)
CREATE INDEX IF NOT EXISTS idx_api_key_hash_active
    ON api_key (keyhash) WHERE isactive = TRUE;

-- Index for tenant key listing
CREATE INDEX IF NOT EXISTS idx_api_key_tenant
    ON api_key (tenantuid) WHERE isactive = TRUE;

-- RLS
ALTER TABLE api_key ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_api_key ON api_key
    USING (tenantuid = auth.uid()::UUID);

-- Service role bypasses RLS, so edge functions using service role key
-- can always read/write. RLS only restricts direct client access.
