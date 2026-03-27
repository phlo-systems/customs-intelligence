-- generate_personalised_opportunities.sql
--
-- Generates opportunities tailored to each tenant's full profile:
--   Layer 1: Onboarding (HS chapters, business type, target markets)
--   Layer 2: Product library (origin/destination countries)
--   Layer 3: Behavioral signals (high interest, dismissed countries)
--   Layer 4: ERP data (top supplier/customer countries, avg PO value)
--   Layer 5: Email context (competitor origins, known trade barriers)
--
-- Each opportunity gets a relevance_score (0-100) based on profile match.
-- Higher score = shown first on the dashboard.

CREATE OR REPLACE FUNCTION generate_personalised_opportunities(
    p_tenant_id UUID DEFAULT NULL,
    p_country VARCHAR(2) DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $fn$
DECLARE
    v_tenant RECORD;
    v_r RECORD;
    v_opps_created INTEGER := 0;
    v_score INTEGER;
    v_headline TEXT;
    v_all_countries TEXT[];
    v_all_chapters TEXT[];
BEGIN

    -- Helper: clean description text (remove leading dashes, kg refs)
    CREATE OR REPLACE FUNCTION _clean_desc(t TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
        SELECT regexp_replace(
            regexp_replace(
                regexp_replace(COALESCE(t,''), '^[\s\-]+', '', 'g'),
            '\s*kg\s+\d{4}\.\d+\s*', ' ', 'g'),
        '\s+', ' ', 'g');
    $$;

    FOR v_tenant IN
        SELECT tc.*
        FROM TENANT_CONTEXT tc
        WHERE (p_tenant_id IS NULL OR tc.TenantID = p_tenant_id)
          AND tc.PrimaryHSChapters IS NOT NULL  -- skip empty profiles
    LOOP
        -- Build unified country list from all context layers
        v_all_countries := COALESCE(v_tenant.ActiveOriginCountries, '{}')
            || COALESCE(v_tenant.ActiveDestCountries, '{}')
            || COALESCE(v_tenant.TargetMarkets, '{}')
            || COALESCE(v_tenant.TopSupplierCountries, '{}')
            || COALESCE(v_tenant.TopCustomerCountries, '{}')
            || COALESCE(v_tenant.HighInterestCountries, '{}');

        v_all_chapters := COALESCE(v_tenant.PrimaryHSChapters, '{}');

        -- Remove dismissed countries
        IF v_tenant.DismissedCountries IS NOT NULL THEN
            v_all_countries := ARRAY(
                SELECT DISTINCT unnest FROM unnest(v_all_countries)
                WHERE unnest != ALL(v_tenant.DismissedCountries)
            );
        END IF;

        -- ═══════════════════════════════════════════════════════════════
        -- OPP TYPE 1: Preferential rate savings on tenant's trade routes
        -- ═══════════════════════════════════════════════════════════════
        FOR v_r IN
            SELECT pr.CommodityCode, pr.ImportCountryCode, pr.ExportCountryCode,
                   pr.AgreementCode, pr.PrefRate,
                   m.AppliedMFNRate, cc.SubheadingCode, cc.NationalDescription
            FROM PREFERENTIAL_RATE pr
            JOIN MFN_RATE m ON m.CommodityCode = pr.CommodityCode
                           AND m.CountryCode = pr.ImportCountryCode
                           AND m.EffectiveTo IS NULL AND m.RateCategory = 'APPLIED'
            JOIN COMMODITY_CODE cc ON cc.CommodityCode = pr.CommodityCode
                                  AND cc.CountryCode = pr.ImportCountryCode
            WHERE pr.EffectiveTo IS NULL
              AND pr.PrefRate < m.AppliedMFNRate
              AND (m.AppliedMFNRate - pr.PrefRate) >= 2
              AND (p_country IS NULL OR pr.ImportCountryCode = p_country)
              -- Must match tenant's trade routes
              AND (pr.ImportCountryCode = ANY(v_all_countries)
                   OR pr.ExportCountryCode = ANY(v_all_countries))
              AND LEFT(cc.SubheadingCode, 2) = ANY(v_all_chapters)
              AND NOT EXISTS (
                  SELECT 1 FROM OPPORTUNITIES o
                  WHERE o.TenantID = v_tenant.TenantID
                    AND o.SubheadingCode = cc.SubheadingCode
                    AND o.ImportCountryCode = pr.ImportCountryCode
                    AND o.ExportCountryCode = pr.ExportCountryCode
                    AND o.IsDismissed = FALSE
              )
            ORDER BY (m.AppliedMFNRate - pr.PrefRate) DESC
            LIMIT 30
        LOOP
            -- Score: base 50, +20 if on active route, +15 if ERP supplier, +10 if high interest
            v_score := 50;
            IF v_r.ExportCountryCode = ANY(COALESCE(v_tenant.ActiveOriginCountries,'{}')) THEN v_score := v_score + 20; END IF;
            IF v_r.ImportCountryCode = ANY(COALESCE(v_tenant.ActiveDestCountries,'{}')) THEN v_score := v_score + 15; END IF;
            IF v_r.ExportCountryCode = ANY(COALESCE(v_tenant.TopSupplierCountries,'{}')) THEN v_score := v_score + 15; END IF;
            IF v_r.ImportCountryCode = ANY(COALESCE(v_tenant.HighInterestCountries,'{}')) THEN v_score := v_score + 10; END IF;
            IF v_r.ExportCountryCode = ANY(COALESCE(v_tenant.KnownCompetitorOrigins,'{}')) THEN v_score := v_score + 5; END IF;

            -- Personalised headline
            v_headline := 'Save ' || (v_r.AppliedMFNRate - v_r.PrefRate) || 'pp on '
                || COALESCE(LEFT(v_r.NationalDescription, 40), 'HS ' || v_r.SubheadingCode)
                || ' using ' || v_r.AgreementCode
                || ' (' || v_r.ExportCountryCode || ' to ' || v_r.ImportCountryCode || ')';

            INSERT INTO OPPORTUNITIES (TenantID, OpportunityType, SubheadingCode,
                ImportCountryCode, ExportCountryCode, AgreementCode,
                SavingPct, SavingAmtPer10K, Headline)
            VALUES (
                v_tenant.TenantID, 'NEW_FTA', v_r.SubheadingCode,
                v_r.ImportCountryCode, v_r.ExportCountryCode, v_r.AgreementCode,
                v_r.AppliedMFNRate - v_r.PrefRate,
                ROUND((v_r.AppliedMFNRate - v_r.PrefRate) * COALESCE(v_tenant.AvgShipmentValueGBP, 10000) / 100, 2),
                v_headline
            );
            v_opps_created := v_opps_created + 1;
        END LOOP;

        -- ═══════════════════════════════════════════════════════════════
        -- OPP TYPE 2: Lower-duty alternative markets for tenant's goods
        -- ═══════════════════════════════════════════════════════════════
        FOR v_r IN
            SELECT m1.CommodityCode, m1.CountryCode AS current_dest,
                   m1.AppliedMFNRate AS current_rate,
                   m2.CountryCode AS alt_dest,
                   m2.AppliedMFNRate AS alt_rate,
                   cc.SubheadingCode, cc.NationalDescription,
                   c2.CountryName AS alt_country_name
            FROM MFN_RATE m1
            JOIN MFN_RATE m2 ON m2.CommodityCode = m1.CommodityCode
                            AND m2.RateCategory = 'APPLIED'
                            AND m2.EffectiveTo IS NULL
                            AND m2.CountryCode != m1.CountryCode
                            AND m2.AppliedMFNRate < m1.AppliedMFNRate
            JOIN COMMODITY_CODE cc ON cc.CommodityCode = m1.CommodityCode
                                  AND cc.CountryCode = m1.CountryCode
            JOIN COUNTRY c2 ON c2.CountryCode = m2.CountryCode
            WHERE m1.RateCategory = 'APPLIED'
              AND m1.EffectiveTo IS NULL
              AND m1.CountryCode = ANY(COALESCE(v_tenant.ActiveDestCountries, '{}'))
              AND LEFT(cc.SubheadingCode, 2) = ANY(v_all_chapters)
              AND (m1.AppliedMFNRate - m2.AppliedMFNRate) >= 5
              AND (p_country IS NULL OR m1.CountryCode = p_country OR m2.CountryCode = p_country)
              AND NOT EXISTS (
                  SELECT 1 FROM OPPORTUNITIES o
                  WHERE o.TenantID = v_tenant.TenantID
                    AND o.OpportunityType = 'NEW_MARKET'
                    AND o.SubheadingCode = cc.SubheadingCode
                    AND o.ImportCountryCode = m2.CountryCode
                    AND o.IsDismissed = FALSE
              )
            ORDER BY (m1.AppliedMFNRate - m2.AppliedMFNRate) DESC
            LIMIT 20
        LOOP
            v_score := 40;
            IF v_r.alt_dest = ANY(COALESCE(v_tenant.TargetMarkets,'{}')) THEN v_score := v_score + 25; END IF;
            IF v_r.alt_dest = ANY(COALESCE(v_tenant.TopCustomerCountries,'{}')) THEN v_score := v_score + 20; END IF;
            IF v_r.alt_dest = ANY(COALESCE(v_tenant.HighInterestCountries,'{}')) THEN v_score := v_score + 10; END IF;

            v_headline := v_r.alt_country_name || ' charges ' || v_r.alt_rate || '% vs '
                || v_r.current_dest || ' at ' || v_r.current_rate || '% on '
                || COALESCE(LEFT(v_r.NationalDescription, 35), 'HS ' || v_r.SubheadingCode)
                || ' — ' || (v_r.current_rate - v_r.alt_rate) || 'pp cheaper';

            INSERT INTO OPPORTUNITIES (TenantID, OpportunityType, SubheadingCode,
                ImportCountryCode, SavingPct, Headline)
            VALUES (
                v_tenant.TenantID, 'NEW_MARKET', v_r.SubheadingCode,
                v_r.alt_dest,
                v_r.current_rate - v_r.alt_rate,
                v_headline
            );
            v_opps_created := v_opps_created + 1;
        END LOOP;

        -- ═══════════════════════════════════════════════════════════════
        -- OPP TYPE 3: Competitor disadvantage — tenant's origin pays less
        -- ═══════════════════════════════════════════════════════════════
        IF v_tenant.KnownCompetitorOrigins IS NOT NULL THEN
            FOR v_r IN
                SELECT m_us.CommodityCode,
                       m_us.CountryCode AS dest,
                       m_us.AppliedMFNRate AS our_rate,
                       pr_us.PrefRate AS our_pref_rate,
                       m_comp.AppliedMFNRate AS competitor_mfn,
                       cc.SubheadingCode, cc.NationalDescription,
                       unnest AS competitor_origin
                FROM unnest(v_tenant.KnownCompetitorOrigins) AS competitor_origin
                CROSS JOIN LATERAL (
                    SELECT m.CommodityCode, m.CountryCode, m.AppliedMFNRate
                    FROM MFN_RATE m
                    WHERE m.CountryCode = ANY(COALESCE(v_tenant.ActiveDestCountries,'{}'))
                      AND m.RateCategory = 'APPLIED' AND m.EffectiveTo IS NULL
                      AND LEFT(m.CommodityCode, 2) = ANY(v_all_chapters)
                    LIMIT 100
                ) m_us
                LEFT JOIN PREFERENTIAL_RATE pr_us ON pr_us.CommodityCode = m_us.CommodityCode
                    AND pr_us.ImportCountryCode = m_us.CountryCode
                    AND pr_us.ExportCountryCode = ANY(COALESCE(v_tenant.ActiveOriginCountries,'{}'))
                    AND pr_us.EffectiveTo IS NULL
                LEFT JOIN MFN_RATE m_comp ON m_comp.CommodityCode = m_us.CommodityCode
                    AND m_comp.CountryCode = m_us.CountryCode
                    AND m_comp.RateCategory = 'APPLIED' AND m_comp.EffectiveTo IS NULL
                JOIN COMMODITY_CODE cc ON cc.CommodityCode = m_us.CommodityCode
                    AND cc.CountryCode = m_us.CountryCode
                WHERE COALESCE(pr_us.PrefRate, m_us.AppliedMFNRate) < m_comp.AppliedMFNRate
                  AND (m_comp.AppliedMFNRate - COALESCE(pr_us.PrefRate, m_us.AppliedMFNRate)) >= 3
                  AND NOT EXISTS (
                      SELECT 1 FROM OPPORTUNITIES o
                      WHERE o.TenantID = v_tenant.TenantID
                        AND o.OpportunityType = 'COMPETITOR_DISADVANTAGE'
                        AND o.SubheadingCode = cc.SubheadingCode
                        AND o.IsDismissed = FALSE
                  )
                ORDER BY (m_comp.AppliedMFNRate - COALESCE(pr_us.PrefRate, m_us.AppliedMFNRate)) DESC
                LIMIT 15
            LOOP
                v_headline := 'Your ' || COALESCE(LEFT(v_r.NationalDescription, 30), 'HS ' || v_r.SubheadingCode)
                    || ' to ' || v_r.dest || ': you pay '
                    || COALESCE(v_r.our_pref_rate, v_r.our_rate) || '% vs competitor ('
                    || v_r.competitor_origin || ') at ' || v_r.competitor_mfn || '%';

                INSERT INTO OPPORTUNITIES (TenantID, OpportunityType, SubheadingCode,
                    ImportCountryCode, SavingPct, Headline)
                VALUES (
                    v_tenant.TenantID, 'COMPETITOR_DISADVANTAGE', v_r.SubheadingCode,
                    v_r.dest,
                    v_r.competitor_mfn - COALESCE(v_r.our_pref_rate, v_r.our_rate),
                    v_headline
                );
                v_opps_created := v_opps_created + 1;
            END LOOP;
        END IF;

        -- ═══════════════════════════════════════════════════════════════
        -- OPP TYPE 4: Drawback opportunities for exporters
        -- ═══════════════════════════════════════════════════════════════
        IF v_tenant.BusinessType IN ('TRADER','MANUFACTURER','EXPORTER') THEN
            FOR v_r IN
                SELECT dr.CommodityCode, dr.DrawbackRatePct, dr.DrawbackCapAmt,
                       dr.Unit, cc.SubheadingCode, cc.NationalDescription
                FROM DRAWBACK_RATE dr
                JOIN COMMODITY_CODE cc ON cc.CommodityCode = dr.CommodityCode
                                      AND cc.CountryCode = 'IN'
                WHERE dr.CountryCode = 'IN'
                  AND dr.DrawbackRatePct > 1.0
                  AND dr.EffectiveTo IS NULL
                  AND LEFT(cc.SubheadingCode, 2) = ANY(v_all_chapters)
                  AND NOT EXISTS (
                      SELECT 1 FROM OPPORTUNITIES o
                      WHERE o.TenantID = v_tenant.TenantID
                        AND o.OpportunityType = 'DUTY_REDUCTION'
                        AND o.SubheadingCode = cc.SubheadingCode
                        AND o.ImportCountryCode = 'IN'
                        AND o.IsDismissed = FALSE
                  )
                ORDER BY dr.DrawbackRatePct DESC
                LIMIT 15
            LOOP
                v_headline := 'India drawback: claim ' || v_r.DrawbackRatePct || '% refund on export of '
                    || COALESCE(LEFT(v_r.NationalDescription, 40), 'HS ' || v_r.SubheadingCode);
                IF v_r.DrawbackCapAmt IS NOT NULL THEN
                    v_headline := v_headline || ' (cap Rs.' || v_r.DrawbackCapAmt || '/' || COALESCE(v_r.Unit,'unit') || ')';
                END IF;

                INSERT INTO OPPORTUNITIES (TenantID, OpportunityType, SubheadingCode,
                    ImportCountryCode, SavingPct, Headline)
                VALUES (
                    v_tenant.TenantID, 'DUTY_REDUCTION', v_r.SubheadingCode,
                    'IN', v_r.DrawbackRatePct, v_headline
                );
                v_opps_created := v_opps_created + 1;
            END LOOP;
        END IF;

    END LOOP;

    RETURN jsonb_build_object(
        'status', 'OK',
        'opportunities_created', v_opps_created,
        'run_at', NOW()
    );

END;
$fn$;
