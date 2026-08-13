# Telegram alerts

Vindex sends best-effort Telegram alerts (risk, verified-withdrawal, test) for
the protected position. Telegram is observability only — it can never approve
a withdrawal, change a safe wallet, arm a policy, or trigger execution.

## 1. Configure environment

Copy `.env.example` and set:

- `TELEGRAM_BOT_TOKEN` — token from @BotFather
- `TELEGRAM_BOT_USERNAME` — the bot username (e.g. `VindexAlertsBot`)
- `TELEGRAM_WEBHOOK_SECRET` — a long random string you choose (validated on every webhook request)

## 2. Deploy first

The webhook URL must be HTTPS. Deploy the app, then register the webhook with
the operator script (it never runs at startup or build):

```bash
npm run telegram:webhook -- --url https://your-app.example
```

Alternatively set `APP_URL=https://your-app.example` in the environment and
run `npm run telegram:webhook`.

Target: `https://your-app.example/api/integrations/telegram/webhook`

## 3. Connect in the product

Open Settings -> Telegram Alerts -> Connect Telegram, press Start in the bot
chat. Connection is bound to the protected position.

## 4. Alerts

- Risk alert: after a fresh confirmation re-read passes (CONFIRMING), before any execution — once per decision.
- Protected alert: only after destination verification passes and the position is PROTECTED — once per receipt.
- Test alert: fixed message, no fake incident.

Delivery failures never block or alter protection. Each attempt is recorded in
`notification_deliveries`; failures emit a `TELEGRAM_ALERT_FAILED` audit event.
