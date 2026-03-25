-- Performance indexes — run after all tables are created

CREATE INDEX idx_commodity_subheading    ON COMMODITY_CODE(SubheadingCode, CountryCode);
CREATE INDEX idx_mfn_rate_lookup         ON MFN_RATE(CommodityCode, CountryCode, RateCategory)
    WHERE EffectiveTo IS NULL;
CREATE INDEX idx_tariff_rate_current     ON TARIFF_RATE(CommodityCode, CountryCode)
    WHERE EffectiveTo IS NULL;
CREATE INDEX idx_tariff_hist_recent      ON TARIFF_RATE_HIST(CommodityCode, CountryCode, EffectiveFrom);
CREATE INDEX idx_vat_rate_lookup         ON VAT_RATE(CommodityCode, CountryCode)
    WHERE EffectiveTo IS NULL;
CREATE INDEX idx_ad_measure_active       ON AD_MEASURE(ImportCountryCode, CommodityCode)
    WHERE ADStatus NOT IN ('EXPIRED');
CREATE INDEX idx_sanctions_active        ON SANCTIONS_MEASURE(IsActive, ImportCountryCode, ExportCountryCode)
    WHERE IsActive = TRUE;
CREATE INDEX idx_pref_rate_lookup        ON PREFERENTIAL_RATE(ImportCountryCode, ExportCountryCode, SubheadingCode)
    WHERE EffectiveTo IS NULL;
CREATE INDEX idx_opportunities_tenant    ON OPPORTUNITIES(TenantID, IsDismissed, IsActioned);
CREATE INDEX idx_alerts_tenant           ON ALERTS(TenantID, IsDismissed, Severity);
CREATE INDEX idx_behaviour_tenant        ON TENANT_BEHAVIOUR_LOG(TenantID, OccurredAt);
CREATE INDEX idx_classification_cache    ON PRODUCT_CLASSIFICATION_CACHE(TenantID, NormalisedDescription);
CREATE INDEX idx_email_extract_tenant    ON EMAIL_CONTEXT_EXTRACT(TenantID, ReviewedByUser);
CREATE INDEX idx_sync_job_status         ON SOURCE_SYNC_JOB(JobStatus, JobStartedAt);
CREATE INDEX idx_sync_change_pending     ON SOURCE_SYNC_CHANGE(ChangeStatus)
    WHERE ChangeStatus = 'PENDING_REVIEW';
CREATE INDEX idx_tariff_source_active    ON TARIFF_SOURCE(IsActive, LastPolledAt)
    WHERE IsActive = TRUE;
