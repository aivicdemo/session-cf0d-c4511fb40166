// AIVIC Backend Configuration
// AIVIC_APP_URL 環境変数が設定されている場合は自動セットされます
// 未設定の場合: REPLACE_WITH_API_URL を AIVIC アプリの URL（例: https://your-app.amplifyapp.com）に書き換えてください

window.AIVIC_API_URL = "REPLACE_WITH_API_URL";
window.AIVIC_TABLES = {
  "修理受付": 0,
  "修理ステータス": 1,
  "修理進捗段階マスタ": 2,
  "停滞理由マスタ": 3,
  "顧客": 4,
  "顧客連絡タスク": 5,
  "連絡内容テンプレート": 6,
  "連絡実施履歴": 7,
  "保管料単価マスタ": 8,
  "保管料計算履歴": 9,
  "請求": 10,
  "ログインユーザー": 11,
  "ユーザー権限マスタ": 12
};
