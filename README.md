# Techzolo Workspaces — SaaS CRM

A working, locally runnable SaaS foundation built from the original standalone WhatsApp CRM. Companies register their own account, receive isolated workspaces and use their own logo and brand color. The existing CRM is now backed by authenticated server APIs and SQLite.

## Start

Requires **Node.js 24.15 or newer**.

```powershell
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). Choose **Start free trial**, enter company/owner details, optionally upload a logo, and create the workspace. No card or external provider account is required for the 14-day local Growth trial. Keep the server running while using the application.

Optional configuration:

```powershell
Copy-Item .env.example .env
```

Edit `.env` and restart the server. Default data is persisted in `data/techzolo.sqlite`; it is not exposed by the web server. Tests use separate in-memory databases. The project contains no default login or hardcoded customer password.

**Double-clicking an HTML file opens the legacy browser-only preview. Use the Node server for the SaaS product.** Root files are canonical; the nested copy's HTML entrypoints reference the root assets.

## What is available

- Responsive product/pricing pages, company registration, sign-in/out, protected routes, trial onboarding and multiple company workspaces.
- Company-specific logos on registration, in navigation, in the browser tab and on public subscriber pages. Owners/admins can replace or remove the logo under **Brand identity**. Missing logos use company initials. Supported formats: PNG, JPEG, WebP; maximum 2 MB and 16 megapixels; server normalizes output to PNG.
- Server-enforced tenant isolation, team roles, expiring email-bound invitation links, role changes, member removal and audit history.
- Contacts, CSV import/export, internal notes, conversation drafts, opportunities, pipeline changes, template/campaign drafts and automation/assistant configuration.
- Live workspace counts, JSON export, plan usage, reserved seat accounting, quotas and read-only access after a trial/subscription expires.
- Optional SMTP verification/recovery/invitation emails, Stripe hosted checkout/portal and signature-verified subscription webhooks.
- Per-company Instagram professional-account OAuth, webhook inbox and 24-hour customer-initiated replies; requires Meta Instagram permissions/App Review and public HTTPS callbacks.
- Permission-based bulk email campaigns with double opt-in, server-side queue pacing, campaign status, signed unsubscribe links and SMTP transport.
- Separate platform operator console with workspace/account search, service health, audited suspension/trial/account access tools. Access is granted only by a server-side `PLATFORM_ADMIN_EMAILS` allowlist; workspace admin roles never grant platform access. See [platform admin setup](docs/PLATFORM-ADMIN.md).
- Company-specific public signup pages: `subscribe.html?workspace=YOUR_COMPANY_SLUG`. Submissions are **pending requests**, not verified marketing permission.

## Integration status

| Capability | Status |
| --- | --- |
| Accounts, companies, branding, CRM persistence, roles and audit | Working locally |
| Email verification/password recovery | Adapter implemented; configure `SMTP_URL` and `MAIL_FROM` |
| Paid subscription checkout/customer portal | Adapter implemented; configure Stripe keys, recurring price IDs and webhook |
| Company WhatsApp connection, live text/body-template sending, signed inbound/receipts, consent confirmation and STOP | Implemented; configure Meta credentials, Embedded Signup and public HTTPS webhook; Meta approval required for third-party companies |
| Instagram company inbox and replies | Implemented; configure Instagram Login scopes, callback/webhook URLs, public HTTPS, Meta review and operator-side credentials; customer starts the conversation and replies are limited to Meta's messaging window |
| Bulk email campaigns | Implemented; configure SMTP, verified sender and unsubscribe-signing secret; recipients must double-confirm email permission; 250 recipients/campaign at one message per second |
| Live AI, executable visual flows and background automation | Not integrated; configuration/drafts only |
| Production hosting, MFA/SSO, backups, retention/deletion and monitoring | Deployment/next-phase work |

Unconfigured providers show their actual status. No browser action can mark a draft as Meta-approved, invent delivered-message counts or claim verified consent. Company owners explicitly connect Meta before live messaging; company signup alone does not connect or send. See [WhatsApp setup and activation](docs/WHATSAPP.md) and [Instagram and email setup](docs/INSTAGRAM-EMAIL.md).

## Test and inspect

```powershell
npx playwright install chromium
npm run check
npm test
npm run test:e2e
npm audit
```

- API tests cover auth, tenant isolation, roles, uploads, concurrent edits, trials, quotas, invitations, recovery, billing and the WhatsApp integration.
- Browser tests cover signup/branding/CRM/team flows, company switching, mobile layouts, live inbox actions and company-specific WhatsApp isolation using synthetic provider responses.
- Screenshots and failure traces are written into `test-results/`.
- Stripe/email test doubles verify local integration logic; they do not count as real-provider acceptance tests.

## Documentation

- [SaaS requirements, feature scope and primary-source research](docs/SAAS-REQUIREMENTS.md)
- [Test cases, priorities, steps, expected results and provider acceptance](docs/TEST-CASES.md)
- [Architecture, data model, security boundaries and deployment setup](docs/ARCHITECTURE.md)
- [Company WhatsApp setup, API behavior and live activation](docs/WHATSAPP.md)
- [Instagram and email setup, consent and operational limits](docs/INSTAGRAM-EMAIL.md)

Research uses OWASP tenant/auth/upload guidance, Stripe subscription documentation and the WhatsApp Business Messaging Policy. The test matrix identifies manual/provider work explicitly rather than presenting it as completed automation.

## Files

| File | Purpose |
| --- | --- |
| `server.mjs` | Express APIs, SQLite schema, authentication, authorization, quotas, uploads, billing and email |
| `whatsapp.mjs` / `whatsapp-ui.js` / `whatsapp.css` | Meta connection, encrypted credentials, signed callbacks, live inbox, receipts and consent |
| `channels.mjs` / `channels-ui.js` | Instagram OAuth/inbox/webhook and email permission, unsubscribe and bulk campaign delivery |
| `saas.js` / `saas.css` | SaaS account flows, landing page, company administration, server persistence and branding |
| `app.js` / `styles.css` | Adapted original CRM views and interactions |
| `index.html` / `subscribe.html` | Workspace and company subscriber entrypoints |
| `.env.example` | Provider and server configuration, without secrets |
| `tests/` / `playwright.config.mjs` | Isolated API and browser verification |

This version runs as one Node instance with a durable SQLite file and versioned workspace documents capped at 16 MB. Use an HTTPS reverse proxy for deployment. High-volume/multi-instance hosting needs a shared database, normalized CRM tables, pagination and operational safeguards; see the launch gaps in the requirements document. The terms/privacy screens are development drafts that must be finalized before public commercial launch.
