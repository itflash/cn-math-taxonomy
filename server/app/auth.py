"""账号、密码、登录凭证。

密码用标准库的 scrypt 加盐哈希。登录成功发一个随机 token，库里只存它的 sha256，
数据库泄露也拿不到能用的 token。token 放在请求头 Authorization: Bearer ... 里，
不用 cookie：APK 的页面和服务器不同源，跨源 cookie 在 WebView 里很麻烦。
"""
import base64
import hashlib
import hmac
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone

from . import config
from .db import now_iso

SCRYPT_N, SCRYPT_R, SCRYPT_P = 2 ** 14, 8, 1


def _b64(b):
    return base64.b64encode(b).decode('ascii')


def hash_password(password):
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode('utf-8'), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32)
    return 'scrypt${}${}${}${}${}'.format(SCRYPT_N, SCRYPT_R, SCRYPT_P, _b64(salt), _b64(dk))


def verify_password(password, stored):
    try:
        algo, n, r, p, salt, dk = stored.split('$')
        if algo != 'scrypt':
            return False
        want = base64.b64decode(dk)
        got = hashlib.scrypt(password.encode('utf-8'), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p), dklen=len(want))
        return hmac.compare_digest(got, want)
    except (ValueError, TypeError):
        return False


# 用户名不存在时也算一次 scrypt，不让响应时间泄露哪些用户名存在
_DUMMY_HASH = hash_password(secrets.token_hex(8))


def token_hash(token):
    return hashlib.sha256(token.encode('ascii')).hexdigest()


def issue_token(conn, user_id, device):
    token = secrets.token_urlsafe(32)
    now = now_iso()
    conn.execute('INSERT INTO tokens (token_hash, user_id, device, created_at, last_seen) VALUES (?, ?, ?, ?, ?)',
                 (token_hash(token), user_id, (device or '')[:80], now, now))
    return token


def user_for_token(conn, token):
    """有效就返回 users 行并刷新 last_seen；过期或不存在返回 None。按最后使用时间滑动过期。"""
    if not token:
        return None
    th = token_hash(token)
    row = conn.execute('SELECT t.last_seen, u.id, u.username FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?',
                       (th,)).fetchone()
    if not row:
        return None
    last = datetime.fromisoformat(row['last_seen'])
    if datetime.now(timezone.utc) - last > timedelta(days=config.TOKEN_TTL_DAYS):
        conn.execute('DELETE FROM tokens WHERE token_hash = ?', (th,))
        return None
    # 一小时内不重复写，减少每次请求的写库
    if datetime.now(timezone.utc) - last > timedelta(hours=1):
        conn.execute('UPDATE tokens SET last_seen = ? WHERE token_hash = ?', (now_iso(), th))
    return row


def revoke_token(conn, token):
    conn.execute('DELETE FROM tokens WHERE token_hash = ?', (token_hash(token),))


def authenticate(conn, username, password):
    row = conn.execute('SELECT id, username, pw_hash FROM users WHERE username = ?', (username,)).fetchone()
    if not row:
        verify_password(password, _DUMMY_HASH)
        return None
    return row if verify_password(password, row['pw_hash']) else None


class LoginLimiter:
    """进程内的失败计数。只有一个 API 进程，够用；重启后清零也无妨。"""

    def __init__(self, max_fails=None, window=None):
        self.max_fails = max_fails or config.LOGIN_MAX_FAILS
        self.window = window or config.LOGIN_WINDOW_SECONDS
        self._fails = {}
        self._lock = threading.Lock()

    def _recent(self, key, now):
        times = [t for t in self._fails.get(key, []) if now - t < self.window]
        self._fails[key] = times
        return times

    def blocked(self, *keys):
        now = time.monotonic()
        with self._lock:
            return any(len(self._recent(k, now)) >= self.max_fails for k in keys)

    def fail(self, *keys):
        now = time.monotonic()
        with self._lock:
            for k in keys:
                self._recent(k, now).append(now)

    def reset(self, *keys):
        with self._lock:
            for k in keys:
                self._fails.pop(k, None)
