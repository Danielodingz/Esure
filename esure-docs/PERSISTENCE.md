# P2 Persistence Contract

P2 adds an optional PostgreSQL-backed published-scenario catalogue and,
separately, opt-in run-report persistence. `PERSISTENCE_MODE=disabled` is the
default. `published` mode never falls back to memory: the process verifies every
migration filename and SHA-256 checksum at startup and fails readiness/startup
if the database is missing or stale. Run reports remain in memory unless
`RUN_PERSISTENCE_ENABLED=true` is also set; enabling it requires
`PERSISTENCE_MODE=published` and `DATABASE_URL`.

Migration 003 extends the existing `runs` table with report fields and a stable
`run_id`. Existing normalized worker-run columns and child tables remain
available. PostgreSQL run reports keep the existing API shape, redact Stellar
secret seeds and account keys before writing JSON, and expire from reads using
`RUN_RETENTION_MS`. The supplied
`migrations/003_persistent_run_history.down.sql` reverses the additive change
and deletes report-only rows; use it only when intentionally discarding that
history.

## Identity and immutability

`scenarios.id` is a server UUID. Bundled/operator scenarios alone have a unique
stable `public_slug`; anonymous inline scenarios must have `public_slug = NULL`,
are unlisted, and retain the submitted scenario ID only as metadata. An inline
definition therefore cannot claim or modify a published slug.

`scenario_versions` is append-only. `(scenario_id, version_number)` and
`(scenario_id, content_hash)` are unique. A trigger rejects every update and
delete. A future cleanup deletion is allowed only when the session is operating
as the maintenance role, explicitly sets the transaction-local
`esure.cleanup_mode=on`, and no run references the version. The foreign key from
`runs` is `RESTRICT`; run children use `CASCADE`, enforcing the approved cleanup
order: terminal run, unreferenced inline version, empty inline scenario.

Fixture reconciliation locks the scenario row, compares canonical definitions
without the server-managed version number, and either does nothing or assigns
`max(version_number)+1` inside the same transaction. It rewrites the definition's
version and calculates the canonical SHA-256 hash before insertion. Constraints
provide the final concurrency guard.

## Database roles

- `esure_application`: read published scenarios/versions and create/update run
  reports. It cannot mutate versions or access cleanup audit records.
- `esure_worker`: later claims and progressively updates runs and evidence. It
  cannot mutate scenario versions or access cleanup audit records.
- `esure_maintenance`: future bounded cleanup only. Version deletion additionally
  requires the trigger conditions above and must create an audit entry.
- `esure_migrations`: owns schema changes and fixture reconciliation. Its URL is
  used only by explicit one-shot commands, never by the web process.

`database/bootstrap-roles.sql` creates NOLOGIN group roles. Each environment uses
separate provider-managed LOGIN credentials granted exactly one group role. Run
`npm run db:migrate` and `npm run db:reconcile` with
`DATABASE_MIGRATION_URL`; the backend receives only the application URL.

Render supports multiple managed PostgreSQL credentials and also permits users
created with SQL, although SQL-created users are not managed in its dashboard.
The secure deployment equivalent is separate Render-managed login credentials,
membership in the NOLOGIN group roles above, and direct port 5432 for migrations.
Transaction-mode PgBouncer is compatible with the transaction-scoped advisory
migration lock; direct connections remain preferable for migrations. The Node
pool defaults to five connections with 5-second connection/query timeouts and a
10-second idle timeout.

## Backup and restore rehearsal

Run this rehearsal only against two new, disposable local databases. The commands
assume PostgreSQL client tools are installed and are run from `esure-backend/`.
Use local placeholder passwords, not deployed credentials. The cluster administrator
is used only to create databases and provision roles; application and migration
connections remain separate.

```sh
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres
export PGPASSWORD='replace-with-local-placeholder'
export SOURCE_DB=esure_backup_source
export RESTORE_DB=esure_backup_restore
createdb "$SOURCE_DB"
createdb "$RESTORE_DB"

export SOURCE_ADMIN_URL='postgresql://postgres:replace-with-local-placeholder@127.0.0.1:5432/esure_backup_source'
export RESTORE_ADMIN_URL='postgresql://postgres:replace-with-local-placeholder@127.0.0.1:5432/esure_backup_restore'
export DATABASE_URL='postgresql://esure_app_rehearsal:replace-with-local-placeholder@127.0.0.1:5432/esure_backup_source'
export DATABASE_MIGRATION_URL='postgresql://esure_migration_rehearsal:replace-with-local-placeholder@127.0.0.1:5432/esure_backup_source'

psql "$SOURCE_ADMIN_URL" -v ON_ERROR_STOP=1 -f database/bootstrap-roles.sql
psql "$SOURCE_ADMIN_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE esure_app_rehearsal LOGIN PASSWORD 'replace-with-local-placeholder';
CREATE ROLE esure_migration_rehearsal LOGIN PASSWORD 'replace-with-local-placeholder';
GRANT esure_application TO esure_app_rehearsal;
GRANT esure_migrations TO esure_migration_rehearsal;
SQL

npm run db:migrate
npm run db:reconcile

export BACKUP_FILE=/tmp/esure-persistence-rehearsal.dump
pg_dump --format=custom --dbname="$SOURCE_ADMIN_URL" --file="$BACKUP_FILE"
pg_restore --dbname="$RESTORE_ADMIN_URL" "$BACKUP_FILE"
```

The bootstrap file must be run while connected to the target database: its schema
grant is database-local. It creates NOLOGIN group roles, not LOGIN credentials.
The archive contains one database, not cluster roles, role memberships, or
passwords. For a restore to another cluster, provision the group and LOGIN roles
there before restoring. Restore without `--no-owner` so objects retain the
`esure_migrations` ownership needed by migration verification. The restore target
must be new; the commands intentionally do not overwrite an existing database.

