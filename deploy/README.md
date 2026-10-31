# Deploying the API on a VPS

One server runs Postgres, the API and Caddy (automatic HTTPS) with Docker Compose. Library files
and the database live in Docker volumes, so rebuilds and restarts keep them. Tested on Ubuntu 24.04.

## Once

1. DNS: an **A record** for the API host (e.g. `api.example.com`) → the server's IPv4.
2. On the server (as root):

   ```sh
   curl -fsSL https://get.docker.com | sh
   ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
   git clone https://github.com/AGemy12/edu-tenancy-platform-backend.git /opt/edu-api
   cd /opt/edu-api/deploy
   cp .env.example .env && nano .env   # fill in every secret (openssl rand -hex 32)
   docker compose up -d --build
   ```

3. Check: `curl https://<API_DOMAIN>/api/health`. The first start runs the migrations and creates
   the platform admin from `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD`.
4. Web app (Vercel): `NEXT_PUBLIC_API_URL=https://<API_DOMAIN>/api`, and put the web app's URL in
   `APP_URL` and `CORS_ORIGIN` here (then `docker compose up -d`).

## Updating

```sh
cd /opt/edu-api && git pull && cd deploy && docker compose up -d --build
```

## Day to day

| Task | Command (in `deploy/`) |
| --- | --- |
| Logs | `docker compose logs -f api` |
| Restart | `docker compose restart api` |
| Database shell | `docker compose exec db psql -U edu edu` |
| Backup | `docker compose exec -T db pg_dump -U edu edu \| gzip > backup-$(date +%F).sql.gz` |
| Restore | `gunzip -c backup.sql.gz \| docker compose exec -T db psql -U edu edu` |
