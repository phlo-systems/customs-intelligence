-- Group 4: Regulatory measures
-- DEV NOTE: Always query SANCTIONS_MEASURE FIRST before any landed cost calculation.
-- IsActive=TRUE on any sanctions row means the trade may be illegal — stop and escalate.

CREATE TABLE REG_MEASURE (
    CommodityCode       VARCHAR(15)   NOT NULL,
    CountryCode         VARCHAR(2)    NOT NULL REFERENCES COUNTRY(CountryCode),
    MeasureType         VARCHAR(20)   NOT NULL,
    MeasureDescription  VARCHAR(300)  NOT NULL,
    LicenceRequired     BOOLEAN       NOT NULL DEFAULT FALSE,
    LicensingAuthority  VARCHAR(200),
    IsProhibited        BOOLEAN       NOT NULL DEFAULT FALSE,
    EffectiveFrom       DATE          NOT NULL,
    EffectiveTo         DATE,
    Notes               TEXT,
    PRIMARY KEY (CommodityCode, CountryCode, MeasureType, EffectiveFrom),
    FOREIGN KEY (CommodityCode, CountryCode) REFERENCES COMMODITY_CODE(CommodityCode, CountryCode)
);

CREATE TABLE IMPORT_CONDITION (
    CommodityCode       VARCHAR(15)   NOT NULL,
    CountryCode         VARCHAR(2)    NOT NULL REFERENCES COUNTRY(CountryCode),
    OriginCountryCode   VARCHAR(2)    REFERENCES COUNTRY(CountryCode),
    NTMCode             VARCHAR(10)   NOT NULL,
    NTMCategory         VARCHAR(15)   NOT NULL
        CHECK (NTMCategory IN ('SPS','TBT','INSPECTION','DOCUMENTARY','HANDLING','PACKAGING')),
    ConditionDescription VARCHAR(300) NOT NULL,
    TreatmentSpecification TEXT,
    CertifyingAuthority VARCHAR(200),
    IssuingLocation     VARCHAR(15)   CHECK (IssuingLocation IN ('ORIGIN','DESTINATION','EITHER')),
    TimingRequirement   VARCHAR(15)   NOT NULL
        CHECK (TimingRequirement IN ('PRE_SHIPMENT','AT_BORDER','POST_ARRIVAL')),
    ValidityDays        INTEGER,
    DocumentCode        VARCHAR(50),
    IsMandatory         BOOLEAN       NOT NULL DEFAULT TRUE,
    EffectiveFrom       DATE          NOT NULL,
    EffectiveTo         DATE,
    Notes               TEXT,
    PRIMARY KEY (CommodityCode, CountryCode, NTMCode, EffectiveFrom),
    FOREIGN KEY (CommodityCode, CountryCode) REFERENCES COMMODITY_CODE(CommodityCode, CountryCode)
);
COMMENT ON COLUMN IMPORT_CONDITION.NTMCode IS
    'A11=phytosanitary, A14=fumigation, B31=labelling, B32=ISPM15 packaging, C1=pre-shipment inspection';

CREATE TABLE EXPORT_MEASURE (
    CommodityCode       VARCHAR(15)   NOT NULL,
    ExportCountryCode   VARCHAR(2)    NOT NULL REFERENCES COUNTRY(CountryCode),
    SubheadingCode      CHAR(6),
    MeasureType         VARCHAR(30)   NOT NULL
        CHECK (MeasureType IN ('EXPORT_DUTY','EXPORT_LICENCE','EXPORT_QUOTA',
                               'EXPORT_RESTRICTION','EXPORT_PROHIBITION')),
    ExportDutyRate      DECIMAL(7,4),
    ExportDutyBasis     VARCHAR(5),
    LicenceRequired     BOOLEAN       NOT NULL DEFAULT FALSE,
    LicensingAuthority  VARCHAR(200),
    QuotaVolumeKG       DECIMAL(15,3),
    ExportVATRefundEligible BOOLEAN   NOT NULL DEFAULT TRUE,
    EffectiveFrom       DATE          NOT NULL,
    EffectiveTo         DATE,
    LegalBasis          VARCHAR(200),
    Notes               TEXT,
    PRIMARY KEY (CommodityCode, ExportCountryCode, MeasureType, EffectiveFrom)
);

CREATE TABLE SANCTIONS_MEASURE (
    SanctionID          BIGSERIAL     PRIMARY KEY,
    SanctionsType       VARCHAR(20)   NOT NULL
        CHECK (SanctionsType IN ('COUNTRY','SECTORAL','ENTITY','COMMODITY')),
    ImportCountryCode   VARCHAR(2)    REFERENCES COUNTRY(CountryCode),
    ExportCountryCode   VARCHAR(2)    REFERENCES COUNTRY(CountryCode),
    CommodityCode       VARCHAR(15),
    SubheadingCode      CHAR(6),
    AdministeringBody   VARCHAR(15)   NOT NULL
        CHECK (AdministeringBody IN ('OFAC','OTSI','EU_CFSP','UNSC')),
    SanctionsRegime     VARCHAR(200)  NOT NULL,
    Description         TEXT          NOT NULL,
    IsActive            BOOLEAN       NOT NULL DEFAULT TRUE,
    EffectiveFrom       DATE          NOT NULL,
    EffectiveTo         DATE,
    LegalBasis          VARCHAR(300)
);
COMMENT ON TABLE SANCTIONS_MEASURE IS
    'ALWAYS query FIRST before landed cost calculation. '
    'IsActive=TRUE means trade is potentially illegal regardless of duty rates.';
