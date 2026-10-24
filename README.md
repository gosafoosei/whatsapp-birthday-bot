# WhatsApp Scheduled Sender

Sends a WhatsApp message to a configured list on a schedule (every 30
minutes) using a WhatsApp Web session driven by
[whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js), run on
GitHub Actions so no personal computer needs to stay on.

- Scheduling: GitHub Actions cron (`*/30 * * * *`) triggers one-shot runs
  (`ONCE=1`): connect, send, clean up, exit.
- The WhatsApp session lives in the Actions cache; on a cold cache it is
  seeded from a private gist.
- Message and recipients come from repository secrets (`MESSAGE`,
  `CONTACTS_JSON`) — no personal data is committed.
- If WhatsApp asks the session to re-login, the run saves the fresh QR
  code as the `qr-code` artifact to scan.
