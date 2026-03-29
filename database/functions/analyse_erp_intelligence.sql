-- analyse_erp_intelligence.sql
--
-- Analyses ERP_LINE_ITEM data per tenant and generates:
--   1. SUPPLIER_CONCENTRATION alerts (>50% spend on one country/supplier)
--   2. SPENDING_TREND alerts (>25% QoQ change on a trade route)
--   3. FX_EXPOSURE alerts (>30% of spend in one non-base currency)
--   4. Auto-populates tenant context from ERP data (HS chapters, countries, volume)
--
-- Called daily by cron or on-demand after each ERP sync.

CREATE OR REPLACE FUNCTION analyse_erp_intelligence(
    p_tenant_id UUID DEFAULT NULL,
    p_lookback_days INTEGER DEFAULT 180
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $fn$
DECLARE
    v_tenant RECORD;
    v_r RECORD;
    v_alerts_created INTEGER := 0;
    v_context_updated INTEGER := 0;
    v_total_purchase_usd DECIMAL;
    v_total_sale_usd DECIMAL;
    v_q_current_start DATE;
    v_q_prior_start DATE;
    v_q_prior_end DATE;
BEGIN

    v_q_current_start := date_trunc('quarter', CURRENT_DATE)::DATE;
    v_q_prior_start   := (v_q_current_start - INTERVAL '3 months')::DATE;
    v_q_prior_end     := v_q_current_start - 1;

    FOR v_tenant IN
        SELECT DISTINCT TenantID FROM ERP_LINE_ITEM
        WHERE (p_tenant_id IS NULL OR TenantID = p_tenant_id)
          AND DocumentDate >= CURRENT_DATE - p_lookback_days
    LOOP

        -- ═══════════════════════════════════════════════════════════
        -- STEP 1: Auto-populate tenant context from ERP data
        -- ═══════════════════════════════════════════════════════════

        -- Auto-derive HS chapters from classified line items
        WITH hs_chapters AS (
            SELECT DISTINCT HSChapter
            FROM ERP_LINE_ITEM
            WHERE TenantID = v_tenant.TenantID
              AND HSChapter IS NOT NULL
              AND DocumentDate >= CURRENT_DATE - p_lookback_days
        ),
        -- Top supplier countries by spend
        supplier_countries AS (
            SELECT ContactCountry, SUM(LineAmountUSD) AS total_usd
            FROM ERP_LINE_ITEM
            WHERE TenantID = v_tenant.TenantID
              AND DocumentType = 'PURCHASE'
              AND ContactCountry IS NOT NULL
              AND DocumentDate >= CURRENT_DATE - p_lookback_days
            GROUP BY ContactCountry
            ORDER BY total_usd DESC
            LIMIT 10
        ),
        -- Top customer countries by revenue
        customer_countries AS (
            SELECT ContactCountry, SUM(LineAmountUSD) AS total_usd
            FROM ERP_LINE_ITEM
            WHERE TenantID = v_tenant.TenantID
              AND DocumentType = 'SALE'
              AND ContactCountry IS NOT NULL
              AND DocumentDate >= CURRENT_DATE - p_lookback_days
            GROUP BY ContactCountry
            ORDER BY total_usd DESC
            LIMIT 10
        ),
        -- Average PO value
        avg_po AS (
            SELECT ROUND(AVG(LineAmountUSD)) AS avg_val
            FROM ERP_LINE_ITEM
            WHERE TenantID = v_tenant.TenantID
              AND DocumentType = 'PURCHASE'
              AND DocumentDate >= CURRENT_DATE - p_lookback_days
        )
        UPDATE TENANT_CONTEXT SET
            TopSupplierCountries = COALESCE(
                (SELECT array_agg(ContactCountry) FROM supplier_countries),
                TopSupplierCountries
            ),
            TopCustomerCountries = COALESCE(
                (SELECT array_agg(ContactCountry) FROM customer_countries),
                TopCustomerCountries
            ),
            AvgPOValueGBP = COALESCE(
                (SELECT avg_val FROM avg_po),
                AvgPOValueGBP
            ),
            -- Merge ERP-derived HS chapters with manually selected ones
            PrimaryHSChapters = (
                SELECT array_agg(DISTINCT ch ORDER BY ch)
                FROM (
                    SELECT unnest(COALESCE(PrimaryHSChapters, '{}')) AS ch
                    UNION
                    SELECT HSChapter FROM hs_chapters
                ) combined
                WHERE ch IS NOT NULL
            ),
            ERPConnected = TRUE,
            LastActiveAt = NOW()
        WHERE TenantID = v_tenant.TenantID;

        v_context_updated := v_context_updated + 1;

        -- ═══════════════════════════════════════════════════════════
        -- STEP 2: Supplier Concentration Risk
        -- ═══════════════════════════════════════════════════════════

        SELECT COALESCE(SUM(LineAmountUSD), 0) INTO v_total_purchase_usd
        FROM ERP_LINE_ITEM
        WHERE TenantID = v_tenant.TenantID
          AND DocumentType = 'PURCHASE'
          AND DocumentDate >= CURRENT_DATE - p_lookback_days;

        IF v_total_purchase_usd > 0 THEN
            -- By country
            FOR v_r IN
                SELECT ContactCountry, SUM(LineAmountUSD) AS country_usd,
                       ROUND(SUM(LineAmountUSD) / v_total_purchase_usd * 100) AS pct
                FROM ERP_LINE_ITEM
                WHERE TenantID = v_tenant.TenantID
                  AND DocumentType = 'PURCHASE'
                  AND ContactCountry IS NOT NULL
                  AND DocumentDate >= CURRENT_DATE - p_lookback_days
                GROUP BY ContactCountry
                HAVING SUM(LineAmountUSD) / v_total_purchase_usd > 0.50
            LOOP
                INSERT INTO ALERTS (TenantID, AlertType, Severity, CountryCode,
                    Headline, Detail, DetectedAt)
                VALUES (
                    v_tenant.TenantID,
                    'SUPPLIER_CONCENTRATION',
                    CASE WHEN v_r.pct >= 75 THEN 'HIGH' ELSE 'MEDIUM' END,
                    v_r.ContactCountry,
                    format('%s%% of your import spend comes from %s — consider diversifying',
                        v_r.pct, v_r.ContactCountry),
                    format('Over the last %s days, $%s of $%s total purchases came from %s. '
                        'Explore alternative suppliers in countries with preferential trade agreements to reduce single-source risk.',
                        p_lookback_days,
                        to_char(v_r.country_usd, 'FM999,999,999'),
                        to_char(v_total_purchase_usd, 'FM999,999,999'),
                        v_r.ContactCountry),
                    NOW()
                )
                ON CONFLICT DO NOTHING;
                v_alerts_created := v_alerts_created + 1;
            END LOOP;

            -- By supplier name
            FOR v_r IN
                SELECT ContactName, ContactCountry, SUM(LineAmountUSD) AS supplier_usd,
                       ROUND(SUM(LineAmountUSD) / v_total_purchase_usd * 100) AS pct
                FROM ERP_LINE_ITEM
                WHERE TenantID = v_tenant.TenantID
                  AND DocumentType = 'PURCHASE'
                  AND ContactName IS NOT NULL
                  AND DocumentDate >= CURRENT_DATE - p_lookback_days
                GROUP BY ContactName, ContactCountry
                HAVING SUM(LineAmountUSD) / v_total_purchase_usd > 0.40
            LOOP
                INSERT INTO ALERTS (TenantID, AlertType, Severity, CountryCode,
                    Headline, Detail, DetectedAt)
                VALUES (
                    v_tenant.TenantID,
                    'SUPPLIER_CONCENTRATION',
                    CASE WHEN v_r.pct >= 60 THEN 'HIGH' ELSE 'MEDIUM' END,
                    v_r.ContactCountry,
                    format('%s%% of purchases from single supplier "%s" — supply chain risk',
                        v_r.pct, LEFT(v_r.ContactName, 60)),
                    format('$%s spent with %s (%s). If this supplier faces disruption, %s%% of your sourcing is at risk. '
                        'Identify backup suppliers in the same or preferential-rate countries.',
                        to_char(v_r.supplier_usd, 'FM999,999,999'),
                        v_r.ContactName,
                        COALESCE(v_r.ContactCountry, 'unknown country'),
                        v_r.pct),
                    NOW()
                )
                ON CONFLICT DO NOTHING;
                v_alerts_created := v_alerts_created + 1;
            END LOOP;
        END IF;

        -- ═══════════════════════════════════════════════════════════
        -- STEP 3: Spending Trend Detection (QoQ by country)
        -- ═══════════════════════════════════════════════════════════

        FOR v_r IN
            WITH current_q AS (
                SELECT ContactCountry, SUM(LineAmountUSD) AS q_usd
                FROM ERP_LINE_ITEM
                WHERE TenantID = v_tenant.TenantID
                  AND DocumentType = 'PURCHASE'
                  AND ContactCountry IS NOT NULL
                  AND DocumentDate >= v_q_current_start
                GROUP BY ContactCountry
            ),
            prior_q AS (
                SELECT ContactCountry, SUM(LineAmountUSD) AS q_usd
                FROM ERP_LINE_ITEM
                WHERE TenantID = v_tenant.TenantID
                  AND DocumentType = 'PURCHASE'
                  AND ContactCountry IS NOT NULL
                  AND DocumentDate BETWEEN v_q_prior_start AND v_q_prior_end
                GROUP BY ContactCountry
            )
            SELECT c.ContactCountry,
                   c.q_usd AS current_usd,
                   p.q_usd AS prior_usd,
                   ROUND((c.q_usd - p.q_usd) / NULLIF(p.q_usd, 0) * 100) AS change_pct
            FROM current_q c
            JOIN prior_q p ON p.ContactCountry = c.ContactCountry
            WHERE p.q_usd > 0
              AND ABS((c.q_usd - p.q_usd) / p.q_usd) >= 0.25  -- 25% change threshold
              AND p.q_usd >= 1000  -- ignore tiny amounts
        LOOP
            INSERT INTO ALERTS (TenantID, AlertType, Severity, CountryCode,
                Headline, Detail, DetectedAt)
            VALUES (
                v_tenant.TenantID,
                'SPENDING_TREND',
                CASE
                    WHEN ABS(v_r.change_pct) >= 50 THEN 'HIGH'
                    ELSE 'MEDIUM'
                END,
                v_r.ContactCountry,
                CASE
                    WHEN v_r.change_pct > 0 THEN
                        format('Import spend from %s up %s%% this quarter — review duty optimisation',
                            v_r.ContactCountry, v_r.change_pct)
                    ELSE
                        format('Import spend from %s down %s%% this quarter — market shift?',
                            v_r.ContactCountry, ABS(v_r.change_pct))
                END,
                CASE
                    WHEN v_r.change_pct > 0 THEN
                        format('Purchases from %s grew from $%s to $%s QoQ (+%s%%). '
                            'At this volume, check if preferential rates or duty relief schemes could reduce costs. '
                            'Review Certificate of Origin requirements.',
                            v_r.ContactCountry,
                            to_char(v_r.prior_usd, 'FM999,999,999'),
                            to_char(v_r.current_usd, 'FM999,999,999'),
                            v_r.change_pct)
                    ELSE
                        format('Purchases from %s fell from $%s to $%s QoQ (%s%%). '
                            'If shifting to a new source country, verify tariff rates and FTA eligibility before committing.',
                            v_r.ContactCountry,
                            to_char(v_r.prior_usd, 'FM999,999,999'),
                            to_char(v_r.current_usd, 'FM999,999,999'),
                            v_r.change_pct)
                END,
                NOW()
            )
            ON CONFLICT DO NOTHING;
            v_alerts_created := v_alerts_created + 1;
        END LOOP;

        -- ═══════════════════════════════════════════════════════════
        -- STEP 4: FX Exposure Alerts
        -- ═══════════════════════════════════════════════════════════

        FOR v_r IN
            SELECT CurrencyCode,
                   SUM(LineAmountUSD) AS currency_usd,
                   ROUND(SUM(LineAmountUSD) / NULLIF(v_total_purchase_usd, 0) * 100) AS pct
            FROM ERP_LINE_ITEM
            WHERE TenantID = v_tenant.TenantID
              AND DocumentType = 'PURCHASE'
              AND DocumentDate >= CURRENT_DATE - p_lookback_days
              AND CurrencyCode NOT IN ('GBP', 'USD', 'EUR')  -- ignore major currencies
            GROUP BY CurrencyCode
            HAVING v_total_purchase_usd > 0
              AND SUM(LineAmountUSD) / v_total_purchase_usd > 0.30
        LOOP
            INSERT INTO ALERTS (TenantID, AlertType, Severity, CountryCode,
                Headline, Detail, DetectedAt)
            VALUES (
                v_tenant.TenantID,
                'FX_EXPOSURE',
                CASE WHEN v_r.pct >= 50 THEN 'HIGH' ELSE 'MEDIUM' END,
                NULL,
                format('%s%% of purchase spend is in %s — consider hedging',
                    v_r.pct, v_r.CurrencyCode),
                format('$%s equivalent in %s over the last %s days. '
                    'Emerging market currencies can move 10-20%% in a quarter. '
                    'Consider forward contracts or natural hedging through matched receivables.',
                    to_char(v_r.currency_usd, 'FM999,999,999'),
                    v_r.CurrencyCode,
                    p_lookback_days),
                NOW()
            )
            ON CONFLICT DO NOTHING;
            v_alerts_created := v_alerts_created + 1;
        END LOOP;

    END LOOP;

    RETURN jsonb_build_object(
        'alerts_created', v_alerts_created,
        'tenants_analysed', (SELECT COUNT(DISTINCT TenantID) FROM ERP_LINE_ITEM
                             WHERE (p_tenant_id IS NULL OR TenantID = p_tenant_id)
                               AND DocumentDate >= CURRENT_DATE - p_lookback_days),
        'context_auto_updated', v_context_updated
    );

END;
$fn$;
