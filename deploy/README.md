# Example production configuration

Starting points for running the published image `ghcr.io/nvanderploeg/chronicle` behind a reverse
proxy. Adapt them to your host.

| File                           | What it is                                                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compose.prod.yml`             | PostgreSQL and the app, with the app bound to `127.0.0.1:3280`. Migrations run at boot. PostgreSQL is sized for a small shared host.                                       |
| `chronicle.env.example`        | Copy to `chronicle.env` and `chmod 600` it. Passwords are hex only (`openssl rand -hex 24`) because they are spliced into `DATABASE_URL`. Set `ORIGIN` to your public URL. |
| `nginx/chronicle.conf.example` | A server block for nginx. The stream route turns off buffering and holds connections for an hour; both routes pass `X-Real-IP`, which the app's write limit keys on.       |
| `systemd/chronicle-update.*`   | A timer that pulls `latest` every 10 minutes and recreates the app when the image changed. Expects the stack in `/opt/chronicle`.                                          |

```sh
docker compose -p chronicle --env-file deploy/chronicle.env -f deploy/compose.prod.yml up -d
```

`ADMIN_TOKEN` in `chronicle.env` turns on the admin portal at `/admin` (see
[`docs/usage.md`](../docs/usage.md#admin-portal-and-migrating-hosts)). Pre-import backups land in
the `backups` volume. The nginx example raises the body limit for `/api/admin/import` only.

Pin a build with `CHRONICLE_TAG=sha-<short>` to roll back. `GET /api/health` answers
`{"service":"chronicle",...,"db":"ok"}` when the app and database are up.

## Constraints

- Run a single app replica: the Bundle import freeze, `ADMIN_BACKUP_DIR` and the SSE bus are per process.
- For an external Postgres over TLS use `DATABASE_URL=postgres://user:pw@host:5432/chronicle?sslmode=verify-full`.
  `pg` reads `sslmode=require|prefer|verify-ca` as full verification and `no-verify` as none;
  `uselibpqcompat=true` restores libpq meanings. A private CA: `sslrootcert=/path/ca.pem`.
  Passwords must be URL-safe (hex).
