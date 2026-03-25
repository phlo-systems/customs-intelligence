-- Group 2: Commodity & Rates
-- DEV NOTE: TARIFF_RATE_HIST is written EXCLUSIVELY by the DB trigger below.
-- Application code must NEVER write to TARIFF_RATE_HIST directly.
-- EffectiveTo IS NULL = currently active rate throughout all rate tables.

CREATE TABLE COMMODITY_CODE (
    CommodityCode       VARCHAR(15)   NOT NULL,
    CountryCode         VARCHAR(2)    NOT NULL REFERENCES COUNTRY(CountryCode),
    SubheadingCode      CHAR(6)       NOT NULL,
    HSVersion           VARCHAR(10)   NOT NULL DEFAULT 'HS 2022',
    NationalDescription VARCHAR(500)  NOT NULL,
    SupplementaryUnit   VARCHAR(20),
    CodeLength          VARCHAR(12),
    IsActive            BOOLEAN       NOT NULL DEFAULT TRUE,
    CreatedAt           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (CommodityCode, CountryCode),
    FOREIGN KEY (SubheadingCode, HSVersion) REFERENCES HS_SUBHEADING(SubheadingCode, HSVersion)
);
COMMENT ON TABLE COMMODITY_CODE IS
    'PK = (CommodityCode + CountryCode). NO surrogate key. '
    'All FKs from rate tables reference this natural PK directly.';

CREATE TABLE MFN_RATE (
    CommodityCode       VARCHAR(15)   NOT NULL,
    CountryCode         VARCHAR(2)    NOT NULL,
    RateCategory        VARCHAR(20)   NOT NULL
        CHECK (RateCategory IN ('APPLIED','BOUND','TRQ_IN_QUOTA','TRQ_OUT_QUOTA')),
    DutyBasisType       VARCHAR(15)   NOT NULL
        CHECK (DutyBasisType IN ('AD_VALOREM','SPECIFIC','COMPOUND','MIXED')),
    BoundRate           DECIMAL(7,4),
    AppliedMFNRate      DECIMAL(7,4),
    SpecificDutyAmt     DECIMAL(10,4),
    SpecificDutyUOM     VARCHAR(20),
    DutyExpression      VARCHAR(200),
    ValuationBasis      VARCHAR(5)    CHECK (ValuationBasis IN ('CIF','FOB','TRANSACTION_VALUE')),
    TRQVolumeKG         DECIMAL(15,3),
    SeasonalFrom        CHAR(5),
    SeasonalTo          CHAR(5),
    EffectiveFrom       DATE          NOT NULL,
    EffectiveTo         DATE,
    CreatedAt           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (CommodityCode, CountryCode, RateCategory, EffectiveFrom),
    FOREIGN KEY (CommodityCode, CountryCode) REFERENCES COMMODITY_CODE(CommodityCode, CountryCode)
);
COMMENT ON COLUMN MFN_RATE.BoundRate IS 'WTO ceiling. AppliedMFNRate <= BoundRate always.';

CREATE TABLE TARIFF_RATE (
    CommodityCode       VARCHAR(15)   NOT NULL,
    CountryCode         VARCHAR(2)    NOT NULL,
    SubheadingCode      CHAR(6)       NOT NULL,
    AppliedMFNRate      DECIMAL(7,4),
    ValuationBasis      VARCHAR(5),
    DutyExpression      VARCHAR(200),
    EffectiveFrom       DATE          NOT NULL,
    EffectiveTo         DATE,
    LastReviewedAt      DATE,
    DataSourceURL       TEXT,
    PRIMARY KEY (CommodityCode, CountryCode, EffectiveFrom),
    FOREIGN KEY (CommodityCode, CountryCode) REFERENCES COMMODITY_CODE(CommodityCode, CountryCode)
);

CREATE TABLE TARIFF_RATE_HIST (
    HistoryID           BIGSERIAL     PRIMARY KEY,
    CommodityCode       VARCHAR(15)   NOT NULL,
    CountryCode         VARCHAR(2)    NOT NULL,
    SubheadingCode      CHAR(6),
    RateType            VARCHAR(20)   NOT NULL,
    OldRate             DECIMAL(7,4),
    NewRate             DECIMAL(7,4),
    ChangeType          VARCHAR(15)   NOT NULL
        CHECK (ChangeType IN ('INCREASE','DECREASE','NEW','REMOVED','NO_CHANGE')),
    EffectiveFrom       DATE          NOT NULL,
    EffectiveTo         DATE,
    LegalBasis          VARCHAR(200),
    ChangedBy           VARCHAR(100),
    SyncJobID           VARCHAR(50),
    CreatedAt           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE TARIFF_RATE_HIST IS
    'Written EXCLUSIVELY by DB trigger trg_tariff_rate_audit. Never write here directly.';

-- DB Trigger — auto-populates TARIFF_RATE_HIST on every TARIFF_RATE update
CREATE OR REPLACE FUNCTION fn_tariff_rate_audit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO TARIFF_RATE_HIST (
        CommodityCode, CountryCode, SubheadingCode,
        RateType, OldRate, NewRate, ChangeType,
        EffectiveFrom, EffectiveTo, ChangedBy
    ) VALUES (
        OLD.CommodityCode, OLD.CountryCode, OLD.SubheadingCode,
        'IMPORT_DUTY', OLD.AppliedMFNRate, NEW.AppliedMFNRate,
        CASE WHEN NEW.AppliedMFNRate > OLD.AppliedMFNRate THEN 'INCREASE'
             WHEN NEW.AppliedMFNRate < OLD.AppliedMFNRate THEN 'DECREASE'
             ELSE 'NO_CHANGE' END,
        OLD.EffectiveFrom, NOW(), current_user
    );
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tariff_rate_audit
    AFTER UPDATE ON TARIFF_RATE
    FOR EACH ROW EXECUTE FUNCTION fn_tariff_rate_audit();
