-- Draft only. Run after deployment, after enabling pg_cron and pg_net.
-- Before running, add two secrets in Supabase Vault:
--   planner_vercel_cron_url    = https://<deployment-domain>/api/cron
--   planner_vercel_cron_secret = the same random value as Vercel's CRON_SECRET
-- No secret values belong in this file or Git.

select cron.schedule(
  'planner-ai-assistant-minute',
  '* * * * *',
  $job$
    select net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'planner_vercel_cron_url'
      ),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'planner_vercel_cron_secret'
        )
      ),
      body := jsonb_build_object('source', 'supabase-cron')
    );
  $job$
);
