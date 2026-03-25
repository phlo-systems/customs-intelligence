-- ============================================================
-- CUSTOMS INTELLIGENCE — SUPABASE DDL
-- All 29 tables across 9 groups
-- Database: PostgreSQL (Supabase)
-- Version: v5.0  |  March 2026
-- Owner: Phlo Systems Limited
-- ============================================================
-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;      -- pgvector for HS embeddings

-- ============================================================
-- GROUP 1 — HS HIERARCHY  (static reference, load once)
-- ============================================================

CREATE TABLE COUNTRY (
    CountryCode         CHAR(2)       PRIMARY KEY,           -- ISO 3166-1 Alpha-2
    CountryCode3        CHAR(3)       NOT NULL,              -- ISO 3166-1 Alpha-3
    CountryName         VARCHAR(100)  NOT NULL,
    Region              VARCHAR(50)   NOT NULL,
    TariffScheduleAuthority VARCHAR(150),
    CurrencyCode        CHAR(3)       NOT NULL,              -- ISO 4217
    ValuationBasis      VARCHAR(5)    NOT NULL               -- CIF or FOB
        CHECK (ValuationBasis IN ('CIF','FOB')),
    IsActive            BOOLEAN       NOT NULL DEFAULT TRUE,
    CreatedAt           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
COMMENT ON COLUMN COUNTRY.ValuationBasis IS
    'CIF = duty on value at destination (UK, EU, GCC). FOB = duty on origin value (BR, AR, MX, UY). '
    'Critical: 14.4% on $10,800 CIF = $1,555 vs 14.4% on $10,000 FOB = $1,440.';

CREATE TABLE HS_SECTION (
    SectionCode         VARCHAR(5)    PRIMARY KEY,           -- Roman numeral e.g. IV
    SectionTitle        VARCHAR(200)  NOT NULL,
    ChapterRange        VARCHAR(10)   NOT NULL,              -- e.g. 16-24
    Notes               TEXT,
    CreatedAt           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE HS_HEADING (
    HeadingCode         CHAR(4)       NOT NULL,              -- 4-digit
    HSVersion           VARCHAR(10)   NOT NULL DEFAULT 'HS 2022',
    ChapterCode         CHAR(2)       NOT NULL,
    HeadingDescription  VARCHAR(500)  NOT NULL,
    SectionCode         VARCHAR(5)    NOT NULL REFERENCES HS_SECTION(SectionCode),
    ClassificationNotes TEXT,
    PRIMARY KEY (HeadingCode, HSVersion)
);
COMMENT ON TABLE HS_HEADING IS
    'INSERT new rows for HS 2028 with HSVersion=''HS 2028'' — never UPDATE existing rows. '
    'This preserves historical rate data tied to old codes.';

CREATE TABLE HS_SUBHEADING (
    SubheadingCode      CHAR(6)       NOT NULL,              -- 6-digit WCO
    HSVersion           VARCHAR(10)   NOT NULL DEFAULT 'HS 2022',
    HeadingCode         CHAR(4)       NOT NULL,
    SubheadingDescription VARCHAR(500) NOT NULL,
    StatisticalUnit     VARCHAR(20),                         -- kg, l, number etc.
    DutyBasis           VARCHAR(20),                         -- Ad Valorem / Specific
    ClassificationNotes TEXT,
    PRIMARY KEY (SubheadingCode, HSVersion),
    FOREIGN KEY (HeadingCode, HSVersion) REFERENCES HS_HEADING(HeadingCode, HSVersion)
);

-- ============================================================
-- GROUP 2 — COMMODITY & RATES
-- ============================================================

CREATE TABLE COMMODITY_CODE (
    CommodityCode       VARCHAR(15)   NOT NULL,              -- national 8-10 digit
    CountryCode         VARCHAR(2)    NOT NULL REFERENCES COUNTRY(CountryCode),
    SubheadingCode      CHAR(6)       NOT NULL,
    HSVersion           VARCHAR(10)   NOT NULL DEFAULT 'HS 2022',
    NationalDescription VARCHAR(500)  NOT NULL,
    SupplementaryUnit   VARCHAR(20),
    CodeLength          VARCHAR(12),                         -- e.g. 10-digit
    IsActive            BOOLEAN       NOT NULL DEFAULT TRUE,
    CreatedAt           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (CommodityCode, CountryCode),
    FOREIGN KEY (SubheadingCode, HSVersion)
        REFERENCES HS_SUBHEADING(SubheadingCode, HSVersion)
);
COMMENT ON TABLE COMMODITY_CODE IS
    'PK = (CommodityCode + CountryCode). NO surrogate key. '
    'All FKs from MFN_RATE, VAT_RATE, AD_MEASURE, REG_MEASURE etc. reference this natural PK directly.';

CREATE TABLE MFN_RATE (
    CommodityCode       VARCHAR(15)   NOT NULL,
    CountryCode         VARCHAR(2)    NOT NULL,
    RateCategory        VARCHAR(20)   NOT NULL
        CHECK (RateCategory IN ('APPLIED','BOUND','TRQ_IN_QUOTA','TRQ_OUT_QUOTA')),
    DutyBasisType       VARCHAR(15)   NOT NULL
        CHECK (DutyBasisType IN ('AD_VALOREM','SPECIFIC','COMPOUND','MIXED')),
    BoundRate           DECIMAL(7,4),                        -- WTO ceiling %
    AppliedMFNRate      DECIMAL(7,4),                        -- actual rate today %
    SpecificDutyAmt     DECIMAL(10,4),                       -- for SPECIFIC / COMPOUND
    SpecificDutyUOM     VARCHAR(20),                         -- e.g. GBP/KG
    DutyExpression      VARCHAR(200),                        -- e.g. '14.4% CIF'
    ValuationBasis      VARCHAR(5)
        CHECK (ValuationBasis IN ('CIF','FOB','TRANSACTION_VALUE')),
    TRQVolumeKG         DECIMAL(15,3),                       -- quota threshold (kg)
    SeasonalFrom        CHAR(5),                             -- MM-DD
    SeasonalTo          CHAR(5),                             -- MM-DD
    EffectiveFrom       DATE          NOT NULL,
    EffectiveTo         DATE,                                -- NULL = current
    CreatedAt           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (CommodityCode, CountryCode, RateCategory, EffectiveFrom),
    FOREIGN KEY (CommodityCode, CountryCode)
        REFERENCES COMMODITY_CODE(CommodityCode, CountryCode)
);
COMMENT ON COLUMN MFN_RATE.EffectiveTo IS
    'NULL = currently active rate. When rate changes: UPDATE old row SET EffectiveTo = new_date - 1, '
    'then INSERT new row with EffectiveTo = NULL.';
COMMENT ON COLUMN MFN_RATE.BoundRate IS
    'WTO Schedule of Concessions ceiling. AppliedMFNRate <= BoundRate always.';

CREATE TABLE TARIFF_RATE (
    CommodityCode       VARCHAR(15)   NOT NULL,
    CountryCode         VARCHAR(2)    NOT NULL,
    SubheadingCode      CHAR(6)       NOT NULL,
    AppliedMFNRate      DECIMAL(7,4),                        -- quick lookup — detail in MFN_RATE
    ValuationBasis      VARCHAR(5),
    DutyExpression      VARCHAR(200),
    EffectiveFrom       DATE          NOT NULL,
    EffectiveTo         DATE,                                -- NULL = current
    LastReviewedAt      DATE,
    DataSourceURL       TEXT,                                -- exact source URL
    PRIMARY KEY (CommodityCode, CountryCode, EffectiveFrom),
    FOREIGN KEY (CommodityCode, CountryCode)
        REFERENCES COMMODITY_CODE(CommodityCode, CountryCode)
);
COMMENT ON TABLE TARIFF_RATE IS
    'Summary rate table for fast landed cost lookup. '
    'DB TRIGGER on UPDATE writes old row to TARIFF_RATE_HIST — app never writes there directly.';

CREATE TABLE TARIFF_RATE_HIST (
    HistoryID           BIGSERIAL     PRIMARY KEY,
    CommodityCode       VARCHAR(15)   NOT NULL,
    CountryCode         VARCHAR(2)    NOT NULL,
    SubheadingCode      CHAR(6),
    RateType            VARCHAR(20)   NOT NULL,              -- IMPORT_DUTY / VAT / EXCISE
    OldRate             DECIMAL(7,4),
    NewRate             DECIMAL(7,4),
    ChangeType          VARCHAR(15)   NOT NULL
        CHECK (ChangeType IN ('INCREASE','DECREASE','NEW','REMOVED','NO_CHANGE')),
    EffectiveFrom       DATE          NOT NULL,
    EffectiveTo         DATE,
    LegalBasis          VARCHAR(200),
    ChangedBy           VARCHAR(100),                        -- 'auto' or username
    SyncJobID           VARCHAR(50),                         -- FK ref to SOURCE_SYNC_JOB
    CreatedAt           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE TARIFF_RATE_HIST IS
    'Written EXCLUSIVELY by DB TRIGGER on TARIFF_RATE AFTER UPDATE. '
    'Application code must NEVER write to this table directly.';

-- DB Trigger for TARIFF_RATE_HIST
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

-- ============================================================
-- GROUP 3 — PREFERENCES
-- ============================================================

CREATE TABLE TRADE_AGREEMENT (
    AgreementCode       VARCHAR(30)   PRIMARY KEY,
    AgreementName       VARCHAR(200)  NOT NULL,
    AgreementType       VARCHAR(10)   NOT NULL
        CHECK (AgreementType IN ('FTA','EPA','GSP','CU','PTA')),
    PartiesISO          TEXT          NOT NULL,              -- comma-separated ISO codes
    InForceFrom         DATE          NOT NULL,
    InForceTo           DATE,                                -- NULL = current
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
    PrefRate            DECIMAL(7,4)  NOT NULL,              -- preferential duty %
    StagingCategory     VARCHAR(30),                         -- Immediate / Partial / Staging TBD
    EffectiveFrom       DATE          NOT NULL,
    EffectiveTo         DATE,                                -- NULL = current
    Notes               TEXT,
    PRIMARY KEY (CommodityCode, ImportCountryCode, ExportCountryCode, AgreementCode, EffectiveFrom),
    FOREIGN KEY (CommodityCode, ImportCountryCode)
        REFERENCES COMMODITY_CODE(CommodityCode, CountryCode)
);

CREATE TABLE RULES_OF_ORIGIN (
    CommodityCode       VARCHAR(15)   NOT NULL,
    AgreementCode       VARCHAR(30)   NOT NULL REFERENCES TRADE_AGREEMENT(AgreementCode),
    ExportCountryCode   VARCHAR(2)    NOT NULL REFERENCES COUNTRY(CountryCode),
    OriginCriterion     VARCHAR(10)   NOT NULL
        CHECK (OriginCriterion IN ('WO','CTH','CTSH','RVC','SP')),
    RVCThresholdPct     DECIMAL(5,2),                        -- if RVC criterion
    AllowedTolerance    DECIMAL(5,2),                        -- % non-originating material
    CumulationRule      TEXT,
    DirectTransportRequired BOOLEAN   NOT NULL DEFAULT TRUE,
    ProofOfOriginDocCode VARCHAR(30),                        -- FK → ORIGIN_DOCUMENT
    Notes               TEXT,
    PRIMARY KEY (CommodityCode, AgreementCode, ExportCountryCode)
);
COMMENT ON COLUMN RULES_OF_ORIGIN.OriginCriterion IS
    'WO=Wholly Obtained, CTH=Change Tariff Heading (4-digit), '
    'CTSH=Change Subheading (6-digit), RVC=Regional Value Content %, SP=Sufficient Processing';

CREATE TABLE ORIGIN_DOCUMENT (
    DocumentCode        VARCHAR(30)   NOT NULL,
    AgreementCode       VARCHAR(30)   NOT NULL REFERENCES TRADE_AGREEMENT(AgreementCode),
    DocumentName        VARCHAR(100)  NOT NULL,              -- EUR.1, REX, Form A etc.
    IssuingAuthority    VARCHAR(200),
    ValidityDays        INTEGER,                             -- NULL = no expiry
    ValueThresholdLocal DECIMAL(12,2),                       -- simplified proof below this value
    ApprovedExporterRequired BOOLEAN  NOT NULL DEFAULT FALSE,
    TemplateURL         TEXT,
    Notes               TEXT,
    PRIMARY KEY (DocumentCode, AgreementCode)
);

-- ============================================================
-- GROUP 4 — REGULATORY
-- ============================================================

CREATE TABLE REG_MEASURE (
    CommodityCode       VARCHAR(15)   NOT NULL,
    CountryCode         VARCHAR(2)    NOT NULL REFERENCES COUNTRY(CountryCode),
    MeasureType         VARCHAR(20)   NOT NULL,              -- WCO code e.g. 715, HALAL, ANV
    MeasureDescription  VARCHAR(300)  NOT NULL,
    LicenceRequired     BOOLEAN       NOT NULL DEFAULT FALSE,
    LicensingAuthority  VARCHAR(200),
    IsProhibited        BOOLEAN       NOT NULL DEFAULT FALSE,
    EffectiveFrom       DATE          NOT NULL,
    EffectiveTo         DATE,
    Notes               TEXT,
    PRIMARY KEY (CommodityCode, CountryCode, MeasureType, EffectiveFrom),
    FOREIGN KEY (CommodityCode, CountryCode)
        REFERENCES COMMODITY_CODE(CommodityCode, CountryCode)
);
COMMENT ON COLUMN REG_MEASURE.IsProhibited IS
    'TRUE = import is banned entirely (e.g. alcohol into Saudi Arabia). Stop the trade.';

CREATE TABLE IMPORT_CONDITION (
    CommodityCode       VARCHAR(15)   NOT NULL,
    CountryCode         VARCHAR(2)    NOT NULL REFERENCES COUNTRY(CountryCode),
    OriginCountryCode   VARCHAR(2)    REFERENCES COUNTRY(CountryCode), -- NULL = all origins
    NTMCode             VARCHAR(10)   NOT NULL,              -- UNCTAD TRAINS e.g. A14, B31
    NTMCategory         VARCHAR(15)   NOT NULL
        CHECK (NTMCategory IN ('SPS','TBT','INSPECTION','DOCUMENTARY','HANDLING','PACKAGING')),
    ConditionDescription VARCHAR(300) NOT NULL,
    TreatmentSpecification TEXT,
    CertifyingAuthority VARCHAR(200),
    IssuingLocation     VARCHAR(15)
        CHECK (IssuingLocation IN ('ORIGIN','DESTINATION','EITHER')),
    TimingRequirement   VARCHAR(15)   NOT NULL
        CHECK (TimingRequirement IN ('PRE_SHIPMENT','AT_BORDER','POST_ARRIVAL')),
    ValidityDays        INTEGER,
    DocumentCode        VARCHAR(50),
    IsMandatory         BOOLEAN       NOT NULL DEFAULT TRUE,
    EffectiveFrom       DATE          NOT NULL,
    EffectiveTo         DATE,
    Notes               TEXT,
    PRIMARY KEY (CommodityCode, CountryCode, NTMCode, EffectiveFrom),
    FOREIGN KEY (CommodityCode, CountryCode)
        REFERENCES COMMODITY_CODE(CommodityCode, CountryCode)
);
COMMENT ON COLUMN IMPORT_CONDITION.NTMCode IS
    'UNCTAD TRAINS codes: A11=phytosanitary, A14=fumigation, '
    'B31=labelling (Arabic/Portuguese), B32=ISPM15 wood packaging, C1=pre-shipment inspection.';

CREATE TABLE EXPORT_MEASURE (
    CommodityCode       VARCHAR(15)   NOT NULL,
    ExportCountryCode   VARCHAR(2)    NOT NULL REFERENCES COUNTRY(CountryCode),
    SubheadingCode      CHAR(6),
    MeasureType         VARCHAR(30)   NOT NULL
        CHECK (MeasureType IN ('EXPORT_DUTY','EXPORT_LICENCE','EXPORT_QUOTA',
                               'EXPORT_RESTRICTION','EXPORT_PROHIBITION')),
    ExportDutyRate      DECIMAL(7,4),
    ExportDutyBasis     VARCHAR(5),                          -- FOB / CIF
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
    ImportCountryCode   VARCHAR(2)    REFERENCES COUNTRY(CountryCode), -- NULL = any
    ExportCountryCode   VARCHAR(2)    REFERENCES COUNTRY(CountryCode), -- NULL = any
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
    'ALWAYS query this table FIRST before any landed cost calculation. '
    'IsActive=TRUE means the trade is potentially illegal regardless of duty rates.';

-- ============================================================
-- GROUP 5 — INDIRECT TAX
-- ============================================================

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
    PostponedAccounting BOOLEAN       NOT NULL DEFAULT FALSE, -- UK PVA
    ReliefAvailable     BOOLEAN       NOT NULL DEFAULT FALSE,
    ReliefSchemeRef     VARCHAR(50),
    StateOrProvince     VARCHAR(50),                          -- Brazil ICMS varies by state
    EffectiveFrom       DATE          NOT NULL,
    EffectiveTo         DATE,                                 -- NULL = current
    LegalBasis          VARCHAR(200),
    Notes               TEXT,
    PRIMARY KEY (CommodityCode, CountryCode, TaxType, EffectiveFrom),
    FOREIGN KEY (CommodityCode, CountryCode)
        REFERENCES COMMODITY_CODE(CommodityCode, CountryCode)
);
COMMENT ON TABLE VAT_RATE IS
    'One row per TaxType. Brazil has 5 rows for HS 2004.10: II+IPI+PIS+COFINS+ICMS. '
    'Calculate sequentially using VATBasis — NOT as a flat sum. Total ~45.75%. '
    'UK frozen food: TaxCategory=ZERO (0% VAT). PostponedAccounting=TRUE for UK PVA.';

CREATE TABLE EXCISE (
    CommodityCode       VARCHAR(15)   NOT NULL,
    CountryCode         VARCHAR(2)    NOT NULL REFERENCES COUNTRY(CountryCode),
    SubheadingCode      CHAR(6),
    ExciseBasisType     VARCHAR(15)   NOT NULL
        CHECK (ExciseBasisType IN ('AD_VALOREM','SPECIFIC','COMPOUND','PROHIBITED')),
    ExciseRate          DECIMAL(7,4),                        -- if ad valorem %
    SpecificDutyAmt     DECIMAL(12,4),                       -- if specific
    SpecificDutyUOM     VARCHAR(20),                         -- e.g. GBP/L_ALC
    ExciseExpression    VARCHAR(200),
    SuspensionAvailable BOOLEAN       NOT NULL DEFAULT FALSE,
    DrawbackAvailable   BOOLEAN       NOT NULL DEFAULT FALSE,
    DomesticRateApplies BOOLEAN       NOT NULL DEFAULT TRUE,
    EffectiveFrom       DATE          NOT NULL,
    EffectiveTo         DATE,
    LegalBasis          VARCHAR(200),
    Notes               TEXT,
    PRIMARY KEY (CommodityCode, CountryCode, EffectiveFrom),
    FOREIGN KEY (CommodityCode, CountryCode)
        REFERENCES COMMODITY_CODE(CommodityCode, CountryCode)
);

CREATE TABLE AD_MEASURE (
    ADMeasureID         BIGSERIAL     PRIMARY KEY,
    CommodityCode       VARCHAR(15)   NOT NULL,
    ImportCountryCode   VARCHAR(2)    NOT NULL REFERENCES COUNTRY(CountryCode),
    ExportingCountryCode VARCHAR(2)   REFERENCES COUNTRY(CountryCode), -- NULL = safeguard
    ExporterName        VARCHAR(300),                         -- NULL = country residual
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
COMMENT ON TABLE AD_MEASURE IS
    'Stacks ON TOP of MFN duty — both apply simultaneously. '
    'ExporterName=NULL means country-wide residual rate. '
    'MeasureType=SAFEGUARD has ExportingCountryCode=NULL (applies to all origins). '
    'UnderTaking=TRUE: no AD duty if import price >= MinImportPrice.';

CREATE TABLE DUTY_RELIEF (
    ReliefID            BIGSERIAL     PRIMARY KEY,
    CommodityCode       VARCHAR(15),                         -- NULL = any commodity
    CountryCode         VARCHAR(2)    NOT NULL REFERENCES COUNTRY(CountryCode),
    ReliefType          VARCHAR(10)   NOT NULL
        CHECK (ReliefType IN ('IPR','CW','TA','EUR','OPR','RECOF','OTHER')),
    DutyImpact          VARCHAR(10)   NOT NULL
        CHECK (DutyImpact IN ('ZERO','SUSPEND','REDUCE')),
    EligibilityCriteria TEXT          NOT NULL,
    ApplicationProcedure TEXT,
    AuthorisationRequired BOOLEAN     NOT NULL DEFAULT TRUE,
    MaxDurationMonths   INTEGER,                             -- NULL = no limit
    GuaranteeRequired   BOOLEAN       NOT NULL DEFAULT FALSE,
    EffectiveFrom       DATE          NOT NULL,
    EffectiveTo         DATE,
    LegalBasis          VARCHAR(200),
    Notes               TEXT
);
COMMENT ON COLUMN DUTY_RELIEF.ReliefType IS
    'IPR=Inward Processing (process+re-export), CW=Customs Warehouse (defer), '
    'TA=Temporary Admission (ATA Carnet), EUR=End Use Relief, '
    'OPR=Outward Processing, RECOF=Brazilian export regime.';

-- ============================================================
-- GROUP 6 — SYNC & AUDIT
-- ============================================================

CREATE TABLE TARIFF_SOURCE (
    SourceID            BIGSERIAL     PRIMARY KEY,
    CountryCode         VARCHAR(2)    REFERENCES COUNTRY(CountryCode), -- NULL = global
    SourceName          VARCHAR(200)  NOT NULL,
    SourceURL           TEXT          NOT NULL,
    SourceType          VARCHAR(15)   NOT NULL
        CHECK (SourceType IN ('API','HTML_SCRAPE','XML_FEED','PDF','CSV','RSS')),
    DataFormat          VARCHAR(10)   NOT NULL
        CHECK (DataFormat IN ('JSON','XML','HTML','CSV','PDF','TXT')),
    PollFrequencyHours  INTEGER       NOT NULL DEFAULT 24,
    AuthMethod          VARCHAR(15)   NOT NULL DEFAULT 'NONE'
        CHECK (AuthMethod IN ('NONE','API_KEY','OAUTH','BASIC_AUTH')),
    AuthCredentialRef   VARCHAR(255),                        -- Azure Key Vault secret NAME only
    AutoApplyThresholdPct DECIMAL(5,2) NOT NULL DEFAULT 5.0, -- changes > this → PENDING_REVIEW
    LastSnapshotHash    VARCHAR(64),                         -- SHA-256 of last parsed response
    LastPolledAt        TIMESTAMPTZ,
    IsActive            BOOLEAN       NOT NULL DEFAULT TRUE,
    Notes               TEXT
);
COMMENT ON COLUMN TARIFF_SOURCE.AuthCredentialRef IS
    'Stores Azure Key Vault SECRET NAME only — never the actual API key or password. '
    'Sync worker retrieves secret at runtime via managed identity.';
COMMENT ON COLUMN TARIFF_SOURCE.AutoApplyThresholdPct IS
    'Changes <= this are AUTO_APPLIED. Changes > this → PENDING_REVIEW. '
    'NEW_CODE and DELETED_CODE always require manual review regardless of threshold.';

CREATE TABLE SOURCE_SYNC_JOB (
    JobID               VARCHAR(50)   PRIMARY KEY,           -- e.g. JOB_0042
    SourceID            BIGINT        NOT NULL REFERENCES TARIFF_SOURCE(SourceID),
    JobStartedAt        TIMESTAMPTZ   NOT NULL,
    JobCompletedAt      TIMESTAMPTZ,
    DurationSeconds     INTEGER,
    JobStatus           VARCHAR(15)   NOT NULL
        CHECK (JobStatus IN ('SUCCESS','PARTIAL','FAILED','TIMEOUT','NO_CHANGE')),
    HTTPStatusCode      INTEGER,
    RecordsChecked      INTEGER       NOT NULL DEFAULT 0,
    RecordsChanged      INTEGER       NOT NULL DEFAULT 0,
    RecordsErrored      INTEGER       NOT NULL DEFAULT 0,
    ErrorMessage        TEXT,
    TriggerType         VARCHAR(15)   NOT NULL DEFAULT 'SCHEDULED'
        CHECK (TriggerType IN ('SCHEDULED','MANUAL','EVENT')),
    TriggeredBy         VARCHAR(100)  NOT NULL DEFAULT 'scheduler',
    RetryCount          INTEGER       NOT NULL DEFAULT 0
);
COMMENT ON TABLE SOURCE_SYNC_JOB IS
    'Written by APPLICATION sync worker — one row per poll execution. '
    'JobStatus=NO_CHANGE means hash matched — no parsing done.';

CREATE TABLE SOURCE_SYNC_CHANGE (
    ChangeID            BIGSERIAL     PRIMARY KEY,
    JobID               VARCHAR(50)   NOT NULL REFERENCES SOURCE_SYNC_JOB(JobID),
    CommodityCode       VARCHAR(15),
    CountryCode         VARCHAR(2)    REFERENCES COUNTRY(CountryCode),
    SubheadingCode      CHAR(6),
    FieldChanged        VARCHAR(25)   NOT NULL
        CHECK (FieldChanged IN ('MFN_RATE','VAT_RATE','EXCISE_RATE','BOUND_RATE',
                               'SPECIFIC_DUTY','DUTY_EXPRESSION','REGULATORY_FLAG',
                               'PREF_RATE','NEW_CODE','DELETED_CODE','SANCTIONS_CHANGE')),
    OldValue            VARCHAR(100),
    NewValue            VARCHAR(100),
    ChangeType          VARCHAR(15)   NOT NULL
        CHECK (ChangeType IN ('INCREASE','DECREASE','NEW_CODE','DELETED_CODE','NO_CHANGE')),
    ChangeStatus        VARCHAR(20)   NOT NULL DEFAULT 'PENDING_REVIEW'
        CHECK (ChangeStatus IN ('PENDING_REVIEW','AUTO_APPLIED','MANUALLY_APPLIED',
                               'REJECTED','SUPERSEDED')),
    ChangeDetectedAt    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    AppliedAt           TIMESTAMPTZ,
    AppliedBy           VARCHAR(100),
    SourceURL           TEXT,                                -- exact commodity-level URL
    SourceSnapshotRef   TEXT,                                -- blob storage path of raw response
    ReviewNotes         TEXT
);

-- ============================================================
-- GROUP 7 — INTELLIGENCE ENGINE
-- ============================================================

CREATE TABLE OPPORTUNITIES (
    OpportunityID       BIGSERIAL     PRIMARY KEY,
    TenantID            UUID          NOT NULL,
    OpportunityType     VARCHAR(30)   NOT NULL
        CHECK (OpportunityType IN ('DUTY_REDUCTION','NEW_FTA','COMPETITOR_DISADVANTAGE',
                                   'NEW_MARKET','EXPIRING_PREFERENCE','QUOTA_OPENED',
                                   'COMPLIANCE_EASE')),
    SubheadingCode      CHAR(6),
    ImportCountryCode   VARCHAR(2)    REFERENCES COUNTRY(CountryCode),
    ExportCountryCode   VARCHAR(2)    REFERENCES COUNTRY(CountryCode),
    AgreementCode       VARCHAR(30)   REFERENCES TRADE_AGREEMENT(AgreementCode),
    SavingPct           DECIMAL(5,2),                        -- duty reduction in pp
    SavingAmtPer10K     DECIMAL(10,2),                       -- £ saving per £10K shipment
    Headline            TEXT          NOT NULL,              -- DB-generated headline
    AIInsight           TEXT,                                -- Claude-generated 2-3 sentence explanation
    AIInsightGeneratedAt TIMESTAMPTZ,
    SourceChangeID      BIGINT        REFERENCES SOURCE_SYNC_CHANGE(ChangeID),
    IsActioned          BOOLEAN       NOT NULL DEFAULT FALSE,
    IsDismissed         BOOLEAN       NOT NULL DEFAULT FALSE,
    ExpiresAt           TIMESTAMPTZ,                         -- NULL = no expiry
    DetectedAt          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE OPPORTUNITIES IS
    'Populated by DB rules engine after each sync. AIInsight populated by separate enrichment job. '
    'Dashboard reads from this table — no live LLM call on page load. '
    'AI cost ~£0.002 per row generated.';

CREATE TABLE ALERTS (
    AlertID             BIGSERIAL     PRIMARY KEY,
    TenantID            UUID          NOT NULL,
    AlertType           VARCHAR(30)   NOT NULL
        CHECK (AlertType IN ('DUTY_INCREASE','SANCTIONS_NEW','AD_INVESTIGATION',
                             'REGULATORY_CHANGE','EXPIRY_WARNING','SYNC_FAILURE')),
    Severity            VARCHAR(10)   NOT NULL
        CHECK (Severity IN ('CRITICAL','HIGH','MEDIUM','LOW')),
    SubheadingCode      CHAR(6),
    CountryCode         VARCHAR(2)    REFERENCES COUNTRY(CountryCode),
    Headline            TEXT          NOT NULL,
    Detail              TEXT,
    IsDismissed         BOOLEAN       NOT NULL DEFAULT FALSE,
    IsActioned          BOOLEAN       NOT NULL DEFAULT FALSE,
    SourceChangeID      BIGINT        REFERENCES SOURCE_SYNC_CHANGE(ChangeID),
    DetectedAt          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    ExpiresAt           TIMESTAMPTZ
);

CREATE TABLE TENANT_CONTEXT (
    TenantID                UUID          PRIMARY KEY,

    -- Layer 1: Explicit onboarding
    BusinessType            VARCHAR(30),
        -- TRADER / IMPORTER / EXPORTER / MANUFACTURER
    PrimaryHSChapters       TEXT[],                          -- e.g. {20, 74, 18}
    AnnualVolumeRange       VARCHAR(20),                     -- e.g. '2M-10M'
    TargetMarkets           TEXT[],                          -- countries exploring

    -- Layer 2: From product library
    ActiveOriginCountries   TEXT[],
    ActiveDestCountries     TEXT[],
    ProductCount            INTEGER       NOT NULL DEFAULT 0,
    AvgShipmentValueGBP     DECIMAL(12,2),

    -- Layer 3: Behavioural signals
    HighInterestCountries   TEXT[],                          -- frequent lookups
    DismissedCountries      TEXT[],                          -- dismissed cards
    PrimaryFocus            VARCHAR(25),
        -- COST_REDUCTION / COMPLIANCE / MARKET_EXPANSION
    LastActiveAt            TIMESTAMPTZ,

    -- Layer 4: ERP-derived
    ERPConnected            BOOLEAN       NOT NULL DEFAULT FALSE,
    ERPType                 VARCHAR(20),
    AvgPOValueGBP           DECIMAL(12,2),                   -- from actual PO data
    TopSupplierCountries    TEXT[],
    TopCustomerCountries    TEXT[],

    -- Layer 5: Email-derived
    EmailConnected          BOOLEAN       NOT NULL DEFAULT FALSE,
    EmailPlatform           VARCHAR(10),                     -- GMAIL / OUTLOOK
    EmailContextSince       DATE,                            -- how far back scanned
    KnownCompetitorOrigins  TEXT[],                          -- from email analysis
    KnownTradeBarriers      TEXT[],                          -- from email analysis
    EmailLastScannedAt      TIMESTAMPTZ,

    -- Conversation memory
    ConversationContext     JSONB,                           -- key facts from CI chat

    UpdatedAt               TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE TENANT_CONTEXT IS
    'Built progressively from 5 layers: '
    '(1) Onboarding form, (2) Product library upload, (3) Behavioural signals, '
    '(4) ERP integration, (5) Email connection. '
    'Used as context for Claude AI insight generation in OPPORTUNITIES.AIInsight.';

CREATE TABLE TENANT_BEHAVIOUR_LOG (
    LogID               BIGSERIAL     PRIMARY KEY,
    TenantID            UUID          NOT NULL,
    ActionType          VARCHAR(30)   NOT NULL
        CHECK (ActionType IN ('TARIFF_LOOKUP','CLASSIFY','COMPARE_COUNTRIES',
                              'OPPORTUNITY_VIEWED','OPPORTUNITY_ACTIONED',
                              'OPPORTUNITY_DISMISSED','ALERT_VIEWED','ALERT_DISMISSED',
                              'COUNTRY_SEARCH','PRODUCT_SEARCH')),
    SubheadingCode      CHAR(6),
    ImportCountryCode   VARCHAR(2),
    ExportCountryCode   VARCHAR(2),
    ReferenceID         BIGINT,                              -- OpportunityID or AlertID if relevant
    OccurredAt          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE TENANT_BEHAVIOUR_LOG IS
    'Every user interaction logged here. Nightly job aggregates into TENANT_CONTEXT. '
    'Frequent lookups → HighInterestCountries. Dismissed cards → DismissedCountries.';

-- ============================================================
-- GROUP 8 — CLASSIFICATION ENGINE
-- ============================================================

CREATE TABLE HS_DESCRIPTION_EMBEDDING (
    SubheadingCode      CHAR(6)       NOT NULL,
    HSVersion           VARCHAR(10)   NOT NULL DEFAULT 'HS 2022',
    CountryCode         VARCHAR(2)    REFERENCES COUNTRY(CountryCode), -- NULL = global WCO
    DescriptionText     TEXT          NOT NULL,
    Embedding           vector(1536)  NOT NULL,              -- pgvector — OpenAI ada-002 or equiv
    EmbeddingModel      VARCHAR(50)   NOT NULL,
    ComputedAt          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (SubheadingCode, HSVersion, CountryCode)
);
CREATE INDEX idx_hs_embedding_cosine ON HS_DESCRIPTION_EMBEDDING
    USING ivfflat (Embedding vector_cosine_ops)
    WITH (lists = 100);
COMMENT ON TABLE HS_DESCRIPTION_EMBEDDING IS
    'Pre-computed embeddings for Stage 1 vector similarity search in /v1/classify. '
    'IVFFlat index for fast cosine similarity. Recompute when EmbeddingModel changes.';

CREATE TABLE CLASSIFICATION_REQUEST (
    RequestID               BIGSERIAL     PRIMARY KEY,
    TenantID                UUID          NOT NULL,
    ERPSource               VARCHAR(20),
        -- XERO / ACUMATICA / GTM / API / CI_FRONTEND
    ProductDescription      TEXT          NOT NULL,
    NormalisedDescription   TEXT          NOT NULL,          -- lower-cased, punctuation stripped
    RequestedAt             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    ResponseTimeMs          INTEGER,
    ModelUsed               VARCHAR(50),
        -- 'embedding_v1' / 'claude-sonnet' / 'hybrid'
    TopSuggestionCode       VARCHAR(15),
    TopConfidence           DECIMAL(5,4),
    ClassificationType      VARCHAR(20),
        -- EXISTING_PRODUCT / AI_INFERRED / MANUAL_OVERRIDE
    UserSelectedCode        VARCHAR(15),                     -- NULL until trader confirms
    FeedbackCorrect         BOOLEAN                          -- NULL until confirmed
);
COMMENT ON TABLE CLASSIFICATION_REQUEST IS
    'Audit trail and feedback loop. UserSelectedCode vs TopSuggestionCode shows where AI is wrong. '
    'FeedbackCorrect populated when trader confirms or overrides.';

CREATE TABLE PRODUCT_CLASSIFICATION_CACHE (
    CacheID                 BIGSERIAL     PRIMARY KEY,
    TenantID                UUID          NOT NULL,
    ProductDescription      TEXT          NOT NULL,
    NormalisedDescription   TEXT          NOT NULL,
    SubheadingCode          CHAR(6)       NOT NULL,
    CommodityCode           VARCHAR(15),
    ConfirmedBy             VARCHAR(20)   NOT NULL
        CHECK (ConfirmedBy IN ('EXISTING_PRODUCT','TRADER_CONFIRMED','ADMIN_VERIFIED')),
    ConfirmedAt             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    UseCount                INTEGER       NOT NULL DEFAULT 1,
    LastUsedAt              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    UNIQUE (TenantID, NormalisedDescription)
);
COMMENT ON TABLE PRODUCT_CLASSIFICATION_CACHE IS
    'Per-tenant confirmed description → code mapping. '
    'Checked before running vector search — returns instantly with confidence=1.0. '
    'GTM product master enriches this on first use at no cost.';

-- ============================================================
-- GROUP 9 — ERP & EMAIL INTEGRATION
-- ============================================================

CREATE TABLE ERP_INTEGRATION (
    IntegrationID       BIGSERIAL     PRIMARY KEY,
    TenantID            UUID          NOT NULL,
    ERPType             VARCHAR(20)   NOT NULL
        CHECK (ERPType IN ('XERO','ACUMATICA','SAGE','NAV','SAP','QUICKBOOKS','OTHER')),
    ERPTenantID         VARCHAR(255)  NOT NULL,              -- ERP's own org/tenant identifier
    AuthTokenRef        VARCHAR(255)  NOT NULL,              -- Azure Key Vault secret NAME only
    WebhookURL          TEXT,                                -- ERP endpoint for CI push-back
    MappingConfig       JSONB,                               -- field mapping rules
    SyncEnabled         BOOLEAN       NOT NULL DEFAULT TRUE,
    LastSyncAt          TIMESTAMPTZ,
    IsActive            BOOLEAN       NOT NULL DEFAULT TRUE,
    CreatedAt           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    UNIQUE (TenantID, ERPType, ERPTenantID)
);
COMMENT ON COLUMN ERP_INTEGRATION.AuthTokenRef IS
    'Azure Key Vault secret NAME only — never store OAuth token, refresh token, or API key here. '
    'Connector retrieves secret at runtime via managed identity.';

CREATE TABLE EMAIL_CONTEXT_EXTRACT (
    ExtractID               BIGSERIAL     PRIMARY KEY,
    TenantID                UUID          NOT NULL,
    EmailPlatform           VARCHAR(10)   NOT NULL
        CHECK (EmailPlatform IN ('GMAIL','OUTLOOK')),
    EmailMessageID          VARCHAR(500)  NOT NULL,          -- platform message ID only
    EmailDate               DATE          NOT NULL,
    EmailType               VARCHAR(20)   NOT NULL
        CHECK (EmailType IN ('SUPPLIER_QUOTE','CUSTOMER_RFQ','SHIPPING_CONF',
                             'CUSTOMS_ENTRY','TRADE_INQUIRY','REGULATORY',
                             'TRADE_FINANCE','FREIGHT','OTHER')),
    SubheadingCodes         TEXT[],                          -- HS codes mentioned
    OriginCountries         TEXT[],
    DestinationCountries    TEXT[],
    Commodities             TEXT[],                          -- product names mentioned
    CounterpartyName        VARCHAR(255),
    CounterpartyCountry     CHAR(2),
    VolumeMT                DECIMAL(12,3),
    Incoterm                VARCHAR(10),
    CompetitorOrigins       TEXT[],                          -- competing supplier origins
    MarketInterest          TEXT[],                          -- markets being explored
    ComplianceConcerns      TEXT[],
    TradeBarriers           TEXT[],
    ExtractedAt             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    ReviewedByUser          BOOLEAN       NOT NULL DEFAULT FALSE,
    -- PRIVACY: No email body, subject, sender address, or recipient stored here
    UNIQUE (TenantID, EmailMessageID)
);
COMMENT ON TABLE EMAIL_CONTEXT_EXTRACT IS
    'Structured extract from trade-related emails. Raw email content NEVER stored. '
    'Processing flow: email → keyword filter → Claude extracts JSON in memory → only this '
    'structured record persisted. User reviews extracts before they update TENANT_CONTEXT. '
    'GDPR basis: legitimate interest for service personalisation. '
    'OAuth scope: gmail.readonly / Mail.Read — read-only, no send or modify access.';

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX idx_commodity_subheading ON COMMODITY_CODE(SubheadingCode, CountryCode);
CREATE INDEX idx_mfn_rate_lookup ON MFN_RATE(CommodityCode, CountryCode, RateCategory)
    WHERE EffectiveTo IS NULL;
CREATE INDEX idx_tariff_rate_current ON TARIFF_RATE(CommodityCode, CountryCode)
    WHERE EffectiveTo IS NULL;
CREATE INDEX idx_tariff_hist_recent ON TARIFF_RATE_HIST(CommodityCode, CountryCode, EffectiveFrom);
CREATE INDEX idx_vat_rate_lookup ON VAT_RATE(CommodityCode, CountryCode)
    WHERE EffectiveTo IS NULL;
CREATE INDEX idx_ad_measure_active ON AD_MEASURE(ImportCountryCode, CommodityCode)
    WHERE ADStatus NOT IN ('EXPIRED');
CREATE INDEX idx_sanctions_active ON SANCTIONS_MEASURE(IsActive, ImportCountryCode, ExportCountryCode)
    WHERE IsActive = TRUE;
CREATE INDEX idx_pref_rate_lookup ON PREFERENTIAL_RATE(ImportCountryCode, ExportCountryCode, SubheadingCode)
    WHERE EffectiveTo IS NULL;
CREATE INDEX idx_opportunities_tenant ON OPPORTUNITIES(TenantID, IsDismissed, IsActioned);
CREATE INDEX idx_alerts_tenant ON ALERTS(TenantID, IsDismissed, Severity);
CREATE INDEX idx_behaviour_tenant ON TENANT_BEHAVIOUR_LOG(TenantID, OccurredAt);
CREATE INDEX idx_classification_cache ON PRODUCT_CLASSIFICATION_CACHE(TenantID, NormalisedDescription);
CREATE INDEX idx_email_extract_tenant ON EMAIL_CONTEXT_EXTRACT(TenantID, ReviewedByUser);
CREATE INDEX idx_sync_job_status ON SOURCE_SYNC_JOB(JobStatus, JobStartedAt);
CREATE INDEX idx_sync_change_pending ON SOURCE_SYNC_CHANGE(ChangeStatus)
    WHERE ChangeStatus = 'PENDING_REVIEW';

-- ============================================================
-- ROW LEVEL SECURITY (Supabase multi-tenant)
-- ============================================================

ALTER TABLE OPPORTUNITIES ENABLE ROW LEVEL SECURITY;
ALTER TABLE ALERTS ENABLE ROW LEVEL SECURITY;
ALTER TABLE TENANT_CONTEXT ENABLE ROW LEVEL SECURITY;
ALTER TABLE TENANT_BEHAVIOUR_LOG ENABLE ROW LEVEL SECURITY;
ALTER TABLE CLASSIFICATION_REQUEST ENABLE ROW LEVEL SECURITY;
ALTER TABLE PRODUCT_CLASSIFICATION_CACHE ENABLE ROW LEVEL SECURITY;
ALTER TABLE ERP_INTEGRATION ENABLE ROW LEVEL SECURITY;
ALTER TABLE EMAIL_CONTEXT_EXTRACT ENABLE ROW LEVEL SECURITY;

-- Tenants can only see their own rows
CREATE POLICY tenant_isolation_opportunities ON OPPORTUNITIES
    USING (TenantID = auth.uid()::UUID);
CREATE POLICY tenant_isolation_alerts ON ALERTS
    USING (TenantID = auth.uid()::UUID);
CREATE POLICY tenant_isolation_context ON TENANT_CONTEXT
    USING (TenantID = auth.uid()::UUID);
CREATE POLICY tenant_isolation_behaviour ON TENANT_BEHAVIOUR_LOG
    USING (TenantID = auth.uid()::UUID);
CREATE POLICY tenant_isolation_classification ON CLASSIFICATION_REQUEST
    USING (TenantID = auth.uid()::UUID);
CREATE POLICY tenant_isolation_cache ON PRODUCT_CLASSIFICATION_CACHE
    USING (TenantID = auth.uid()::UUID);
CREATE POLICY tenant_isolation_erp ON ERP_INTEGRATION
    USING (TenantID = auth.uid()::UUID);
CREATE POLICY tenant_isolation_email ON EMAIL_CONTEXT_EXTRACT
    USING (TenantID = auth.uid()::UUID);

-- ============================================================
-- TABLE SUMMARY
-- ============================================================
-- Group 1 — HS Hierarchy:        COUNTRY, HS_SECTION, HS_HEADING, HS_SUBHEADING
-- Group 2 — Commodity & Rates:   COMMODITY_CODE, MFN_RATE, TARIFF_RATE, TARIFF_RATE_HIST
-- Group 3 — Preferences:         TRADE_AGREEMENT, PREFERENTIAL_RATE, RULES_OF_ORIGIN, ORIGIN_DOCUMENT
-- Group 4 — Regulatory:          REG_MEASURE, IMPORT_CONDITION, EXPORT_MEASURE, SANCTIONS_MEASURE
-- Group 5 — Indirect Tax:        VAT_RATE, EXCISE, AD_MEASURE, DUTY_RELIEF
-- Group 6 — Sync & Audit:        TARIFF_SOURCE, SOURCE_SYNC_JOB, SOURCE_SYNC_CHANGE
-- Group 7 — Intelligence:        OPPORTUNITIES, ALERTS, TENANT_CONTEXT, TENANT_BEHAVIOUR_LOG
-- Group 8 — Classification:      HS_DESCRIPTION_EMBEDDING, CLASSIFICATION_REQUEST,
--                                 PRODUCT_CLASSIFICATION_CACHE
-- Group 9 — ERP & Email:         ERP_INTEGRATION, EMAIL_CONTEXT_EXTRACT
-- Total: 29 tables
-- ============================================================
