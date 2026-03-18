# Renuir Product Strategy
CEO Plan Review — 2026-03-18

> Source of truth for product direction post-takeover. Complements PRD.md and _index.md.
> Full review: `~/.gstack/projects/renuir/ceo-plans/2026-03-18-renuir-full-product.md`

---

## Current State (as of 2026-03-15)

| Area | Status |
|------|--------|
| Security vulnerabilities | 10 critical, all active in production |
| Missing backend endpoints | 15 (cause core screens to 404) |
| Test coverage | 0 tests in either repo |
| Backend | 1088-line monolith (server.js) |
| Shipping provider | Decided: **Shippo** |

---

## Revised Epic Sequence

```
Sprint 0  → EP-1: Security Hardening (10 backend fixes)
Sprint 1  → EP-2: Missing Endpoints (15 routes) + CI setup + tests-alongside
Sprint 2  → EP-2 continued
Sprint 3  → EP-2 continued + EP-7: AI Matching Engine (match trigger, scoring, push)
Sprint 4  → EP-2 wrap + EP-7 wrap
Sprint 5  → EP-6: B2B Org Management (mobile features + web admin portal)
           + EP-8: Trust & Safety (report/flag/suspend + moderation queue)
Sprint 6  → EP-3: Backend Refactor (modularize server.js)
           + EP-4: Auth Upgrade (short-lived JWT + refresh tokens)
           + EP-5: Test Suite cleanup (frontend tests, CI polish)
```

---

## Key Decisions Locked

| Decision | Detail |
|----------|--------|
| **Shipping: Shippo** | All shipping label generation via Shippo API. ShipEngine/EasyPost references removed. |
| **Tests alongside EP-2** | Every new endpoint ships with Jest + supertest integration tests. Definition of done. |
| **EP-7 AI Matching is P0** | Without it, Matches tab is empty at launch. Polling cron (5 min), no extra infra. |
| **B2B web admin portal** | EP-6 includes React/Next.js admin dashboard for org admins. Staff use mobile for logging. |
| **EP-8 Trust & Safety** | Report/flag/suspend flows + moderation queue. Required before B2B public launch. |
| **GitHub Actions CI** | Added as first sub-issue of EP-2. npm test on every PR to Renuir-backend. |
| **EP-7 job queue** | Polling cron (5 min interval). Upgradeable to BullMQ+Redis if volume demands. |

---

## New Epics Added by CEO Review

### EP-7: AI Matching Engine (Sprint 3-4)
- Async match trigger on item upload (polling cron, 5 min interval)
- Scoring: Google Vision tags + pHash visual similarity → confidence %
- Push notification on match found (FCM)
- Category + location index for O(N×M) scan cap
- Unit tests: scoring algorithm, edge cases (corrupt image, quota exceeded)

### EP-8: Trust & Safety (Sprint 5)
- POST /api/reports — report/flag any item or user
- Admin moderation queue (web portal)
- Suspend/hide item actions
- Rate limiting on report endpoint (prevent spam flooding)
- HIDDEN item state added to lifecycle

---

## Critical Gaps (must address in specs)

1. **SMTP failure on OTP send** — no fallback, silent failure (EP-1/EP-2 spec)
2. **Stripe webhook deduplication** — unknown if duplicate events are handled (EP-2 spec)
3. **Vision API errors on upload** — item saved but never matched (EP-7 spec)
4. **Finder ghosting after claim approval** — no reminder/timeout/re-open (TODOS.md P2)

---

## Architecture Changes

### B2B Web Portal (EP-6, new)
React/Next.js admin dashboard:
- Staff management (invite, roles, remove)
- Claim inbox and review
- Analytics (items logged, resolution rate, avg time)
- Subscription and billing management
- Deploy: Cloud Run (new service) or Vercel/Netlify

### Socket.io Horizontal Scale (before Sprint 5)
Add `socket.io-redis` adapter before B2B public launch. Without it, Socket.io breaks on
multiple Cloud Run instances. This is a P1 TODOS item.

---

## TODOS (from CEO review)

| Priority | Item |
|----------|------|
| P1 | Redis adapter for Socket.io before B2B public launch (Sprint 5 prereq) |
| P1 | B2B web portal design review via /plan-design-review before EP-6 impl |
| P2 | Finder ghosting: auto-reminder at 7 days + claim re-open at 14 days |
| P2 | Dispute resolution: owner can flag rejected claim → support queue |
| P3 | TypeScript migration for backend (post-EP-3, if feasible) |
| P3 | Push notification analytics (delivery rate, tap rate by type) |

---

## Design Gaps (for EP-6 web portal)

No designs exist for the B2B web admin portal. Run `/plan-design-review` before EP-6
implementation begins. DESIGN.md covers the mobile app design system only.

Empty states not specced (mobile app):
- Home feed empty state
- Matches tab empty state
- Messages empty state
- Shipping error state

---

## 12-Month Ideal State

```
B2C: live with AI matching, premium MRR growing
B2B: 10+ org contracts (hotels, airports, venues)
Web portal: admins self-serve analytics + billing
CI/CD: mature, all endpoints tested
Dispute resolution: live
Matching accuracy: tuned with real data
```
