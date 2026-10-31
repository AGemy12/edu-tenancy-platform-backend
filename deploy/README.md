# Deploying the API on a VPS

Postgres and the API run with Docker Compose. Library files and the database live in Docker
volumes, so rebuilds and restarts keep them. The API listens on `127.0.0.1:${API_PORT}` only; the
public door is a reverse proxy with HTTPS: the server's existing nginx, or the bundled Caddy on an
empty server. Tested on Ubuntu 24.04.

## Once

1. DNS: an **A record** for the API host (e.g. `edu-api.example.com`) → the server's IPv4.
2. On the server:

   ```sh
   command -v docker || curl -fsSL https://get.docker.com | sh
   git clone https://github.com/AGemy12/edu-tenancy-platform-backend.git /opt/edu-api
   cd /opt/edu-api/deploy
   cp .env.example .env && nano .env   # fill in every secret (openssl rand -hex 32)
   ```

3. Start it, depending on who owns ports 80/443 (`ss -tlnp | grep -E ':(80|443) '`):

   - **nginx already runs** (other sites on this server):

     ```sh
     docker compose up -d --build
     cp nginx.conf.example /etc/nginx/sites-available/edu-api
     nano /etc/nginx/sites-available/edu-api   # set server_name and the port (API_PORT)
     ln -s /etc/nginx/sites-available/edu-api /etc/nginx/sites-enabled/
     nginx -t && systemctl reload nginx
     certbot --nginx -d <API_DOMAIN>           # HTTPS (apt install certbot python3-certbot-nginx)
     ```

   - **Empty server**: `docker compose --profile caddy up -d --build` (Caddy takes 80/443 and
     gets the certificate itself).

4. Check: `curl https://<API_DOMAIN>/api/health`. The first start runs the migrations and creates
   the platform admin from `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD`.
5. Web app (Vercel): `NEXT_PUBLIC_API_URL=https://<API_DOMAIN>/api`, and put the web app's URL in
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
