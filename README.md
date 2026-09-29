# Planner AI Assistant

Telegram AI assistant for an existing Planner application. It connects to the Planner's Supabase project and works with the user's existing planner data rather than maintaining a separate copy.

## Features

- Read tasks, calendar events, habits, weekly plans, and ideas.
- Create and update tasks and events, complete tasks, and record or undo habit completions.
- Save, update, archive, and retrieve ideas.
- Create and cancel one-time reminders.
- Ask for confirmation before destructive task, event, and idea deletions.
- Link a Telegram account to a Planner account using Supabase authentication.
- Run as a Telegram webhook on Vercel, with scheduled reminder processing through Supabase Cron.

## Architecture

- **Telegram:** Telegraf handles conversations and Telegram updates.
- **AI:** OpenAI-compatible API interprets requests and selects from a constrained set of Planner tools.
- **Data and authentication:** Supabase is the source of truth for Planner data and account linking.
- **Hosting:** Vercel Node.js Functions receive Telegram webhooks; Supabase Cron invokes the protected scheduled-work endpoint.

The bot uses the server-side Supabase secret key only from server environment variables. Never put credentials in source files or client-side code.

## Local development

Requirements: Node.js 22 or later and a Supabase project containing the Planner schema.

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env.local` and fill in the required credentials locally.
3. Start the bot in polling mode with `node bot.js`.

For local polling, provide `TELEGRAM_BOT_TOKEN`, `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `SUPABASE_ANON_KEY`.

## Vercel deployment

The `api/telegram.mjs` function handles Telegram webhooks. The `api/cron.mjs` function handles scheduled work and requires a shared `CRON_SECRET`. Webhook deployment also requires persistent Telegram session storage and the schema in `schema-proposals/vercel-webhook-storage.sql`.

Configure credentials in Vercel Project Settings → Environment Variables. Set the Telegram webhook URL and secret there, deploy, then register the webhook with `npm run set-webhook`. Configure Supabase Cron and its Vault secrets using `schema-proposals/vercel-minute-cron.sql` only after deployment, following the comments in that SQL file.

## Configuration

See `.env.example` for the supported environment variable names and optional scheduler settings. Keep real values in `.env.local` or the hosting provider's secret environment settings. `.env.local` is excluded from Git.

## Database setup notes

The bot is designed to use the existing Planner tables and user ownership model. SQL files under `schema-proposals/` document additional tables and deployment configuration; review and apply them in the intended Supabase project as needed.

## License

No license has been selected. Until one is added, the source is publicly viewable but is not granted an open-source reuse license.
