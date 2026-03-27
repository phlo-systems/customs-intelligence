-- Drawback rates per commodity code per country.
-- India source: Notification 77/2023-Customs (N.T.) — Drawback Schedule 2023-24
-- Drawback = refund of customs/excise duties paid on imported inputs used in export goods.
-- Rate is % of FOB value; Cap is maximum amount per unit in local currency.

CREATE TABLE IF NOT EXISTS DRAWBACK_RATE (
    CommodityCode       VARCHAR(15)   NOT NULL,
    CountryCode         VARCHAR(2)    NOT NULL REFERENCES COUNTRY(CountryCode),
    Description         TEXT,
    Unit                VARCHAR(20),
    DrawbackRatePct     DECIMAL(7,4),
    DrawbackCapAmt      DECIMAL(12,2),
    DrawbackCapCurrency CHAR(3)       NOT NULL DEFAULT 'INR',
    NotificationRef     VARCHAR(100),
    EffectiveFrom       DATE          NOT NULL,
    EffectiveTo         DATE,
    Notes               TEXT,
    CreatedAt           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (CommodityCode, CountryCode, EffectiveFrom)
);

CREATE INDEX IF NOT EXISTS idx_drawback_rate_country
    ON DRAWBACK_RATE(CountryCode);
CREATE INDEX IF NOT EXISTS idx_drawback_rate_code
    ON DRAWBACK_RATE(CommodityCode);