Compare the published versions and their stored content hashes on both databases:

```sh
psql "$SOURCE_ADMIN_URL" -X -v ON_ERROR_STOP=1 -At -F '|' -c "SELECT s.public_slug, sv.version_number, sv.schema_version, sv.content_hash FROM scenarios s JOIN scenario_versions sv ON sv.scenario_id = s.id WHERE s.visibility = 'published' AND s.status = 'active' ORDER BY s.public_slug, sv.version_number" > /tmp/esure-source-versions.txt
psql "$RESTORE_ADMIN_URL" -X -v ON_ERROR_STOP=1 -At -F '|' -c "SELECT s.public_slug, sv.version_number, sv.schema_version, sv.content_hash FROM scenarios s JOIN scenario_versions sv ON sv.scenario_id = s.id WHERE s.visibility = 'published' AND s.status = 'active' ORDER BY s.public_slug, sv.version_number" > /tmp/esure-restore-versions.txt
diff -u /tmp/esure-source-versions.txt /tmp/esure-restore-versions.txt

psql "$SOURCE_ADMIN_URL" -X -v ON_ERROR_STOP=1 -At -F '|' -c "SELECT version, filename, checksum FROM schema_migrations ORDER BY version" > /tmp/esure-source-migrations.txt
psql "$RESTORE_ADMIN_URL" -X -v ON_ERROR_STOP=1 -At -F '|' -c "SELECT version, filename, checksum FROM schema_migrations ORDER BY version" > /tmp/esure-restore-migrations.txt
diff -u /tmp/esure-source-migrations.txt /tmp/esure-restore-migrations.txt
sha256sum migrations/001_persistence_foundation.sql migrations/002_role_privileges.sql migrations/003_persistent_run_history.sql

psql "$RESTORE_ADMIN_URL" -X -v ON_ERROR_STOP=1 -c "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname IN ('esure_application', 'esure_worker', 'esure_maintenance', 'esure_migrations', 'esure_app_rehearsal', 'esure_migration_rehearsal') ORDER BY rolname" -c "SELECT member.rolname AS login_role, parent.rolname AS granted_role FROM pg_auth_members m JOIN pg_roles member ON member.oid = m.member JOIN pg_roles parent ON parent.oid = m.roleid WHERE member.rolname IN ('esure_app_rehearsal', 'esure_migration_rehearsal') ORDER BY login_role" -c "SELECT has_table_privilege('esure_app_rehearsal', 'scenario_versions', 'SELECT') AS app_can_read_versions, has_table_privilege('esure_app_rehearsal', 'scenario_versions', 'INSERT') AS app_can_insert_versions, has_table_privilege('esure_migration_rehearsal', 'schema_migrations', 'SELECT') AS migrations_can_verify"

export DATABASE_MIGRATION_URL='postgresql://esure_migration_rehearsal:replace-with-local-placeholder@127.0.0.1:5432/esure_backup_restore'
npm run db:reconcile
```

Both `diff` commands should produce no output. In this checkout the catalogue
query returns 13 published versions across 13 slugs; each is version 1 with
schema version 1 and a `sha256:` content hash. The migration query returns
versions 1, 2, and 3; compare each recorded checksum with `sha256sum`. The role
query should show four NOLOGIN group roles, each rehearsal LOGIN granted its
matching group, and privileges `t`, `f`, `t` respectively. A successful
restore-side `db:reconcile` also verifies the recorded migration filenames and
checksums against the current migration files.

Published scenario versions are durable in `published` mode. Run reports are
in-memory by default; `RUN_PERSISTENCE_ENABLED=true` with `PERSISTENCE_MODE=published`
stores reports in PostgreSQL. This rehearsal verifies database contents, not
durable execution, worker leases, or restart/resume behavior; that planned work is
tracked in [#21](https://github.com/Esureorg/Esure/issues/21).

Stop the rehearsal on any failed command or mismatch. Leave the source database
untouched, create a fresh disposable restore target for another attempt, and do
not use destructive restore or down-migration commands against a live database.
For production, use a pre-migration backup or point-in-time restore only for
destructive incompatibility; use a new forward repair migration for ordinary
defects. Applied migration files are never edited.

Migrations are numbered, applied in one transaction under a transaction-scoped
advisory lock, and recorded with filename plus SHA-256 checksum. A changed
historical migration or missing migration fails startup verification. A failed
migration rolls back completely. Production rollback uses a pre-migration
backup/point-in-time restore for destructive incompatibility and a new forward
repair migration for ordinary defects; applied migration files are never edited
and automatic destructive down-migrations are not used.

References: [Render database credentials](https://render.com/docs/postgresql-credentials)
and [Render connection pooling](https://render.com/docs/postgresql-connection-pooling).

## Proposed later-phase contracts (not active in P2.0-P2.2)

Every worker mutation will be fenced by `lease_owner`, a monotonically increasing
`lease_epoch`, an unexpired lease, and the expected run status. Heartbeats,
progress writes, and finalization use compare-and-set predicates. A stale worker
must stop after any zero-row mutation.

Idempotency records store `hmac-sha256(key)` rather than the supplied key and bind
it to an endpoint plus canonical `sha256` request fingerprint. Same key/request
returns the original run; a mismatch returns a generic 409 without revealing an
inline definition.

Before any Stellar submission, the exact signed transaction is built in memory,
its deterministic transaction hash is persisted with prepared step evidence,
and that transaction commits under the active lease. Seeds and signed/raw XDR are
never persisted. If persistence fails before that commit, no submission occurs.
If persistence fails after submission, the transaction is never automatically
resubmitted; recovery later queries Testnet Horizon by the stored hash.
