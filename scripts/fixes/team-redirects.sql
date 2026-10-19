-- Old WordPress team links (/team/<slug>) go to the team's own page now (/teams/<slug>, docs/public-site.md
-- "Team pages") instead of its last season. For databases imported before team pages (staging, 2026-10-20); a fresh
-- import writes them this way. Only imported redirects whose team has a page; safe to run again.
-- npx wrangler d1 execute DB --env staging --remote --file scripts/fixes/team-redirects.sql
UPDATE redirects
SET to_path = '/teams/' || substr(from_path, 7), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source = 'wp-import'
  AND from_path LIKE '/team/%'
  AND EXISTS (
    SELECT 1 FROM teams t
    JOIN season_teams st ON st.team_id = t.id
    JOIN seasons s ON s.id = st.season_id
    WHERE t.slug = substr(redirects.from_path, 7) AND s.status IN ('published', 'archived')
  );
