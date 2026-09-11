#!/usr/bin/env python3
"""
本機測試版的回測（零依賴，python3 tests/test-local-server.py）

本機版是給 Eason 在多支手機上實測用的。**如果它跟正式後端行為不一樣，
測起來對、上線卻錯，比沒測還糟**——所以這支驗的是「兩邊同一套規則」：

  1. caps()／pickTeam() 的輸出跟 docs/apps-script-roulette.gs 逐項相同
  2. 終值一定平均（跟 test-roulette-backend.js 同一組模擬）
  3. HTTP 層真的跑得起來，JSONP 形狀正確
"""
import importlib.util, json, os, random, re, sys, threading, urllib.request, urllib.error, urllib.parse, time

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('ls', os.path.join(HERE, 'local-server.py'))
LS = importlib.util.module_from_spec(spec); spec.loader.exec_module(LS)

passed = failed = 0
bad_names = []
def ok(cond, name, extra=''):
    global passed, failed
    if cond: passed += 1
    else:
        failed += 1; bad_names.append(name)
        print(f'  ✗ {name}' + (f'  → {extra}' if extra else ''))
def eq(a, b, name): ok(a == b, name, f'得到 {a!r}，預期 {b!r}')
def sec(t): print(f'\n── {t}')

def reset():
    LS.STATE['phase'] = 'CHECKIN'; LS.STATE['rows'] = []

# ══ 1. 名額演算法與 .gs 逐項相同 ══
sec('1. 名額演算法（對照 docs/apps-script-roulette.gs 的 caps()）')
CASES = [((3,1,1),(6,6)), ((12,6,5),(6,6)), ((14,7,6),(7,7)), ((44,20,19),(22,22)),
         ((56,28,27),(28,28)), ((43,21,20),(22,21)), ((43,20,21),(21,22))]
for (n,r,w),(er,ew) in CASES:
    c = LS.caps(n,r,w)
    eq((c['red'],c['white']), (er,ew), f'caps({n},{r},{w})')

sec('2. 抽籤：名額用完一定進另一隊')
eq(LS.pick({'red':5,'white':5},{'red':5,'white':2}), ('WHITE',True), '紅隊滿了 → 強制白隊')
eq(LS.pick({'red':5,'white':5},{'red':2,'white':5}), ('RED',True),   '白隊滿了 → 強制紅隊')
both = {LS.pick({'red':5,'white':5},{'red':1,'white':1})[0] for _ in range(200)}
eq(both, {'RED','WHITE'}, '兩邊都有名額時兩隊都抽得到')
eq(LS.pick({'red':5,'white':5},{'red':1,'white':1})[1], False, '兩邊都有名額時不算補位')

# ══ 3. 終值一定平均 ══
sec('3. 終值模擬：三種報到節奏 × 六種人數')
def play(total, cadence, respin=0.3):
    reset()
    LS.handle({'action':'admin','pw':LS.ADMIN_PW,'cmd':'setLeaders','red':'隊長紅','white':'隊長白'})
    people = [{'name':f'員工{i}','dev':f'dev_{i:012d}'} for i in range(total-2)]
    def checkin(p): LS.handle({'action':'checkin', **p})
    def draw(p):
        r1 = LS.handle({'action':'spin', **p})
        if not r1['ok']: return
        if random.random() < respin: LS.handle({'action':'spin', **p})
        else: LS.handle({'action':'confirm', **p})
    if cadence == 'ALL_FIRST':
        for p in people: checkin(p)
        for p in people: draw(p)
    elif cadence == 'IMMEDIATE':
        for p in people: checkin(p); draw(p)
    else:
        i = j = 0
        while j < len(people):
            for _ in range(5):
                if i < len(people): checkin(people[i]); i += 1
            for _ in range(3):
                if j < i: draw(people[j]); j += 1
    c = LS.counts(LS.STATE['rows'])
    return c['red'], c['white']

