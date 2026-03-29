-- Group 12: ERP Line Items — Universal invoice/order line storage
-- Stores individual line items from ANY ERP (Xero, Acumatica, Sage, etc.)
-- Used for: auto-classification, spending trends, concentration risk, FX exposure

CREATE TABLE ERP_LINE_ITEM (
    LineItemID          BIGSERIAL       PRIMARY KEY,
    TenantID            UUID            NOT NULL,
    ERPType             VARCHAR(20)     NOT NULL
        CHECK (ERPType IN ('XERO','ACUMATICA','SAGE','NAV','SAP','QUICKBOOKS','OTHER')),
    DocumentType        VARCHAR(10)     NOT NULL
        CHECK (DocumentType IN ('PURCHASE','SALE')),
    DocumentRef         VARCHAR(255)    NOT NULL,  -- Invoice/PO/SO number
    DocumentDate        DATE            NOT NULL,
    ContactName         VARCHAR(500),
    ContactCountry      CHAR(2),                   -- ISO country of supplier/customer
    LineDescription     TEXT,
    Quantity            DECIMAL(14,4),
    UnitPrice           DECIMAL(14,4),
    LineAmountLocal     DECIMAL(14,2)   NOT NULL,  -- Amount in original currency
    CurrencyCode        CHAR(3)         NOT NULL,
    LineAmountUSD       DECIMAL(14,2),             -- Converted to USD at sync time
    FXRateUsed          DECIMAL(14,6),             -- Rate used for conversion
    HSCodeAuto          VARCHAR(10),               -- Auto-classified HS code (from /classify)
    HSConfidence        DECIMAL(3,2),              -- Classification confidence 0.00-1.00
    HSChapter           CHAR(2),                   -- Derived from HSCodeAuto (first 2 digits)
    LineNumber          INTEGER         NOT NULL DEFAULT 1,
    SyncedAt            TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    UNIQUE (TenantID, ERPType, DocumentRef, LineNumber, DocumentDate)
);

-- Indexes for intelligence queries
CREATE INDEX idx_erp_line_tenant ON ERP_LINE_ITEM (TenantID, DocumentType);
CREATE INDEX idx_erp_line_date ON ERP_LINE_ITEM (TenantID, DocumentDate);
CREATE INDEX idx_erp_line_country ON ERP_LINE_ITEM (TenantID, ContactCountry);
CREATE INDEX idx_erp_line_hs ON ERP_LINE_ITEM (TenantID, HSChapter);
CREATE INDEX idx_erp_line_currency ON ERP_LINE_ITEM (TenantID, CurrencyCode);

COMMENT ON TABLE ERP_LINE_ITEM IS
    'Universal ERP line items from all connectors. Powers auto-classification, '
    'spending trend analysis, supplier concentration alerts, and FX exposure tracking.';
