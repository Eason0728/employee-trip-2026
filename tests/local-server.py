#!/usr/bin/env python3
"""
分隊轉盤｜本機測試版

在這台 Mac 上跑起一個小伺服器，同時做兩件事：
  1. 送出 roulette.html / roulette-admin.html
  2. 用 /api 實作跟 Apps Script 一模一樣的抽籤規則

所以**同一個 wifi 下的多支手機可以真的同時連進來測**，資料會同步——
這是「示範模式」做不到的（示範模式的資料只留在各自的手機裡）。

    python3 tests/local-server.py            # 預設 8910 埠
    python3 tests/local-server.py 8080       # 換埠

演算法照抄 docs/apps-script-roulette.gs 的 caps() 與 pickTeam()。
tests/test-local-server.py 會驗兩邊行為一致——本機測得對，正式才會對。
"""
import http.server, socketserver, json, random, re, socket, sys, threading, urllib.parse, os, secrets

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAP_FLOOR, MAX_PEOPLE, MIN_CLOSE = 6, 56, 12
ROLE_KEYS = ['ASSAULT', 'CANNON', 'SNIPER']
SETTINGS = {'redName': '豪火戰隊', 'redCry': '火力全開——豪！不！留！情！',
            'whiteName': '榆你相遇隊', 'whiteCry': '從從容容、游刃有餘；匆匆忙忙、連滾帶爬',
            'roleAssault': '突擊手', 'roleCannon': '重炮手', 'roleSniper': '狙擊手',
            'roleLeader': '總指揮'}
ADMIN_PW = 'demo'

LOCK = threading.Lock()          # Apps Script 那邊用 LockService，這裡用 threading.Lock，用意一樣
STATE = {'phase': 'CHECKIN', 'rows': []}


def counts(rows):
    red = sum(1 for r in rows if r['team'] == 'RED')
    white = sum(1 for r in rows if r['team'] == 'WHITE')
    unspun = sum(1 for r in rows if r['status'] == 'CHECKED_IN')
    return {'red': red, 'white': white, 'checkedIn': len(rows), 'pendingUnspun': unspun}


def caps(checked_in, red, white):
    half = checked_in // 2
    if checked_in % 2 == 0:
        cap_r = cap_w = half
    elif red >= white:
        cap_r, cap_w = half + 1, half
    else:
        cap_r, cap_w = half, half + 1
    return {'red': max(cap_r, CAP_FLOOR, red), 'white': max(cap_w, CAP_FLOOR, white)}


def pick(cap, cnt):
    rem_r = max(0, cap['red'] - cnt['red'])
    rem_w = max(0, cap['white'] - cnt['white'])
    if rem_r <= 0 and rem_w <= 0:
        return ('RED' if cnt['red'] <= cnt['white'] else 'WHITE'), True
    if rem_r <= 0:
        return 'WHITE', True
    if rem_w <= 0:
        return 'RED', True
    return ('RED' if random.random() < rem_r / (rem_r + rem_w) else 'WHITE'), False


def pick_role(rows, team):
    n = {k: 0 for k in ROLE_KEYS}
    for r in rows:
        if r['team'] == team and r['status'] == 'LOCKED' and r.get('role') in n:
            n[r['role']] += 1
    lo = min(n.values())
    return random.choice([k for k in ROLE_KEYS if n[k] == lo])


def find(rows, name):
    return next((r for r in rows if r['name'] == name), None)


def me_of(rows, p):
    name = (p.get('name') or '').strip()
    r = find(rows, name) if name else None
    if r is None and p.get('dev'):
        r = next((x for x in rows if x['dev'] == p['dev']), None)
    if r is None:
        return {'name': '', 'team': None, 'status': 'NONE', 'spins': 0, 'role': ''}
    return {'name': r['name'], 'team': r['team'], 'status': r['status'], 'spins': r['spins'],
            'role': r.get('role', '')}


def snap(p, extra=None):
    rows = STATE['rows']
    c = counts(rows)
    d = {'me': me_of(rows, p), 'count': c, 'cap': caps(c['checkedIn'], c['red'], c['white']),
         'settings': SETTINGS}
    if extra:
        d.update(extra)
    return {'ok': True, 'phase': STATE['phase'], 'data': d}


def bad(code, msg, data=None):
    o = {'ok': False, 'phase': STATE['phase'], 'error': code, 'message': msg}
    if data:
        o['data'] = data
    return o


def new_person(name, dev, team, status, spins, src, role=''):
    return {'name': name, 'dev': dev or '', 'team': team, 'status': status, 'spins': spins,
            'src': src, 'role': role}


