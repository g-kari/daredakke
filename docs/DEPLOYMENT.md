# 本番配備のチェックリスト

この文書は手順の準備です。ここに書かれた操作が承認済みという意味ではありません。

## 決めて確認するもの

- リポジトリ g-kari/daredakke（公開ソース）の所有者、反映先ブランチ、変更範囲
- 使用するCloudflareアカウントと既存/新規D1
- 本人専用のホスト、Cloudflare Accessのチームとアプリ
- 本人メールだけのAllowポリシー
- APP_ORIGIN、ACCESS_TEAM_DOMAIN、ACCESS_AUDIENCE、OWNER_EMAIL
- 本番配備、リソース作成、料金、セキュリティ設定の承認範囲

Accessは新たな本人認証・アクセス制御の設定です。既存設定を変更したり新たな永続アクセスを作る前に、必要な操作ごとの承認を得ます。ログイン、権限不足、課金画面を別ルートで迂回しません。

## コード準備後、承認を得て行う順序

1. 対象リポジトリの指示・既存構成を読み、準備ソースを専用ブランチへ統合する
2. D1とAccessが対象アカウント/ホストに一致することを確認する
3. wrangler.jsoncのローカル用database_id/nameと空のvarsを実際の承認済み値にする
4. ドメインのAccess保護を先に確立し、workers.devとpreview URLが無効であることを確認する
5. npm ci、npm run types、npm run check、npm run dry-runを実行する
6. 対象D1へのマイグレーション適用を承認範囲内で行う
7. 対象ホストへの配備を承認範囲内で行う
8. 匿名・別アカウント・本人で画面とAPIの境界を確認する
9. 本人のデモ保存先だけで追加・紐づけ・統合・復元・JSON roundtripを確認する
10. 正しい所有者以外に記録が見えないことを確認して結果を共有する

## 中止条件

- Accessの保護が未完了、所有者メールやAUDが不明
- 匿名/別アカウントで画面またはAPIの記録が見える
- 想定外の料金・権限・公開範囲の変更が必要
- マイグレーション先や既存データの有無が不明

本番データの移行、削除、バックフィルはこのパッケージの通常配備に含めません。元Sitesは移行確認と明示的な指示があるまで保全します。

## 1 Workerの静的bundle方式

Cloudflare Static AssetsのDirect Uploadはupload-session JWTを使うため、接続がその認証方式を扱えない場合はwrangler.bundled.jsoncを使います。npm run bundle:workerはfrontend build、UTF-8 byte/hash検査、同じWorkerに含めるJSON生成、配備しないWorker dry-runを実行します。生成物は.gitignore対象です。秘密や実データのファイルを読みません。

src/worker/bundled.tsは元のauth-first handlerに静的応答を渡します。認証を迂回する公開経路、追加Worker、外部fetchによるasset proxyはありません。GET/HEAD、固定MIME、未知assetの404、private/no-storeを検証しています。

Cloudflare APIの通常multipart Worker uploadにこのbundleを使い、main_module、DB binding、非秘密の4設定値を指定します。実設定値はCloudflare側に置き、公開リポジトリへ本人メールやアカウント情報を入れません。空Workerをworkers.dev/preview無効で作り、Access本人限定ルールを確認してから承認されたホストを接続します。

bundleは小さなテキスト画面用です。バイナリー画像、合計1MB超または100ファイル超は生成を止めます。その場合は正式なStatic Assets配備経路の確認が必要です。静的ファイルもWorkerを実行するため、利用量と料金は通常のStatic Assets方式と異なります。新プランや資格情報の作成を自動で行いません。

## ロールバック

配備前のWorkerバージョンとD1バックアップを確認します。Workerの切り戻しとDBの復元は別です。今回の初期SQLは1テーブルを作成するだけで、既存行を消したり変更したりしません。適用済みマイグレーションは書き換えず、将来の変更は追記します。
