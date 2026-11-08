**English** | [Русский](README.ru.md)

# Planner AI Assistant

A Telegram assistant for Planner. The assistant reads and updates Planner data in Supabase, so the web app and Telegram bot work with the same account and records.

> This repository contains the Telegram assistant and its deployment configuration. The Planner web application is a separate project and remains the source of truth for planner data.

## What it can do

Talk to the bot in natural language after connecting your Planner account. It can use the following Planner actions:

### Read your plan

- Show today's events, tasks, overdue tasks, and habit check-ins.
- List tasks by status or time range: open, due today, overdue, future, or all.
- Show events over a date range, including occurrences of recurring events.
- Show habits and completion history for a selected date.
- Summarize a week of events, tasks, and habits.
- Read ideas saved in Planner, with archived ideas included only when requested.

### Update Planner from Telegram

- **Tasks:** create tasks with an optional note, deadline, and low/medium/high priority; edit them; mark them complete; or delete them.
- **Events:** create and edit calendar events with a title, start/end time, and color. Daily, weekly, monthly, and yearly recurrence is supported with an end date. Events can also be deleted.
- **Habits:** mark an existing habit complete for a date or undo that completion. The bot does not create or rename habits.
- **Ideas:** save ideas, view them, change their title or category, archive or restore them, and delete them.
- **Reminders:** create one-time reminders for a future date and time, or cancel a reminder that has not been sent.
- **Deletion safety:** deleting a task, event, or idea requires a separate confirmation in Telegram. Use `/cancel` to cancel a pending deletion or pairing flow.

The assistant uses a constrained set of typed tools to perform Planner operations. It does not expose arbitrary database queries to the language model.

After linking your account, you can ask the bot what is planned for today, add a high-priority task for tomorrow, or set a reminder for 18:00. The bot asks for details if it needs them.

## How it works

```mermaid
flowchart LR
    U[User in Telegram] --> T[Telegram Bot API]
    T --> V[Telegram webhook handler]
    V --> B[Telegraf bot]
    B --> A[OpenAI-compatible AI and Planner tools]
    A --> S[(Supabase Planner data)]
    C[Supabase Cron] --> J[Scheduled job handler]
    J --> S
    J --> T
```

### Account linking

<img src="docs/screenshots/telegram-linking.png" alt="Telegram connection status in the Planner profile" width="460">

1. The user signs in to Planner and opens **Profile → Create connection code**.
2. Planner generates a random one-time code and asks Supabase to store only its SHA-256 hash for the signed-in user. The code expires after 10 minutes; a new code can be issued at most once per minute.
3. The user sends `/start` to the Telegram bot and submits the code.
4. A server-only Supabase function validates and consumes the code atomically, then records the Telegram ID to Supabase user ID mapping in `telegram_users`.
5. Each Planner tool resolves the linked Supabase user ID and scopes its database operations to that user's records. The link is one Planner account per Telegram account and one Telegram account per Planner account.

No email or SMTP setup is needed for Telegram linking. The Planner browser uses its public Supabase key for the signed-in user's pairing request; the bot uses the Supabase secret key only on the server to consume a code and perform Planner operations.

### Assistant requests

Natural-language messages are sent to the configured OpenAI-compatible API. The model can select only declared Planner tools; each tool validates inputs and performs a scoped Supabase operation. Deleting a task, event or idea requires a separate user confirmation. Dates and event recurrences are interpreted using the configured planner timezone.

The bot does not provide a separate `/help` command. Start or restart the conversation with `/start`; if the Telegram session was reset, the bot restores the existing account link from Supabase. Send `/cancel` while a pairing code or deletion confirmation is pending to abandon that step.

### Reminders and morning summaries

Reminders are stored in Supabase and delivered by scheduled work. Supabase Cron calls the protected endpoint once per minute. The job sends due reminders and prevents concurrent workers from sending the same reminder twice.

An optional morning summary can report today's events and tasks, overdue tasks, and habit progress. It is disabled unless `MORNING_SUMMARY_ENABLED=true`. Delivery time and timezone are configurable. The summary is assembled from Planner data; it does not require a separate AI request.

## Data and access

- Supabase is the source of truth. The assistant works with the Planner's existing `tasks`, `events`, `habits`, and `habit_completions` tables, plus the `telegram_users` account-link table.
- Optional features use their own supporting tables, such as `ideas`, `reminders`, summary delivery records, and webhook session/receipt storage.
- Planner tools look up the Supabase user ID through `telegram_users` and scope reads, updates, and deletes to that ID.
- The service-role secret is used only by server-side code. Because it is a privileged key, the typed tools must continue to scope every user operation by the linked `user_id`. Never expose the key to browser code, commit it, or send it in chat.
- PostgreSQL table grants are also required: bypassing RLS does not grant SQL privileges by itself. The pairing SQL proposal grants the bot access to `telegram_users`, `tasks`, `events`, `habits`, and `habit_completions` while leaving RLS enabled.
- `.env.local` and other local environment files are excluded by `.gitignore`; `.env.example` contains names and placeholders only.

