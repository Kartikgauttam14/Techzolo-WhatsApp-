# Platform admin console

The operator console is separate from company owner/admin roles. Workspace membership never grants platform administration.

## Grant access

Verify the operator email in the account's Account & Security page first. Add the exact verified sign-in email to the server's ignored `.env` file, then restart the server:

```dotenv
PLATFORM_ADMIN_EMAILS=operator@your-company.com
```

Multiple operators can be separated by commas. The allowlist is server-only, is normalized to lowercase, and is never returned by an API. Keep this list small and protected. Admins sign in at the normal product URL, then choose **Admin console** in the navigation. Adding an email does not create an account, verify it, or bypass password authentication.

## Features

- Overview of workspaces, current subscribers, open trials, suspension count, account count, contacts, connected WhatsApp accounts, estimated monthly recurring revenue, and database/provider configuration state.
- Searchable, filterable, paginated workspace directory with owner, plan, billing status, trial end, team/contact counts, WhatsApp connection state, and creation date.
- A support view with workspace members and recent company audit events. It excludes CRM records, WhatsApp messages, access tokens, app secrets, and payment details.
- Audited workspace suspension/restoration and trial extension for unpaid trials, bounded to 1–90 days. Suspension preserves the billing status and data, leaves read access in place, and blocks edits, signup requests, and outbound WhatsApp actions until restored.
- Searchable user directory and audited account access disable/restore. Disabling an account immediately deletes its active sessions. Platform-allowlisted accounts cannot disable themselves through this console.
- A global audit trail for operator actions, stored separately from tenant-visible audit results.

The console does not impersonate companies, expose message contents or credentials, alter Stripe subscription entitlements, or delete customer data. Plan status remains controlled by verified Stripe events. Operators should use the detail view and audit record to support account decisions.

## Verification

`npm test` covers allowlist enforcement, safe metrics, account isolation, trial limits, suspension and restoration, session revocation, and audit events. The browser suite verifies platform navigation, workspace search, and support details using an isolated in-memory database.
