#!/bin/bash
# 分隊轉盤｜併發壓測
#
#   ./tests/stress-roulette.sh <部署網址> <通行碼> [人數]
#
# 為什麼一定要跑：鼎鼎好聲音在小量測試時完全正常，正式壓測 60 支手機同時送，
# 60 筆全部回報成功、試算表只進了 22 筆——appendRow 不是原子操作。
# 加了 LockService 才一票不掉。這個 bug 只有併發壓測抓得到。
#
# ⚠️ 2026-09-11 踩過：參數裡的中文**一定要百分比編碼**。直接把中文放進網址，
#    Google 會回 HTTP 400，而腳本沒檢查回應，看起來就像「資料全掉了」。
#    這裡一律用 curl -G --data-urlencode，讓 curl 自己編。
set -u
API="${1:?用法：stress-roulette.sh <部署網址> <通行碼> [人數]}"
PW="${2:?需要主持人通行碼}"
N="${3:-56}"
STAGGER="${4:-0}"   # 每支手機之間隔幾秒才送（0＝全部同一秒，最壞情況）
PEOPLE=$((N - 2))
TMP=$(mktemp -d)

api() {   # api <輸出檔> <key=value>...
  local out="$1"; shift
  local args=()
  for kv in "$@"; do args+=(--data-urlencode "$kv"); done
  curl -sGL --max-time 120 -w '\n%{http_code}' "$API" "${args[@]}" > "$out" 2>&1
}

echo "▶ 清空並設定隊長（會刪掉現有資料，確定沒有正式資料再跑）"
api "$TMP/clear.txt" "action=admin" "pw=$PW" "cmd=clearAll"
api "$TMP/lead.txt"  "action=admin" "pw=$PW" "cmd=setLeaders" "red=壓測紅" "white=壓測白"
tail -1 "$TMP/lead.txt" | grep -q '^200$' || { echo "✗ 設隊長失敗："; cat "$TMP/lead.txt"; exit 1; }

echo "▶ $PEOPLE 支手機報到（間隔 ${STAGGER}s）"
for i in $(seq 1 "$PEOPLE"); do
  ( [ "$STAGGER" != "0" ] && sleep "$(echo "$i * $STAGGER" | bc -l)"
    api "$TMP/in$i.txt" "action=checkin" "name=壓測$i" "dev=dev_$(printf '%012d' "$i")" ) &
done; wait

echo "▶ $PEOPLE 支手機抽籤（間隔 ${STAGGER}s）"
for i in $(seq 1 "$PEOPLE"); do
  ( [ "$STAGGER" != "0" ] && sleep "$(echo "$i * $STAGGER" | bc -l)"
    api "$TMP/s$i.txt" "action=spin"    "name=壓測$i" "dev=dev_$(printf '%012d' "$i")"
    api "$TMP/c$i.txt" "action=confirm" "name=壓測$i" "dev=dev_$(printf '%012d' "$i")" ) &
done; wait

echo "▶ 逐筆檢查回應"
# ⚠️ 只看 HTTP 200 會被騙：後端拿不到鎖時回的是 200 + {"ok":false,"error":"BUSY"}。
#    2026-09-11 第一版就是這樣誤判成「163 個請求全部成功」，實際只有 26 筆進得去。
BAD=$(cat "$TMP"/in*.txt "$TMP"/s*.txt "$TMP"/c*.txt | python3 -c "
import sys, json, collections
codes = collections.Counter()
bad = 0
buf = []
for line in sys.stdin:
    line = line.rstrip('\n')
    if line.strip().isdigit() and len(line.strip()) == 3:
        body = ''.join(buf); buf = []
        http = line.strip()
        if http != '200': codes['HTTP ' + http] += 1; bad += 1; continue
        try: d = json.loads(body)
        except Exception: codes['回應不是 JSON'] += 1; bad += 1; continue
        if d.get('ok'): codes['ok'] += 1
        else: codes[d.get('error', '?')] += 1; bad += 1
    else:
        buf.append(line)
for k, v in codes.most_common(): print(f'   {k}: {v}', file=sys.stderr)
print(bad)
")
[ "$BAD" = 0 ] && echo "   ✓ 所有請求都回 ok" || echo "   ✗ $BAD 個請求沒成功"

echo "▶ 對帳"
api "$TMP/final.txt" "action=state"
sed '$d' "$TMP/final.txt" | python3 -c "
import sys, json
d = json.load(sys.stdin)['data']['count']
n = $N
print(f\"   報到 {d['checkedIn']}／預期 {n}　紅 {d['red']}　白 {d['white']}　差距 {abs(d['red']-d['white'])}\")
fail = 0
if d['checkedIn'] != n:
    print(f\"   ✗ 掉資料：報到只有 {d['checkedIn']} 筆，預期 {n}\"); fail = 1
if d['red'] + d['white'] != n:
    print(f\"   ✗ 有人沒被指派：{d['red']}+{d['white']} != {n}\"); fail = 1
if abs(d['red'] - d['white']) > (0 if n % 2 == 0 else 1):
    print(f\"   ✗ 兩隊不平均：{d['red']} 對 {d['white']}\"); fail = 1
print('   ✓ 一筆不掉，兩隊平均' if not fail else '')
sys.exit(fail)
"
RC=$?
echo "▶ 清掉壓測資料"
api "$TMP/cleanup.txt" "action=admin" "pw=$PW" "cmd=clearAll"
rm -rf "$TMP"
exit $((RC + BAD))
