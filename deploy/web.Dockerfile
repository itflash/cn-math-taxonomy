# 静态站点镜像：只放网页实际用到的文件（构建上下文是仓库根目录，排除规则见根目录 .dockerignore）
FROM caddy:2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY index.html manifest.webmanifest sw.js .nojekyll /srv/
COPY assets /srv/assets
COPY explore /srv/explore
COPY diagnose /srv/diagnose
COPY children /srv/children
COPY account /srv/account
COPY data /srv/data
