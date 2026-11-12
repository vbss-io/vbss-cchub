---
type: project
company: acme
category: product
status: active
workspace: acme-wk
created: 2026-01-05
updated: 2026-11-10
tags: [project, acme]
---

# Acme Platform

**What it is (1 line):** fictitious platform used as the golden vault fixture.
**Why it matters:** locks the vault format so refactors cannot change how files are rewritten.
**Current state:** live in staging, billing migration in progress.

## Open loops

- [ ] Renew vendor contract #p1 📅 2026-11-30
  - waiting on the legal review from Alex
  - see [[globex|Globex Rollout]] for the shared checklist and `inline code` in a note
- [-] Migrate billing service #p0 🛫 2026-11-02 📅 2026-11-20
  - [x] Export legacy invoices
  - [-] Map the new tax codes
    - note under a subtask
    - [ ] Validate rounding rules
  - [ ] Cut over the webhook
- [ ] Plain task without priority
- [ ] Task with a link to https://example.com/acme/docs and a trailing tag #p3
- [ ] Weekly report #p2 🔁 every week 🛫 2026-11-09 📅 2026-11-13
- [ ] Review dashboards 🔁 every weekday 📅 2026-11-13
- [ ] Follow up on the audit ⏳ 2026-11-14 📅 2026-11-16

### Blocked and parked

- [ ] BLOCK - Publish the status page - waiting for the DNS change #p1
- [ ] BLOCKED - Rotate signing keys - security window not scheduled
- [ ] BLOCK: Fix the SSO redirect - vendor patch pending
- [ ] HOLD - Payment retries - waiting on the Initech sandbox account #p2
- [-] HOLD - Hire a designer - budget freeze until Q1 #p3
- [ ] ARCHIVED - Old onboarding flow - replaced by the new wizard
- [x] ARCHIVED - Legacy export job - dropped
- [ ] BACKLOG - Banner copy review

## Done loops

- [x] Security: audit and dependency bumps ✅ 2026-11-09
  - 20 packages fixed, lockfile reviewed
  - [x] Bump express
  - [x] Bump vite
- [x] Docs: refresh the onboarding guide #p2 ✅ 2026-11-03
- [x] Weekly report #p2 🔁 every week 🛫 2026-11-02 📅 2026-11-06 ✅ 2026-11-06
- [x] Infra: move the cache to the new region ✅ 2026-10-27
  - [x] Warm the cache
  - results in the sync doc

## Decisões

- 11/10 - staging stays on the shared cluster until the billing cutover, because the sandbox quota is tight
- 10/28 - the status page is hosted outside the platform so it survives an outage
- 10/15 - example of a fenced block that must never be parsed as tasks:

```md
- [ ] not a task, inside a fence
- [x] neither is this one
```

## Links

- repo: <https://example.com/acme/platform>
- notes: [[fontes/sessions/2026-11-12]]
- [[globex|Globex Rollout]]
