-- Exchange rates for customs valuation.
-- India: CBIC notifies rates fortnightly via Customs (NT) notification.
-- Other countries: market rates updated daily from open API.

CREATE TABLE IF NOT EXISTS exchange_rate (
    currencycode        CHAR(3)       NOT NULL,
    countrycode         VARCHAR(2)    NOT NULL,  -- country this rate applies for customs
    rateperinr          DECIMAL(15,6),           -- 1 INR = X foreign currency (for IN)
    inrperunit          DECIMAL(15,6),           -- 1 foreign currency = X INR (for IN)
    rateperzar          DECIMAL(15,6),           -- 1 ZAR = X foreign currency (for ZA)
    zarperunit          DECIMAL(15,6),           -- 1 foreign currency = X ZAR (for ZA)
    ratepergbp          DECIMAL(15,6),           -- 1 GBP = X foreign currency (for GB)
    gbpperunit          DECIMAL(15,6),           -- 1 foreign currency = X GBP (for GB)
    ratetype            VARCHAR(15)   NOT NULL DEFAULT 'MARKET'
        CHECK (ratetype IN ('CBIC_NOTIFIED','RBI_REFERENCE','MARKET','MANUAL')),
    notificationref     VARCHAR(100),
    effectivefrom       DATE          NOT NULL,
    effectiveto         DATE,
    source              VARCHAR(50),
    updatedat           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (currencycode, countrycode, effectivefrom)
);

CREATE INDEX IF NOT EXISTS idx_exchange_rate_current
    ON exchange_rate(countrycode, effectiveto) WHERE effectiveto IS NULL;
