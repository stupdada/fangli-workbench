"""Customer-approved writing samples in the runtime database."""
import hashlib
from app.store import now
from .errors import Problem
from .storage import dumps, loads, text_value

VIDEO_PLATFORM = '短视频'
VIDEO_FORM = '页面式口播'


class AcceptedExpressions:
    def __init__(self, store):
        self.store = store
        with store.conn() as c:
            c.executescript('''
                CREATE TABLE IF NOT EXISTS wb_accepted_expressions (
                    id TEXT PRIMARY KEY, client_id TEXT NOT NULL, medium TEXT NOT NULL,
                    platform TEXT NOT NULL, form TEXT NOT NULL, record TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS wb_accepted_scope
                    ON wb_accepted_expressions(client_id, medium, platform, form, created_at);
            ''')

    def save(self, client_id, article, selection, excerpt, purpose, medium):
        if selection not in ('excerpt', 'article') or medium not in ('article', 'video'):
            raise Problem('请选择认可范围和适用形式')
        purpose = text_value(purpose, '用途', 200, empty=False).strip()
        body = article['body_md']
        if selection == 'excerpt':
            sample = text_value(excerpt, '选段', 4000, empty=False)
            sample = sample.replace('\r\n', '\n').strip()
            if sample not in body.replace('\r\n', '\n'):
                raise Problem('选段须为采用稿中的连续原文')
        else:
            sample = body
        if not sample.strip():
            raise Problem('当前采用稿没有可保存的正文')
        platform, form = (VIDEO_PLATFORM, VIDEO_FORM) if medium == 'video' else (
            str(article['platform_id']), article['fmt'])
        record = {'client_id': client_id, 'medium': medium, 'platform': platform, 'form': form,
                  'selection': selection, 'purpose': purpose, 'text': sample,
                  'source': {'article_id': article['id'], 'version_id': article['current_version'],
                             'title': article['title'], 'platform_id': article['platform_id'],
                             'platform': article['platform_name'], 'form': article['fmt']}}
        ident = 'accepted-' + hashlib.sha256(dumps(record).encode('utf-8')).hexdigest()
        with self.store.conn() as c:
            c.execute('INSERT OR IGNORE INTO wb_accepted_expressions VALUES(?,?,?,?,?,?,?)',
                      (ident, client_id, medium, platform, form, dumps(record), now()))
        return {'id': ident, **{k: v for k, v in record.items() if k != 'text'}}

    def references(self, client_id, medium, platform, form):
        with self.store.conn() as c:
            rows = c.execute('''SELECT id,record FROM wb_accepted_expressions
                WHERE client_id=? AND medium=? AND platform=? AND form=?
                ORDER BY created_at DESC, rowid DESC LIMIT 2''',
                (client_id, medium, str(platform), form)).fetchall()
        result = []
        for row in rows:
            record = loads(row['record'])
            sample = record['text'].strip()
            result.append({'id': row['id'], 'lesson': record['purpose'],
                           'medium': record['medium'],
                           'sample': sample[:480], 'sample_truncated': len(sample) > 480,
                           'source': record['source']})
        return result
