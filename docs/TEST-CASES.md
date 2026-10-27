# SaaS test cases

Designed from the implementation and primary-source research checked on 27 October 2026. Tests below distinguish executed automated coverage from acceptance work requiring configured providers or an operator.

## Run locally

```powershell
npm install
npx playwright install chromium
npm run check
npm test
npm run test:e2e
npm audit
```

API tests use a new in-memory database and local HTTP server for each case. Browser tests use an isolated in-memory application at port 3001. The browser runner never uses the user's `data/techzolo.sqlite`. No real cards, WhatsApp messages or external emails are used. Email and Stripe responses are test doubles in API tests.

## Automated API cases

Source: `tests/api.test.mjs`. Each row corresponds to an executable test, rather than a checklist assertion presented as a separate test.

| ID | Priority | Preconditions and actions | Expected result |
| --- | --- | --- | --- |
| AUTH-01 | P0 | Register a company with valid owner details and accepted terms | Empty company state, owner membership and 14-day Growth trial |
| AUTH-02 | P0 | Inspect account/session persistence after registration | Salted hash differs from password; raw session token not stored; HttpOnly/SameSite cookie |
| AUTH-03 | P0 | Submit short password, then unchecked terms | 400; no partial company or owner account |
| AUTH-04 | P1 | Reuse a registered email or company slug | 409; original account remains intact |
| SEC-01 | P0 | Request private APIs without session; request server/.env/database/test paths | 401 for private APIs; 404 for non-allowlisted files; CSP present |
| TEN-01 | P0 | Register A and B; save contact in A; request A using B's query parameters and switch request | B sees only its own data; unauthorized switch denied; audit scoped to B |
| SEC-02 | P0 | Submit writes with forged CSRF, foreign Origin, non-JSON content and cross-site fetch metadata | 403 or 415; state unchanged |
| AUTH-05 | P0 | Sign in with wrong/correct password; log out and replay old cookie | Invalid password denied; correct login succeeds; old session rejected |
| AUTH-06 | P0 | Expire session in fixture and request account | 401 |
| AUTH-07 | P1 | Repeat incorrect password attempts | 429 after allowed attempts |
| CRM-01 | P0 | Save contact; submit an older version of same workspace | Contact persists; stale write returns 409 without overwrite |
| CRM-02 | P0 | Submit duplicate numbers, an orphan opportunity and malformed state | 400 without partial writes |
| CONSENT-01 | P0 | Attempt browser-assigned permission, Approved template and sent/read counters | 400; browser cannot invent provider-backed state |
| SEC-03 | P0 | Insert quote/event-handler characters into notification route | 400; unsafe attribute content rejected |
| BILL-01 | P0 | Expire company trial; read workspace and attempt edits/branding change | Reads/billing available; writes 402 |
| BILL-02 | P1 | Starter workspace submits 1,001 contacts | 402; quota enforced on server |
| BRAND-01 | P0 | Register with valid WebP logo; fetch public branding from separate company | Normalized PNG up to 512 px; company colors correct; public payload excludes private state |
| BRAND-02 | P0 | Upload SVG, fake PNG, over-2-MB file and invalid color | 400/413; no unsafe logo stored |
| BRAND-03 | P1 | Upload and remove logo | Empty logo reference, public logo returns 404, initials fallback available |
| RBAC-01 | P0 | Accept viewer invitation; try writes, branding, invites, audit and checkout | Read-only CRM access; restricted operations 403 |
| RBAC-02 | P0 | Agent edits contact/note, then company settings | CRM changes succeed; configuration change 403 |
| RBAC-03 | P0 | Admin changes brand, invites agent/admin and opens billing | Branding/agent invite succeed; admin escalation and billing 403 |
| TEAM-01 | P0 | Wrong recipient accepts invite; correct recipient accepts; replay and expire invitations | Email binding, single use and expiry enforced |
| TEAM-02 | P1 | Fill Starter seats with pending invitations; invite another person; revoke invite and replay it | 402 at seat cap; revocation invalidates token |
| TEAM-03 | P0 | Try removing owner; remove normal member and replay their session | Owner protected; removed member loses current workspace access |
| TEN-02 | P0 | Create second workspace and switch back | Correct company identity and separate state restored |
| CONSENT-02 | P0 | Submit public signup twice | One pending request with wording/time; no verified subscriber/contact created |
| CONSENT-03 | P0 | Omit agreement; disable company signup and submit again | 400 or 403; no permission asserted |
| AUTH-08 | P0 | Request recovery, reset password and replay token/old session | New password works; token single-use; previous sessions revoked |
| AUTH-09 | P0 | Verify email twice; request recovery for known/unknown addresses | Verification one-time; generic account-existence response |
| BILL-03 | P0 | Create Stripe checkout without webhook | Checkout URL returned; paid access not granted |
| BILL-04 | P0 | Deliver webhook with forged signature | 400; trial/plan unchanged |
| BILL-05 | P0 | Deliver signed, duplicate and delayed subscription events | Deduplicated event; current provider state used; cancellation stops writes |
| BILL-06 | P0 | Provider reports unknown recurring price ID | Fail closed to incomplete access; no arbitrary plan granted |
| TEN-03 | P0 | Switch company in another tab/session context; submit prior company state with stale workspace header | 409 before reading/writing the new tenant |
| RBAC-04 | P0 | Owner demotes agent to viewer while agent remains signed in | Next mutation 403 without requiring logout |
| SEC-04 | P0 | Expire recovery token and submit prototype-reserved contact ID | Both rejected |
| CONFIG-01 | P1 | Start without SMTP/Stripe; attempt recovery and checkout | Clear 503 configuration status; trial remains unchanged |
| PLATFORM-01 | P0 | Configure one exact platform-admin email and one normal workspace owner; request the platform API as both | Allowlisted account sees operator metrics; tenant owner receives 403; signed-out request receives 401 |
| PLATFORM-02 | P0 | Search tenant list and open workspace details | Owner/plan/usage/WhatsApp metadata is visible; CRM state, messages and tokens are excluded |
| PLATFORM-03 | P0 | Suspend then restore a trial workspace | Reads remain available; edits, signup and outbound sends are blocked while suspended; billing status and data are preserved |
| PLATFORM-04 | P1 | Extend an unpaid trial by 1 and 90 days; attempt 0/91 days and paid account | Valid additions bounded to 1–90 days; paid workspaces rejected; actions appear in global audit |
| PLATFORM-05 | P0 | Disable an account while signed in; attempt old-cookie request/login; restore it | Existing sessions revoked; sign-in fails while disabled; restored account can sign in; operator cannot disable its own allowlisted account |

