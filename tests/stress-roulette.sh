#!/bin/bash
# 分隊轉盤｜併發壓測（要等 Eason 部署後才能跑）
#
#   ./tests/stress-roulette.sh <部署網址> <通行碼> [人數]
#
# 為什麼一定要跑：鼎鼎好聲音在小量測試時完全正常，正式壓測 60 支手機同時送，
# 60 筆全部回報成功、試算表只進了 22 筆——appendRow 不是原子操作。
# 加了 LockService 才一票不掉。這個 bug 只有併發壓測抓得到。
set -u
API="${1:?用法：stress-roulette.sh <部署網址> <通行碼> [人數]}"
PW="${2:?需要主持人通行碼}"
N="${3:-56}"
PEOPLE=$((N - 2))
TMP=$(mktemp -d)

echo "▶ 清空並設定隊長（會刪掉現有資料，確定沒有正式資料再跑）"
curl -sL "$API?action=admin&pw=$PW&cmd=clearAll" >/dev/null
curl -sL "$API?action=admin&pw=$PW&cmd=setLeaders&red=壓測紅&white=壓測白" >/dev/null

echo "▶ $PEOPLE 支手機同時報到"
for i in $(seq 1 "$PEOPLE"); do
  ( curl -sL --max-time 90 "$API?action=checkin&name=壓測$i&dev=dev_$(printf '%012d' "$i")" > "$TMP/in$i.txt" ) &
done; wait

echo "▶ $PEOPLE 支手機同時抽籤"
for i in $(seq 1 "$PEOPLE"); do
  ( curl -sL --max-time 90 "$API?action=spin&name=壓測$i&dev=dev_$(printf '%012d' "$i")" > "$TMP/s$i.txt"
    curl -sL --max-time 90 "$API?action=confirm&name=壓測$i&dev=dev_$(printf '%012d' "$i")" >/dev/null ) &
done; wait

echo "▶ 對帳"
FINAL=$(curl -sL "$API?action=state")
echo "$FINAL"
RED=$(echo "$FINAL"   | sed -n 's/.*"red":\([0-9]*\).*/\1/p' | head -1)
WHITE=$(echo "$FINAL" | sed -n 's/.*"white":\([0-9]*\).*/\1/p' | head -1)
IN=$(echo "$FINAL"    | sed -n 's/.*"checkedIn":\([0-9]*\).*/\1/p' | head -1)
echo
echo "報到 $IN／預期 $N　　紅 $RED　白 $WHITE"
FAILED=0
[ "$IN" = "$N" ] || { echo "✗ 掉資料：報到只有 $IN 筆，預期 $N"; FAILED=1; }
[ "$RED" = "$WHITE" ] || { echo "✗ 兩隊不平均：$RED 對 $WHITE"; FAILED=1; }
[ "$FAILED" = 0 ] && echo "✓ 一筆不掉，兩隊平均"
echo "▶ 記得再跑一次 clearAll 把壓測資料清掉"
rm -rf "$TMP"
exit $FAILED
