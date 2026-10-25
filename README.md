# WhatsApp Scheduled Sender

Sends a WhatsApp message to a configured list on a schedule (every 30
minutes) using a WhatsApp Web session driven by
[whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js), run on
GitHub Actions so no personal computer needs to stay on.

- Scheduling: long-runner mode (`LONG=1`). Each job stays connected ~5.5 h
  and sends on the bot's own 30-minute clock, then relaunches the next job
  via the API, so GitHub's flaky cron is only a backstop (every 2 h at :37,
  plus manual `workflow_dispatch`). Only one job is ever live at a time.
- The WhatsApp session lives in the Actions cache; on a cold cache it is
  seeded from a private gist.
- Message and recipients come from repository secrets (`MESSAGE`,
  `CONTACTS_JSON`) — no personal data is committed.
- If WhatsApp asks the session to re-login, the run saves the fresh QR
  code as the `qr-code` artifact to scan.
