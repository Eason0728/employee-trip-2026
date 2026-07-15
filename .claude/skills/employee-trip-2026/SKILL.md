---
name: employee-trip-2026
description: 維護「2026年度員工旅遊」報名網站（eason0728.github.io/employee-trip-2026）的專用 skill。當使用者提到以下任何情境時，必須載入：員旅、員工旅遊、報名表、報名登記表、員旅問卷、漆彈/水晶彈選項、親友欄位、飲食需求、費用方案、截止日、Apps Script 後端、報名試算表、統計分頁、去重公式。即使只說「問卷改一下」「報名表有問題」也要載入。
---

# 2026 年度員工旅遊 報名網站

repo: `Eason0728/employee-trip-2026`（public）
主程式: `index.html`（**單一檔案**，HTML + 原生 JS + 內嵌 CSS，無框架、無 build；含大量 base64 圖片，grep 時記得排除長行）
線上網址: `https://eason0728.github.io/employee-trip-2026/`
部署: **push 到 main → GitHub Actions（`.github/workflows/deploy.yml`）自動部署 Pages**，約 20 秒完成。驗證方式＝看最新 workflow run 的 conclusion（CCR 環境的 proxy 擋 `*.github.io`，開網頁驗證會 403，不是站掛了）。

> 注意：這不是排班 app（mala-schedule）。兩個專案互不相干，只是同一個使用者。

## 頁面結構

4 個分頁（`switchTab(idx)`、`#panel-0..3`）：旅遊介紹（含費用方案一覽）／第一天（9/14 出發＆入住）／第二天（9/15 漆彈＆返家，含獵鷹漆彈介紹）／**報名登記表（panel-3）**。
表單在 panel-3，**預設分頁不是它**——自動化測試要先 `switchTab(3)` 才能操作表單元素。

## 報名表（最常改的部分）

- 員工欄位：單位/店別/姓名/出生/身分證/手機/地址/職別/自費金額/搭車地點/攜帶親友(0-5)/參與漆彈／水晶彈/飲食習慣/備註/同房需求。身分證欄位有「外籍夥伴請填居留證統一證號」提示。
- **同房需求**（選填，不計入進度 13）：4 個空格 `s-room1..4`，送出時取非空值用「、」串成單一 payload key `roommates`（後端 BC 欄）；prefill 用 split('、') 拆回 4 格。
- 親友區塊由 `renderFamilyBlocks()` 動態產生，每位親友 6 個必填：姓名/出生/身分證/地址(可勾「同上」)/漆彈／水晶彈/飲食需求。改親友欄位要同步改：render 模板、`keep[]` 暫存、`updateProgress()`、送出驗證、payload、確認頁 `famResults`、`prefillFromSaved()` 七個地方。
- 單選一律走 `selectRadio(name,id)`（id 格式 `name-id`），**disabled 的選項會被它擋掉**，這是年齡閘門的一部分，別移除。
- **年齡閘門**：`famPbGate(i)` + `famPbAllowed(birth)`——漆彈滿 12 歲、水晶彈滿 6 歲、未滿 6 歲只能「不參加，改玩其他加購活動」。年齡以 `TRIP_DATE`（2026-09-14+08:00）計算，生日當天算滿歲。改生日會重新閘門並清掉不合法的已選項。選項值常數：`PB_YES/PB_CRYSTAL/PB_NO`；PB_NO＝「不參加，改玩其他加購活動」（2026-07-16 起員工與親友統一。員工選項是靜態 HTML 寫死、親友用 PB_NO 常數，**改字要兩邊同步**；舊值「參與其他加購活動」在 `prefillFromSaved()` 有 `PB_NO_LEGACY` 相容映射，試算表歷史列仍是舊字串）。
- **出生年月日擋未來日期**：`TODAY_STR`（本機時區今日）——員工與親友 date input 都有 `max=TODAY_STR`，送出時也各自驗證（手動輸入可繞過 max，靠送出驗證擋）。
- 費用：`famFee(birth)`——未滿3歲免費、未滿12歲 $2,000、滿12歲 $5,000。
- **進度條**：總數動態＝13（員工）＋每位親友 6。`#progressPct` 的初始 HTML 文字是寫死的「0 / 13」——**改欄位數量時要同步改這個數字**（曾漏改造成顯示 0/12）；頁面載入時也會呼叫一次 `updateProgress()` 兜底。
- **截止日**：`SIGNUP_DEADLINE`＝2026-07-24T00:00+08:00（7/23 整天可填）。過期隱藏表單、顯示 `#closedNotice`、送出也會擋。**後端 doPost 也有同一日期的截止檢查**（過期回 `{result:'closed'}` 不寫入）——改截止日要前後端一起改，後端改完要重新部署。
- **記憶與重填**：`SIGNUP_KEY='malaTrip2026SignupV2'`。**問卷結構大改、要全員重新填寫時：bump 這個 key（V3…），舊 key 資料保留不動**，這是使用者指定的模式（舊資料保留不覆蓋）。

