# だれだっけ

人を軸に、名前・別名・タグ・メモとDiscord / X / VRChatのアカウントを整理する本人専用ツールです。

Cloudflare Workers + D1版は https://daredakke.0g0.xyz に本人限定で配備されています。リポジトリ内のD1 IDと認証値は設定例で、本番の実値はCloudflare側で管理します。未リリースの変更の配備状況は更新履歴と対象PRで確認してください。外部サービス連携と元の私用試作からの実データ移行は行っていません。

## 構成

- React / TypeScript / Viteの画面
- Cloudflare WorkerのJSON APIと静的ファイル配信
- D1の記録保存と更新revisionによる競合防止
- Cloudflare Accessの署名付きJWTを検証する本人認証
- デモとマイレコードを分離
- 人・アカウントの追加と編集、検索、未整理アカウントの手動紐づけ
- 同一サービスの正規化URLが一致する登録の重複候補、手動統合と復元
- version 1 JSONの書き出しと検証付き読み込み
- 未保存の人・アカウント・JSON入力を閉じる際の破棄確認

サービス接続はすべて未接続です。URL・IDの手入力のみです。顔や名前から同一人物を推測しません。サンプルは架空で、デモのプロフィールURLを外部へ開くことはできません。

## まずローカルで確認

Node.js 22.13以上が必要です。クラウドへの認証やAPIトークンは不要です。

1. npm ci
2. npm run types
3. npm run check
4. npm run db:local
5. npm run dry-run

checkは型検証・暗号検証・実際のローカルD1を使うAPIテスト・画面のビルドを実行します。未保存入力の実画面テストはnpx playwright install chromiumの後にnpm run test:browserで別途実行できます。架空のAPI応答だけを使い、Cloudflare本番や外部サービスには接続しません。詳細は[ブラウザー回帰テスト](tests/browser/README.md)を参照してください。db:localはローカルD1のみにマイグレーションを適用します。dry-runは配備せずにWorkerを束ねます。

本番認証設定が空のままでは、画面もAPIも503で拒否します。npm run devで公開可能な認証バイパスは用意していません。npm run deployは準備版では意図的に停止します。

## 本人専用認証

環境変数はdocs/environment.schema.jsonに定義しています。

- APP_ORIGIN: 承認された本人専用ホストのhttpsオリジン
- ACCESS_TEAM_DOMAIN: 承認されたCloudflare Accessチームのhttpsドメイン
- ACCESS_AUDIENCE: このアプリ用AccessのApplication Audience（AUD）
- OWNER_EMAIL: 本人として許可する1つのログインメールアドレス

すべて非秘密の設定値です。秘密鍵、Accessサービス・トークン、Cloudflare APIトークンをソースや画面へ入れません。

WorkerはCf-Access-Jwt-AssertionのRS256署名・issuer・audience・期限・not-before・app種別・本人メール・空でないsubjectを検証します。JWT内のissuerから公開鍵URLを決めません。公開鍵の取得先は設定済みチームに固定します。昔のSites用oai-authenticated-user-*ヘッダー、単なるメールヘッダー、未検証のcookieは信用しません。サービス・トークンも受け入れません。

公開鍵のresolverはWorkerの同じisolate内で再利用します。検証済みissuerごとの最大4件のLRUキャッシュで、取得のtimeoutは5秒、未知の鍵による再取得のcooldownは30秒、公開鍵の有効期間は10分です。期限内の鍵は公開鍵エンドポイントの一時停止中も使えますが、期限切れや不明な鍵は認証を拒否します。JWT、メール、本人判定はキャッシュしません。

静的ファイルを含む全リクエストが認証Workerを先に通ります。workers.devとpreview URLは無効です。実際のAccessアプリ、許可ポリシー、ホスト保護の作成・変更には事前承認が必要です。

保存先は署名検証後のissuerとsubから作るユーザー別namespaceです。デモ、マイレコード、復元履歴もその中で分離します。保存時は読み込み時のnamespaceと現在のログインの一致を確認し、切り替わっていたら古い入力を保存せず画面から消します。URLやJSONのowner指定は保存先を変更できません。

これは将来の複数ユーザーに備えた分離の土台です。今のWorkerの許可メールはOWNER_EMAIL 1件のままで、他ユーザーのログイン、一般公開、共有、登録画面は有効にしていません。詳しくは [認証とユーザー分離](docs/AUTHENTICATION.md) を参照してください。

## 本番へ進める前

画面の配布には2通りあります。通常のwrangler.jsoncはCloudflare Static Assets用です。API経由でupload-sessionの認証を扱えない接続では、npm run bundle:workerで画面を同じWorkerのbundleに含められます。どちらも元の認証入口を先に通り、別の公開Workerや資格情報は不要です。bundle方式は合計1MB・100個までのUTF-8ファイルに限定します。通常のStatic Assetsとは異なり、静的応答にもWorkerの利用量がかかります。

docs/DEPLOYMENT.mdのチェックリストに従ってください。ソースはユーザーが用意した [g-kari/daredakke](https://github.com/g-kari/daredakke) で管理します。CIは型検証・テスト・ローカルD1・配備しないdry-runだけを実行し、Cloudflareへ配備しません。

D1のdatabase_idはローカル用の置換必須値です。承認後に対象アカウント、データベース、本人専用ドメイン、Accessアプリを確認し、実際の値へ置き換えます。設定後はnpm run typesをやり直します。

## 保存と互換性

- 記録はD1に保存します。localStorageを記録の保存先にしません。
- 保存文書は操作履歴を含めUTF-8で850KBまで。JSON読み込みは900KBまで。
- 人200件、アカウント1,000件、別名とタグは各20個まで。
- 復元は履歴にある直近10操作です。長期の保管はJSONバックアップが必要です。
- 新しい書き出しはformat: daredakke / version: 1です。旧format: friend-record / version: 1も読み込めます。
- 読み込みはユーザーが選択した保存先だけを置き換え、直前の状態を復元用に保持します。
- 元Sitesの本番データを取得・移行する処理はありません。実データ移行は別途許可とバックアップ確認後に行います。

## 検証の限界

本番Cloudflare Accessとの接続、公開されたCloudflareでのエンドツーエンド保存、実機スマートフォンと支援技術の操作は未検証です。未保存入力のキーボード操作と390pxのモバイル幅は、架空APIを使うChromium回帰テストの対象です。合格状況は対象コミットのCI結果を確認してください。WebMCPは対応ブラウザーを検出したときだけ検索と人追加画面を開くツールを登録しますが、対応ブラウザーでの実行検証は未実施です。

## 公式資料

- [Access JWTの検証](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Accessのアプリケーショントークン](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
- [Workerを先に実行する静的アセット設定](https://developers.cloudflare.com/workers/static-assets/binding/)
- [D1マイグレーション](https://developers.cloudflare.com/d1/reference/migrations/)
- [Workersの推奨実装](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