The SQL files under [`schema-proposals/`](schema-proposals/) are deployment and feature setup scripts. Review each against the target Supabase project before applying it; do not run them against an unrelated project.

## Project structure

| Path | Purpose |
| --- | --- |
| `bot.js` | Telegraf bot, account linking, message handling, and tool registration |
| `ai-assistant.js`, `ai-tools.js` | AI orchestration, tool definitions, confirmation flow, and safe tool dispatch |
| `read-tools.js` | Planner reads, date/timezone handling, weekly views, and recurring event expansion |
| `task-tools.js`, `event-tools.js`, `habit-tools.js` | Validated task, event, and habit operations |
| `idea-tools.js`, `reminder-tools.js` | Idea and one-time reminder operations |
| `scheduler.js`, `morning-summary.js` | Due reminder delivery and optional morning summaries |
| `api/telegram.mjs` | Receives Telegram updates and skips duplicates |
| `api/cron.mjs` | Protected scheduled-work endpoint and webhook receipt cleanup |
| `supabase-session-store.js` | Persistent Telegram session storage for serverless webhook runs |
| `scripts/set-webhook.js` | Registers the deployed endpoint with Telegram |
| `schema-proposals/` | SQL for optional tables and Supabase Cron setup |

## Run locally

### Requirements

- Node.js 22 or later.
- A Telegram bot token.
- An OpenAI API key or credentials for a compatible API.
- A Supabase project with the Planner schema and account-link table.

### Setup

1. Install packages: `npm install`.
2. Copy `.env.example` to `.env.local`.
3. Fill the local file with the required environment values listed below. Keep it out of Git.
4. Start the bot in polling mode: `node bot.js`.

For local development, the bot polls Telegram for updates. With a webhook configured, Telegram sends updates to the server.

Run the automated tests with `npm test`.

## Webhook and scheduled jobs

`api/telegram.mjs` receives Telegram updates. `api/cron.mjs` sends reminders and morning summaries when called by Supabase Cron.

- [`telegram-pairing.sql`](schema-proposals/telegram-pairing.sql) adds one-time pairing codes. The Planner tables require RLS policies.
- [`vercel-webhook-storage.sql`](schema-proposals/vercel-webhook-storage.sql) adds storage for sessions and processed updates. Set `TELEGRAM_SESSION_STORE=supabase` to use it.
- `npm run set-webhook` registers the handler's HTTPS URL with Telegram. Configure the webhook URL and secret before running it.
- [`vercel-minute-cron.sql`](schema-proposals/vercel-minute-cron.sql) sets the schedule. It uses the `/api/cron` URL and `CRON_SECRET` stored in Supabase Vault.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot API access |
| `OPENAI_API_KEY` | Yes | AI provider authentication |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Yes, server only | Privileged server-side Planner operations |
| `OPENAI_BASE_URL` | No | Override the default OpenAI API endpoint for a compatible provider |
| `OPENAI_MODEL` | No | Model name; see `.env.example` for the configured default |
| `TELEGRAM_SESSION_STORE` | Webhook mode | Set to `supabase` for persistent serverless sessions |
| `TELEGRAM_WEBHOOK_SECRET` | Webhook mode | Verifies Telegram webhook requests |
| `TELEGRAM_WEBHOOK_URL` | Local webhook setup | Public HTTPS URL of the deployed `/api/telegram` endpoint |
| `CRON_SECRET` | Scheduled work | Shared secret protecting `/api/cron` |
| `PLANNER_TIMEZONE` | No | Planner timezone; defaults to `Europe/Moscow` |
| `MORNING_SUMMARY_ENABLED` | No | Enable optional morning summaries; defaults to `false` |
| `MORNING_SUMMARY_HOUR` | No | Local delivery hour; defaults to `8` |
| `MORNING_SUMMARY_MINUTE` | No | Local delivery minute; defaults to `0` |
| `MORNING_SUMMARY_WINDOW_MINUTES` | No | Delivery window; defaults to `60` minutes |
| `REMINDER_BATCH_SIZE` | No | Maximum due reminders handled in one run; defaults to `50` |

## License

No license has been added. The repository is publicly viewable, but no open-source reuse rights are granted unless a license is added.
