-- Run this first before any other DDL
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;  -- pgvector for HS embeddings (Supabase: enable in dashboard)
