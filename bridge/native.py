"""Resource ownership around the byte-for-byte original ZIP Store."""
import sqlite3
from contextlib import nullcontext
from app.store import Store


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, *exc):
        try:
            return super().__exit__(*exc)
        finally:
            self.close()


class ArticleInsert:
    """Run the native INSERT inside the caller's SQLite transaction."""
    def __init__(self, connection):
        self.connection = connection

    def conn(self):
        return nullcontext(self.connection)


class LocalStore(Store):
    def conn(self):
        conn = sqlite3.connect(self.db_path, timeout=15, factory=ClosingConnection)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys=ON')
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def add_arranged_article(self, plan_id, position, owner, snapshot_id, values):
        with self.conn() as conn:
            conn.execute('BEGIN IMMEDIATE')
            article_id = Store.add_article(ArticleInsert(conn), plan_id, **values)
            conn.execute('INSERT INTO wb_batch_article_outputs VALUES(?,?)', (article_id, position))
            conn.execute('INSERT INTO wb_article_locks VALUES(?,?)', (article_id, owner))
            conn.execute('INSERT INTO wb_article_sources VALUES(?,?)', (article_id, snapshot_id))
        return article_id
