from conftest import login


def child(name='小满', grade='三年级'):
    return {'name': name, 'grade': grade, 'textbook': '人教版', 'createdAt': '2026-10-24T00:00:00Z'}


def sync(client, headers, since=0, changes=()):
    r = client.post('/api/sync', headers=headers, json={'since': since, 'changes': list(changes)})
    assert r.status_code == 200, r.text
    return r.json()


# ---------- 登录 ----------

def test_login_wrong_password(client):
    r = client.post('/api/login', json={'username': 'family', 'password': 'nope'})
    assert r.status_code == 401


def test_login_unknown_user(client):
    r = client.post('/api/login', json={'username': 'nobody', 'password': 'nope'})
    assert r.status_code == 401


def test_login_rate_limited_after_repeated_failures(client):
    for _ in range(3):
        client.post('/api/login', json={'username': 'family', 'password': 'nope'})
    r = client.post('/api/login', json={'username': 'family', 'password': 'correct horse'})
    assert r.status_code == 429


def test_sync_requires_token(client):
    assert client.post('/api/sync', json={'since': 0, 'changes': []}).status_code == 401
    assert client.post('/api/sync', headers={'Authorization': 'Bearer forged'}, json={'since': 0}).status_code == 401


def test_logout_revokes_only_that_device(client):
    phone, tablet = login(client, 'phone'), login(client, 'tablet')
    assert client.post('/api/logout', headers=phone).status_code == 204
    assert client.get('/api/me', headers=phone).status_code == 401
    assert client.get('/api/me', headers=tablet).json() == {'username': 'family'}


# ---------- 同步 ----------

def test_second_device_pulls_what_first_pushed(client):
    a, b = login(client, 'a'), login(client, 'b')
    out = sync(client, a, 0, [{'kind': 'child', 'id': 'c1', 'baseRev': 0, 'data': child()}])
    assert out['rev'] == 1 and out['conflicts'] == []
    got = sync(client, b, 0)
    assert [(c['kind'], c['id'], c['rev'], c['data']['name']) for c in got['changes']] == [('child', 'c1', 1, '小满')]
    # 再拉一次没有新东西
    assert sync(client, b, got['rev'])['changes'] == []


def test_records_from_two_devices_merge(client):
    a, b = login(client, 'a'), login(client, 'b')
    sync(client, a, 0, [{'kind': 'record', 'id': 'math|s1|cnm_221', 'baseRev': 0, 'data': {'childId': 'c1', 'weak': []}}])
    sync(client, b, 0, [{'kind': 'record', 'id': 'math|s2|cnm_100', 'baseRev': 0, 'data': {'childId': 'c1', 'weak': []}}])
    ids = sorted(c['id'] for c in sync(client, a, 0)['changes'])
    assert ids == ['math|s1|cnm_221', 'math|s2|cnm_100']


def test_stale_edit_is_rejected_and_server_copy_returned(client):
    a, b = login(client, 'a'), login(client, 'b')
    sync(client, a, 0, [{'kind': 'child', 'id': 'c1', 'baseRev': 0, 'data': child('小满', '三年级')}])
    seen = sync(client, b, 0)  # b 看到 rev 1
    sync(client, a, 1, [{'kind': 'child', 'id': 'c1', 'baseRev': 1, 'data': child('小满', '四年级')}])  # rev 2
    out = sync(client, b, seen['rev'], [{'kind': 'child', 'id': 'c1', 'baseRev': 1, 'data': child('满满', '三年级')}])
    assert [c['data']['grade'] for c in out['conflicts']] == ['四年级']
    assert out['rev'] == 2  # 被拒的修改不占版本号


def test_edit_after_delete_keeps_it_deleted(client):
    a, b = login(client, 'a'), login(client, 'b')
    sync(client, a, 0, [{'kind': 'child', 'id': 'c1', 'baseRev': 0, 'data': child()}])
    sync(client, b, 0)
    sync(client, a, 1, [{'kind': 'child', 'id': 'c1', 'baseRev': 1, 'deleted': True}])
    out = sync(client, b, 1, [{'kind': 'child', 'id': 'c1', 'baseRev': 1, 'data': child('改名')}])
    assert out['conflicts'][0]['deleted'] is True and out['conflicts'][0]['data'] is None


def test_delete_on_both_devices_is_not_a_conflict(client):
    a, b = login(client, 'a'), login(client, 'b')
    sync(client, a, 0, [{'kind': 'child', 'id': 'c1', 'baseRev': 0, 'data': child()}])
    sync(client, a, 1, [{'kind': 'child', 'id': 'c1', 'baseRev': 1, 'deleted': True}])
    assert sync(client, b, 0, [{'kind': 'child', 'id': 'c1', 'baseRev': 1, 'deleted': True}])['conflicts'] == []


def test_record_for_deleted_child_is_still_stored(client):
    a, b = login(client, 'a'), login(client, 'b')
    sync(client, a, 0, [{'kind': 'child', 'id': 'c1', 'baseRev': 0, 'data': child()}])
    sync(client, a, 1, [{'kind': 'child', 'id': 'c1', 'baseRev': 1, 'deleted': True}])
    out = sync(client, b, 0, [{'kind': 'record', 'id': 'math|s9|x', 'baseRev': 0, 'data': {'childId': 'c1'}}])
    assert out['conflicts'] == []
    assert any(c['kind'] == 'record' and c['id'] == 'math|s9|x' for c in out['changes'])


def test_cursor_ahead_of_server_triggers_full_resync(client):
    a = login(client)
    sync(client, a, 0, [{'kind': 'child', 'id': 'c1', 'baseRev': 0, 'data': child()}])
    out = sync(client, a, 99)
    assert out['reset'] is True and [c['id'] for c in out['changes']] == ['c1']


def test_rejects_upsert_without_data_and_unknown_kind(client):
    a = login(client)
    r = client.post('/api/sync', headers=a, json={'since': 0, 'changes': [{'kind': 'child', 'id': 'c1', 'baseRev': 0}]})
    assert r.status_code == 422
    r = client.post('/api/sync', headers=a, json={'since': 0, 'changes': [{'kind': 'user', 'id': 'x', 'baseRev': 0, 'data': {}}]})
    assert r.status_code == 422


def test_cors_allows_app_origin(client):
    r = client.options('/api/sync', headers={'Origin': 'https://localhost', 'Access-Control-Request-Method': 'POST',
                                             'Access-Control-Request-Headers': 'authorization,content-type'})
    assert r.headers.get('access-control-allow-origin') == 'https://localhost'