for cad, label in [('ALL_FIRST','全部先報到再抽'), ('INTERLEAVED','報到與抽交錯'), ('IMMEDIATE','一報到就抽')]:
    for n in (44, 50, 56):
        bad = next((res for res in (play(n,cad) for _ in range(40)) if res != (n//2, n//2)), None)
        ok(bad is None, f'{label}｜{n} 人（雙數）終值必為 {n//2} 對 {n//2}', bad and f'出現 {bad[0]} 對 {bad[1]}')
    for n in (43, 51):
        bad = next((res for res in (play(n,cad) for _ in range(40))
                    if abs(res[0]-res[1]) != 1 or sum(res) != n), None)
        ok(bad is None, f'{label}｜{n} 人（奇數）終值差距必為 1', bad and f'出現 {bad[0]} 對 {bad[1]}')

# ══ 4. 狀態機 ══
sec('4. 兩次機會與封盤把關')
reset()
eq(LS.handle({'action':'spin','name':'甲','dev':'d1'})['error'], 'NOT_OPEN', '沒設隊長就抽 → NOT_OPEN')
LS.handle({'action':'admin','pw':LS.ADMIN_PW,'cmd':'setLeaders','red':'隊長紅','white':'隊長白'})
eq(LS.handle({'action':'checkin','name':'  甲  ','dev':'d1'})['data']['me']['name'], '甲', '姓名前後空白去掉')
r = LS.handle({'action':'spin','name':'甲','dev':'d1'})
eq(r['data']['me']['status'], 'PENDING', '第一次抽完是暫定')
r = LS.handle({'action':'spin','name':'甲','dev':'d1'})
eq((r['data']['me']['status'], r['data']['me']['spins']), ('LOCKED', 2), '第二次抽完直接鎖死')
eq(LS.handle({'action':'spin','name':'甲','dev':'d9'})['error'], 'ALREADY_LOCKED', '換裝置也不能再抽')
LS.handle({'action':'checkin','name':'乙','dev':'d2'})
c = LS.handle({'action':'admin','pw':LS.ADMIN_PW,'cmd':'close'})
eq(c['error'], 'UNSPUN', '有人報到未抽 → 封盤被擋')
eq(c['data']['names'], ['乙'], '擋下來時列出是誰')
eq(LS.handle({'action':'admin','pw':'wrong','cmd':'stats'})['error'], 'BAD_PW', '通行碼錯 → BAD_PW')
reset()
LS.handle({'action':'checkin','name':'丙','dev':'d3'})
eq(LS.handle({'action':'roster'})['data']['red'], [], 'CHECKIN 階段名單是空的')
ok('丙' not in json.dumps(LS.handle({'action':'roster'}), ensure_ascii=False), 'CHECKIN 階段不外流姓名')

# ══ 5. HTTP 層 ══
sec('5. HTTP 層與 JSONP')
reset()
PORT = 8917
srv = LS.Server(('127.0.0.1', PORT), LS.Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
time.sleep(0.3)
def get(path):
    with urllib.request.urlopen(f'http://127.0.0.1:{PORT}{path}', timeout=5) as r:
        return r.status, r.read().decode('utf-8')
st, body = get('/api?action=state&callback=cb7')
ok(re.match(r'^cb7\(\{.*\}\);$', body), 'JSONP 外層是 cb7({...});', body[:50])
st, body = get('/api?action=state')
eq(json.loads(body)['phase'], 'CHECKIN', '沒帶 callback 回純 JSON')
st, body = get('/roulette.html')
ok("window.ROULETTE_API='/api'" in body, '頁面被注入本機端點（不會走示範模式）')
# 前端已經填上正式端點；本機版靠注入 window.ROULETTE_API 蓋過去，
# 所以在本機測永遠打本機、不會誤打正式後端。這條就是在守這件事。
i_inject = body.index("window.ROULETTE_API='/api'")
i_api = body.index('var API = window.ROULETTE_API')
ok(i_inject < i_api, '注入的本機端點排在 var API 前面，本機測不會打到正式後端')
st, body = get('/roulette-admin.html')
ok("window.ROULETTE_API='/api'" in body, '控制台也被注入')
st, body = get('/roulette-demo.js')
eq(st, 200, '靜態檔案送得出去')

# 瀏覽器一定會要 favicon.ico。第一版沒處理，log_error 用 HTTPStatus 呼叫 log_message，
# 字串判斷直接炸掉整條連線——瀏覽器那邊看起來像伺服器掛了。
st, _ = get('/favicon.ico')
eq(st, 204, 'favicon 回 204，不會噴例外')
try:
    get('/no-such-file.html'); ok(False, '找不到的檔案要回 404')
except urllib.error.HTTPError as e:
    eq(e.code, 404, '找不到的檔案回 404 而不是炸掉連線')
st, body = get('/api?action=state')
eq(json.loads(body)['phase'], 'CHECKIN', '出過 404 之後伺服器還活著')
srv.shutdown()

print(f'\n{passed} passed, {failed} failed')
if failed:
    print('失敗項目：\n  - ' + '\n  - '.join(bad_names)); sys.exit(1)
