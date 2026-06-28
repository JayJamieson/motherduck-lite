// motherduck-lite — Worker (control plane + TLS-terminating reverse proxy)
//
// Flow:  DuckDB quack client --HTTPS--> Cloudflare edge (TLS) --> this Worker
//        --> per-db Sandbox DO (DuckSandbox) --> container Quack server :9494
//
// v0 scope:
//   * Read/write, single native .db per database id.
//   * Durability via Sandbox createBackup()/restoreBackup() (squashfs -> R2).
//   * AUTHN ONLY: the shared Quack token IS the credential. The container's
//     default quack token-auth validates the client. NO AUTHZ (every query the
//     engine accepts is allowed). Per-user identity + ACLs are the documented
//     upgrade — see README.
//
// Security note for the PoC: anyone who reaches this Worker URL *and* holds the
// Quack token can connect. The Worker is the only public ingress; the container
// port is never exposed publicly (we route via containerFetch inside the DO).

import { getSandbox } from "@cloudflare/sandbox";
export { DuckSandbox } from "./DuckSandbox";

export interface Env {
  // Durable Object binding -> DuckSandbox class (see wrangler.jsonc).
  DUCK_SANDBOX: DurableObjectNamespace;
  // R2 bucket used by the Sandbox backup/restore API.
  BACKUP_BUCKET: R2Bucket;
  // Shared secret handed to authorized clients; also passed to the container
  // as the quack server token. `wrangler secret put QUACK_TOKEN`.
  QUACK_TOKEN: string;
  // Toggle local dev (uses the R2 binding directly, no presigned creds).
  LOCAL_DEV?: string;
}

// Resolve which logical database this request targets.
// v0: single db "default". Multi-tenant upgrade: derive from Host or path,
// e.g. <db>.warehouse.example.com -> db, and use it as the DO name below.
function resolveDbId(url: URL): string {
  return url.searchParams.get("db") ?? "default";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return new Response("ok\n", { status: 200 });
    }

    const dbId = resolveDbId(url);

    // One Sandbox DO instance per database id => one live container per db =>
    // single-writer is structurally guaranteed (no two Quack servers on one file).
    const sandbox = getSandbox(env.DUCK_SANDBOX, dbId);

    // Mark this request as Quack proxy traffic so the DO forwards it to :9494
    // instead of treating it as Sandbox control-plane traffic.
    const proxied = new Request(request, {
      headers: new Headers(request.headers),
    });
    proxied.headers.set("x-mdl-proxy", "quack");

    // The DO ensures the engine is booted/restored/serving, then proxies.
    return sandbox.fetch(proxied);
  },
};
