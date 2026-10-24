"""SQLite 存储。

一个家庭一个账号。孩子档案和诊断记录都存在 items 表里，用 kind 区分。
每个账号有一个递增的版本号 users.rev：每接受一次修改就加一，写到那一行的 rev 上。
设备记住自己同步到哪个版本，下次只拉比它新的行。删除只打标记（deleted=1），
否则另一台设备会把删掉的东西同步回来。
"""
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  pw_hash TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device TEXT,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  data TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, kind, id)
);
CREATE INDEX IF NOT EXISTS items_by_rev ON items (user_id, rev);
"""


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def connect(path=None):
    path = path or config.DB_PATH
    if path != ':memory:':
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    # isolation_level=None：事务自己用 BEGIN 控制
    conn = sqlite3.connect(path, isolation_level=None, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    conn.execute('PRAGMA journal_mode = WAL')
    conn.execute('PRAGMA busy_timeout = 10000')
    return conn


def init(path=None):
    conn = connect(path)
    try:
        conn.executescript(SCHEMA)
    finally:
        conn.close()


@contextmanager
def session(path=None):
    conn = connect(path)
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def write_tx(conn):
    """写事务。BEGIN IMMEDIATE 一开始就拿写锁，两台设备同时同步时版本号不会撞。"""
    conn.execute('BEGIN IMMEDIATE')
    try:
        yield conn
    except BaseException:
        conn.execute('ROLLBACK')
        raise
    else:
        conn.execute('COMMIT')
