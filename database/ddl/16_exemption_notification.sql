-- Customs duty exemption notifications.
-- Primary: India Notification 50/2017-Customs (master BCD exemption list).
-- Each entry maps a chapter/heading/tariff item to a concessional BCD rate.
-- The concessional rate OVERRIDES the standard MFN rate in tariff schedules.

CREATE TABLE IF NOT EXISTS exemption_notification (
    exemptionid         BIGSERIAL     PRIMARY KEY,
    countrycode         VARCHAR(2)    NOT NULL DEFAULT 'IN',
    notificationref     VARCHAR(100)  NOT NULL,  -- e.g. "50/2017-Customs"
    sno                 INTEGER,                  -- serial number within notification
    hscode              VARCHAR(20),              -- chapter/heading/tariff item
    hscodeto            VARCHAR(20),              -- for ranges (e.g. "0302 or 0303")
    description         TEXT,
    concessionalrate    DECIMAL(7,4),             -- the exempted rate (NULL = see rate_expression)
    rateexpression      VARCHAR(100),             -- for non-% rates like "Rs.60/kg or 45%"
    igstrate            DECIMAL(7,4),             -- concessional IGST if specified
    conditionno         INTEGER,                  -- condition number (references appendix)
    isactive            BOOLEAN       NOT NULL DEFAULT TRUE,
    effectivefrom       DATE          NOT NULL DEFAULT '2017-07-01',
    effectiveto         DATE,
    amendedby           VARCHAR(100),             -- later notification that amended this entry
    notes               TEXT,
    createdat           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exemption_hscode ON exemption_notification(hscode, countrycode);
CREATE INDEX IF NOT EXISTS idx_exemption_notif ON exemption_notification(notificationref);
