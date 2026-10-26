import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

/**
 * Stack inputs for the Paperclip Cloudflare edge. Every value comes from the
 * env file passed to `alchemy deploy --env-file` (the CLI loads it into
 * Effect's Config, not into process.env).
 */
export interface StackConfig {
  /** Public hostname of the board, e.g. `paperclip.example.com`. */
  readonly hostname: string;
  /** Explicit zone name or id; inferred from the hostname when unset. */
  readonly zone: string | undefined;
  /** Provision (or adopt) an R2 bucket for Paperclip's S3 storage provider. */
  readonly r2Assets: boolean;
  /** Explicit bucket name; the stack derives `paperclip-assets-<stage>` when unset. */
  readonly r2Bucket: string | undefined;
}

const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export const normalizeHostname = (raw: string): string => {
  const value = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");
  if (!HOSTNAME_RE.test(value)) {
    throw new Error(
      `PAPERCLIP_HOSTNAME must be a bare hostname in a zone on this Cloudflare account (for example paperclip.example.com), got ${JSON.stringify(raw)}`,
    );
  }
  return value;
};

export const parseBoolean = (raw: string, name: string): boolean => {
  const value = raw.trim().toLowerCase();
  if (value === "" || value === "false" || value === "0" || value === "no") return false;
  if (value === "true" || value === "1" || value === "yes") return true;
  throw new Error(`${name} must be true or false, got ${JSON.stringify(raw)}`);
};

// R2 bucket names: 3-63 characters, lowercase letters, digits and hyphens,
// starting and ending with a letter or digit.
const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export const normalizeBucketName = (raw: string): string | undefined => {
  const value = raw.trim();
  if (value === "") return undefined;
  if (!BUCKET_NAME_RE.test(value)) {
    throw new Error(
      `PAPERCLIP_R2_BUCKET must be an R2 bucket name (3-63 lowercase letters, digits or hyphens, starting and ending with a letter or digit), got ${JSON.stringify(raw)}`,
    );
  }
  return value;
};

const optional = (name: string) => Config.String(name).pipe(Config.withDefault(""));

/** Pure validation of the raw env values; throws a descriptive Error. */
export const buildStackConfig = (raw: {
  hostname: string;
  zone: string;
  r2Assets: string;
  r2Bucket: string;
}): StackConfig => {
  if (!raw.hostname.trim()) {
    throw new Error(
      "Set PAPERCLIP_HOSTNAME in deploy/cloudflare/.env (for example paperclip.example.com).",
    );
  }
  const r2Bucket = normalizeBucketName(raw.r2Bucket);
  const r2Switch =
    raw.r2Assets.trim() === "" ? undefined : parseBoolean(raw.r2Assets, "PAPERCLIP_R2_ASSETS");
  if (r2Switch === false && r2Bucket !== undefined) {
    throw new Error(
      "PAPERCLIP_R2_BUCKET names a bucket but PAPERCLIP_R2_ASSETS is false; drop one of the two.",
    );
  }
  return {
    hostname: normalizeHostname(raw.hostname),
    zone: raw.zone.trim().toLowerCase() || undefined,
    // A bucket name alone turns the bucket on.
    r2Assets: r2Switch ?? r2Bucket !== undefined,
    r2Bucket,
  };
};

export const readStackConfig: Effect.Effect<StackConfig, Config.ConfigError> = Effect.gen(
  function* () {
    const raw = {
      hostname: yield* optional("PAPERCLIP_HOSTNAME"),
      zone: yield* optional("CLOUDFLARE_ZONE"),
      r2Assets: yield* optional("PAPERCLIP_R2_ASSETS"),
      r2Bucket: yield* optional("PAPERCLIP_R2_BUCKET"),
    };
    // A configuration mistake is an operator error with a remedy in the
    // message, not a retryable failure: die so the CLI prints it and stops.
    return yield* Effect.try({
      try: () => buildStackConfig(raw),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(Effect.catch((error) => Effect.die(error)));
  },
);
