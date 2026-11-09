"""Transactional schema changes to the workbench database."""
from unicodedata import normalize

from .errors import Conflict


def client_name_key(name):
    return ' '.join(normalize('NFKC', name).split()).casefold()


def customer_lifecycle(db):
    checks = (
        ('客户任务', '''SELECT 1 FROM wb_conversations t LEFT JOIN wb_clients c ON c.id=t.client_id
                       WHERE c.id IS NULL'''),
        ('客户资料', '''SELECT 1 FROM wb_document_groups g LEFT JOIN wb_clients c ON c.id=g.client_id
                       LEFT JOIN wb_documents d ON d.id=g.current_document_id
                       LEFT JOIN wb_document_assets a ON a.document_id=d.id AND a.group_id=g.id
                       WHERE c.id IS NULL OR (g.current_document_id IS NOT NULL
                             AND (a.document_id IS NULL OR d.client_id<>g.client_id))'''),
        ('资料修订', '''SELECT 1 FROM wb_documents d LEFT JOIN wb_document_assets a ON a.document_id=d.id
                       LEFT JOIN wb_document_groups g ON g.id=a.group_id AND g.client_id=d.client_id
                       WHERE g.id IS NULL'''),
    )
    for label, sql in checks:
        if db.execute(sql + ' LIMIT 1').fetchone():
            raise Conflict(f'旧库存在失联的{label}，请核对后再升级')
    db.execute('ALTER TABLE wb_clients ADD COLUMN name_key TEXT NOT NULL DEFAULT \'\'')
    db.execute('ALTER TABLE wb_clients ADD COLUMN archived_at TEXT')
    db.execute('ALTER TABLE wb_document_groups ADD COLUMN removed_at TEXT')
    db.executemany('UPDATE wb_clients SET name_key=? WHERE id=?',
                   [(client_name_key(row['name']), row['id']) for row in db.execute('SELECT id,name FROM wb_clients')])
    db.execute('CREATE INDEX wb_clients_active_name ON wb_clients(name_key) WHERE archived_at IS NULL')
    # Existing duplicate groups are retained until the operator resolves them.
    # Only inserts and transitions to a new active name need to pass the guard.
    for name, event, condition in (
        ('wb_client_unique_insert', 'INSERT', ''),
        ('wb_client_unique_update', 'UPDATE OF name_key,archived_at',
         'AND (NEW.name_key<>OLD.name_key OR OLD.archived_at IS NOT NULL)'),
    ):
        db.execute(f'''CREATE TRIGGER {name} BEFORE {event} ON wb_clients
            WHEN NEW.archived_at IS NULL {condition} AND EXISTS (
                SELECT 1 FROM wb_clients WHERE name_key=NEW.name_key AND archived_at IS NULL AND id<>NEW.id)
            BEGIN SELECT RAISE(ABORT,'wb_active_client_name'); END''')
    db.execute('''CREATE TABLE wb_customer_plans_v1(
        client_id TEXT PRIMARY KEY REFERENCES wb_clients(id),revision INTEGER NOT NULL,options TEXT NOT NULL,
        document_groups TEXT NOT NULL,updated_at TEXT NOT NULL)''')
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_customer_plans'").fetchone():
        db.execute('''INSERT INTO wb_customer_plans_v1
            SELECT client_id,revision,options,document_groups,updated_at FROM wb_customer_plans''')
        db.execute('DROP TABLE wb_customer_plans')
    db.execute('ALTER TABLE wb_customer_plans_v1 RENAME TO wb_customer_plans')


def geo_observations(db):
    db.execute('''CREATE TABLE wb_geo_plans(
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES wb_clients(id), revision INTEGER NOT NULL,
        spec_hash TEXT NOT NULL, spec TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(client_id,revision), UNIQUE(client_id,spec_hash), UNIQUE(id,client_id))''')
    db.execute('''CREATE TABLE wb_geo_runs(
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL, plan_id TEXT NOT NULL, request_key TEXT NOT NULL,
        request_hash TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT,
        FOREIGN KEY(plan_id,client_id) REFERENCES wb_geo_plans(id,client_id), UNIQUE(client_id,request_key))''')
    db.execute('''CREATE TABLE wb_geo_items(
        run_id TEXT NOT NULL REFERENCES wb_geo_runs(id), ordinal INTEGER NOT NULL, kind TEXT NOT NULL,
        question TEXT NOT NULL, sample INTEGER NOT NULL, state TEXT NOT NULL, result TEXT, raw TEXT,
        PRIMARY KEY(run_id,ordinal))''')


def geo_active_plan(db):
    db.execute('''CREATE TABLE wb_geo_current_plans(
        client_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL,
        FOREIGN KEY(plan_id,client_id) REFERENCES wb_geo_plans(id,client_id))''')
    db.execute('''INSERT INTO wb_geo_current_plans SELECT p.client_id,p.id FROM wb_geo_plans p
                  WHERE p.revision=(SELECT MAX(old.revision) FROM wb_geo_plans old WHERE old.client_id=p.client_id)''')


def task_lifecycle(db):
    db.execute('''CREATE TABLE IF NOT EXISTS wb_task_lifecycle(
        conversation_id TEXT PRIMARY KEY REFERENCES wb_conversations(id), pinned_at TEXT, archived_at TEXT,
        CHECK(pinned_at IS NULL OR archived_at IS NULL))''')


def import_drafts_and_restore(db):
    if 'import_draft' not in {row['name'] for row in db.execute('PRAGMA table_info(wb_clients)')}:
        db.execute('ALTER TABLE wb_clients ADD COLUMN import_draft INTEGER NOT NULL DEFAULT 0 CHECK(import_draft IN (0,1))')
    db.execute('ALTER TABLE wb_document_groups ADD COLUMN default_excluded INTEGER NOT NULL DEFAULT 0')
    db.execute('DROP INDEX wb_clients_active_name')
    db.execute('CREATE INDEX wb_clients_active_name ON wb_clients(name_key) WHERE archived_at IS NULL AND import_draft=0')
    for name, event, condition in (
        ('wb_client_unique_insert', 'INSERT', ''),
        ('wb_client_unique_update', 'UPDATE OF name_key,archived_at,import_draft',
         'AND (NEW.name_key<>OLD.name_key OR OLD.archived_at IS NOT NULL OR OLD.import_draft=1)'),
    ):
        db.execute(f'DROP TRIGGER {name}')
        db.execute(f'''CREATE TRIGGER {name} BEFORE {event} ON wb_clients
            WHEN NEW.archived_at IS NULL AND NEW.import_draft=0 {condition} AND EXISTS (
                SELECT 1 FROM wb_clients WHERE name_key=NEW.name_key AND archived_at IS NULL AND import_draft=0 AND id<>NEW.id)
            BEGIN SELECT RAISE(ABORT,'wb_active_client_name'); END''')


MIGRATIONS = (customer_lifecycle, geo_observations, geo_active_plan, task_lifecycle, import_drafts_and_restore)


def migrate(store):
    with store.conn() as db:
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('BEGIN IMMEDIATE')
        version = db.execute('PRAGMA user_version').fetchone()[0]
        if version > len(MIGRATIONS):
            raise Conflict('数据库版本高于此工作台支持的版本')
        for next_version, migration in enumerate(MIGRATIONS[version:], start=version + 1):
            migration(db)
            db.execute(f'PRAGMA user_version={next_version}')
