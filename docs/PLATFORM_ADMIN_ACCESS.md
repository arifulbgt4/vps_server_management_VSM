# Platform Admin access and credentials

This guide covers the VSM **Platform Admin** account only. It is separate from the `n8n-automation` SaaS Super Admin account.

Production URL:

```text
https://admin.openmusk.store
```

The effective login username comes from `ADMIN_USERNAME` in the VSM root `.env`. The password is stored as a one-way scrypt hash under `/srv/vsm/secrets`; VSM also keeps the generated initial/reset plaintext password in `/srv/vsm/bootstrap/admin_initial_password` unless that file is removed manually.

## Show the current Platform Admin username

From the VSM repository directory:

```bash
cd ~/srv
ADMIN_USER="$(grep -E '^ADMIN_USERNAME=' .env | tail -n1 | cut -d= -f2-)"
printf '%s\n' "${ADMIN_USER:-admin}"
```

If `ADMIN_USERNAME` is not configured, the default username is:

```text
admin
```

A simpler check is:

```bash
grep '^ADMIN_USERNAME=' .env
```

## Show the current generated/reset password

```bash
sudo cat /srv/vsm/bootstrap/admin_initial_password
```

Protect this file as a secret. Do not copy it into Git, documentation, chat logs, issue trackers, or shell scripts.

If `/srv/vsm/bootstrap/admin_initial_password` no longer exists, the password cannot be recovered from `admin_password_hash`. Use the password reset procedure below.

## Change only the Platform Admin username

Edit the VSM root `.env`:

```bash
cd ~/srv
nano .env
```

Change:

```dotenv
ADMIN_USERNAME=admin
```

to the desired username, for example:

```dotenv
ADMIN_USERNAME=myadmin
```

Use a simple username containing letters, digits, `_`, `-`, or `.`.

Apply the new environment value by recreating Platform Admin:

```bash
docker compose up -d --force-recreate platform-admin
```

Verify:

```bash
docker compose ps platform-admin
docker compose logs --tail=100 platform-admin
```

The password is unchanged.

## Change/reset the Platform Admin password

Changing `VSM_ADMIN_PASSWORD` in `.env` **does not** change an already initialized password. Once `/srv/vsm/secrets/master/admin_password_hash` exists, the initializer reuses that hash.

Use the following reset procedure. It regenerates only the Platform Admin password hash and Platform Admin session secret; database, Redis, n8n, media, encryption, and automation credentials remain unchanged.

First enter the new password without putting it in shell history:

```bash
cd ~/srv
read -rsp 'New Platform Admin password: ' NEW_ADMIN_PASSWORD
echo
```

Remove only the persisted Platform Admin password hash and auth-session master secret:

```bash
sudo rm -f \
  /srv/vsm/secrets/master/admin_password_hash \
  /srv/vsm/secrets/master/auth_session_secret
```

Run the idempotent VSM secret initializer with the new password supplied only for this command:

```bash
VSM_ADMIN_PASSWORD="$NEW_ADMIN_PASSWORD" \
  docker compose up --force-recreate vsm-init
```

The initializer writes a new password hash and a new Platform Admin session secret. Rotating the session secret invalidates previously authenticated Platform Admin browser sessions.

Clear the shell variable:

```bash
unset NEW_ADMIN_PASSWORD
```

Recreate Platform Admin so it uses the current secret files and environment:

```bash
docker compose up -d --force-recreate platform-admin
```

Show the newly generated/reset plaintext password if needed:

```bash
sudo cat /srv/vsm/bootstrap/admin_initial_password
```

Verify Platform Admin:

```bash
docker compose ps platform-admin
docker compose logs --tail=100 platform-admin
curl -fsS https://admin.openmusk.store/api/health
```

Then sign in again at:

```text
https://admin.openmusk.store
```

## Change username and password together

First update `ADMIN_USERNAME` in `.env`, then execute the password reset procedure above. The final command:

```bash
docker compose up -d --force-recreate platform-admin
```

applies the new username, new password hash, and new session secret together.

## Set a chosen password during the first bootstrap

For a brand-new installation, `VSM_ADMIN_PASSWORD` may be set before the first `vsm-init` execution. If it is blank, VSM generates a strong random initial password.

For normal production use, prefer leaving this value blank in `.env` and letting VSM generate the first password:

```dotenv
ADMIN_USERNAME=admin
VSM_ADMIN_PASSWORD=
```

Retrieve the generated password afterward with:

```bash
sudo cat /srv/vsm/bootstrap/admin_initial_password
```

If a chosen first-boot password is required, set `VSM_ADMIN_PASSWORD` only for bootstrap, complete the deployment, then clear the plaintext value from `.env` after confirming login. The persisted scrypt hash remains under `/srv/vsm/secrets/master/admin_password_hash`.

## Security notes

- The Platform Admin password hash is one-way; do not attempt to recover plaintext from the hash.
- `/srv/vsm/bootstrap/admin_initial_password` is a convenience/recovery file and should remain root-readable only.
- Do not commit `.env`, `/srv/vsm/secrets`, or `/srv/vsm/bootstrap` content.
- Password reset should rotate the Platform Admin auth-session secret so existing sessions are invalidated.
- The VSM Platform Admin account is not the same account as the `n8n-automation` SaaS Super Admin.
