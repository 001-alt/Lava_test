"""Local, transactional document repository. No client-provided SQL or paths."""
import json
import os
import sqlite3
import threading
import time


KEYS = {
    'slots': 'key', 'records': 'dedupKey', 'bad': 'id', 'error': 'id',
    'judgements': 'id', 'archives': 'id', 'workorders': 'id', 'devices': 'id',
    'logindex': 'id', 'ledger': 'dedupKey', 'rawfiles': 'path', 'meta': 'k',
}
FIELDS = {'station', 'sn', 'day', 'result', 'state', 'woNo', 'time', 'at',
          'confirmed', 'handled', 'verdict', 'path', 'pulledAt', 'releasedAt',
          'createdAt', 'cabinet', 'ip', 'no', 'status', 'dedupKey'}


class SQLiteStore:
    def __init__(self, path):
        self.path = os.path.abspath(path)
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.path, timeout=10, check_same_thread=False)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('PRAGMA busy_timeout=10000')
        self.db.execute('CREATE TABLE IF NOT EXISTS documents ('
                        'collection TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL,'
                        'PRIMARY KEY(collection, key))')
        for field in ('station', 'sn', 'day', 'result', 'state', 'woNo'):
            self.db.execute("CREATE INDEX IF NOT EXISTS idx_%s ON documents "
                            "(collection, json_extract(payload, '$.%s'))" % (field, field))
        self.db.execute('PRAGMA user_version=1')
        self.db.commit()

    def info(self):
        with self.lock:
            usage = sum(os.path.getsize(p) for p in
                        (self.path, self.path + '-wal', self.path + '-shm') if os.path.exists(p))
            return {'backend': 'sqlite', 'schemaVersion': 1, 'usage': usage,
                    'quota': 0, 'usedPct': 0,
                    'database': self.path, 'sqliteVersion': sqlite3.sqlite_version}

    def execute(self, request):
        if not isinstance(request, dict):
            raise ValueError('请求必须是 JSON 对象')
        action = request.get('action')
        store = request.get('store')
        if action == 'info':
            return self.info()
        if action == 'clearAll':
            with self.lock, self.db:
                # Configuration lives in meta and is preserved just like browser mode.
                self.db.execute("DELETE FROM documents WHERE NOT "
                                "(collection='meta' AND key='appConfig')")
            return True
        if store not in KEYS:
            raise ValueError('未知数据表')
        if action == 'putMany':
            records = request.get('records')
            if not isinstance(records, list) or len(records) > 10000:
                raise ValueError('每批最多 10000 条记录')
            rows = []
            for rec in records:
                if not isinstance(rec, dict) or not isinstance(rec.get(KEYS[store]), str) or not rec[KEYS[store]]:
                    raise ValueError('记录缺少有效主键：' + KEYS[store])
                rows.append((store, rec[KEYS[store]], json.dumps(rec, ensure_ascii=False, allow_nan=False)))
            with self.lock, self.db:
                self.db.executemany('INSERT INTO documents VALUES (?, ?, ?) '
                                    'ON CONFLICT(collection, key) DO UPDATE SET payload=excluded.payload', rows)
            return len(rows)
        if action in ('get', 'delete', 'deleteMany', 'ledgerFilter', 'ledgerMark'):
            keys = request.get('keys', [])
            if not isinstance(keys, list) or len(keys) > 10000 or any(not isinstance(k, str) for k in keys):
                raise ValueError('无效主键列表')
            with self.lock, self.db:
                if action == 'get':
                    result = []
                    for key in keys:
                        row = self.db.execute('SELECT payload FROM documents WHERE collection=? AND key=?',
                                              (store, key)).fetchone()
                        if row:
                            result.append(json.loads(row[0]))
                    return result
                if action in ('delete', 'deleteMany'):
                    before = self.db.total_changes
                    self.db.executemany('DELETE FROM documents WHERE collection=? AND key=?',
                                        [(store, k) for k in keys])
                    return self.db.total_changes - before
                if store != 'ledger':
                    raise ValueError('台账操作仅允许 ledger 表')
                if action == 'ledgerFilter':
                    return [k for k in keys if self.db.execute(
                        'SELECT 1 FROM documents WHERE collection=? AND key=?', (store, k)).fetchone()]
                before = self.db.total_changes
                self.db.executemany('INSERT OR IGNORE INTO documents VALUES (?, ?, ?)',
                                    [(store, k, json.dumps({'dedupKey': k, 'at': int(time.time() * 1000)}))
                                     for k in keys])
                return self.db.total_changes - before
        if action == 'clear':
            with self.lock, self.db:
                self.db.execute('DELETE FROM documents WHERE collection=?', (store,))
            return 0
        if action in ('query', 'count'):
            filters = request.get('filter') or {}
            opts = request.get('opts') or {}
            if not isinstance(filters, dict) or not isinstance(opts, dict):
                raise ValueError('查询参数无效')
            where, args = ['collection=?'], [store]
            field = filters.get('index')
            if field:
                if field not in FIELDS:
                    raise ValueError('不支持的查询字段')
                expr = "json_extract(payload, '$.%s')" % field
                if 'value' in filters:
                    where.append(expr + ' IS ?')
                    args.append(filters['value'])
                if 'lower' in filters:
                    where.append(expr + (' > ?' if filters.get('lowerOpen') else ' >= ?'))
                    args.append(filters['lower'])
                if 'upper' in filters:
                    where.append(expr + (' < ?' if filters.get('upperOpen') else ' <= ?'))
                    args.append(filters['upper'])
            if 'from' in filters:
                field = field or 'time'
                where.append("json_extract(payload, '$.%s') >= ?" % field)
                args.append(filters['from'])
            sql = 'SELECT %s FROM documents WHERE %s' % (
                'COUNT(*)' if action == 'count' else 'payload', ' AND '.join(where))
            if action == 'query':
                sort = opts.get('sortBy') or field
                if sort:
                    if sort not in FIELDS:
                        raise ValueError('不支持的排序字段')
                    sql += " ORDER BY json_extract(payload, '$.%s') %s, key" % (sort, 'DESC' if opts.get('desc') else 'ASC')
                else:
                    sql += ' ORDER BY key ' + ('DESC' if opts.get('desc') else 'ASC')
                if opts.get('limit'):
                    limit = int(opts['limit'])
                    if limit < 1 or limit > 1000000:
                        raise ValueError('查询数量超出范围')
                    sql += ' LIMIT ?'
                    args.append(limit)
            with self.lock:
                rows = self.db.execute(sql, args).fetchall()
            return rows[0][0] if action == 'count' else [json.loads(r[0]) for r in rows]
        raise ValueError('未知存储操作')

    def close(self):
        with self.lock:
            self.db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            self.db.close()
