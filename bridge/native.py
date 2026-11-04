"""Resource ownership around the byte-for-byte original ZIP Store."""
import sqlite3
from app.store import Store


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, *exc):
        try:
            return super().__exit__(*exc)
        finally:
            self.close()


class LocalStore(Store):
    def conn(self):
        conn = sqlite3.connect(self.db_path, timeout=15, factory=ClosingConnection)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        return conn
