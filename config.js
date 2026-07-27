/* ============================================================
   Repas Atelier 設定ファイル
   ここだけ編集すれば公開できます。
   ============================================================ */
window.REPAS_CONFIG = {

  /* AI解析プロキシのURL。
     - ローカルテスト中(localhost)は自動で同一オリジンの /api/analyze を使うので変更不要。
     - 本番公開時は、デプロイした Cloudflare Worker のURLをここに貼る。
       例: "https://repas-proxy.あなたのサブドメイン.workers.dev/api/analyze"          */
  PROXY_URL: "https://repas-proxy.yuya-suzuki-37.workers.dev/api/analyze",

  /* 診断結果の下に出す「次の一歩」CTA。
     LINE公式 / 予約フォーム / UTAGE等のURLに差し替える。
     空文字("")のままだとCTAブロックは非表示になる。                                     */
  CTA_URL: "",
  CTA_LABEL: "無料でダイエット相談をLINEで受ける",
  CTA_TITLE: "この結果を、続く習慣へ。",
  CTA_TEXT: "あなたの食事傾向に合わせて、無理なく続くダイエットの進め方をLINEでご提案します。",

  /* 1日の目安（診断結果で「この一食は1日の何%か」を出すのに使用）                        */
  DAILY_KCAL_TARGET: 2000,
};