def handle(p):
    action = p.get('action', 'state')
    name = (p.get('name') or '').strip()
    rows = STATE['rows']

    if action == 'state':
        return snap(p)

    if action == 'roster':
        red, white = [], []
        if STATE['phase'] != 'CHECKIN':
            for r in rows:
                if r['status'] != 'LOCKED':
                    continue
                (red if r['team'] == 'RED' else white).append(
                    {'name': r['name'], 'role': r.get('role', '')})
        c = counts(rows)
        return {'ok': True, 'phase': STATE['phase'],
                'data': {'red': red, 'white': white, 'me': me_of(rows, p), 'count': c,
                         'cap': caps(c['checkedIn'], c['red'], c['white']), 'settings': SETTINGS}}

    with LOCK:
        rows = STATE['rows']
        if action == 'checkin':
            if not name:
                return bad('BAD_NAME', '請先輸入姓名')
            if find(rows, name):
                return snap(p)
            if len(rows) >= MAX_PEOPLE:
                return bad('ROSTER_FULL', f'人數已經滿了（上限 {MAX_PEOPLE} 人）')
            rows.append(new_person(name, p.get('dev'), None, 'CHECKED_IN', 0, 'SELF'))
            return snap(p)

        if action == 'spin':
            if not name:
                return bad('BAD_NAME', '請先輸入姓名')
            if STATE['phase'] != 'DRAW':
                return bad('NOT_OPEN', '現在還不能抽')
            r = find(rows, name)
            if r is None:
                if len(rows) >= MAX_PEOPLE:
                    return bad('ROSTER_FULL', f'人數已經滿了（上限 {MAX_PEOPLE} 人）')
                r = new_person(name, p.get('dev'), None, 'CHECKED_IN', 0, 'SELF')
                rows.append(r)
            if r['status'] == 'LOCKED':
                return bad('ALREADY_LOCKED', '你已經抽完了')
            second = r['status'] == 'PENDING'
            if second:
                r['team'] = None
            c = counts(rows)
            team, forced = pick(caps(c['checkedIn'], c['red'], c['white']), c)
            r['team'], r['status'], r['spins'] = team, ('LOCKED' if second else 'PENDING'), (2 if second else 1)
            r['role'] = pick_role(rows, team) if second else ''
            return snap(p, {'forced': forced})

        if action == 'confirm':
            r = find(rows, name)
            if r is None:
                return bad('NO_SUCH_NAME', '找不到這個名字')
            if r['status'] == 'LOCKED':
                return bad('ALREADY_LOCKED', '你已經抽完了')
            if r['status'] != 'PENDING':
                return bad('NOT_PENDING', '還沒抽過')
            r['status'] = 'LOCKED'
            if not r.get('role'):
                r['role'] = pick_role(rows, r['team'])
            return snap(p)

        if action == 'admin':
            if p.get('pw') != ADMIN_PW:
                return bad('BAD_PW', '通行碼不對')
            cmd = p.get('cmd', '')
            c = counts(rows)
            if cmd == 'stats':
                return {'ok': True, 'phase': STATE['phase'], 'data': {
                    'rows': [{'name': r['name'], 'team': r['team'], 'status': r['status'],
                              'spins': r['spins'], 'src': r['src'], 'role': r.get('role', '')} for r in rows],
                    'count': c, 'cap': caps(c['checkedIn'], c['red'], c['white']),
                    'leaders': {'red': '', 'white': ''}, 'gate': {'openAt': '', 'openMin': ''},
                    'settings': SETTINGS,
                    'sheetUrl': 'https://docs.google.com/spreadsheets/d/LOCAL/edit'}}
            if cmd == 'setLeaders':
                rn, wn = (p.get('red') or '').strip(), (p.get('white') or '').strip()
                if not rn or not wn:
                    return bad('BAD_NAME', '兩位隊長的姓名都要填')
                if rn == wn:
                    return bad('BAD_NAME', '兩位隊長不能是同一個人')
                STATE['rows'] = [r for r in rows if r['src'] != 'LEADER' and r['name'] not in (rn, wn)]
                STATE['rows'].insert(0, new_person(wn, '', 'WHITE', 'LOCKED', 0, 'LEADER', 'LEADER'))
                STATE['rows'].insert(0, new_person(rn, '', 'RED', 'LOCKED', 0, 'LEADER', 'LEADER'))
                STATE['phase'] = 'DRAW'
                return snap({})
            if cmd == 'open':
                STATE['phase'] = 'DRAW'
                return snap({})
            if cmd == 'close':
                un = [r['name'] for r in rows if r['status'] == 'CHECKED_IN']
                if un:
                    return bad('UNSPUN', '還有人報到了沒抽，先讓他抽完或把他刪掉', {'names': un})
                if len(rows) < MIN_CLOSE and p.get('force') != '1':
                    return bad('TOO_FEW', f'報到不到 {MIN_CLOSE} 人，確認要封嗎', {'count': len(rows)})
                for r in rows:
                    if r['status'] == 'PENDING':
                        r['status'] = 'LOCKED'
                        if not r.get('role'):
                            r['role'] = pick_role(rows, r['team'])
                STATE['phase'] = 'CLOSED'
                return snap({})
            if cmd == 'move':
                r = find(rows, name)
                if r is None:
                    return bad('NO_SUCH_NAME', '找不到這個名字')
                if p.get('team') not in ('RED', 'WHITE'):
                    return bad('BAD_TEAM', '隊伍只能是 RED 或 WHITE')
                r['team'], r['status'] = p['team'], 'LOCKED'
                r['role'] = 'LEADER' if r['src'] == 'LEADER' else pick_role(rows, p['team'])
                return snap({})
            if cmd == 'delete':
                r = find(rows, name)
                if r is None:
                    return bad('NO_SUCH_NAME', '找不到這個名字')
                rows.remove(r)
                return snap({})
            if cmd == 'resolvePending':
                mode, k = p.get('mode', 'lock'), 0
                for r in rows:
                    if r['status'] != 'PENDING':
                        continue
                    if name and r['name'] != name:
                        continue
                    if mode == 'reset':
                        r['team'], r['status'], r['spins'], r['role'] = None, 'CHECKED_IN', 0, ''
                    else:
                        r['status'] = 'LOCKED'
                        if not r.get('role'):
                            r['role'] = pick_role(rows, r['team'])
                    k += 1
                return snap({}, {'affected': k})
            if cmd == 'clearAll':
                STATE['rows'] = []
                STATE['phase'] = 'CHECKIN'
                return snap({})
            return bad('BAD_ACTION', '不認識的主持人指令')

    return bad('BAD_ACTION', '不認識的指令')


