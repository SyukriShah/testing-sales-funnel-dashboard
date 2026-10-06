# Hosting the IKHLAS Funnel Monitor dashboard internally

The dashboard is a static website: one `index.html` plus a `shots/` folder of screenshots. It has no server code, no database and no
login of its own. This note says what to set up so colleagues can open it safely.

## What gets hosted

Run `npm run export` in the project folder. It creates `dashboard/site/` (about 65 MB) with the same content as the shared claude.ai link.
It contains production test logs, URLs, dummy-data screenshots and the Insights notes. It does not contain screenshots from runs that
used a saved genuine record, and it does not include the Run tests tab (that needs the local control panel).
Treat it as internal. Do not put it on a public site.

## Choose how to run it

| Option | When | Steps |
|---|---|---|
| Existing internal web server (IIS, Apache, nginx) | Quickest | Copy `dashboard/site/` to a web root. Apply the headers in `hosting/nginx.conf`. |
| Docker container | Your team already runs containers | `docker build -f hosting/Dockerfile -t funnel-monitor-site .` then `docker compose -f hosting/docker-compose.yml up -d`. Push the image to a **private** registry only. |
| Static storage (Azure Blob static site, S3) | Cloud is already approved | Upload `dashboard/site/`. It must sit behind company sign-in. |

The Docker files were written but not built on the machine that made them (Docker is not installed there). Please build and check once.

## Checklist for IT

Needs IT (cannot be done from the project):
- [ ] **Company sign-in (SSO).** Put the site behind the existing reverse proxy or identity gateway (for example oauth2-proxy, Azure AD / Entra
      application proxy, or the proxy your other internal tools use). Allow only the people who need it.
- [ ] **HTTPS.** Serve it with an internal certificate. The container listens on plain HTTP port 8080 on localhost only.
- [ ] **Network.** Reachable from the office network or VPN only.
- [ ] **A name.** For example `funnel-monitor.<internal-domain>`.

Already in the files:
- [x] Security headers: content security policy, no framing, no content sniffing, no referrer, no search indexing (`hosting/nginx.conf`).
- [x] No directory listing, hidden files blocked, server version hidden.
- [x] Container runs as a non-root user with a read-only file system and all extra permissions dropped (`hosting/docker-compose.yml`).
- [x] Optional interim password: see the commented `auth_basic` lines in `nginx.conf`. Use it only until company sign-in is ready.

## Keeping it fresh

The site shows the results as of the last export. To refresh it:

```
SITE_TARGET=/path/to/web/root      npm run publish:site    # a folder or mounted share
SITE_TARGET=user@host:/var/www/x   npm run publish:site    # copied with rsync over ssh
```

This rebuilds the site and copies it. It also deletes screenshots that are no longer in the dashboard, so old data does not stay on the server.
To run it on a schedule, add it to cron or launchd on the machine that runs the tests. The daily test run itself is currently switched off
(see `scripts/run-daily.sh`), so a schedule would republish the same results until tests run again.

## Keep these in mind

- The tests create dummy quotation records in production on every run. Agree a reserved set of test IDs with the business.
- The tests and the Run tests tab stay on a machine you control. They are not part of the hosted site.
- Screenshots and logs are kept for a limited time (`monitor.config.json`, `retention`). The hosted copy only holds the latest screenshots.
