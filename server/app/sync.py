"""同步：设备一次请求里既上传自己的修改，也拉取别处的修改。

冲突规则（共用一个家庭账号，多台设备同时写）：
- 每个修改带 baseRev：设备改这一项时，它看到的服务器版本（新建为 0）。
- 服务器上这一项的 rev 比 baseRev 新，说明别的设备已经改过（或删过），这次修改不生效，
  以服务器为准，把服务器那份放进 conflicts 返回，设备用它覆盖本地并提示用户。
  两边都是删除时不算冲突。
- 删除只打标记，rev 照样加一，其他设备下次同步就知道删了。
- 孩子被删后，离线设备才传上来的这个孩子的诊断记录照常保存，但设备上看不到
  （记录挂在不存在的孩子下面），以后需要可以从库里恢复。
"""
import json

from .db import now_iso, write_tx

KINDS = ('child', 'record')


def _row_out(row):
    return {
        'kind': row['kind'],
        'id': row['id'],
        'rev': row['rev'],
        'deleted': bool(row['deleted']),
        'data': json.loads(row['data']) if row['data'] is not None else None,
        'updatedAt': row['updated_at'],
    }


def sync(conn, user_id, since, changes):
    """changes: [{kind, id, baseRev, deleted, data}]，已校验过。返回 {rev, reset, changes, conflicts}。"""
    conflict_keys = []
    with write_tx(conn):
        rev = conn.execute('SELECT rev FROM users WHERE id = ?', (user_id,)).fetchone()['rev']
        # 设备记的版本比服务器还新：服务器数据被重置过，让设备整份重拉
        reset = since > rev
        if reset:
            since = 0
        for ch in changes:
            cur = conn.execute('SELECT rev, deleted FROM items WHERE user_id = ? AND kind = ? AND id = ?',
                               (user_id, ch['kind'], ch['id'])).fetchone()
            if cur and cur['rev'] > ch['baseRev']:
                if not (cur['deleted'] and ch['deleted']):
                    conflict_keys.append((ch['kind'], ch['id']))
                continue
            rev += 1
            data = None if ch['deleted'] else json.dumps(ch['data'], ensure_ascii=False, separators=(',', ':'))
            conn.execute(
                'INSERT INTO items (user_id, kind, id, rev, deleted, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) '
                'ON CONFLICT (user_id, kind, id) DO UPDATE SET rev = excluded.rev, deleted = excluded.deleted, '
                'data = excluded.data, updated_at = excluded.updated_at',
                (user_id, ch['kind'], ch['id'], rev, 1 if ch['deleted'] else 0, data, now_iso()))
        conn.execute('UPDATE users SET rev = ? WHERE id = ?', (rev, user_id))

    rows = conn.execute('SELECT * FROM items WHERE user_id = ? AND rev > ? ORDER BY rev', (user_id, since)).fetchall()
    conflicts = []
    for kind, item_id in conflict_keys:
        row = conn.execute('SELECT * FROM items WHERE user_id = ? AND kind = ? AND id = ?', (user_id, kind, item_id)).fetchone()
        conflicts.append(_row_out(row))
    return {'rev': rev, 'reset': reset, 'changes': [_row_out(r) for r in rows], 'conflicts': conflicts}
