# Paperclip Cloudflare edge (Alchemy)

Alchemy stack for the Cloudflare side of a self-hosted Paperclip: Tunnel, DNS, a gateway
Worker with KV (maintenance and outage pages, status endpoint, origin probe), and an optional
R2 bucket. Paperclip itself runs unchanged on your own machine from
[`../hostinger/docker-compose.yml`](../hostinger/docker-compose.yml) and its own account
system is the login; there is no Cloudflare login in front of it.

The stack is deployed either from this directory (first setup, experiments) or by the
`cloudflare` job of [`.github/workflows/deploy-hostinger.yml`](../../.github/workflows/deploy-hostinger.yml),
which runs before every VPS rollout. Both share the same state, kept in the Cloudflare
account by Alchemy's state store, so they can be mixed freely.

## From your machine

```sh
cd deploy/cloudflare
pnpm install --ignore-workspace       # standalone package, own lockfile
cp .env.example .env                  # hostname
pnpm alchemy profile edit --add Cloudflare   # once (OAuth; see scopes below)
pnpm run plan                         # preview (stage prod; ALCHEMY_STAGE=x to change)
pnpm run deploy                       # provision (the tunnel token output is redacted)
pnpm tunnel-token                     # print the tunnel token for the VPS (needs an API token)
pnpm run logs                         # tail the gateway Worker's logs
pnpm test && pnpm typecheck
```

At the **Cloudflare OAuth scopes** prompt pick **Custom Scopes** and tick at least
`zone.read`, `dns.write`, `workers-scripts.write`, `workers-kv-storage.write`,
`workers-routes.write`, `secrets-store.write` (Alchemy's state store keeps its token there),
`account-settings.read` and `argotunnel.write`; add `workers-r2.write` for the optional R2
bucket. **All Scopes** also works; **Basic Scopes** lacks the DNS and tunnel permissions.

Instead of the OAuth profile you can export `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`; environment credentials win over the profile.

## From GitHub Actions

The `cloudflare` job installs this package, writes `.env` from repository variables and
runs `pnpm run deploy --yes`. Alchemy sees `CI=true` and reads credentials from the
environment only, so no profile is involved. Configure, on the repository or on the
`hostinger` environment:

| Kind | Name | Value |
|------|------|-------|
| Secret | `CLOUDFLARE_API_TOKEN` | API token with the permissions below |
| Variable or secret | `CLOUDFLARE_ACCOUNT_ID` | Account id (Cloudflare dashboard, account home, right column) |
| Variable | `PAPERCLIP_HOSTNAME` | Public hostname, the same value as in the VPS `.env` |
| Variable (optional) | `CLOUDFLARE_ZONE` | Zone name or id when it cannot be inferred from the hostname |
| Variable (optional) | `PAPERCLIP_R2_ASSETS` | `true` to create the R2 bucket `paperclip-assets-<stage>` |
| Variable (optional) | `PAPERCLIP_R2_BUCKET` | Bucket name instead of the default; turns R2 on by itself. A bucket that already exists under that name is adopted, not recreated |
| Variable (optional) | `ALCHEMY_STAGE` | Stage name, default `prod`. The VPS tunnel token belongs to one stage |

The `vps` job of the same workflow needs its own secrets: `VPS_HOST`, `VPS_USER` and
`VPS_SSH_KEY` (private key) or `VPS_SSH_PASSWORD`, plus the optional `VPS_APP_DIR` variable
when the compose directory on the host is not `/docker/paperclip`. It also writes the host's
`.env` from GitHub for every key you choose to keep there (secrets such as `DATABASE_URL`
and `BETTER_AUTH_SECRET`; variables such as `PAPERCLIP_HOSTNAME`); the full list is in the
workflow header and in `../hostinger/.env.example`. Keys you do not define stay as edited on
the host. The tunnel's connector token is the exception: the job reads it from the Cloudflare
API with `CLOUDFLARE_API_TOKEN` and writes it as `TUNNEL_TOKEN`, so the first run already
starts cloudflared; a `TUNNEL_TOKEN` secret overrides that.

API token permissions (dashboard → My Profile → API Tokens → Create Custom Token):

| Scope | Permission |
|-------|-----------|
| Account | Workers Scripts: Edit, Workers KV Storage: Edit, Cloudflare Tunnel: Edit, Secrets Store: Edit, Account Settings: Read |
| Account (only with an R2 bucket) | Workers R2 Storage: Edit |
| Zone (the hostname's zone) | Zone: Read, DNS: Edit, Workers Routes: Edit |

The same token works for `pnpm tunnel-token` locally. The job is idempotent: when nothing
in this directory or in the variables changed, Alchemy reports no changes and the VPS job
starts right away. Untick the `cloudflare` input of the workflow to skip it, for example to
roll an image back while the Cloudflare API is unavailable.

The first deploy creates the tunnel; later deploys keep it, so its connector token does not
change. Outside the workflow, `pnpm tunnel-token` prints it for the VPS `.env` (`TUNNEL_TOKEN`).

This directory is intentionally outside the pnpm workspace so Alchemy's dependency tree
never touches the repository lockfile.
