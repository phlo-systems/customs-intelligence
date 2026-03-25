-- Group 1: HS Hierarchy — static reference, load once, update every 6 years for HS revision
-- DEV NOTE: For HS 2028, INSERT new rows with HSVersion='HS 2028' — never UPDATE existing rows

CREATE TABLE COUNTRY (
    CountryCode         CHAR(2)       PRIMARY KEY,
    CountryCode3        CHAR(3)       NOT NULL,
    CountryName         VARCHAR(100)  NOT NULL,
    Region              VARCHAR(50)   NOT NULL,
    TariffScheduleAuthority VARCHAR(150),
    CurrencyCode        CHAR(3)       NOT NULL,
    ValuationBasis      VARCHAR(5)    NOT NULL CHECK (ValuationBasis IN ('CIF','FOB')),
    IsActive            BOOLEAN       NOT NULL DEFAULT TRUE,
    CreatedAt           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
COMMENT ON COLUMN COUNTRY.ValuationBasis IS
    'CIF = duty on value at destination (UK, EU, GCC). FOB = duty on origin value (BR, AR, MX, UY). '
    'At 14.4% on $10,800 CIF vs $10,000 FOB: $1,555 vs $1,440 — an 8% difference.';

CREATE TABLE HS_SECTION (
    SectionCode         VARCHAR(5)    PRIMARY KEY,
    SectionTitle        VARCHAR(200)  NOT NULL,
    ChapterRange        VARCHAR(10)   NOT NULL,
    Notes               TEXT,
    CreatedAt           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE HS_HEADING (
    HeadingCode         CHAR(4)       NOT NULL,
    HSVersion           VARCHAR(10)   NOT NULL DEFAULT 'HS 2022',
    ChapterCode         CHAR(2)       NOT NULL,
    HeadingDescription  VARCHAR(500)  NOT NULL,
    SectionCode         VARCHAR(5)    NOT NULL REFERENCES HS_SECTION(SectionCode),
    ClassificationNotes TEXT,
    PRIMARY KEY (HeadingCode, HSVersion)
);

CREATE TABLE HS_SUBHEADING (
    SubheadingCode      CHAR(6)       NOT NULL,
    HSVersion           VARCHAR(10)   NOT NULL DEFAULT 'HS 2022',
    HeadingCode         CHAR(4)       NOT NULL,
    SubheadingDescription VARCHAR(500) NOT NULL,
    StatisticalUnit     VARCHAR(20),
    DutyBasis           VARCHAR(20),
    ClassificationNotes TEXT,
    PRIMARY KEY (SubheadingCode, HSVersion),
    FOREIGN KEY (HeadingCode, HSVersion) REFERENCES HS_HEADING(HeadingCode, HSVersion)
);
