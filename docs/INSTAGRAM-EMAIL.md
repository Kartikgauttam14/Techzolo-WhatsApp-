# Instagram messaging and email campaigns

## Instagram

Every workspace connects one Instagram Business or Creator account through the
official Instagram Login authorization flow. Access tokens are encrypted in the
server database and are never returned to a browser. Instagram messages are
stored by workspace and Instagram-scoped sender ID. The shared Instagram inbox
appears in **Integrations** after a connection is made.

The Meta app needs Instagram Login / Business Login, the `instagram_business_basic`
and `instagram_business_manage_messages` permissions, the Instagram messaging
webhook subscription, and App Review/Advanced Access for accounts outside app
roles. Configure the exact redirect URI shown on **Integrations** as the OAuth
callback in Meta, and set the webhook callback shown there with the same
`INSTAGRAM_WEBHOOK_VERIFY_TOKEN`. The callback and webhook must be reachable over
public HTTPS in production. Developers and testers may use a Meta test account
while the app is in Development mode.

Set `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`,
`INSTAGRAM_WEBHOOK_VERIFY_TOKEN`, and a stable 32-byte base64
`INSTAGRAM_ENCRYPTION_KEY` in the server `.env`. The Instagram keys can match
the product's Meta app if Instagram messaging is enabled on that app. Restart
the server after changing environment values.

Instagram's API only allows a business to reply after the customer starts the
conversation; this integration checks the 24-hour reply window before sends.
It does not provide bulk or cold Instagram DMs. Meta app review and webhook
configuration are external prerequisites for real customer traffic.

## Bulk email

Email uses the existing shared SMTP transport. Set `SMTP_URL`, a verified
`MAIL_FROM` sender, `EMAIL_UNSUBSCRIBE_SECRET` (32+ random characters), and a
public HTTPS `APP_URL`. Campaigns send from the configured SaaS sender; the
company name is included in the content and unsubscribe notice. Each workspace
has isolated subscriber and campaign records.

In **Subscribers**, an owner or admin can send an individual permission request
to a contact email. The recipient must click the one-time confirmation link
before becoming campaign eligible. CSV import, existing contact records, and
WhatsApp consent do not create email marketing permission. A campaign can only
target confirmed addresses that still exist in the workspace contacts. Sending
is sequential, one message per second, and capped at 250 recipients per
campaign. The worker survives restarts by resuming unsent recipients. If the
server stops during a send or SMTP returns an ambiguous result, that recipient
is marked **unknown**, the campaign pauses, and that address is never retried
automatically; an admin can continue the remaining queued recipients after
checking the provider. The sent count means SMTP accepted the message, not that
it reached the inbox. A signed unsubscribe page and `List-Unsubscribe` headers
are included; unsubscribe immediately suppresses subsequent sends.

Use a transactional/marketing SMTP provider whose terms allow permission-based
campaign mail. Configure SPF, DKIM, and DMARC for the sender domain. This first
release does not include email open tracking, click tracking, scheduling,
multi-domain sender verification, bounce/complaint webhooks, or high-volume
queue infrastructure. Do not use it for purchased lists or recipients who
have not confirmed.

## Source material

- [Meta's official Instagram API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api) documents the Instagram Send API, `instagram_business_manage_messages`, and its customer-started conversation requirement.
- [Meta's Instagram API workspace](https://www.postman.com/meta/instagram/overview) is the official source collection for API examples and changes.
