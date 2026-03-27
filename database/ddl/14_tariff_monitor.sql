-- Tariff monitoring and data freshness tracking.
-- Tracks government notifications, chapter update timestamps, and sync status.

-- Tracks every government notification we've seen (CBIC, DGFT, DGTR, GST Council)
CREATE TABLE IF NOT EXISTS notification_tracker (
    notificationid      BIGSERIAL     PRIMARY KEY,
    source              VARCHAR(20)   NOT NULL
        CHECK (source IN ('CBIC_TARIFF','CBIC_NT','CBIC_CIRCULAR','DGFT','DGTR','GST_COUNCIL','EGAZETTE')),
    notificationref     VARCHAR(100)  NOT NULL,  -- e.g. "50/2025-Customs" or "9/2025-IGST(Rate)"
    title               TEXT,
    publishdate         DATE,
    detectedat          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    status              VARCHAR(15)   NOT NULL DEFAULT 'NEW'
        CHECK (status IN ('NEW','REVIEWED','APPLIED','IGNORED','PENDING_APPROVAL')),
    priority            VARCHAR(10)   NOT NULL DEFAULT 'MEDIUM'
        CHECK (priority IN ('CRITICAL','HIGH','MEDIUM','LOW')),
    countrycode         VARCHAR(2)    NOT NULL DEFAULT 'IN',
    affectedtables      TEXT[],       -- e.g. {'mfn_rate','vat_rate'}
    affectedcodes       TEXT[],       -- HS codes affected (if known)
    aiextract           JSONB,        -- Claude's parsed interpretation of the notification
    sourceurl           TEXT,
    pdfstored           BOOLEAN       NOT NULL DEFAULT FALSE,
    reviewedby          TEXT,
    reviewedat          TIMESTAMPTZ,
    appliednotes        TEXT,
    createdat           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    UNIQUE (source, notificationref)
);

-- Tracks the update timestamp of each CBIC tariff chapter (for change detection)
CREATE TABLE IF NOT EXISTS cbic_chapter_sync (
    chapternum          INTEGER       NOT NULL,
    countrycode         VARCHAR(2)    NOT NULL DEFAULT 'IN',
    cbiccontentid       INTEGER,          -- CBIC internal content ID
    filepath            TEXT,             -- e.g. CONTENTREPO/Customs/Tariff/.../chap-1.pdf
    cbicupdateddt       TIMESTAMPTZ,      -- updatedDt from CBIC API
    lastsyncdt          TIMESTAMPTZ,      -- when we last downloaded & parsed
    commoditycount      INTEGER,          -- rows written from this chapter
    synchash            VARCHAR(64),      -- SHA-256 of the downloaded PDF (detect content changes)
    syncstatus          VARCHAR(15)   NOT NULL DEFAULT 'CURRENT'
        CHECK (syncstatus IN ('CURRENT','STALE','SYNCING','ERROR')),
    errormessage        TEXT,
    createdat           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (chapternum, countrycode)
);

-- High-level data freshness per country per data type
CREATE TABLE IF NOT EXISTS data_freshness (
    countrycode         VARCHAR(2)    NOT NULL,
    datatype            VARCHAR(30)   NOT NULL
        CHECK (datatype IN ('BCD_RATES','IGST_RATES','DRAWBACK','ANTI_DUMPING','SAFEGUARD',
                            'PREFERENTIAL','EXCHANGE_RATE','IMPORT_POLICY','EXPORT_POLICY',
                            'SANCTIONS','CHAPTER_PDFS','REFERENCE_DOCS')),
    lastsyncat          TIMESTAMPTZ,
    rowcount            INTEGER,
    sourcename          VARCHAR(100),  -- e.g. "CBIC Tariff Act Chapters 1-97"
    sourceversion       VARCHAR(50),   -- e.g. "as on 30.06.2025"
    nextexpectedupdate  TEXT,          -- e.g. "Budget Day Feb 2027" or "Fortnightly"
    staleafterhours     INTEGER       NOT NULL DEFAULT 720,  -- 30 days default
    notes               TEXT,
    PRIMARY KEY (countrycode, datatype)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_notification_tracker_status ON notification_tracker(status);
CREATE INDEX IF NOT EXISTS idx_notification_tracker_source ON notification_tracker(source, countrycode);
CREATE INDEX IF NOT EXISTS idx_notification_tracker_date ON notification_tracker(detectedat DESC);
CREATE INDEX IF NOT EXISTS idx_cbic_chapter_sync_status ON cbic_chapter_sync(syncstatus);
