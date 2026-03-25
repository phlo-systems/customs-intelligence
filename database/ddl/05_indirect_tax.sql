-- Group 5: Indirect Tax
-- DEV NOTE (Brazil): VAT_RATE has 5 rows for HS 2004.10: II+IPI+PIS+COFINS+ICMS
-- Calculate sequentially using VATBasis — NOT as a flat sum. Total ~45.75%.
-- AD_MEASURE stacks ON TOP of MFN duty — both apply simultaneously.

CREATE TABLE VAT_RATE (
    CommodityCode       VARCHAR(15)   NOT NULL,
    CountryCode         VARCHAR(2)    NOT NULL REFERENCES COUNTRY(CountryCode),
    SubheadingCode      CHAR(6),
    TaxType             VARCHAR(15)   NOT NULL
        CHECK (TaxType IN ('VAT','GST','IVA','ITBIS','II','IPI','PIS','COFINS','ICMS',
                           'CONSUMPTION_TAX','EXCISE')),
    TaxCategory         VARCHAR(10)   NOT NULL
        CHECK (TaxCategory IN ('STANDARD','REDUCED','ZERO','EXEMPT','SUSPENDED')),
    Rate                DECIMAL(7,4)  NOT NULL,
    VATBasis            VARCHAR(30)   NOT NULL
        CHECK (VATBasis IN ('CUSTOMS_VALUE_PLUS_DUTY','CUSTOMS_VALUE_ONLY',
                            'TRANSACTION_VALUE','TOTAL_IMPORT_VALUE','GROSS_WEIGHT')),
    PostponedAccounting BOOLEAN       NOT NULL DEFAULT FALSE,
    ReliefAvailable     BOOLEAN       NOT NULL DEFAULT FALSE,
    ReliefSchemeRef     VARCHAR(50),
    StateOrProvince     VARCHAR(50),
    EffectiveFrom       DATE          NOT NULL,
    EffectiveTo         DATE,
    LegalBasis          VARCHAR(200),
    Notes               TEXT,
    PRIMARY KEY (CommodityCode, CountryCode, TaxType, EffectiveFrom),
    FOREIGN KEY (CommodityCode, CountryCode) REFERENCES COMMODITY_CODE(CommodityCode, CountryCode)
);

CREATE TABLE EXCISE (
    CommodityCode       VARCHAR(15)   NOT NULL,
    CountryCode         VARCHAR(2)    NOT NULL REFERENCES COUNTRY(CountryCode),
    SubheadingCode      CHAR(6),
    ExciseBasisType     VARCHAR(15)   NOT NULL
        CHECK (ExciseBasisType IN ('AD_VALOREM','SPECIFIC','COMPOUND','PROHIBITED')),
    ExciseRate          DECIMAL(7,4),
    SpecificDutyAmt     DECIMAL(12,4),
    SpecificDutyUOM     VARCHAR(20),
    ExciseExpression    VARCHAR(200),
    SuspensionAvailable BOOLEAN       NOT NULL DEFAULT FALSE,
    DrawbackAvailable   BOOLEAN       NOT NULL DEFAULT FALSE,
    DomesticRateApplies BOOLEAN       NOT NULL DEFAULT TRUE,
    EffectiveFrom       DATE          NOT NULL,
    EffectiveTo         DATE,
    LegalBasis          VARCHAR(200),
    Notes               TEXT,
    PRIMARY KEY (CommodityCode, CountryCode, EffectiveFrom),
    FOREIGN KEY (CommodityCode, CountryCode) REFERENCES COMMODITY_CODE(CommodityCode, CountryCode)
);

CREATE TABLE AD_MEASURE (
    ADMeasureID         BIGSERIAL     PRIMARY KEY,
    CommodityCode       VARCHAR(15)   NOT NULL,
    ImportCountryCode   VARCHAR(2)    NOT NULL REFERENCES COUNTRY(CountryCode),
    ExportingCountryCode VARCHAR(2)   REFERENCES COUNTRY(CountryCode),
    ExporterName        VARCHAR(300),
    ExporterTAIC        VARCHAR(100),
    MeasureType         VARCHAR(20)   NOT NULL
        CHECK (MeasureType IN ('ANTI_DUMPING','COUNTERVAILING','SAFEGUARD')),
    ADRateType          VARCHAR(20)
        CHECK (ADRateType IN ('AD_VALOREM','SPECIFIC','MIN_IMPORT_PRICE')),
    ADRate              DECIMAL(7,4),
    SpecificAmt         DECIMAL(10,4),
    SpecificUOM         VARCHAR(20),
    MinImportPrice      DECIMAL(15,4),
    MIPCurrency         CHAR(3),
    ADStatus            VARCHAR(20)   NOT NULL
        CHECK (ADStatus IN ('INVESTIGATION','PROVISIONAL','DEFINITIVE','REVIEW','EXPIRED')),
    ProvisionalFrom     DATE,
    DefinitiveFrom      DATE,
    SunsetReviewDate    DATE,
    InvestigatingBody   VARCHAR(200),
    UnderTaking         BOOLEAN       NOT NULL DEFAULT FALSE,
    ADCaseRef           VARCHAR(100),
    Notes               TEXT,
    CreatedAt           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE DUTY_RELIEF (
    ReliefID            BIGSERIAL     PRIMARY KEY,
    CommodityCode       VARCHAR(15),
    CountryCode         VARCHAR(2)    NOT NULL REFERENCES COUNTRY(CountryCode),
    ReliefType          VARCHAR(10)   NOT NULL
        CHECK (ReliefType IN ('IPR','CW','TA','EUR','OPR','RECOF','OTHER')),
    DutyImpact          VARCHAR(10)   NOT NULL
        CHECK (DutyImpact IN ('ZERO','SUSPEND','REDUCE')),
    EligibilityCriteria TEXT          NOT NULL,
    ApplicationProcedure TEXT,
    AuthorisationRequired BOOLEAN     NOT NULL DEFAULT TRUE,
    MaxDurationMonths   INTEGER,
    GuaranteeRequired   BOOLEAN       NOT NULL DEFAULT FALSE,
    EffectiveFrom       DATE          NOT NULL,
    EffectiveTo         DATE,
    LegalBasis          VARCHAR(200),
    Notes               TEXT
);
