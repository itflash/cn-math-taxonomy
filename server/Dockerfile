FROM python:3.13-slim

# 国内服务器可在 deploy/.env 里设 PIP_INDEX_URL 用镜像源，留空用官方 PyPI
ARG PIP_INDEX_URL=
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 CNM_DB=/data/cnm.sqlite3
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir ${PIP_INDEX_URL:+--index-url "$PIP_INDEX_URL"} -r requirements.txt \
 && useradd --system --uid 10001 --home /srv app \
 && mkdir -p /data && chown app /data
COPY app ./app
USER app
VOLUME ["/data"]
EXPOSE 8000
# 只在 compose 内网里被 Caddy 访问，信任它转发的真实 IP（登录限流按 IP 计）
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
