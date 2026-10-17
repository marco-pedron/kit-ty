import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// SQLite storage of the relay (node:sqlite, built into Node 22: no native dependency).
// Both tables are append-only: triggers abort any UPDATE or DELETE, so not even a bug in the
// relay can rewrite history. A backup is never overwritten either: a PUT adds a version and a
// GET returns the latest one.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq         INTEGER PRIMARY KEY,
  trip_id     TEXT NOT NULL,
  nonce       TEXT NOT NULL UNIQUE,
  type        TEXT NOT NULL,
  author      TEXT NOT NULL,
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL UNIQUE,
  received_at TEXT NOT NULL,
  stored_json TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TABLE IF NOT EXISTS backups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pubkey     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  blob       BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS backups_by_pubkey ON backups (pubkey, id);
CREATE TRIGGER IF NOT EXISTS backups_no_update BEFORE UPDATE ON backups
BEGIN SELECT RAISE(ABORT, 'backups are append-only'); END;
CREATE TRIGGER IF NOT EXISTS backups_no_delete BEFORE DELETE ON backups
BEGIN SELECT RAISE(ABORT, 'backups are append-only'); END;
`;

export interface EventRow {
  seq: number;
  tripId: string;
  nonce: string;
  type: string;
  author: string;
  prevHash: string;
  hash: string;
  receivedAt: string;
  /** The StoredEvent as encoded on the wire (bigints as decimal strings). */
  storedJson: string;
}

export interface BackupRow {
  /** Monotonic id of this version. */
  version: number;
  createdAt: string;
  blob: Uint8Array;
}

export interface RelayDb {
  insertEvent(row: EventRow): void;
  /** Rows with seq > sinceSeq, in seq order. */
  listEvents(sinceSeq?: number): EventRow[];
  hasNonce(nonce: string): boolean;
  putBackup(pubkey: string, blob: Uint8Array, createdAt: string): number;
  latestBackup(pubkey: string): BackupRow | null;
  /** Raw access, for tests that check the append-only triggers. */
  readonly raw: DatabaseSync;
  close(): void;
}

/** `path` is a file, or ':memory:' for tests. */
export function openRelayDb(path: string): RelayDb {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);

  const insert = db.prepare(
    `INSERT INTO events (seq, trip_id, nonce, type, author, prev_hash, hash, received_at, stored_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const list = db.prepare(
    `SELECT seq, trip_id, nonce, type, author, prev_hash, hash, received_at, stored_json
     FROM events WHERE seq > ? ORDER BY seq`,
  );
  const nonce = db.prepare('SELECT 1 FROM events WHERE nonce = ?');
  const putBackup = db.prepare('INSERT INTO backups (pubkey, created_at, blob) VALUES (?, ?, ?)');
  const latestBackup = db.prepare(
    'SELECT id, created_at, blob FROM backups WHERE pubkey = ? ORDER BY id DESC LIMIT 1',
  );

  return {
    insertEvent(r) {
      insert.run(
        r.seq,
        r.tripId,
        r.nonce,
        r.type,
        r.author,
        r.prevHash,
        r.hash,
        r.receivedAt,
        r.storedJson,
      );
    },
    listEvents(sinceSeq = 0) {
      return list.all(sinceSeq).map((r) => ({
        seq: Number(r.seq),
        tripId: String(r.trip_id),
        nonce: String(r.nonce),
        type: String(r.type),
        author: String(r.author),
        prevHash: String(r.prev_hash),
        hash: String(r.hash),
        receivedAt: String(r.received_at),
        storedJson: String(r.stored_json),
      }));
    },
    hasNonce(n) {
      return nonce.get(n) !== undefined;
    },
    putBackup(pubkey, blob, createdAt) {
      return Number(putBackup.run(pubkey, createdAt, blob).lastInsertRowid);
    },
    latestBackup(pubkey) {
      const r = latestBackup.get(pubkey);
      if (r === undefined) return null;
      return {
        version: Number(r.id),
        createdAt: String(r.created_at),
        blob: r.blob as Uint8Array,
      };
    },
    raw: db,
    close() {
      db.close();
    },
  };
}
