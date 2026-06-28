// quackhost — long-lived process that serves a DuckDB database over the Quack
// remote protocol, plus a localhost-only admin endpoint the reaper uses to
// FORCE CHECKPOINT before snapshotting.
//
// One process owns the read/write handle to the .db file (single writer). The
// Quack server runs on background threads inside the same DuckDB instance, so
// a checkpoint issued from any connection to that instance flushes the WAL.
//
// Server-side init: before serving, we run INIT_SQL_PATH against the instance.
// Anything instance-level it creates (catalog tables/views/macros, ATTACH,
// CREATE SECRET, LOAD, SET GLOBAL) is shared with every connecting Quack client.
// The script runs on EVERY boot and must be idempotent: persistent catalog
// objects also return via restore, while ATTACH/secrets/extensions/SET GLOBAL
// are not persisted and must be re-established each cold start.
//
// Requires a go-duckdb build bundling DuckDB >= 1.5.3 (Quack as a core,
// autoloadable extension). If your pin is older, INSTALL quack from the
// core_nightly repo in the init below.

package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	_ "github.com/duckdb/duckdb-go/v2"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// quack_serve is a CALL with named args; the token is interpolated (not bound),
// so escape single quotes defensively even though it's our own secret.
func sqlString(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

// runScript executes a multi-statement SQL file against the instance, statement
// by statement (the driver runs one statement per Exec). Naive ';' splitting:
// fine for a config/init script — don't put ';\n' inside a string literal.
func runScript(ctx context.Context, db *sql.DB, path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil // no init configured — that's fine
		}
		return err
	}
	for _, stmt := range strings.Split(string(raw), ";\n") {
		s := strings.TrimSpace(stmt)
		if s == "" || strings.HasPrefix(s, "--") {
			continue
		}
		if _, err := db.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("init stmt %q: %w", s, err)
		}
	}
	return nil
}

func main() {
	dbPath := env("DB_PATH", "/work/main.duckdb")
	host := env("QUACK_HOST", "0.0.0.0")
	port := env("QUACK_PORT", "9494")
	token := os.Getenv("QUACK_TOKEN")
	adminAddr := env("ADMIN_ADDR", "127.0.0.1:8088")
	initPath := env("INIT_SQL_PATH", "/app/init.sql")
	if token == "" {
		log.Fatal("QUACK_TOKEN is required")
	}

	db, err := sql.Open("duckdb", dbPath)
	if err != nil {
		log.Fatalf("open duckdb: %v", err)
	}
	// Keep it open for the life of the process; do NOT close until shutdown.
	db.SetMaxOpenConns(4)

	ctx := context.Background()

	// Fail fast with a clear message if the bundled engine can't even open.
	if err := db.PingContext(ctx); err != nil {
		log.Fatalf("ping duckdb: %v", err)
	}
	var ver string
	if err := db.QueryRowContext(ctx, "SELECT version()").Scan(&ver); err == nil {
		log.Printf("duckdb version: %s", ver)
	}

	// Quack is core+autoloadable from v1.5.3, but the extension binary is fetched
	// on first use, so the container needs outbound network. Try the core repo,
	// then core_nightly, and make failure fatal+loud (the previous silent path
	// let the process limp on and then crash inside quack_serve).
	if _, err := db.ExecContext(ctx, "INSTALL quack; LOAD quack;"); err != nil {
		log.Printf("quack from core failed: %v; trying core_nightly", err)
		if _, err2 := db.ExecContext(ctx, "INSTALL quack FROM core_nightly; LOAD quack;"); err2 != nil {
			log.Fatalf("could not load quack extension: %v", err2)
		}
	}
	log.Print("quack extension loaded")

	// Server-side init: runs BEFORE serving so the catalog/secrets/attachments
	// are guaranteed present at the first client connect. Must be idempotent.
	if err := runScript(ctx, db, initPath); err != nil {
		log.Fatalf("server init (%s): %v", initPath, err)
	}

	serveSQL := fmt.Sprintf(
		"CALL quack_serve('quack:%s:%s', token => %s, allow_other_hostname => true);",
		host, port, sqlString(token),
	)
	if _, err := db.ExecContext(ctx, serveSQL); err != nil {
		log.Fatalf("quack_serve: %v", err)
	}
	log.Printf("quack server listening on %s:%s, db=%s", host, port, dbPath)

	// Admin: localhost-only checkpoint + health. The reaper POSTs /checkpoint
	// right before createBackup so only completed writes are captured.
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("/checkpoint", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		cctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		// FORCE so a live client transaction doesn't fail the reaper; in >=1.4
		// it waits for the checkpoint lock rather than aborting transactions.
		if _, err := db.ExecContext(cctx, "FORCE CHECKPOINT;"); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("checkpointed\n"))
	})
	admin := &http.Server{Addr: adminAddr, Handler: mux}
	go func() {
		if err := admin.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("admin server: %v", err)
		}
	}()

	// Graceful stop: best-effort final checkpoint. (An ungraceful eviction skips
	// this — durability still bounded by the reaper's last successful backup.)
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	<-stop
	log.Print("shutdown: final checkpoint")
	sctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := db.ExecContext(sctx, "FORCE CHECKPOINT;"); err != nil {
		log.Printf("final checkpoint: %v", err)
	}
	_ = admin.Shutdown(sctx)
	_ = db.Close()
}
