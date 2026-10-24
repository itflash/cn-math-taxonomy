import os
import tempfile

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch):
    tmp = tempfile.mkdtemp()
    from app import config
    monkeypatch.setattr(config, 'DB_PATH', os.path.join(tmp, 'test.sqlite3'))
    from app import auth, db, main
    main.limiter = auth.LoginLimiter(max_fails=3, window=60)
    db.init()
    with db.session() as conn, db.write_tx(conn):
        conn.execute('INSERT INTO users (username, pw_hash, created_at) VALUES (?, ?, ?)',
                     ('family', auth.hash_password('correct horse'), db.now_iso()))
    with TestClient(main.app) as c:
        yield c


def login(client, device='phone'):
    r = client.post('/api/login', json={'username': 'family', 'password': 'correct horse', 'device': device})
    assert r.status_code == 200, r.text
    return {'Authorization': 'Bearer ' + r.json()['token']}
