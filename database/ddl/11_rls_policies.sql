-- Row Level Security — tenant isolation
-- Run last, after all tables and indexes are created.
-- These policies ensure each tenant can only see their own rows.

ALTER TABLE OPPORTUNITIES             ENABLE ROW LEVEL SECURITY;
ALTER TABLE ALERTS                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE TENANT_CONTEXT            ENABLE ROW LEVEL SECURITY;
ALTER TABLE TENANT_BEHAVIOUR_LOG      ENABLE ROW LEVEL SECURITY;
ALTER TABLE CLASSIFICATION_REQUEST    ENABLE ROW LEVEL SECURITY;
ALTER TABLE PRODUCT_CLASSIFICATION_CACHE ENABLE ROW LEVEL SECURITY;
ALTER TABLE ERP_INTEGRATION           ENABLE ROW LEVEL SECURITY;
ALTER TABLE EMAIL_CONTEXT_EXTRACT     ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_opportunities  ON OPPORTUNITIES
    USING (TenantID = auth.uid()::UUID);
CREATE POLICY tenant_isolation_alerts         ON ALERTS
    USING (TenantID = auth.uid()::UUID);
CREATE POLICY tenant_isolation_context        ON TENANT_CONTEXT
    USING (TenantID = auth.uid()::UUID);
CREATE POLICY tenant_isolation_behaviour      ON TENANT_BEHAVIOUR_LOG
    USING (TenantID = auth.uid()::UUID);
CREATE POLICY tenant_isolation_classification ON CLASSIFICATION_REQUEST
    USING (TenantID = auth.uid()::UUID);
CREATE POLICY tenant_isolation_cache          ON PRODUCT_CLASSIFICATION_CACHE
    USING (TenantID = auth.uid()::UUID);
CREATE POLICY tenant_isolation_erp            ON ERP_INTEGRATION
    USING (TenantID = auth.uid()::UUID);
CREATE POLICY tenant_isolation_email          ON EMAIL_CONTEXT_EXTRACT
    USING (TenantID = auth.uid()::UUID);
