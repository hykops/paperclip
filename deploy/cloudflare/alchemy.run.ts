import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { readStackConfig } from "./src/stack-config.ts";

// Alchemy stack for the Cloudflare edge in front of a self-hosted Paperclip.
//
// Paperclip itself runs unchanged on your own machine (deploy/hostinger
// docker-compose.yml): Express + Postgres + agent CLIs in Docker, in its
// `authenticated` + `public` mode. Paperclip's own accounts are the login; no
// Cloudflare login sits in front of them. This stack provisions everything on
// the Cloudflare side so that machine needs no open ports:
//
// - Cloudflare Tunnel        the `cloudflared` container on the VPS dials out
// - Tunnel configuration     routes the hostname to http://paperclip:3100
// - DNS CNAME                <hostname> → <tunnel-id>.cfargotunnel.com
// - KV namespace             gateway state: probe history, maintenance flag
// - Gateway Worker           on <hostname>/*: maintenance + outage pages,
//                            /__gateway/status, cron probe every 5 minutes
// - R2 bucket (optional)     uploads via Paperclip's S3 storage provider
//
// Stages are independent: `--stage prod` and `--stage staging` create separate
// tunnels and Workers; pick a different hostname per stage.
//
// Config comes from the env file passed with `--env-file` (the CLI loads it
// into Effect Config, NOT process.env). Cloudflare credentials come from
// `alchemy profile` (OAuth) or CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID.
//
// Resource attributes (`tunnel.tunnelId`, `kv.namespaceId`, ...) are lazy
// Outputs until apply: derive strings from them with Output.map /
// Output.interpolate, never with a JS template literal.

const PAPERCLIP_PORT = 3100;
/** Compose service name of the Paperclip container the tunnel forwards to. */
const ORIGIN_SERVICE = `http://paperclip:${PAPERCLIP_PORT}`;
/**
 * The gateway probes this path. It answers 200 once the server is ready and 503
 * while it starts, without auth or SQL.
 */
const PROBE_PATH = "/api/liveness";

export default Alchemy.Stack(
  "paperclip-edge",
  {
    providers: Cloudflare.providers(),
    // Durable state in the account's Cloudflare state store, shared by every
    // machine and CI run that deploys this stack.
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    const config = yield* readStackConfig;
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const zoneId = yield* Cloudflare.Zone.resolveZoneId({
      accountId,
      zone: config.zone,
      hostname: config.hostname,
    }).pipe(
      Effect.catch((error) =>
        Effect.die(
          new Error(
            `${String(error)}. PAPERCLIP_HOSTNAME must live in a zone on this Cloudflare account; set CLOUDFLARE_ZONE when the zone name cannot be inferred.`,
          ),
        ),
      ),
    );

    // --- Network: tunnel, ingress, DNS ----------------------------------------
    const tunnel = yield* Cloudflare.Tunnel.Tunnel("Tunnel", {
      name: `paperclip-${stage}`,
    });

    yield* Cloudflare.Tunnel.Configuration("TunnelConfig", {
      tunnelId: tunnel.tunnelId,
      // The provider appends the mandatory catch-all (http_status:404) rule.
      ingress: [
        {
          hostname: config.hostname,
          service: ORIGIN_SERVICE,
          originRequest: { connectTimeout: 30 },
        },
      ],
    });

    yield* Cloudflare.DNS.Record("Dns", {
      zoneId,
      name: config.hostname,
      type: "CNAME",
      content: Output.interpolate`${tunnel.tunnelId}.cfargotunnel.com`,
      proxied: true,
      comment: `Paperclip ${stage} tunnel (managed by alchemy)`,
    });

    // --- Gateway Worker + KV ---------------------------------------------------
    const kv = yield* Cloudflare.KV.Namespace("GatewayKv", {
      title: `paperclip-gateway-${stage}`,
    });

    yield* Cloudflare.Worker("Gateway", {
      name: `paperclip-gateway-${stage}`,
      main: `${import.meta.dirname}/src/gateway/worker.ts`,
      routes: [{ pattern: `${config.hostname}/*`, zoneId }],
      workersDev: false,
      compatibility: { date: "2026-10-01" },
      // Origin probe; also keeps the KV probe history fresh for /__gateway/status.
      crons: ["*/5 * * * *"],
      observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
      env: {
        GATEWAY_KV: kv,
        PAPERCLIP_HOSTNAME: config.hostname,
        GATEWAY_STAGE: stage,
        GATEWAY_PROBE_PATH: PROBE_PATH,
      },
    });

    // --- Optional durable storage for uploads ---------------------------------
    // A bucket that already exists under this name (created by hand, or by an
    // earlier stack whose state is gone) is adopted, not recreated: the R2
    // provider identifies buckets by name alone.
    const assets = config.r2Assets
      ? yield* Cloudflare.R2.Bucket("Assets", {
          name: config.r2Bucket ?? `paperclip-assets-${stage}`,
        }).pipe(
          // Uploads are data; `alchemy destroy` forgets the bucket instead of deleting it.
          Alchemy.RemovalPolicy.retain(),
        )
      : undefined;

    return {
      url: `https://${config.hostname}`,
      stage,
      zoneId,
      tunnelId: tunnel.tunnelId,
      /** Paste into the VPS .env as TUNNEL_TOKEN. Also: `pnpm tunnel-token`. */
      tunnelToken: tunnel.token,
      gatewayKvNamespaceId: kv.namespaceId,
      assetsBucket: assets?.bucketName,
    };
  }),
);
