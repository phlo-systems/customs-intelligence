-- Group 6: Sync & Audit
-- DEV NOTE: AuthCredentialRef stores Azure Key Vault SECRET NAME only — never the actual key.
-- Sync logic (HTTP, parsing, hashing, diff) is APPLICATION layer only — not in DB.
-- AutoApplyThresholdPct default 5.0: changes > this → PENDING_REVIEW.
-- NEW_CODE and DELETED_CODE always require manual review regardless of threshold.

CREATE TABLE TARIFF_SOURCE (
    SourceID            BIGSERIAL     PRIMARY KEY,
    CountryCode         VARCHAR(2)    REFERENCES COUNTRY(CountryCode),
    SourceName          VARCHAR(200)  NOT NULL,
    SourceURL           TEXT          NOT NULL,
    SourceType          VARCHAR(15)   NOT NULL
        CHECK (SourceType IN ('API','HTML_SCRAPE','XML_FEED','PDF','CSV','RSS')),
    DataFormat          VARCHAR(10)   NOT NULL
        CHECK (DataFormat IN ('JSON','XML','HTML','CSV','PDF','TXT')),
    PollFrequencyHours  INTEGER       NOT NULL DEFAULT 24,
    AuthMethod          VARCHAR(15)   NOT NULL DEFAULT 'NONE'
        CHECK (AuthMethod IN ('NONE','API_KEY','OAUTH','BASIC_AUTH')),
    AuthCredentialRef   VARCHAR(255),
    AutoApplyThresholdPct DECIMAL(5,2) NOT NULL DEFAULT 5.0,
    LastSnapshotHash    VARCHAR(64),
    LastPolledAt        TIMESTAMPTZ,
    IsActive            BOOLEAN       NOT NULL DEFAULT TRUE,
    Notes               TEXT
);

CREATE TABLE SOURCE_SYNC_JOB (
    JobID               VARCHAR(50)   PRIMARY KEY,
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
    SourceURL           TEXT,
    SourceSnapshotRef   TEXT,
    ReviewNotes         TEXT
);
