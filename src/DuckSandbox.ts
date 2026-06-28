// DuckSandbox — a Sandbox (Durable Object) subclass that owns one logical
// database: its lifecycle, durability loop, and proxying to the Quack server.
//
// Responsibilities:
//   boot()        cold-start: restore latest snapshot (if any) -> start the
//                 Quack host process -> wait for :9494 -> arm the reaper.
//   alarm()       reaper: checkpoint -> chmod -> createBackup -> persist handle
//                 -> reschedule. This is the *only* path that makes writes
//                 durable, so the reaper interval is the data-loss window.
//   fetch()       branch: x-mdl-proxy traffic -> containerFetch(:9494);
//                 everything else -> Sandbox control plane (super.fetch).
//
// Notes:
//   * The restore overlay is lost on sleep/restart, so boot() always re-restores
//     from the handle in DO storage (which IS durable across sleeps).
//   * createBackup only captures completed writes, so we CHECKPOINT first to fold
//     the WAL into the main file before snapshotting.

import { Sandbox } from "@cloudflare/sandbox";
import type { DirectoryBackup } from "@cloudflare/sandbox";

const DB_DIR = "/work";
const DB_PATH = `${DB_DIR}/main.duckdb`;
const QUACK_PORT = 9494;
const ADMIN_PORT = 8088; // quackhost admin (checkpoint/health), localhost-only
const REAPER_MS = 60_000; // <- data-loss window. Keep < sleepAfter (10m).
const BACKUP_TTL_S = 7 * 24 * 60 * 60;
const PROC_ID = "quackhost"; // stable id so we can detect an existing process

interface DuckEnv {
  BACKUP_BUCKET: R2Bucket;
  QUACK_TOKEN: string;
  LOCAL_DEV?: string;
}

export class DuckSandbox extends Sandbox<DuckEnv> {
  private serving = false;
  private bootPromise?: Promise<void>;

