-- match_hs_codes.sql — Vector similarity search for HS classification
-- Uses pgvector cosine distance on HS_DESCRIPTION_EMBEDDING.
--
-- Called by the /classify Edge Function as Stage 1 (before Claude LLM).
-- Returns top N matches with cosine similarity score.
--
-- Usage:
--   SELECT * FROM match_hs_codes(
--     query_embedding := '[0.1, 0.2, ...]'::vector(1536),
--     match_count     := 10,
--     min_similarity  := 0.5
--   );

CREATE OR REPLACE FUNCTION match_hs_codes(
    query_embedding  vector(1536),
    match_count      INT DEFAULT 10,
    min_similarity   FLOAT DEFAULT 0.5
)
RETURNS TABLE (
    subheading_code  CHAR(6),
    country_code     VARCHAR(2),
    description_text TEXT,
    hs_version       VARCHAR(10),
    similarity       FLOAT
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT
        e.subheadingcode,
        e.countrycode,
        e.descriptiontext,
        e.hsversion,
        1 - (e.embedding <=> query_embedding) AS similarity
    FROM hs_description_embedding e
    WHERE 1 - (e.embedding <=> query_embedding) >= min_similarity
    ORDER BY e.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;