## Automated browser cases

Source: `tests/browser/saas.spec.mjs`. All run in Chromium at desktop or 390 px phone width.

| ID | Priority | User flow | Expected result |
| --- | --- | --- | --- |
| UI-01 | P0 | Open product page; resize to phone; open private contacts URL without sign-in | Landing and trial CTA visible; no horizontal overflow; sign-in gate |
| UI-02 | P0 | Register, add contact, reload, upload logo, change color, reload, use public signup, inspect billing | Saved record/brand survive reload; correct company logo on public page; pending signup visible; unconfigured billing explicit |
| UI-03 | P0 | Create another company, switch back, sign out and open protected route | Correct company context restored; signed-out data inaccessible |
| UI-04 | P1 | Visit every CRM and admin route at phone width | Each view renders a heading, no document overflow or runtime exceptions |
| UI-05 | P1 | Create template, campaign draft and automation; save business details | Real persisted configuration; no delivery counters invented |
| UI-06 | P0 | Invite viewer through UI, accept as intended account, try editing, remove member | Correct workspace branding and role; viewer denied; access revoked after removal |
| UI-07 | P1 | Sign in with a server-allowlisted operator, open console, search a workspace and inspect its details | Operator navigation and support metadata render; member workspaces remain isolated; panel fits small screens without page overflow |

