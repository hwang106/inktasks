# InkTasks reminder service

A Cloudflare Worker with a D1 database. Every minute it sends due reminders as Web Push
notifications to each device where InkTasks is installed. It stores push addresses, reminder
times, and task titles. The titles are sealed with the sync passphrase key, so the service can't
read them. Only the Microsoft account that registers first can use the service.

Live at https://inktasks-reminders.tasklist.workers.dev (free plan).

## Test

    node test/worker.test.mjs        # push encryption, VAPID, scheduling, access rules
    node dev.mjs                     # local copy on :8787 for the InkNotes dev server's --fake-ms mode

## Set up from scratch (or move to a new Cloudflare account)

    npx wrangler login
    npx wrangler d1 create inktasks-reminders      # put the id in wrangler.toml
    npx wrangler d1 execute inktasks-reminders --remote --file=schema.sql
    # Make a new VAPID key pair (P-256). Put the public key (base64url, raw) in wrangler.toml and
    # app/js/config.js. Store the private key as a JWK:
    npx wrangler secret put VAPID_PRIVATE_JWK
    npx wrangler deploy                            # then put the URL in app/js/config.js

The private key exists only as the Cloudflare secret. If the account is lost, make a new key pair
and deploy again. Each device signs up again by itself the next time InkTasks opens, and
reminders are resent from the tasks.
