# Roomly design documents

| Document | What it covers |
|---|---|
| [HLD.md](HLD.md) | **High-level design**: requirements, context, architecture, technology choices, domain model, multi-tenancy, user journeys, the booking-correctness decision, real-time, async boundaries, security, deployment, scaling, CI/CD, trade-offs |
| [LLD.md](LLD.md) | **Low-level design**: every table and constraint, RLS and roles, request pipeline, booking algorithms and concurrency, auth token flows, plan limits, socket protocol, Stripe webhook logic, outbox worker, frontend structure, full API reference, error catalogue, configuration, testing |

## Diagrams

All diagrams are PNG images in [`images/`](images), generated from text sources in [`diagrams/`](diagrams). Keeping them as text means they stay reviewable in git diffs and are easy to update.

| Folder | Count |
|---|---|
| [`images/hld`](images/hld) | 14 diagrams |
| [`images/lld`](images/lld) | 36 diagrams |

To regenerate after editing a `.mmd` file (uses the Microsoft Edge that ships with Windows; no extra browser download):

```bash
npm run design:render            # all diagrams
npm run design:render -- lld/05  # only matching files
```

On macOS/Linux, point `diagrams/puppeteer.json` at a local Chrome or Chromium.
