"""HTTP 接口。静态页面由 Caddy 提供，这里只有 /api。"""
import json
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, model_validator

from . import auth, config, db
from .sync import sync as do_sync

MAX_ITEM_BYTES = 64 * 1024
MAX_CHANGES = 500


@asynccontextmanager
async def lifespan(_app):
    db.init()
    yield


app = FastAPI(title='cnm-sync', docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_methods=['GET', 'POST'],
    allow_headers=['Authorization', 'Content-Type'],
    max_age=86400,
)
limiter = auth.LoginLimiter()


def get_conn():
    with db.session() as conn:
        yield conn


def bearer(request: Request):
    h = request.headers.get('authorization', '')
    return h[7:].strip() if h.lower().startswith('bearer ') else ''


def current_user(request: Request, conn=Depends(get_conn)):
    user = auth.user_for_token(conn, bearer(request))
    if not user:
        raise HTTPException(status_code=401, detail='请先登录。')
    return user


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=40)
    password: str = Field(min_length=1, max_length=200)
    device: str = Field(default='', max_length=80)


class Change(BaseModel):
    kind: Literal['child', 'record']
    # 诊断记录的 id 是 subject|seed|目标列表，整年级诊断时目标很多，所以放宽长度
    id: str = Field(min_length=1, max_length=10000)
    baseRev: int = Field(ge=0)
    deleted: bool = False
    data: dict | None = None

    @model_validator(mode='after')
    def _check(self):
        if self.deleted:
            self.data = None
        elif self.data is None:
            raise ValueError('没有删除的修改必须带 data')
        elif len(json.dumps(self.data, ensure_ascii=False).encode('utf-8')) > MAX_ITEM_BYTES:
            raise ValueError('单条数据太大')
        return self


class SyncIn(BaseModel):
    since: int = Field(ge=0)
    changes: list[Change] = Field(default_factory=list, max_length=MAX_CHANGES)


@app.get('/api/health')
def health():
    return {'ok': True}


@app.post('/api/login')
def login(body: LoginIn, request: Request, conn=Depends(get_conn)):
    username = body.username.strip()
    ip = request.client.host if request.client else '?'
    keys = ('u:' + username.lower(), 'ip:' + ip)
    if limiter.blocked(*keys):
        raise HTTPException(status_code=429, detail='登录失败次数太多，请 15 分钟后再试。')
    user = auth.authenticate(conn, username, body.password)
    if not user:
        limiter.fail(*keys)
        raise HTTPException(status_code=401, detail='用户名或密码不对。')
    limiter.reset(*keys)
    with db.write_tx(conn):
        token = auth.issue_token(conn, user['id'], body.device)
    return {'token': token, 'username': user['username']}


@app.post('/api/logout', status_code=204)
def logout(request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    auth.revoke_token(conn, bearer(request))
    return Response(status_code=204)


@app.get('/api/me')
def me(user=Depends(current_user)):
    return {'username': user['username']}


@app.post('/api/sync')
def sync(body: SyncIn, user=Depends(current_user), conn=Depends(get_conn)):
    return do_sync(conn, user['id'], body.since, [c.model_dump() for c in body.changes])
