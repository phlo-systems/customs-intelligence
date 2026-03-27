-- Make p_export_country optional in get_landed_cost
-- When NULL: skip preferential rates, sanctions origin check, AD origin filter,
-- import conditions origin filter, export measures. Returns MFN + VAT + excise only.

-- Drop old signature first (required params have changed order)
DROP FUNCTION IF EXISTS get_landed_cost(CHAR, CHAR, VARCHAR, NUMERIC, CHAR);

CREATE OR REPLACE FUNCTION get_landed_cost(
    p_import_country CHAR(2),
    p_commodity_code VARCHAR(20),
    p_export_country CHAR(2) DEFAULT NULL,
    p_customs_value  NUMERIC DEFAULT NULL,
    p_currency       CHAR(3) DEFAULT 'ZAR'
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $fn$
DECLARE
    v_rates_only        BOOLEAN := (p_customs_value IS NULL);

    v_valuation_basis   VARCHAR(5);
    v_import_country    VARCHAR(100);
    v_export_country    VARCHAR(100);
    v_subheading_code   CHAR(6);
    v_commodity_desc    VARCHAR(500);

    v_mfn_rate          NUMERIC := 0;
    v_mfn_expression    VARCHAR(200);
    v_mfn_basis_type    VARCHAR(15);
    v_mfn_specific_amt  NUMERIC;
    v_mfn_specific_uom  VARCHAR(20);

    v_pref_rate         NUMERIC;
    v_pref_agreement    VARCHAR(30);
    v_pref_staging      VARCHAR(30);
    v_effective_rate    NUMERIC;

    v_duty_amount       NUMERIC := 0;
    v_vat_rows          JSONB := '[]'::JSONB;
    v_vat_total         NUMERIC := 0;
    v_vat_rate_pct      NUMERIC := 0;
    v_running_base      NUMERIC;

    v_ad_rows           JSONB := '[]'::JSONB;
    v_ad_total          NUMERIC := 0;

    v_excise_rows       JSONB := '[]'::JSONB;
    v_excise_total      NUMERIC := 0;

    v_reg_measures      JSONB := '[]'::JSONB;
    v_is_prohibited     BOOLEAN := FALSE;
    v_import_conditions JSONB := '[]'::JSONB;
    v_export_measures   JSONB := '[]'::JSONB;
    v_relief_schemes    JSONB := '[]'::JSONB;

    v_drawback_rate     NUMERIC;
    v_drawback_cap      NUMERIC;
    v_drawback_unit     VARCHAR(20);
    v_drawback_obj      JSONB := NULL;

    v_sws_rate          NUMERIC := 0;
    v_sws_amount        NUMERIC := 0;

    v_total_border_cost NUMERIC := 0;
    r                   RECORD;
BEGIN

    -- 0. Resolve context
    SELECT CountryName, ValuationBasis
    INTO v_import_country, v_valuation_basis
    FROM COUNTRY WHERE CountryCode = p_import_country;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('status','error','error','Import country not found: ' || p_import_country);
    END IF;

    IF p_export_country IS NOT NULL THEN
        SELECT CountryName INTO v_export_country
        FROM COUNTRY WHERE CountryCode = p_export_country;
        IF NOT FOUND THEN
            RETURN jsonb_build_object('status','error','error','Export country not found: ' || p_export_country);
        END IF;
    END IF;

    SELECT cc.SubheadingCode, cc.NationalDescription
    INTO v_subheading_code, v_commodity_desc
    FROM COMMODITY_CODE cc
    WHERE cc.CommodityCode = p_commodity_code
      AND cc.CountryCode   = p_import_country
      AND cc.IsActive      = TRUE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('status','error','error','Commodity code ' || p_commodity_code || ' not found for ' || p_import_country);
    END IF;

    -- Step 1: Sanctions (only when export country provided)
    IF p_export_country IS NOT NULL THEN
        FOR r IN
            SELECT SanctionID, SanctionsType, AdministeringBody, SanctionsRegime, Description, LegalBasis
            FROM SANCTIONS_MEASURE
            WHERE IsActive = TRUE
              AND (ImportCountryCode = p_import_country OR ImportCountryCode IS NULL)
              AND (ExportCountryCode = p_export_country OR ExportCountryCode IS NULL)
              AND (CommodityCode = p_commodity_code OR SubheadingCode = v_subheading_code
                   OR (CommodityCode IS NULL AND SubheadingCode IS NULL))
        LOOP
            RETURN jsonb_build_object(
                'status','BLOCKED','blocked_reason','SANCTIONS',
                'message','This trade route is subject to active sanctions. Do not proceed.',
                'sanctions', jsonb_build_array(jsonb_build_object(
                    'sanction_id',r.SanctionID,'type',r.SanctionsType,
                    'administered_by',r.AdministeringBody,'regime',r.SanctionsRegime,
                    'description',r.Description,'legal_basis',r.LegalBasis))
            );
        END LOOP;
    END IF;

    -- Step 2: MFN rate
    SELECT m.AppliedMFNRate, m.DutyExpression, m.DutyBasisType,
           m.SpecificDutyAmt, m.SpecificDutyUOM
    INTO v_mfn_rate, v_mfn_expression, v_mfn_basis_type,
         v_mfn_specific_amt, v_mfn_specific_uom
    FROM MFN_RATE m
    WHERE m.CommodityCode = p_commodity_code
      AND m.CountryCode   = p_import_country
      AND m.RateCategory  = 'APPLIED'
      AND m.EffectiveTo IS NULL
    ORDER BY m.EffectiveFrom DESC LIMIT 1;

    IF NOT v_rates_only THEN
        IF v_mfn_basis_type = 'SPECIFIC' AND v_mfn_specific_amt IS NOT NULL THEN
            v_duty_amount := v_mfn_specific_amt;
        ELSIF v_mfn_rate IS NOT NULL THEN
            v_duty_amount := ROUND(p_customs_value * v_mfn_rate / 100, 2);
        END IF;
    END IF;

    -- Step 2b: India SWS (Social Welfare Surcharge) = 10% of BCD
    IF p_import_country = 'IN' AND COALESCE(v_mfn_rate, 0) > 0 THEN
        v_sws_rate := ROUND(v_mfn_rate * 0.10, 4);
        IF NOT v_rates_only AND v_duty_amount > 0 THEN
            v_sws_amount := ROUND(v_duty_amount * 0.10, 2);
        END IF;
    END IF;

    -- Step 3: Preferential rate (only when export country provided)
    IF p_export_country IS NOT NULL THEN
        SELECT pr.PrefRate, pr.AgreementCode, pr.StagingCategory
        INTO v_pref_rate, v_pref_agreement, v_pref_staging
        FROM PREFERENTIAL_RATE pr
        WHERE pr.CommodityCode     = p_commodity_code
          AND pr.ImportCountryCode = p_import_country
          AND pr.ExportCountryCode = p_export_country
          AND pr.EffectiveTo IS NULL
        ORDER BY pr.PrefRate ASC LIMIT 1;
    END IF;

    IF v_pref_rate IS NOT NULL AND v_pref_rate < COALESCE(v_mfn_rate, 999) THEN
        v_effective_rate := v_pref_rate;
        IF NOT v_rates_only THEN
            v_duty_amount := ROUND(p_customs_value * v_pref_rate / 100, 2);
        END IF;
    ELSE
        v_effective_rate := COALESCE(v_mfn_rate, 0);
    END IF;

    -- Step 4: VAT / indirect taxes
    v_running_base := COALESCE(p_customs_value, 100) + v_duty_amount;

    FOR r IN
        SELECT TaxType, TaxCategory, Rate, VATBasis, PostponedAccounting, ReliefAvailable, Notes
        FROM VAT_RATE
        WHERE CommodityCode = p_commodity_code
          AND CountryCode   = p_import_country
          AND EffectiveTo IS NULL
          AND TaxCategory NOT IN ('EXEMPT','SUSPENDED')
        ORDER BY CASE TaxType WHEN 'II' THEN 1 WHEN 'IPI' THEN 2 WHEN 'PIS' THEN 3 WHEN 'COFINS' THEN 4 WHEN 'ICMS' THEN 5 ELSE 6 END
    LOOP
        DECLARE
            v_tax_base   NUMERIC;
            v_tax_amount NUMERIC;
        BEGIN
            v_tax_base := CASE r.VATBasis
                WHEN 'CUSTOMS_VALUE_PLUS_DUTY' THEN COALESCE(p_customs_value, 100) + v_duty_amount
                WHEN 'CUSTOMS_VALUE_ONLY'      THEN COALESCE(p_customs_value, 100)
                WHEN 'TRANSACTION_VALUE'       THEN COALESCE(p_customs_value, 100)
                WHEN 'TOTAL_IMPORT_VALUE'      THEN v_running_base
                ELSE COALESCE(p_customs_value, 100) + v_duty_amount
            END;

            v_tax_amount   := ROUND(v_tax_base * r.Rate / 100, 2);
            v_vat_rate_pct := v_vat_rate_pct + r.Rate;
            IF NOT v_rates_only THEN
                v_vat_total  := v_vat_total + v_tax_amount;
                v_running_base := v_running_base + v_tax_amount;
            END IF;

            v_vat_rows := v_vat_rows || jsonb_build_object(
                'tax_type',r.TaxType,'category',r.TaxCategory,
                'rate_pct',r.Rate,'basis',r.VATBasis,
                'tax_amount', CASE WHEN v_rates_only THEN NULL ELSE v_tax_amount END,
                'postponed_accounting',r.PostponedAccounting,
                'relief_available',r.ReliefAvailable
            );
        END;
    END LOOP;

    -- Step 5: AD / CVD (only when export country provided)
    IF p_export_country IS NOT NULL THEN
        FOR r IN
            SELECT ADMeasureID, MeasureType, ADRateType, ADRate, SpecificAmt, SpecificUOM,
                   MinImportPrice, ADStatus, ExporterName, ADCaseRef, UnderTaking
            FROM AD_MEASURE
            WHERE CommodityCode     = p_commodity_code
              AND ImportCountryCode = p_import_country
              AND (ExportingCountryCode = p_export_country OR ExportingCountryCode IS NULL)
              AND ADStatus NOT IN ('EXPIRED','INVESTIGATION')
        LOOP
            DECLARE v_ad_amount NUMERIC := 0;
            BEGIN
                IF r.UnderTaking AND r.MinImportPrice IS NOT NULL
                   AND NOT v_rates_only AND (p_customs_value >= r.MinImportPrice) THEN
                    v_ad_amount := 0;
                ELSIF r.ADRateType = 'SPECIFIC' AND r.SpecificAmt IS NOT NULL THEN
                    v_ad_amount := CASE WHEN v_rates_only THEN 0 ELSE r.SpecificAmt END;
                ELSIF r.ADRateType = 'AD_VALOREM' AND r.ADRate IS NOT NULL AND NOT v_rates_only THEN
                    v_ad_amount := ROUND(p_customs_value * r.ADRate / 100, 2);
                END IF;
                v_ad_total := v_ad_total + v_ad_amount;
                v_ad_rows := v_ad_rows || jsonb_build_object(
                    'measure_id',r.ADMeasureID,'type',r.MeasureType,
                    'rate_type',r.ADRateType,'rate_pct',r.ADRate,
                    'ad_amount', CASE WHEN v_rates_only THEN NULL ELSE v_ad_amount END,
                    'status',r.ADStatus,'exporter',r.ExporterName,'case_ref',r.ADCaseRef
                );
            END;
        END LOOP;
    END IF;

    -- Step 6: Excise
    FOR r IN
        SELECT ExciseBasisType, ExciseRate, SpecificDutyAmt, SpecificDutyUOM,
               ExciseExpression, SuspensionAvailable, DrawbackAvailable
        FROM EXCISE
        WHERE CommodityCode = p_commodity_code
          AND CountryCode   = p_import_country
          AND EffectiveTo IS NULL
    LOOP
        DECLARE v_excise_amount NUMERIC := 0;
        BEGIN
            IF r.ExciseBasisType = 'PROHIBITED' THEN v_is_prohibited := TRUE;
            ELSIF r.ExciseBasisType = 'AD_VALOREM' AND r.ExciseRate IS NOT NULL AND NOT v_rates_only THEN
                v_excise_amount := ROUND(p_customs_value * r.ExciseRate / 100, 2);
            ELSIF r.ExciseBasisType = 'SPECIFIC' AND r.SpecificDutyAmt IS NOT NULL AND NOT v_rates_only THEN
                v_excise_amount := r.SpecificDutyAmt;
            END IF;
            v_excise_total := v_excise_total + v_excise_amount;
            v_excise_rows := v_excise_rows || jsonb_build_object(
                'basis_type',r.ExciseBasisType,'rate_pct',r.ExciseRate,
                'specific_uom',r.SpecificDutyUOM,'expression',r.ExciseExpression,
                'excise_amount', CASE WHEN v_rates_only THEN NULL ELSE v_excise_amount END,
                'suspension_available',r.SuspensionAvailable
            );
        END;
    END LOOP;

    -- Step 7: Regulatory
    FOR r IN
        SELECT MeasureType, MeasureDescription, LicenceRequired,
               LicensingAuthority, IsProhibited, Notes
        FROM REG_MEASURE
        WHERE CommodityCode = p_commodity_code
          AND CountryCode   = p_import_country
          AND (EffectiveTo IS NULL OR EffectiveTo > CURRENT_DATE)
    LOOP
        IF r.IsProhibited THEN v_is_prohibited := TRUE; END IF;
        v_reg_measures := v_reg_measures || jsonb_build_object(
            'measure_type',r.MeasureType,'description',r.MeasureDescription,
            'licence_required',r.LicenceRequired,'is_prohibited',r.IsProhibited
        );
    END LOOP;

    IF v_is_prohibited THEN
        RETURN jsonb_build_object(
            'status','BLOCKED','blocked_reason','PROHIBITED',
            'message','This commodity is prohibited from import into ' || v_import_country
        );
    END IF;

    -- Step 8: Import conditions (origin filter only when export country provided)
    FOR r IN
        SELECT NTMCode, NTMCategory, ConditionDescription, CertifyingAuthority,
               TimingRequirement, DocumentCode, IsMandatory
        FROM IMPORT_CONDITION
        WHERE CommodityCode = p_commodity_code
          AND CountryCode   = p_import_country
          AND (p_export_country IS NULL OR OriginCountryCode = p_export_country OR OriginCountryCode IS NULL)
          AND (EffectiveTo IS NULL OR EffectiveTo > CURRENT_DATE)
          AND IsMandatory = TRUE
    LOOP
        v_import_conditions := v_import_conditions || jsonb_build_object(
            'ntm_code',r.NTMCode,'category',r.NTMCategory,
            'description',r.ConditionDescription,'timing',r.TimingRequirement,
            'document_code',r.DocumentCode
        );
    END LOOP;

    -- Step 9: Export measures (only when export country provided)
    IF p_export_country IS NOT NULL THEN
        FOR r IN
            SELECT MeasureType, ExportDutyRate, LicenceRequired, ExportVATRefundEligible
            FROM EXPORT_MEASURE
            WHERE CommodityCode = p_commodity_code AND ExportCountryCode = p_export_country
              AND (EffectiveTo IS NULL OR EffectiveTo > CURRENT_DATE)
        LOOP
            v_export_measures := v_export_measures || jsonb_build_object(
                'measure_type',r.MeasureType,'export_duty_rate_pct',r.ExportDutyRate,
                'licence_required',r.LicenceRequired,'vat_refund_eligible',r.ExportVATRefundEligible
            );
        END LOOP;
    END IF;

    -- Step 10: Relief schemes
    FOR r IN
        SELECT ReliefType, DutyImpact, EligibilityCriteria, AuthorisationRequired
        FROM DUTY_RELIEF
        WHERE CountryCode = p_import_country
          AND (CommodityCode = p_commodity_code OR CommodityCode IS NULL)
          AND (EffectiveTo IS NULL OR EffectiveTo > CURRENT_DATE)
    LOOP
        v_relief_schemes := v_relief_schemes || jsonb_build_object(
            'relief_type',r.ReliefType,'duty_impact',r.DutyImpact,
            'eligibility',r.EligibilityCriteria,'authorisation_required',r.AuthorisationRequired
        );
    END LOOP;

    -- Step 11: Drawback rate (if available)
    SELECT DrawbackRatePct, DrawbackCapAmt, Unit
    INTO v_drawback_rate, v_drawback_cap, v_drawback_unit
    FROM DRAWBACK_RATE
    WHERE CommodityCode = p_commodity_code
      AND CountryCode   = p_import_country
      AND EffectiveTo IS NULL
    ORDER BY EffectiveFrom DESC LIMIT 1;

    IF v_drawback_rate IS NOT NULL THEN
        v_drawback_obj := jsonb_build_object(
            'drawback_rate_pct', v_drawback_rate,
            'drawback_cap_amt',  v_drawback_cap,
            'drawback_cap_currency', 'INR',
            'drawback_unit',     v_drawback_unit,
            'note',              'Drawback is refund of duties on re-exported goods. Rate is % of FOB value, subject to cap.'
        );
    END IF;

    -- Final amounts
    IF NOT v_rates_only THEN
        v_total_border_cost := v_duty_amount + v_sws_amount + v_vat_total + v_ad_total + v_excise_total;
    END IF;

    -- Return
    RETURN jsonb_build_object(

        'status', 'OK',
        'mode',   CASE WHEN v_rates_only THEN 'rates_only' ELSE 'full_calculation' END,

        'input', jsonb_build_object(
            'export_country_code', p_export_country,
            'export_country_name', v_export_country,
            'import_country_code', p_import_country,
            'import_country_name', v_import_country,
            'commodity_code',      p_commodity_code,
            'subheading_code',     v_subheading_code,
            'commodity_description', v_commodity_desc,
            'customs_value',       p_customs_value,
            'currency',            p_currency,
            'valuation_basis',     v_valuation_basis
        ),

        'duty', jsonb_build_object(
            'mfn_rate_pct',       v_mfn_rate,
            'mfn_expression',     v_mfn_expression,
            'pref_rate_pct',      v_pref_rate,
            'pref_agreement',     v_pref_agreement,
            'pref_staging',       v_pref_staging,
            'effective_rate_pct', v_effective_rate,
            'duty_amount',        CASE WHEN v_rates_only THEN NULL ELSE v_duty_amount END,
            'sws_rate_pct',       CASE WHEN v_sws_rate > 0 THEN v_sws_rate ELSE NULL END,
            'sws_amount',         CASE WHEN v_rates_only OR v_sws_amount = 0 THEN NULL ELSE v_sws_amount END,
            'sws_note',           CASE WHEN v_sws_rate > 0 THEN 'Social Welfare Surcharge = 10% of BCD (India)' ELSE NULL END
        ),

        'indirect_tax', jsonb_build_object(
            'taxes',         v_vat_rows,
            'vat_rate_pct',  v_vat_rate_pct,
            'vat_total',     CASE WHEN v_rates_only THEN NULL ELSE v_vat_total END
        ),

        'trade_remedies', jsonb_build_object(
            'measures', v_ad_rows,
            'ad_total', CASE WHEN v_rates_only THEN NULL ELSE v_ad_total END
        ),

        'excise', jsonb_build_object(
            'measures',     v_excise_rows,
            'excise_total', CASE WHEN v_rates_only THEN NULL ELSE v_excise_total END
        ),

        'regulatory',        jsonb_build_object('measures', v_reg_measures),
        'import_conditions', v_import_conditions,
        'export_measures',   v_export_measures,
        'relief_schemes',    v_relief_schemes,
        'drawback',          v_drawback_obj,

        'summary', CASE WHEN v_rates_only THEN
            jsonb_build_object(
                'mode',                  'rates_only',
                'effective_duty_rate_pct', v_effective_rate,
                'mfn_rate_pct',          v_mfn_rate,
                'vat_rate_pct',          v_vat_rate_pct,
                'sws_rate_pct',          v_sws_rate,
                'total_border_rate_pct', v_effective_rate + v_sws_rate + v_vat_rate_pct,
                'pref_agreement',        v_pref_agreement,
                'currency',              p_currency,
                'note',                  CASE WHEN p_export_country IS NULL
                    THEN 'MFN rates only — provide export_country for preferential rates'
                    ELSE 'Provide customs_value for currency amounts'
                END,
                'calculated_at',         NOW()
            )
        ELSE
            jsonb_build_object(
                'mode',               'full_calculation',
                'customs_value',      p_customs_value,
                'duty_amount',        v_duty_amount,
                'sws_amount',         v_sws_amount,
                'ad_surcharge',       v_ad_total,
                'excise_amount',      v_excise_total,
                'vat_amount',         v_vat_total,
                'total_border_cost',  v_total_border_cost,
                'total_landed_cost',  p_customs_value + v_total_border_cost,
                'border_cost_pct',    ROUND(v_total_border_cost / NULLIF(p_customs_value,0) * 100, 2),
                'currency',           p_currency,
                'note',               CASE WHEN p_export_country IS NULL
                    THEN 'MFN rates only — provide export_country for preferential rates and trade remedies'
                    ELSE NULL
                END,
                'calculated_at',      NOW()
            )
        END
    );

END;
$fn$;
