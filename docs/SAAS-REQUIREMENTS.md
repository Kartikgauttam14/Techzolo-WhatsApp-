# SaaS scope and research

Research checked on 30 October 2026. This is an implemented local SaaS foundation, not a claim that every enterprise feature or live provider integration is finished.

## Implemented product requirements

| Area | Behavior |
| --- | --- |
| Acquisition | Responsive product page, pricing comparison, trial signup and sign in |
| Organization onboarding | Company name, unique workspace slug, owner account, optional company logo, brand color, clean CRM state and 14-day Growth trial |
| Identity | Salted scrypt password hashes, opaque server-side sessions, HttpOnly/SameSite cookies, CSRF verification, login throttling, verification and recovery email adapters |
| Tenancy | Server resolves tenant from session membership; reads and writes are tenant-scoped; explicit workspace context prevents stale tabs writing after a switch |
| Branding | Company PNG/JPEG/WebP upload during registration or later, image decoding and PNG normalization, logo removal, initials fallback, brand color, company-specific document titles and favicon |
| Customer branding | Subscriber URL includes the company slug; public response contains only brand and signup information; company logo is consistent across navigation and subscriber page |
| Team | Owner/admin/agent/viewer roles, invitations bound to email, single-use hashed invitation tokens, expiry, revocation, role changes and member removal |
| CRM | Contacts, search, CSV import/export, notes, conversation drafts, opportunity creation/editing and pipeline movement |
| Messaging channels | Company-scoped WhatsApp Business integration and Instagram professional account OAuth, signed webhooks, inboxes and provider-window reply checks |
| Campaigns | WhatsApp draft workflow plus SMTP bulk email campaigns, double opt-in, per-company audiences, paced sending, delivery outcomes and unsubscribe suppression |
| Subscriptions | Plan catalog, reserved seat accounting, server quotas, trial expiry, Stripe checkout and portal adapters, raw-body signed webhooks, event deduplication and provider-state reconciliation |
| Trust and operations | Audit history, live workspace counts, JSON export, explicit provider configuration status, security screen and draft legal notices |

## Permission model

| Capability | Owner | Admin | Agent | Viewer |
| --- | --- | --- | --- | --- |
| Read CRM and reports | Yes | Yes | Yes | Yes |
| Contacts, conversation drafts, notes, pipeline | Yes | Yes | Yes | No |
| Settings, templates, campaigns, automation/assistant configuration | Yes | Yes | No | No |
| Company branding | Yes | Yes | No | No |
| Invite agents/viewers | Yes | Yes | No | No |
| Invite admins, change roles, remove members | Yes | No | No | No |
| Audit and pending website requests | Yes | Yes | No | No |
| Subscription checkout/portal | Yes | No | No | No |

The server enforces these permissions. UI checks only improve feedback. Password recovery and workspace creation are account-level actions. Every authenticated user may own an independent workspace.

## Research decisions

1. **Bind tenant context to verified membership and isolate all resources.** OWASP describes tenant context, IDOR prevention, uploads, caching and logging as separate concerns. The server ignores tenant query parameters, checks membership on each request and requires the expected workspace ID. Public logo access is intentional; CRM state is private. [OWASP Multi-Tenant Security](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html)
2. **Hash passwords, constrain sessions and throttle authentication.** Passwords are 15–128 characters and use individual salts with scrypt. Opaque session tokens and one-time links are hashed in SQLite. SMTP supports verification and expiring recovery. Production requires HTTPS. [OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
3. **Treat a logo as an untrusted upload.** Allowlisted MIME types are insufficient by themselves: Sharp decodes the bytes, checks the actual format, enforces pixel and byte limits, strips metadata and re-encodes PNG. SVG is rejected. The API controls the output filename and resource scope. [OWASP File Upload](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html), [Sharp constructor](https://sharp.pixelplumbing.com/api-constructor/)
4. **Grant paid access from provider state.** Checkout redirects do not change plans. The webhook verifies raw bytes with the Stripe signing secret, deduplicates event IDs and retrieves the current subscription before applying mapped price IDs. Canceled, incomplete, past-due and other inactive states cannot write CRM records. [Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)
5. **Separate permissions by channel.** WhatsApp signup requests require WhatsApp confirmation; email requires a separate double opt-in. Neither imports nor website checkboxes silently enroll a contact. Instagram replies are customer-initiated and limited to the supported messaging window. [WhatsApp Business Messaging Policy](https://whatsappbusiness.com/policy/), [Meta's official Instagram API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api)

These implementation choices are derived from the sources; they are not certifications or exhaustive compliance claims.

## Configurable commercial assumptions

The catalog is an implementation default, not a recommendation about market pricing. All amounts are INR per company per month; each company starts with a 14-day Growth trial without a card.

| Plan | Monthly catalog price | Contacts | Seats including pending invites | Saved campaigns | Automation configurations |
| --- | --- | --- | --- | --- | --- |
| Starter | ₹1,499 | 1,000 | 3 | 10 | 3 |
| Growth | ₹3,999 | 5,000 | 10 | 100 | 25 |
| Scale | ₹9,999 | 10,000 | 50 | 1,000 | 100 |

The full workspace has a 16 MB storage ceiling, including notes and drafts. These are saved-record quotas, not monthly message allowances. Taxes and provider fees are additional. Configure matching recurring Stripe prices before enabling billing. Existing data stays readable if access expires or a plan is downgraded; the server rejects new records above the current plan quota.

## Explicit launch gaps

- Meta integrations are implemented in `whatsapp.mjs` and `channels.mjs`; live activation still needs credentials, app products/scopes, Meta review and public HTTPS callbacks for each provider. Instagram is text inbox/reply only. WhatsApp media templates, coexistence and automatic outbound retries remain out of scope. See WHATSAPP.md and INSTAGRAM-EMAIL.md.
- Email uses one operator-configured SMTP sender identity and a conservative 250-recipient campaign cap. Domain-specific sender verification, scheduling, bounce/complaint webhooks and large-scale queue infrastructure remain out of scope.
- Live AI responses and executable visual flows. Assistant and automation settings are stored configuration only.
- SSO/MFA, enterprise identity provisioning, ownership transfer, a platform-wide super-admin console and self-service account/company deletion.
- Production email reputation, DNS and final legal/company contact details. The included terms/privacy are development drafts.
- Distributed sessions/rate limits, normalized CRM storage, pagination, large file/object storage and tenant backup/restore.
- Deployment, HTTPS termination, production keys, recurring backups with restore tests, retention enforcement, error monitoring and load testing.

Keep billing in Stripe test mode until the live-provider acceptance cases in TEST-CASES.md are completed. No external messages are sent by development or tests unless a deployment operator explicitly configures those providers.