## 後端（Google Apps Script，⚠️ 最容易漏的一環）

- 送出＝POST JSON 到 `APPS_SCRIPT_URL`（寫在 index.html 裡，`mode:'no-cors'`）。
- Apps Script 部署在**使用者的 Google 帳號**，這邊看不到也改不了。最新版程式碼備份在本 repo `docs/apps-script.gs`——**改它＝只是備份，真正生效要使用者貼到 Apps Script 編輯器**。
- **它是寫死欄位清單的**：前端 payload 每次新增 key（例如 f1diet），後端就要同步改，否則新資料默默被丟掉（踩過兩次）。**流程：改前端 payload → 同步更新 `docs/apps-script.gs` → 把完整程式碼貼給使用者 → 提醒三步驟**：
  1. 貼上取代全部程式碼
  2. 若欄位增減（**2026-07-16 起報名已開跑的新規則**）：只能**尾端新增**欄位，doPost 會自動補表頭；「統計」分頁刪掉讓它重建（純公式、下一筆送出自動重建）；**「報名登記V2」分頁絕對不能刪**——裡面是已報名的真資料。欄位順序變動/中間插入一律禁止（會跟舊列錯位）。
  3. 重新部署：「部署 → **管理部署作業** → ✏️ 編輯 → 版本選**新版本** → 部署」。**絕不能按「新增部署作業」**——會產生新網址，前端打的還是舊網址。
  - **部署順序**：先後端再前端（舊前端不送新 key 沒事；新前端打舊後端，新欄位會默默被丟掉）。
- 資料流：每次送出**append 一列**（含修改重送），歷史全保留。試算表＝「2026員旅報名表」（fileId `1BIUU1ksPH82e-CvS2_pQnlzrbNTKlnsi7FpgcCDVwUI`，owner madesiaosinla@gmail.com）。分頁：`工作表1`＝6月意願調查（舊）、`報名登記`＝V1（舊）、`報名登記V2`＝現行、`統計`＝自動產生。
- **統計分頁**（`ensureStatsSheet`，首筆送出自動建立）：左＝去重名單（`SORTN(SORT(...,1,FALSE),9^9,2,6,TRUE)`，同身分證字號取時間最新一筆），右 BD/BE＝報名員工數、總人數、漆彈/水晶彈人數、葷素/忌口人數、自費總計。統計一律看這個分頁，直接加總流水帳會重複計算。純公式、勿手動編輯。
- 身分證欄設文字格式的欄位字母**會隨欄位增減位移**，改欄位時記得重算（現行：F,G,T,AA,AH,AO,AV）。

## 驗證與部署流程（使用者指定的節奏）

**「先本機測試再上線」**：改完 → 本機起 server → Playwright 無頭瀏覽器實測 → 全過才 push（push 即上線）。測試腳本在 `tests/test-survey.js`（40+ 檢查：年齡邊界、閘門、進度、payload 攔截、記憶回填、V1 隔離）。跑法：

```bash
cd <repo> && python3 -m http.server 8899 --bind 127.0.0.1 &   # 服務 index.html
npm install playwright   # 若未裝（CCR 環境瀏覽器已在 /opt/pw-browsers）
node tests/test-survey.js
```

- **timezone 必須設 Asia/Taipei**（`browser.newContext({timezoneId:'Asia/Taipei'})`）——容器是 UTC，年齡「生日當天算滿歲」的邊界測試會差一天。
- 測試用 `page.route('**/script.google.com/**')` 攔截送出，**絕不真的打正式端點**；也不要從開發端 POST 測試資料進正式試算表（權限機制會擋，這是對的——測試資料由使用者自己從網頁送）。
- 改了欄位數，記得更新測試裡的進度總數斷言（13 + 6×親友數）。

## 其他注意

- GitHub MCP 的 `actions_list` 回傳很大，會存檔到 tool-results——直接 `jq -r '.workflow_runs[0] | [.run_number,.status,.conclusion,.head_sha[0:7]] | @tsv'` 那個檔案。
- 使用者訊息簡短且可能有錯字（「一覽」=「一欄」），照上下文推斷，動手前講清楚你的理解。
- 投保旅平險必備資料＝姓名/出生/身分證(外籍居留證號)/地址，問卷已齊；受益人預設法定繼承人不用收。

## 收尾：自我改進

用完本 skill 後，review 對話中被重複糾正的地方，整理成規則寫回本檔。
