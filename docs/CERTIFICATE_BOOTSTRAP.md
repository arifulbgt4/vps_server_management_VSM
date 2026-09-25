# Certificate bootstrap and renewal

VSM separates certificate bootstrap from ongoing renewal.

## Bootstrap (`certbot-init`)

`deploy/certbot/issue-certs.sh` checks each configured certificate under `/etc/letsencrypt/live/<domain>/fullchain.pem` before contacting Let's Encrypt.

- If an existing certificate is readable and remains valid for more than 30 days, bootstrap skips the ACME request for that domain.
- If the certificate is missing, invalid, or within the 30-day renewal window, bootstrap runs `certbot certonly` for that domain.
- This keeps ordinary Compose dependency startup from being blocked by a transient external DNS/ACME outage when the VPS already has valid certificates.
- A genuinely missing or near-expiry certificate still requires working DNS/network access and a successful ACME challenge.

`certbot-init` touches `/var/www/certbot/.certs-ready` only after every configured domain has a usable certificate or has been successfully issued/renewed.

## Ongoing renewal (`certbot-renew`)

`deploy/certbot/renew-loop.sh` remains responsible for periodic renewal checks. It runs `certbot renew` on the configured interval and uses the deploy hook to sync renewed certificates and restart affected services.

## Troubleshooting

Inspect bootstrap state:

```bash
docker compose ps -a certbot-init
docker compose logs --tail=200 certbot-init
```

If bootstrap fails while certificates are already valid, first pull the latest VSM code and recreate the one-shot certificate service:

```bash
cd /srv
git pull origin master
docker compose up certbot-init
```

Then start the dependent application services again.
