CREATE INDEX IF NOT EXISTS "Position_search_idx"
ON "Position"
USING GIN (
  to_tsvector(
    'simple',
    coalesce("title", '') || ' ' ||
    coalesce("shortDescription", '')
  )
);

CREATE INDEX IF NOT EXISTS "Attribute_search_idx"
ON "Attribute"
USING GIN (
  to_tsvector(
    'simple',
    coalesce("name", '') || ' ' ||
    coalesce("description", '')
  )
);

CREATE INDEX IF NOT EXISTS "AttributeOption_search_idx"
ON "AttributeOption"
USING GIN (
  to_tsvector(
    'simple',
    coalesce("value", '')
  )
);

CREATE INDEX IF NOT EXISTS "Project_search_idx"
ON "Project"
USING GIN (
  to_tsvector(
    'simple',
    coalesce("name", '') || ' ' ||
    coalesce("description", '')
  )
);

CREATE INDEX IF NOT EXISTS "User_search_idx"
ON "User"
USING GIN (
  to_tsvector(
    'simple',
    coalesce("name", '') || ' ' ||
    coalesce("email", '')
  )
);

CREATE INDEX IF NOT EXISTS "ProfileAttributeValue_search_idx"
ON "ProfileAttributeValue"
USING GIN (
  to_tsvector(
    'simple',
    coalesce("stringValue", '') || ' ' ||
    coalesce("textValue", '') || ' ' ||
    coalesce("imageUrl", '')
  )
);
