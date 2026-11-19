-- Feature 31 (the final review's override of plan 31 section 3.5): the categories that exist keep the names an import gave them, with
-- entities, emoji and direction marks, and the public menu shows them. The clean names come from `cleanGroupName`, which runs in the
-- application, so this migration only asks for the work once: the worker's relay turns this row into the `category_names_clean` job
-- (`CategoryNameCleanup`), which renames each category in its own transaction, skips a name another category already has, and writes the
-- search signal and the audit row a staff rename writes. The event type is `CATEGORY_NAMES_CLEAN_EVENT`; a test keeps the two equal.
INSERT INTO "outbox_events" ("type", "aggregate_type", "aggregate_id", "payload")
VALUES ('catalog.category_names_clean', 'service_categories', 1, '{"meta": {}}'::jsonb);
