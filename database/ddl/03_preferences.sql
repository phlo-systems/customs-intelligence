-- Group 3: Preferences — FTAs, GSP, EPA, Customs Unions
-- DEV NOTE: Always check all four tables in sequence:
-- TRADE_AGREEMENT → PREFERENTIAL_RATE → RULES_OF_ORIGIN → ORIGIN_DOCUMENT

CREATE TABLE TRADE_AGREEMENT (
    AgreementCode       VARCHAR(30)   PRIMARY KEY,
    AgreementName       VARCHAR(200)  NOT NULL,
    AgreementType       VARCHAR(10)   NOT NULL
        CHECK (AgreementType IN ('FTA','EPA','GSP','CU','PTA')),
    PartiesISO          TEXT          NOT NULL,
    InForceFrom         DATE          NOT NULL,
    InForceTo           DATE,
    AdministeredBy      VARCHAR(200),
    Notes               TEXT,
    CreatedAt           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE PREFERENTIAL_RATE (
    CommodityCode       VARCHAR(15)   NOT NULL,
    ImportCountryCode   VARCHAR(2)    NOT NULL REFERENCES COUNTRY(CountryCode),
    ExportCountryCode   VARCHAR(2)    NOT NULL REFERENCES COUNTRY(CountryCode),
    AgreementCode       VARCHAR(30)   NOT NULL REFERENCES TRADE_AGREEMENT(AgreementCode),
    SubheadingCode      CHAR(6)       NOT NULL,
    PrefRate            DECIMAL(7,4)  NOT NULL,
    StagingCategory     VARCHAR(30),
    EffectiveFrom       DATE          NOT NULL,
    EffectiveTo         DATE,
    Notes               TEXT,
    PRIMARY KEY (CommodityCode, ImportCountryCode, ExportCountryCode, AgreementCode, EffectiveFrom),
    FOREIGN KEY (CommodityCode, ImportCountryCode) REFERENCES COMMODITY_CODE(CommodityCode, CountryCode)
);

CREATE TABLE RULES_OF_ORIGIN (
    CommodityCode       VARCHAR(15)   NOT NULL,
    AgreementCode       VARCHAR(30)   NOT NULL REFERENCES TRADE_AGREEMENT(AgreementCode),
    ExportCountryCode   VARCHAR(2)    NOT NULL REFERENCES COUNTRY(CountryCode),
    OriginCriterion     VARCHAR(10)   NOT NULL
        CHECK (OriginCriterion IN ('WO','CTH','CTSH','RVC','SP')),
    RVCThresholdPct     DECIMAL(5,2),
    AllowedTolerance    DECIMAL(5,2),
    CumulationRule      TEXT,
    DirectTransportRequired BOOLEAN   NOT NULL DEFAULT TRUE,
    ProofOfOriginDocCode VARCHAR(30),
    Notes               TEXT,
    PRIMARY KEY (CommodityCode, AgreementCode, ExportCountryCode)
);
COMMENT ON COLUMN RULES_OF_ORIGIN.OriginCriterion IS
    'WO=Wholly Obtained, CTH=Change Tariff Heading, CTSH=Change Subheading, '
    'RVC=Regional Value Content %, SP=Sufficient Processing';

CREATE TABLE ORIGIN_DOCUMENT (
    DocumentCode        VARCHAR(30)   NOT NULL,
    AgreementCode       VARCHAR(30)   NOT NULL REFERENCES TRADE_AGREEMENT(AgreementCode),
    DocumentName        VARCHAR(100)  NOT NULL,
    IssuingAuthority    VARCHAR(200),
    ValidityDays        INTEGER,
    ValueThresholdLocal DECIMAL(12,2),
    ApprovedExporterRequired BOOLEAN  NOT NULL DEFAULT FALSE,
    TemplateURL         TEXT,
    Notes               TEXT,
    PRIMARY KEY (DocumentCode, AgreementCode)
);
