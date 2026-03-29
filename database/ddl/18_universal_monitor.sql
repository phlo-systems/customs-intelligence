-- ═══════════════════════════════════════════════════════════════
-- 18_universal_monitor.sql — Universal monitoring framework tables
-- Tracks 9-point checklist execution + cross-verification audit
-- ═══════════════════════════════════════════════════════════════

-- ── monitor_checklist_run ───────────────────────────────────────
-- Tracks every check execution for audit and dashboard.
-- One row per check per country per run.

CREATE TABLE IF NOT EXISTS monitor_checklist_run (
    runid               BIGSERIAL     PRIMARY KEY,
    countrycode         VARCHAR(2)    NOT NULL,
    checkname           VARCHAR(40)   NOT NULL
        CHECK (checkname IN (
            'official_tariff_schedule',
            'gazette_notifications',
            'budget_announcements',
            'wto_notifications',
            'trade_agreement_updates',
            'trade_remedies',
            'indirect_tax_changes',
            'cross_verification',
            'exchange_rate'
        )),
    status              VARCHAR(10)   NOT NULL
        CHECK (status IN ('OK', 'CHANGED', 'ERROR', 'SKIPPED')),
    findingscount       INTEGER       NOT NULL DEFAULT 0,
    errormessage        TEXT,
    sourceurl           TEXT,
    metadata            JSONB,
    durationms          INTEGER,
    executedat          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_checklist_run_country
    ON monitor_checklist_run(countrycode, executedat DESC);

CREATE INDEX IF NOT EXISTS idx_checklist_run_status
    ON monitor_checklist_run(status)
    WHERE status IN ('CHANGED', 'ERROR');

COMMENT ON TABLE monitor_checklist_run IS
    'Audit trail for the 9-point universal tariff monitoring checklist. '
    'One row per check per country per daily run.';


-- ── cross_verification_log ──────────────────────────────────────
-- Rate verification audit trail. Written when cross_verify_rates()
-- finds a mismatch between our stored rate and the external source.

CREATE TABLE IF NOT EXISTS cross_verification_log (
    verificationid      BIGSERIAL     PRIMARY KEY,
    countrycode         VARCHAR(2)    NOT NULL,
    commoditycode       VARCHAR(15)   NOT NULL,
    ourrate             DECIMAL(7,4),
    externalrate        DECIMAL(7,4),
    externalsource      VARCHAR(50)   NOT NULL,
    ismatch             BOOLEAN       NOT NULL,
    mismatchpct         DECIMAL(7,4),
    resolvedstatus      VARCHAR(15)   DEFAULT 'PENDING'
        CHECK (resolvedstatus IN (
            'PENDING', 'CONFIRMED_CORRECT', 'UPDATED', 'FALSE_POSITIVE'
        )),
    resolvednotes       TEXT,
    verifiedat          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crossverify_mismatch
    ON cross_verification_log(ismatch, countrycode)
    WHERE ismatch = FALSE;

COMMENT ON TABLE cross_verification_log IS
    'Audit trail for weekly rate cross-verification. '
    'Samples N random codes per country and compares against authoritative external source.';


-- ── Expand notification_tracker.source allowed values ───────────
-- Drop and recreate the CHECK constraint to allow new sources.
-- (Safe: CHECK constraints don't affect existing data.)

ALTER TABLE notification_tracker
    DROP CONSTRAINT IF EXISTS notification_tracker_source_check;

ALTER TABLE notification_tracker
    ADD CONSTRAINT notification_tracker_source_check
    CHECK (source IN (
        -- Existing
        'CBIC_TARIFF', 'CBIC_NT', 'CBIC_CIRCULAR', 'DGFT', 'DGTR',
        'GST_COUNCIL', 'EGAZETTE',
        -- WTO universal
        'WTO_TARIFF', 'WTO_RTA', 'WTO_AD', 'WTO_CVD', 'WTO_SAFEGUARD',
        -- Country-specific
        'UK_HMRC', 'SARS', 'ITAC', 'SISCOMEX', 'CAMEX', 'ABF', 'ADC_AU',
        'EU_OJ', 'TARIC',
        -- Framework
        'BUDGET', 'GAZETTE', 'CROSS_VERIFY'
    ));