The browser suite writes screenshots into `test-results/`, including desktop/mobile landing, company branding, billing and mobile dashboard. Traces are retained on failure. Screenshot inspection supplements assertions; it is not a substitute for accessibility or provider acceptance testing.

## Manual/provider acceptance cases — not claimed as executed

Use a non-production environment with synthetic data. Document the operator, environment, date, evidence and outcome for each case before launch.

| ID | Priority | Preconditions and steps | Expected result / launch criterion |
| --- | --- | --- | --- |
| LIVE-01 | P0 | Configure Stripe test keys/price IDs; complete checkout with provider test card and deliver signed event | One subscription; exact intended plan/status; access enabled only by webhook |
| LIVE-02 | P0 | Fail a recurring payment, cancel at period end and then finish cancellation | Provider status/portal accurate; write access follows final policy; records remain readable |
| LIVE-03 | P0 | Upgrade/downgrade between mapped prices using portal | Current provider plan applied; existing records readable; additions obey downgraded limits |
| LIVE-04 | P0 | Stop app webhook receiver, make billing change, restore receiver and retry/reconcile | Event recovered without duplicate entitlement effects; documented reconciliation procedure |
| LIVE-05 | P0 | Configure real SMTP test inbox; register/resend verification and use password recovery | Email delivered, correct public URL, links expire and cannot be reused |
| LIVE-06 | P1 | SMTP fails during registration or invitation | Workspace not lost; resend/copy path available; no credential leakage |
| BRAND-04 | P1 | Upload wide/tall/transparent and EXIF-rotated company marks | Aspect ratio and orientation preserved; metadata removed; accessible image labels |
| BRAND-05 | P1 | Company logo fails to load because of a network/server error | Operator can retry or remove it; initials render when logo is removed |
| A11Y-01 | P1 | Use keyboard only through signup, workspace picker, dialogs and mobile menu | Visible focus, reachable labels/actions, Escape closes dialogs, usable focus order |
| A11Y-02 | P1 | Screen-reader pass; browser zoom 200%; reduced motion; 320 px phone | Semantics usable; no lost controls; no forced animation; contrast meets chosen accessibility target |
| OPS-01 | P0 | Restart Node after saving CRM/branding on durable DATABASE_PATH | Company, logo, members and records persist; valid sessions remain as intended |
| OPS-02 | P0 | Create backup, restore to clean staging host and verify two companies | Restore procedure proven; membership, branding, consent requests and billing identifiers intact |
| OPS-03 | P0 | Deploy behind HTTPS with NODE_ENV=production and correct APP_URL | Secure/HttpOnly/SameSite cookie; HSTS; no mixed content; origin checks succeed |
| OPS-04 | P1 | Exercise expected concurrent users and representative record volume | Latency/memory/concurrency limits measured; no 16 MB document surprises; scaling decision documented |
| SEC-05 | P0 | Penetration test tenant IDs, roles, invite tokens, uploads and public metadata | No cross-company reads/writes, privilege escalation, token leakage or unsafe file execution |
| LEGAL-01 | P0 | Publish actual operator contact, legal terms, privacy/retention process | No development-policy notice remains before public commercial launch |
| LIVE-WA-01 | P0 | Connect a Meta test WABA/number; send customer replies and approved templates; deliver inbound/status webhooks | Real provider acceptance and receipt/inbound routing match synthetic tests; no messages sent to non-test recipients |
| FUTURE-02 | P1 | Implement AI provider/visual flow execution | Responses and execution tested against connected source data; configuration alone is not counted as execution |

## Primary-source rationale

- [OWASP Multi-Tenant Security](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html): TEN, RBAC, resource isolation and audit scope.
- [OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html): AUTH and session/recovery attacks.
- [OWASP File Upload](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html): BRAND content/format/size/pixel checks.
- [Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks): BILL lifecycle, signatures, delayed events and provider acceptance.
- [WhatsApp Business Messaging Policy](https://whatsappbusiness.com/policy/): CONSENT and future opt-out/template/delivery tests.
