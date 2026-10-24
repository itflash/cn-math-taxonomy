"""账号管理命令。不开放注册，家庭账号在服务器上用这里创建。

  python -m app.cli create-user <用户名>      # 交互输入密码
  python -m app.cli set-password <用户名>
  python -m app.cli list-users
  python -m app.cli logout-all <用户名>       # 让所有设备重新登录
"""
import argparse
import getpass
import sys

from . import auth, db


def _password():
    pw = getpass.getpass('密码：')
    if len(pw) < 8:
        sys.exit('密码至少 8 位。')
    if getpass.getpass('再输一次：') != pw:
        sys.exit('两次输入不一致。')
    return pw


def main(argv=None):
    p = argparse.ArgumentParser(prog='app.cli')
    sub = p.add_subparsers(dest='cmd', required=True)
    for name in ('create-user', 'set-password', 'logout-all'):
        sub.add_parser(name).add_argument('username')
    sub.add_parser('list-users')
    args = p.parse_args(argv)

    db.init()
    with db.session() as conn:
        if args.cmd == 'list-users':
            for row in conn.execute('SELECT u.username, u.created_at, COUNT(t.token_hash) AS devices FROM users u '
                                    'LEFT JOIN tokens t ON t.user_id = u.id GROUP BY u.id ORDER BY u.id'):
                print('{}\t创建于 {}\t登录设备 {}'.format(row['username'], row['created_at'], row['devices']))
            return
        user = conn.execute('SELECT id FROM users WHERE username = ?', (args.username,)).fetchone()
        if args.cmd == 'create-user':
            if user:
                sys.exit('用户已存在。')
            pw = _password()
            with db.write_tx(conn):
                conn.execute('INSERT INTO users (username, pw_hash, created_at) VALUES (?, ?, ?)',
                             (args.username, auth.hash_password(pw), db.now_iso()))
            print('已创建', args.username)
            return
        if not user:
            sys.exit('没有这个用户。')
        with db.write_tx(conn):
            if args.cmd == 'set-password':
                conn.execute('UPDATE users SET pw_hash = ? WHERE id = ?', (auth.hash_password(_password()), user['id']))
            # 改密码时也让所有设备重新登录
            conn.execute('DELETE FROM tokens WHERE user_id = ?', (user['id'],))
        print('完成。所有设备需要重新登录。')


if __name__ == '__main__':
    main()
