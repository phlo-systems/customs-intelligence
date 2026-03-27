-- run_rules_engine.sql — 7-rule intelligence engine
--
-- Generates ALERTS and OPPORTUNITIES from actual DB data.
-- Called after tariff syncs, notification processing, or ad-hoc.
--
-- Rules:
--   1. DUTY_INCREASE  — rate went up (from TARIFF_RATE_HIST)
--   2. DUTY_REDUCTION — rate went down (opportunity)
--   3. EXPIRY_WARNING — preferential rate expiring within 90 days
--   4. AD_INVESTIGATION — new/active anti-dumping measure
--   5. REGULATORY_CHANGE — new notification applied (from notification_tracker)
--   6. NEW_FTA — preferential rate cheaper than MFN (opportunity)
--   7. COMPETITOR_DISADVANTAGE — tenant's origin country has higher duty than alternatives

CREATE OR REPLACE FUNCTION run_rules_engine(
    p_tenant_id UUID DEFAULT NULL,       -- NULL = run for all tenants
    p_lookback_days INTEGER DEFAULT 30,  -- how far back to look for changes
    p_country VARCHAR(2) DEFAULT NULL    -- NULL = all countries
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $fn$
DECLARE
    v_tenant RECORD;
    v_r RECORD;
    v_alerts_created INTEGER := 0;
    v_opps_created INTEGER := 0;
    v_since DATE := CURRENT_DATE - p_lookback_days;
BEGIN

    -- Iterate over tenants
    FOR v_tenant IN
        SELECT tc.TenantID, tc.PrimaryHSChapters, tc.ActiveOriginCountries,
               tc.ActiveDestCountries, tc.TargetMarkets
        FROM TENANT_CONTEXT tc
        WHERE (p_tenant_id IS NULL OR tc.TenantID = p_tenant_id)
    LOOP

        -- ═══════════════════════════════════════════════════════════════════
        -- RULE 1: DUTY_INCREASE alerts — rate went up recently
        -- ═══════════════════════════════════════════════════════════════════
        FOR v_r IN
            SELECT h.CommodityCode, h.CountryCode, h.SubheadingCode,
                   h.OldRate, h.NewRate, h.CreatedAt,
                   cc.NationalDescription
            FROM TARIFF_RATE_HIST h
            JOIN COMMODITY_CODE cc ON cc.CommodityCode = h.CommodityCode
                                  AND cc.CountryCode = h.CountryCode
            WHERE h.ChangeType = 'INCREASE'
              AND h.CreatedAt >= v_since
              AND (p_country IS NULL OR h.CountryCode = p_country)
              -- Only for codes relevant to this tenant
              AND (v_tenant.PrimaryHSChapters IS NULL
                   OR LEFT(h.SubheadingCode, 2) = ANY(v_tenant.PrimaryHSChapters))
              -- Don't duplicate existing alerts
              AND NOT EXISTS (
                  SELECT 1 FROM ALERTS a
                  WHERE a.TenantID = v_tenant.TenantID
                    AND a.AlertType = 'DUTY_INCREASE'
                    AND a.SubheadingCode = h.SubheadingCode
                    AND a.CountryCode = h.CountryCode
                    AND a.DetectedAt >= v_since
              )
        LOOP
            INSERT INTO ALERTS (TenantID, AlertType, Severity, SubheadingCode, CountryCode, Headline, Detail)
            VALUES (
                v_tenant.TenantID,
                'DUTY_INCREASE',
                CASE WHEN (v_r.NewRate - v_r.OldRate) >= 10 THEN 'CRITICAL'
                     WHEN (v_r.NewRate - v_r.OldRate) >= 5  THEN 'HIGH'
                     ELSE 'MEDIUM' END,
                v_r.SubheadingCode,
                v_r.CountryCode,
                v_r.CountryCode || ': Import duty increased from ' ||
                    COALESCE(v_r.OldRate::TEXT,'0') || '% to ' || v_r.NewRate || '% on HS ' ||
                    v_r.SubheadingCode,
                'Commodity: ' || v_r.CommodityCode || ' — ' || COALESCE(v_r.NationalDescription,'') ||
                    '. Effective from tariff update on ' || v_r.CreatedAt::DATE
            );
            v_alerts_created := v_alerts_created + 1;
        END LOOP;

        -- ═══════════════════════════════════════════════════════════════════
        -- RULE 2: DUTY_REDUCTION opportunities — rate went down
        -- ═══════════════════════════════════════════════════════════════════
        FOR v_r IN
            SELECT h.CommodityCode, h.CountryCode, h.SubheadingCode,
                   h.OldRate, h.NewRate, h.CreatedAt,
                   cc.NationalDescription
            FROM TARIFF_RATE_HIST h
            JOIN COMMODITY_CODE cc ON cc.CommodityCode = h.CommodityCode
                                  AND cc.CountryCode = h.CountryCode
            WHERE h.ChangeType = 'DECREASE'
              AND h.CreatedAt >= v_since
              AND (p_country IS NULL OR h.CountryCode = p_country)
              AND (v_tenant.PrimaryHSChapters IS NULL
                   OR LEFT(h.SubheadingCode, 2) = ANY(v_tenant.PrimaryHSChapters))
              AND NOT EXISTS (
                  SELECT 1 FROM OPPORTUNITIES o
                  WHERE o.TenantID = v_tenant.TenantID
                    AND o.OpportunityType = 'DUTY_REDUCTION'
                    AND o.SubheadingCode = h.SubheadingCode
                    AND o.ImportCountryCode = h.CountryCode
                    AND o.DetectedAt >= v_since
              )
        LOOP
            INSERT INTO OPPORTUNITIES (TenantID, OpportunityType, SubheadingCode,
                ImportCountryCode, SavingPct, Headline)
            VALUES (
                v_tenant.TenantID,
                'DUTY_REDUCTION',
                v_r.SubheadingCode,
                v_r.CountryCode,
                v_r.OldRate - v_r.NewRate,
                v_r.CountryCode || ': Import duty reduced from ' ||
                    COALESCE(v_r.OldRate::TEXT,'0') || '% to ' || v_r.NewRate || '% on HS ' ||
                    v_r.SubheadingCode || ' — ' || COALESCE(v_r.NationalDescription,'')
            );
            v_opps_created := v_opps_created + 1;
        END LOOP;

        -- ═══════════════════════════════════════════════════════════════════
        -- RULE 3: EXPIRY_WARNING — preferential rates expiring within 90 days
        -- ═══════════════════════════════════════════════════════════════════
        FOR v_r IN
            SELECT pr.CommodityCode, pr.ImportCountryCode, pr.ExportCountryCode,
                   pr.AgreementCode, pr.PrefRate, pr.EffectiveTo,
                   cc.NationalDescription, cc.SubheadingCode
            FROM PREFERENTIAL_RATE pr
            JOIN COMMODITY_CODE cc ON cc.CommodityCode = pr.CommodityCode
                                  AND cc.CountryCode = pr.ImportCountryCode
            WHERE pr.EffectiveTo IS NOT NULL
              AND pr.EffectiveTo BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '90 days'
              AND (p_country IS NULL OR pr.ImportCountryCode = p_country)
              AND (v_tenant.PrimaryHSChapters IS NULL
                   OR LEFT(cc.SubheadingCode, 2) = ANY(v_tenant.PrimaryHSChapters))
              AND NOT EXISTS (
                  SELECT 1 FROM ALERTS a
                  WHERE a.TenantID = v_tenant.TenantID
                    AND a.AlertType = 'EXPIRY_WARNING'
                    AND a.SubheadingCode = cc.SubheadingCode
                    AND a.CountryCode = pr.ImportCountryCode
                    AND a.DetectedAt >= CURRENT_DATE - 30
              )
        LOOP
            INSERT INTO ALERTS (TenantID, AlertType, Severity, SubheadingCode, CountryCode,
                Headline, Detail, ExpiresAt)
            VALUES (
                v_tenant.TenantID,
                'EXPIRY_WARNING',
                CASE WHEN v_r.EffectiveTo <= CURRENT_DATE + 30 THEN 'CRITICAL'
                     WHEN v_r.EffectiveTo <= CURRENT_DATE + 60 THEN 'HIGH'
                     ELSE 'MEDIUM' END,
                v_r.SubheadingCode,
                v_r.ImportCountryCode,
                'Preferential rate under ' || v_r.AgreementCode || ' expires ' ||
                    v_r.EffectiveTo || ' for HS ' || v_r.SubheadingCode ||
                    ' (' || v_r.ImportCountryCode || '→' || v_r.ExportCountryCode || ')',
                'Current preferential rate: ' || v_r.PrefRate || '%. '  ||
                    'Product: ' || COALESCE(v_r.NationalDescription,'') || '. ' ||
                    'After expiry, MFN rate will apply.',
                v_r.EffectiveTo
            );
            v_alerts_created := v_alerts_created + 1;
        END LOOP;

        -- ═══════════════════════════════════════════════════════════════════
        -- RULE 4: AD_INVESTIGATION — new anti-dumping/safeguard measures
        -- ═══════════════════════════════════════════════════════════════════
        FOR v_r IN
            SELECT ad.ADMeasureID, ad.CommodityCode, ad.ImportCountryCode,
                   ad.ExportingCountryCode, ad.MeasureType, ad.ADRate,
                   ad.SpecificAmt, ad.SpecificUOM, ad.ADStatus, ad.ADCaseRef,
                   ad.Notes, cc.SubheadingCode, cc.NationalDescription
            FROM AD_MEASURE ad
            LEFT JOIN COMMODITY_CODE cc ON cc.CommodityCode = ad.CommodityCode
                                       AND cc.CountryCode = ad.ImportCountryCode
            WHERE ad.CreatedAt >= v_since
              AND (p_country IS NULL OR ad.ImportCountryCode = p_country)
              AND NOT EXISTS (
                  SELECT 1 FROM ALERTS a
                  WHERE a.TenantID = v_tenant.TenantID
                    AND a.AlertType = 'AD_INVESTIGATION'
                    AND a.SubheadingCode = COALESCE(cc.SubheadingCode, LEFT(ad.CommodityCode,6))
                    AND a.CountryCode = ad.ImportCountryCode
                    AND a.DetectedAt >= v_since
              )
        LOOP
            INSERT INTO ALERTS (TenantID, AlertType, Severity, SubheadingCode, CountryCode,
                Headline, Detail)
            VALUES (
                v_tenant.TenantID,
                'AD_INVESTIGATION',
                CASE WHEN v_r.ADStatus IN ('DEFINITIVE','PROVISIONAL') THEN 'CRITICAL'
                     ELSE 'HIGH' END,
                COALESCE(v_r.SubheadingCode, LEFT(v_r.CommodityCode, 6)),
                v_r.ImportCountryCode,
                v_r.MeasureType || ' duty ' ||
                    CASE WHEN v_r.ADStatus = 'INVESTIGATION' THEN 'investigation opened'
                         WHEN v_r.ADStatus = 'PROVISIONAL' THEN 'provisionally imposed'
                         ELSE 'imposed' END ||
                    ' on HS ' || COALESCE(v_r.SubheadingCode, LEFT(v_r.CommodityCode,6)) ||
                    CASE WHEN v_r.ExportingCountryCode IS NOT NULL
                         THEN ' from ' || v_r.ExportingCountryCode ELSE '' END,
                'Ref: ' || COALESCE(v_r.ADCaseRef,'') ||
                    CASE WHEN v_r.ADRate IS NOT NULL THEN '. Rate: ' || v_r.ADRate || '% CIF' ELSE '' END ||
                    CASE WHEN v_r.SpecificAmt IS NOT NULL
                         THEN '. Amount: ' || v_r.SpecificAmt || ' ' || COALESCE(v_r.SpecificUOM,'')
                         ELSE '' END ||
                    '. ' || COALESCE(v_r.Notes,'')
            );
            v_alerts_created := v_alerts_created + 1;
        END LOOP;

        -- ═══════════════════════════════════════════════════════════════════
        -- RULE 5: REGULATORY_CHANGE — new notifications recently applied
        -- ═══════════════════════════════════════════════════════════════════
        FOR v_r IN
            SELECT n.notificationid, n.source, n.notificationref, n.title,
                   n.priority, n.affectedcodes, n.publishdate
            FROM notification_tracker n
            WHERE n.status = 'APPLIED'
              AND n.reviewedat >= v_since
              AND n.countrycode = COALESCE(p_country, n.countrycode)
              AND NOT EXISTS (
                  SELECT 1 FROM ALERTS a
                  WHERE a.TenantID = v_tenant.TenantID
                    AND a.AlertType = 'REGULATORY_CHANGE'
                    AND a.Detail LIKE '%' || n.notificationref || '%'
                    AND a.DetectedAt >= v_since
              )
        LOOP
            INSERT INTO ALERTS (TenantID, AlertType, Severity, CountryCode,
                Headline, Detail)
            VALUES (
                v_tenant.TenantID,
                'REGULATORY_CHANGE',
                CASE v_r.priority WHEN 'CRITICAL' THEN 'CRITICAL'
                     WHEN 'HIGH' THEN 'HIGH' ELSE 'MEDIUM' END,
                COALESCE(p_country, 'IN'),
                'New notification: ' || v_r.notificationref ||
                    CASE WHEN v_r.title IS NOT NULL THEN ' — ' || LEFT(v_r.title, 100) ELSE '' END,
                'Source: ' || v_r.source || '. Published: ' || COALESCE(v_r.publishdate::TEXT, '?') ||
                    '. Ref: ' || v_r.notificationref
            );
            v_alerts_created := v_alerts_created + 1;
        END LOOP;

        -- ═══════════════════════════════════════════════════════════════════
        -- RULE 6: NEW_FTA opportunity — pref rate < MFN rate
        -- ═══════════════════════════════════════════════════════════════════
        FOR v_r IN
            SELECT pr.CommodityCode, pr.ImportCountryCode, pr.ExportCountryCode,
                   pr.AgreementCode, pr.PrefRate,
                   m.AppliedMFNRate, cc.SubheadingCode, cc.NationalDescription
            FROM PREFERENTIAL_RATE pr
            JOIN MFN_RATE m ON m.CommodityCode = pr.CommodityCode
                           AND m.CountryCode = pr.ImportCountryCode
                           AND m.EffectiveTo IS NULL
                           AND m.RateCategory = 'APPLIED'
            JOIN COMMODITY_CODE cc ON cc.CommodityCode = pr.CommodityCode
                                  AND cc.CountryCode = pr.ImportCountryCode
            WHERE pr.EffectiveTo IS NULL
              AND pr.PrefRate < m.AppliedMFNRate
              AND (m.AppliedMFNRate - pr.PrefRate) >= 3  -- at least 3pp saving
              AND (p_country IS NULL OR pr.ImportCountryCode = p_country)
              AND (v_tenant.ActiveOriginCountries IS NULL
                   OR pr.ExportCountryCode = ANY(v_tenant.ActiveOriginCountries))
              AND NOT EXISTS (
                  SELECT 1 FROM OPPORTUNITIES o
                  WHERE o.TenantID = v_tenant.TenantID
                    AND o.OpportunityType = 'NEW_FTA'
                    AND o.SubheadingCode = cc.SubheadingCode
                    AND o.ImportCountryCode = pr.ImportCountryCode
                    AND o.ExportCountryCode = pr.ExportCountryCode
                    AND o.IsDismissed = FALSE
              )
            LIMIT 50  -- cap per tenant per run
        LOOP
            INSERT INTO OPPORTUNITIES (TenantID, OpportunityType, SubheadingCode,
                ImportCountryCode, ExportCountryCode, AgreementCode,
                SavingPct, SavingAmtPer10K, Headline)
            VALUES (
                v_tenant.TenantID,
                'NEW_FTA',
                v_r.SubheadingCode,
                v_r.ImportCountryCode,
                v_r.ExportCountryCode,
                v_r.AgreementCode,
                v_r.AppliedMFNRate - v_r.PrefRate,
                ROUND((v_r.AppliedMFNRate - v_r.PrefRate) * 100, 2),  -- saving per 10K
                'Save ' || (v_r.AppliedMFNRate - v_r.PrefRate) || 'pp using ' ||
                    v_r.AgreementCode || ' for HS ' || v_r.SubheadingCode ||
                    ' (' || v_r.ExportCountryCode || '→' || v_r.ImportCountryCode || ')'
            );
            v_opps_created := v_opps_created + 1;
        END LOOP;

        -- ═══════════════════════════════════════════════════════════════════
        -- RULE 7: COMPETITOR_DISADVANTAGE — tenant's origin has lower duty
        -- ═══════════════════════════════════════════════════════════════════
        -- (Skip if tenant has no origin countries configured)
        IF v_tenant.ActiveOriginCountries IS NOT NULL THEN
            FOR v_r IN
                SELECT DISTINCT m1.CountryCode AS import_country,
                       m1.CommodityCode, cc.SubheadingCode,
                       m1.AppliedMFNRate AS tenant_origin_rate,
                       m2.AppliedMFNRate AS competitor_rate,
                       m2.CountryCode AS competitor_import_country,
                       cc.NationalDescription
                FROM MFN_RATE m1
                JOIN MFN_RATE m2 ON m2.CommodityCode = m1.CommodityCode
                                AND m2.RateCategory = 'APPLIED'
                                AND m2.EffectiveTo IS NULL
                                AND m2.CountryCode != m1.CountryCode
                JOIN COMMODITY_CODE cc ON cc.CommodityCode = m1.CommodityCode
                                      AND cc.CountryCode = m1.CountryCode
                WHERE m1.RateCategory = 'APPLIED'
                  AND m1.EffectiveTo IS NULL
                  AND m1.CountryCode = ANY(v_tenant.ActiveDestCountries)
                  AND m1.AppliedMFNRate < m2.AppliedMFNRate
                  AND (m2.AppliedMFNRate - m1.AppliedMFNRate) >= 5  -- 5pp advantage
                  AND (p_country IS NULL OR m1.CountryCode = p_country)
                  AND NOT EXISTS (
                      SELECT 1 FROM OPPORTUNITIES o
                      WHERE o.TenantID = v_tenant.TenantID
                        AND o.OpportunityType = 'COMPETITOR_DISADVANTAGE'
                        AND o.SubheadingCode = cc.SubheadingCode
                        AND o.ImportCountryCode = m1.CountryCode
                        AND o.IsDismissed = FALSE
                  )
                LIMIT 20
            LOOP
                INSERT INTO OPPORTUNITIES (TenantID, OpportunityType, SubheadingCode,
                    ImportCountryCode, SavingPct, Headline)
                VALUES (
                    v_tenant.TenantID,
                    'COMPETITOR_DISADVANTAGE',
                    v_r.SubheadingCode,
                    v_r.import_country,
                    v_r.competitor_rate - v_r.tenant_origin_rate,
                    v_r.import_country || ' charges ' || v_r.tenant_origin_rate || '% vs ' ||
                        v_r.competitor_import_country || ' at ' || v_r.competitor_rate ||
                        '% on HS ' || v_r.SubheadingCode ||
                        ' — ' || (v_r.competitor_rate - v_r.tenant_origin_rate) || 'pp advantage'
                );
                v_opps_created := v_opps_created + 1;
            END LOOP;
        END IF;

    END LOOP; -- end tenant loop

    RETURN jsonb_build_object(
        'status', 'OK',
        'alerts_created', v_alerts_created,
        'opportunities_created', v_opps_created,
        'lookback_days', p_lookback_days,
        'country_filter', p_country,
        'run_at', NOW()
    );

END;
$fn$;
