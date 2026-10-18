// SQL for seasons imported before the importer wrote seasons.generated_from (scripts/fix-imported-seasons.ts).
//
// generated_from is the shapeKey() of the settings a draw was made from; the Fixtures tab says "Settings changed"
// when it doesn't match the season's settings (isStale in src/lib/fixtures/competition.ts). Imported seasons had none,
// so every one of them looked out of date. This writes drawShapeKey() in SQL, from the same rows the adapter reads:
// team ids in season_teams.sort then name order, the number of sessions, meetings, finals and duty.
// scripts/wp/shape.test.ts holds it to the TypeScript key.

/** Only imported seasons (wp_id) that have no key yet, so it never touches a season made or regenerated here. */
export const IMPORTED_WITHOUT_SHAPE = `"seasons"."wp_id" IS NOT NULL AND "seasons"."generated_from" IS NULL`

export const importedShapeSql = () =>
  `UPDATE "seasons" SET "generated_from" = json_array(
  json((SELECT json_group_array("team_id") FROM (SELECT "st"."team_id" FROM "season_teams" "st" JOIN "teams" "t" ON "t"."id" = "st"."team_id" WHERE "st"."season_id" = "seasons"."id" ORDER BY "st"."sort", "t"."name"))),
  coalesce(json_array_length("seasons"."settings", '$.sessions'), 0),
  coalesce(json_extract("seasons"."settings", '$.meetings'), 1),
  json(CASE WHEN coalesce(json_extract("seasons"."settings", '$.includeFinals'), 0) THEN 'true' ELSE 'false' END),
  json(CASE WHEN "seasons"."duty_enabled" THEN 'true' ELSE 'false' END)
) WHERE ${IMPORTED_WITHOUT_SHAPE};`.replace(/\n\s*/g, ' ')