  // ---- request routing -----------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("x-mdl-proxy") !== "quack") {
      // Sandbox SDK control-plane traffic (port 3000) — leave untouched.
      return super.fetch(request);
    }
    await this.ensureServing();
    // Internal hop, container port never publicly exposed. Quack is HTTP-framed
    // so we can forward bytes without understanding the protobuf body.
    return this.containerFetch(request, QUACK_PORT);
  }

  // ---- lifecycle ------------------------------------------------------------

  async ensureServing(): Promise<void> {
    if (this.serving) return;
    // DO requests aren't strictly serialized, so coalesce concurrent callers
    // onto a single boot to avoid racing two startProcess calls.
    if (!this.bootPromise) {
      this.bootPromise = this.bringUp().finally(() => {
        this.bootPromise = undefined;
      });
    }
    await this.bootPromise;
  }

  private async bringUp(): Promise<void> {
    // The DO can hibernate while the container (and quackhost, holding the .db
    // lock) keeps running. In-memory `serving` is then false on a fresh DO
    // instance — so check for a live process before starting a second one
    // (which would fail with "Conflicting lock is held").
    const existing = await this.getProcess(PROC_ID).catch(() => null);
    if (existing && (existing.status === "running" || existing.status === "starting")) {
      try {
        await existing.waitForPort(QUACK_PORT, { mode: "tcp", timeout: 30_000 });
      } catch {
        /* already up from a prior session; best-effort readiness check */
      }
      this.serving = true;
      await this.armReaper();
      return;
    }
    await this.boot();
  }

  private async armReaper(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + REAPER_MS);
    }
  }

  // Configure the per-db server-side init script (catalog/ATTACH/secrets/SET
  // GLOBAL). Applied on next boot. Call from an admin route in the Worker.
  async setInitScript(sql: string): Promise<void> {
    await this.ctx.storage.put("initSql", sql);
  }

  private async boot(): Promise<void> {
    await this.exec(`mkdir -p ${DB_DIR}`);

    // Restore the latest snapshot if we have one; otherwise this is first boot
    // and the Quack host will create a fresh db file on start.
    const handle = await this.ctx.storage.get<DirectoryBackup>("backupHandle");
    if (handle) {
      const res = await this.restoreBackup(handle);
      if (!res.success) {
        // Don't silently start on an empty db over a db we *thought* existed.
        throw new Error(`restoreBackup failed for ${handle.id}`);
      }
    }

    // Per-db server-side init script. Written OUTSIDE /work so it's never part
    // of a snapshot, and re-materialized on every boot. quackhost runs it
    // against the instance before serving; idempotency is the script's job.
    // Falls back to the baked /app/init.sql when none is configured.
    let initPath = "/app/init.sql";
    const initSql = await this.ctx.storage.get<string>("initSql");
    if (initSql) {
      initPath = "/tmp/mdl-init.sql";
      await this.writeFile(initPath, initSql);
    }

    // Long-lived Quack server. The host process owns the only RW handle to the
    // file (single-writer) and exposes a localhost admin for checkpoints.
    // onOutput/onExit surface the process's stdout/stderr in `wrangler tail`.
    const proc = await this.startProcess("/app/quackhost", {
      processId: PROC_ID,
      env: {
        DB_PATH,
        QUACK_HOST: "0.0.0.0",
        QUACK_PORT: String(QUACK_PORT),
        QUACK_TOKEN: this.env.QUACK_TOKEN,
        ADMIN_ADDR: `127.0.0.1:${ADMIN_PORT}`,
        INIT_SQL_PATH: initPath,
      },
      onOutput: (stream, data) => console.log(`[quackhost ${stream}] ${data}`),
      onExit: (code) => console.log(`[quackhost exit] code=${code}`),
    });

    // waitForPort is a method on the returned Process, not on the Sandbox.
    // TCP mode just confirms the port is accepting — the Quack server doesn't
    // answer GET / with a 2xx, so an HTTP readiness check would never pass.
    try {
      await proc.waitForPort(QUACK_PORT, { mode: "tcp", timeout: 60_000 });
    } catch (err) {
      // Dump whatever the process logged so the failure cause is visible.
      try {
        const logs = await proc.getLogs();
        console.error("[quackhost stdout]\n" + logs.stdout);
        console.error("[quackhost stderr]\n" + logs.stderr);
      } catch {}
      throw err;
    }
    this.serving = true;
    await this.armReaper();
  }

  // ---- durability loop ------------------------------------------------------

  async alarm(): Promise<void> {
    // Gate on the actual process, not in-memory state: the DO may have
    // hibernated since the alarm was set. Don't wake a sleeping container just
    // to back it up — if it's not running, stop the loop (ensureServing re-arms
    // it on the next request).
    const proc = await this.getProcess(PROC_ID).catch(() => null);
    const running = !!proc && (proc.status === "running" || proc.status === "starting");
    if (!running) {
      this.serving = false;
      return;
    }
    this.serving = true;
    try {
      await this.checkpointAndBackup();
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + REAPER_MS);
    }
  }

  // Best-effort durable snapshot on graceful container stop, tightening the
  // loss window for clean sleeps (ungraceful eviction still falls back to the
  // last reaper backup). Runs before super.onStop() tears things down.
  async onStop(): Promise<void> {
    try {
      const proc = await this.getProcess(PROC_ID).catch(() => null);
      if (proc && (proc.status === "running" || proc.status === "starting")) {
        await this.checkpointAndBackup();
      }
    } catch {
      /* best effort */
    }
    await super.onStop();
  }

  private async checkpointAndBackup(): Promise<void> {
    // 1) Fold WAL into the main file (only completed writes get snapshotted).
    await this.exec(
      `curl -fsS -X POST http://127.0.0.1:${ADMIN_PORT}/checkpoint`,
    );
    // 2) mksquashfs needs read access across the tree.
    await this.exec(`chmod -R a+rX ${DB_DIR}`);
    // 3) Snapshot -> R2, persist the handle for the next cold boot.
    const backup = await this.createBackup({
      dir: DB_DIR,
      name: `db-${Date.now()}`,
      ttl: BACKUP_TTL_S,
      // localBucket avoids presigned-URL creds during `wrangler dev`.
      localBucket: this.env.LOCAL_DEV === "true",
    });
    await this.ctx.storage.put("backupHandle", backup);
  }
}
