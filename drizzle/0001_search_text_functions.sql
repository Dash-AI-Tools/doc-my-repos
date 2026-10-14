-- Custom SQL migration: helper used by the generated documents.search_vector column.
-- pg_catalog.array_to_string(anyarray, text) is STABLE because some element types
-- (timestamps, floats) render differently under session settings, so Postgres rejects
-- it in a generated column. For text[] the elements are already text and the output
-- depends on nothing but the arguments, so declaring this text[]-only wrapper
-- IMMUTABLE is honest. Do not widen the signature to anyarray.
CREATE FUNCTION "public"."docmyrepos_immutable_array_to_string"(text[], text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$ SELECT pg_catalog.array_to_string($1, $2) $$;
