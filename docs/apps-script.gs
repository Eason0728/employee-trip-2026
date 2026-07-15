// 2026 員旅「報名登記表」後端 V2：寫入「報名登記V2」分頁＋自動建立「統計」分頁
// ⚠️ 本檔僅為備份。實際生效的程式碼在使用者 Google 帳號的 Apps Script 專案裡，
//    前端 payload 欄位有增減時：更新本檔 → 把完整內容貼給使用者取代 → 刪掉
//    「報名登記V2」「統計」分頁讓表頭重建 → 管理部署作業→編輯→新版本→部署
//    （不可按「新增部署作業」，會換網址）。
function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    var data = JSON.parse(e.postData.contents);
    function v(x) { return x == null ? '' : x; }

    var TAB = '報名登記V2';
    var HEADERS = ['時間','單位','店別','姓名','出生年月日','身分證字號','手機號碼','地址',
                   '職別','自費金額(員工)','搭車地點','攜帶親友',
                   '參與漆彈／水晶彈(員工)','漆彈人數','水晶彈人數','飲食習慣','備註'];
    for (var i = 1; i <= 5; i++) {
      HEADERS.push('親友'+i+'姓名','親友'+i+'出生年月日','親友'+i+'身分證字號',
                   '親友'+i+'地址','親友'+i+'漆彈／水晶彈','親友'+i+'飲食','親友'+i+'費用');
    }
    HEADERS.push('親友費用小計','自費總計');

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB);
    if (!sheet) {
      sheet = ss.insertSheet(TAB);
      sheet.appendRow(HEADERS);
      sheet.setFrozenRows(1);
      // 員工身分證(F)/手機(G)與親友身分證(T,AA,AH,AO,AV) 存成文字
      ['F:F','G:G','T:T','AA:AA','AH:AH','AO:AO','AV:AV'].forEach(function(r) {
        sheet.getRange(r).setNumberFormat('@');
      });
    }

    var row = [new Date(),
      v(data.unit), v(data.store), v(data.name), v(data.birth),
      v(data.id), v(data.phone), v(data.addr), v(data.role), v(data.fee),
      v(data.pickup), v(data.family),
      v(data.paintball), v(data.paintballCount), v(data.crystalCount),
      v(data.diet), v(data.memo)];
    for (var i = 1; i <= 5; i++) {
      row.push(v(data['f'+i+'name']), v(data['f'+i+'birth']), v(data['f'+i+'id']),
               v(data['f'+i+'addr']), v(data['f'+i+'paintball']), v(data['f'+i+'diet']), v(data['f'+i+'fee']));
    }
    row.push(v(data.familyFee), v(data.totalFee));
    sheet.appendRow(row);

    ensureStatsSheet(ss);

    return ContentService.createTextOutput(JSON.stringify({result:'ok'}))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({result:'error', message:String(err)}))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

// 「統計」分頁：同一身分證字號只取最新一筆（每次送出時檢查，不存在才建立）
function ensureStatsSheet(ss) {
  if (ss.getSheetByName('統計')) return;
  var st = ss.insertSheet('統計');
  st.getRange('A1').setFormula("={'報名登記V2'!A1:BB1}");
  st.getRange('A2').setFormula("=SORTN(SORT('報名登記V2'!A2:BB,1,FALSE),9^9,2,6,TRUE)");
  st.getRange('BD1:BD8').setValues([
    ['報名員工數'],['總人數(含親友)'],['漆彈總人數'],['水晶彈總人數'],
    ['葷食人數(含親友)'],['全素人數(含親友)'],['特殊忌口人數(含親友)'],['自費總計']
  ]).setFontWeight('bold');
  st.getRange('BE1:BE8').setFormulas([
    ['=COUNTA(D2:D)'],
    ['=COUNTA(D2:D)+SUM(L2:L)'],
    ['=SUM(N2:N)'],
    ['=SUM(O2:O)'],
    ['=COUNTIF(P2:P,"葷食*")+COUNTIF(W2:W,"葷食*")+COUNTIF(AD2:AD,"葷食*")+COUNTIF(AK2:AK,"葷食*")+COUNTIF(AR2:AR,"葷食*")+COUNTIF(AY2:AY,"葷食*")'],
    ['=COUNTIF(P2:P,"全素*")+COUNTIF(W2:W,"全素*")+COUNTIF(AD2:AD,"全素*")+COUNTIF(AK2:AK,"全素*")+COUNTIF(AR2:AR,"全素*")+COUNTIF(AY2:AY,"全素*")'],
    ['=COUNTIF(P2:P,"其他*")+COUNTIF(W2:W,"其他*")+COUNTIF(AD2:AD,"其他*")+COUNTIF(AK2:AK,"其他*")+COUNTIF(AR2:AR,"其他*")+COUNTIF(AY2:AY,"其他*")'],
    ['=SUM(BB2:BB)']
  ]);
  st.setFrozenRows(1);
}
