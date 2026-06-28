#!/usr/bin/env bash
# Smoke test: attach to the deployed Quack server, confirm the round trip,
# then write and read back.
#
# Usage:
#   WORKER_URL=https://your-worker.example.workers.dev QUACK_TOKEN=token ./scripts/smoke-test.sh
#   VERIFY=1 WORKER_URL=... QUACK_TOKEN=... ./scripts/smoke-test.sh   # read-only (durability check)
#
# Requires the duckdb CLI (>= 1.5.3) on PATH.
#
# Beta-Quack client rules this test obeys:
#   * No DELETE/UPDATE over ATTACH ("Can only delete from base table") — run
#     those server-side via quack_query(), or reset with CREATE OR REPLACE.
#   * No streaming source (range(), read_csv, ...) feeding INSERT/CTAS, and no
#     scanning a streamed result twice (UNION ALL) in one statement
#     ("Multiple streaming scans ..."). Use literal VALUES / single scans.

set -euo pipefail

: "${WORKER_URL:?set WORKER_URL to your deployed Worker URL}"
: "${QUACK_TOKEN:?set QUACK_TOKEN to the shared token}"

# Quack URIs are `quack:host:port` with NO scheme and NO path/query.
HOST="${WORKER_URL#http://}"; HOST="${HOST#https://}"; HOST="${HOST%%/*}"
QURI="quack:${HOST}:443"
echo "Connecting to ${QURI} ..."

if [ "${VERIFY:-}" = "1" ]; then
  duckdb <<SQL
CREATE SECRET (TYPE quack, SCOPE '${QURI}', TOKEN '${QUACK_TOKEN}');
ATTACH '${QURI}' AS w;
USE w;
SELECT count(*) AS rows, max(sq) AS max_sq FROM smoke;
SQL
  echo
  echo "VERIFY: if you still see 10 | 100 after a cold start, the data survived restore."
  exit 0
fi

duckdb <<SQL
CREATE SECRET (TYPE quack, SCOPE '${QURI}', TOKEN '${QUACK_TOKEN}');

-- Prove the round trip reaches the server (shipped verbatim to remote):
FROM quack_query('${QURI}', 'FROM whoami()');

ATTACH '${QURI}' AS w;
USE w;

-- CREATE OR REPLACE gives an idempotent clean slate without a client DELETE.
CREATE OR REPLACE TABLE smoke (i INTEGER, sq INTEGER);
-- Literal VALUES: no streaming source feeding the write.
INSERT INTO smoke VALUES (1,1),(2,4),(3,9),(4,16),(5,25),(6,36),(7,49),(8,64),(9,81),(10,100);

-- Single-scan aggregate (not UNION ALL): expect 10 | 100
SELECT count(*) AS rows, max(sq) AS max_sq FROM smoke;
SQL

echo
echo "If whoami() returned server info and you see 10 | 100, the write hit the"
echo "server. To check durability: cause a cold start (redeploy or idle past"
echo "sleepAfter), then run with VERIFY=1 to read without resetting the table."
