-- ATH-58: per-repo auto-start on webhook `opened`.
-- Auto-start generates a review only — it never posts to GitHub (ATH-57).
-- Diff fetch uses the GITHUB_TOKEN env PAT (Railway / .env), not stored OAuth.
alter table agamotto.configured_repos
add column if not exists auto_start boolean not null default false;

comment on column agamotto.configured_repos.auto_start is 'When true, an opened webhook starts the first review pass using GITHUB_TOKEN. Completes to READY; does not post to GitHub.';
