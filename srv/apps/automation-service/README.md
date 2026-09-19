# Automation API and SaaS Worker

This image builds the backend runtime from `arifulbgt4/n8n-automation`.

One image is reused for three roles: `migrate`, `api`, and `worker`.

`automation-worker` is intentionally separate from VSM's `n8n-worker`. The n8n worker consumes n8n's execution queue; `automation-worker` consumes the SaaS BullMQ queues.

Runtime secrets are mounted from `/srv/vsm/secrets/automation` and converted into `DATABASE_URL`, `REDIS_URL`, `APP_ENCRYPTION_KEY`, and `INTERNAL_SERVICE_AUTH_SECRET` by the entrypoint.
