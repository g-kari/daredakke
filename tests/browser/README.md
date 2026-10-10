# 入力破棄のブラウザー回帰テスト

npm ci 後、npx playwright install chromium と npm run test:browser で実行します。

通常のvite buildで生成した実画面をlocalhostのpreviewで開き、Playwright側で /api/session と /api/records を架空データに置き換えます。本番の認証・API・D1は使わず、localhost以外への通信を遮断します。実装にデモ用の認証回避やテスト入口を追加しません。

デスクトップと390pxのモバイル幅で、Escape / キャンセル / 閉じる / 背景クリック、入力の保持と破棄、フォーカス復帰・トラップ、通常保存、JSONの保持、繰り返しのWebMCP追加要求、本人変更時の入力消去を確認します。WebMCP登録先だけをテスト用に差し替えるため、対応ブラウザーでのWebMCP通信互換性を証明するテストではありません。

CIは読み取り専用のpermissionsで同じテストを実行し、最終ソースSHA、JSON結果、失敗時のtraceとスクリーンショットを1日間だけ保存します。証拠には架空データだけを使います。本番Cloudflare Accessとの接続、実機スマートフォン・支援技術の操作は別途確認が必要です。
