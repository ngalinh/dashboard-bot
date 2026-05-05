# Project notes for Claude

## Workflow: auto-merge & deploy after a fix

After a fix is committed and pushed (and CI is green / no review blockers), proceed without asking:

1. If the PR is draft, mark it ready (`update_pull_request` with `draft: false`).
2. Squash-merge into `main` (`merge_pull_request` with `merge_method: "squash"`).
3. Deploy is automatic — the `Deploy to server` workflow in `.github/workflows/deploy.yml` runs on every push to `main` (SSH + `docker compose up --build -d`). No manual action needed.
4. Report the merge commit SHA and link to the deploy workflow run.

Skip the merge and ask first if any of the following are true:
- CI is failing or pending on a required check.
- There are unresolved review comments / change requests.
- The PR touches infra/secrets/migrations, or is not a small bug fix.
- The user specifically asked to hold off.

Force-push to `main` is never allowed. If `main` is ahead, rebase the branch and re-push, don't force-push the base.