INJECT = b"<script>window.ROULETTE_API='/api';</script>"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        # ⚠️ log_error() 會用非字串呼叫這裡（HTTPStatus），直接當字串處理會炸掉整個連線
        first = str(args[0]) if args else ''
        if '/api' not in first:
            return
        sys.stderr.write('  · %s\n' % first[:110])

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/api':
            q = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
            body = json.dumps(handle(q), ensure_ascii=False)
            cb = q.get('callback', '')
            if re.match(r'^[A-Za-z_$][A-Za-z0-9_$]*$', cb):
                body, ctype = f'{cb}({body});', 'application/javascript'
            else:
                ctype = 'application/json'
            data = body.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', ctype + '; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)
            return

        if parsed.path == '/favicon.ico':
            self.send_response(204); self.end_headers(); return

        if parsed.path in ('/', '/index'):
            self.send_response(302)
            self.send_header('Location', '/roulette.html')
            self.end_headers()
            return

        # 把 window.ROULETTE_API 注進兩個頁面，讓它們打本機的 /api 而不是示範模式
        if parsed.path in ('/roulette.html', '/roulette-admin.html'):
            with open(os.path.join(ROOT, parsed.path.lstrip('/')), 'rb') as f:
                html = f.read().replace(b'</head>', INJECT + b'</head>', 1)
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(html)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(html)
            return

        super().do_GET()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        return s.getsockname()[0]
    finally:
        s.close()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8910
    ip = lan_ip()
    print('\n  分隊轉盤 · 本機測試版')
    print('  ─────────────────────────────────────────────')
    print(f'  這台 Mac　　同仁　http://127.0.0.1:{port}/roulette.html')
    print(f'  　　　　　　主持人 http://127.0.0.1:{port}/roulette-admin.html')
    print(f'  同一個 wifi　同仁　http://{ip}:{port}/roulette.html')
    print(f'  　　　　　　主持人 http://{ip}:{port}/roulette-admin.html')
    print(f'\n  主持人通行碼：{ADMIN_PW}')
    print('  多支手機連進來資料會同步。關掉這支程式資料就沒了。')
    print('  ─────────────────────────────────────────────\n')
    with Server(('0.0.0.0', port), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\n  已停止。\n')
