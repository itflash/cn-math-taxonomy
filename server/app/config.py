"""运行配置，全部来自环境变量。"""
import os

DB_PATH = os.environ.get('CNM_DB', '/data/cnm.sqlite3')
# APK 里页面来源是 https://localhost（Capacitor），要在这里放行；网页和 API 同域时不需要。
CORS_ORIGINS = [o.strip() for o in os.environ.get('CNM_CORS_ORIGINS', 'https://localhost,capacitor://localhost').split(',') if o.strip()]
TOKEN_TTL_DAYS = int(os.environ.get('CNM_TOKEN_TTL_DAYS', '180'))
# 登录失败限制：同一用户名或同一 IP 在窗口内失败这么多次后暂时拒绝
LOGIN_MAX_FAILS = int(os.environ.get('CNM_LOGIN_MAX_FAILS', '5'))
LOGIN_WINDOW_SECONDS = int(os.environ.get('CNM_LOGIN_WINDOW_SECONDS', '900'))
