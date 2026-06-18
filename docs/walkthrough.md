# ワークスルー: RDS Proxy, ECS ネイティブシークレット注入, CDKTF Datadog 監視

本プロジェクトにおけるパフォーマンス改善, スロットリング回避（Secrets ManagerのAPI上限対策）, 開発環境（`dev`）のコスト最適化, および **CDK for Terraform (CDKTF) を用いた Datadog 監視（TypeScript）＆ リモートステートバックエンド移行** の実装がすべて完了しました。

---

## 1. RDS Proxy の導入 ＆ 認証情報注入 of ネイティブ化

### 変更内容

#### 1. [database.ts (RDSインフラ定義)](file:///c:/Git/learning-ts-concepts/infra/lib/constructs/database.ts)
- `prod` / `stg` 環境のみ `DatabaseProxy` を構築する分岐を追加。
- 接続数オーバーとフェイルオーバー対策として Amazon RDS Proxy を導入。

#### 2. [compute.ts (Fargate定義)](file:///c:/Git/learning-ts-concepts/infra/lib/constructs/compute.ts)
- 平文の `DB_SECRET_ARN` 環境変数渡しを廃止。
- `ecs.Secret.fromSecretsManager` を使用し、ECSネイティブの環境変数自動注入（`DB_USER` / `DB_PASSWORD`）へリファクタリング。これにより、タスク増時の Secrets Manager API スロットリングを回避。
- DBのホスト名を `DB_HOST` 環境変数としてコンテナへ引き渡し。

#### 3. [stack.ts (CDKインフラ定義)](file:///c:/Git/learning-ts-concepts/infra/lib/stack.ts)
- Proxyの有無に基づき、`dbHost` (Proxy エンドポイント or DBクラスターホスト名) を動的に決定して `ComputeConstruct` へ引き渡し。
- セキュリティグループの通信許可（ECS -> DB）を、Proxyの有無に応じて動的に切り替えるように設定。

#### 4. [stack.test.ts (CDKユニットテスト)](file:///c:/Git/learning-ts-concepts/infra/test/stack.test.ts)
- ネイティブシークレット注入の有無と、`dev` では `DBProxy` が0件であることをチェックするアサーションを追加。
- テストコードにおける `Match.arrayWith` や CloudFormation 組み込み関数 `Fn::GetAtt` を含むオブジェクト比較について、Jest のプレーンなオブジェクト検証にリファクタリングし、テストの安定性を向上。

---

## 2. 開発環境（dev）夜間自動停止の実装

### 変更内容

#### 1. [stack.ts (CDKインフラ定義)](file:///c:/Git/learning-ts-concepts/infra/lib/stack.ts)
- Fargate タスク数を夜間に 0 へ自動スケールダウンするスケジュール定義（JST 20:00 停止、翌08:00 起動）。
- Aurora DB クラスターを夜間に一時停止する Lambda 関数（`RdsControlFunction`）および EventBridge トリガ（起動・停止）を定義。

#### 2. [stack.test.ts (CDKユニットテスト)](file:///c:/Git/learning-ts-concepts/infra/test/stack.test.ts)
- 自動スケーリング設定、制御用 Lambda、およびイベントルールのリソース数が正しいか検証するアサーションを追加。

---

## 3. Datadog 監視設定の新規構築 (CDK for Terraform)

インフラのメトリクス（ECS, RDS）を対象としたアラート（Monitor）を、TypeScriptコードで宣言的に管理する仕組みを導入しました。

### 変更内容

#### 1. [tsconfig.json, package.json, cdktf.json (プロジェクト設定)](file:///c:/Git/learning-ts-concepts/monitoring/package.json)
- CDKTF と Datadog プロバイダー (`@cdktf/provider-datadog`) の依存関係を追加。
- Windows の CLI ローカルインストール時の `node-pty` ビルドエラーを回避するため、`--ignore-scripts` を使用して安全にインストール可能な構成にしました。

#### 2. [config.ts (環境変数注入の抽象化 ＆ バックエンド設定読込)](file:///c:/Git/learning-ts-concepts/monitoring/lib/config/config.ts)
- `DatadogConfig` と `getDatadogConfig()` を拡張。
- `process.env.DATADOG_API_KEY` 等に加え、リモートステート管理に必要な `TERRAFORM_STATE_BUCKET` や `TERRAFORM_LOCK_TABLE` などの AWS 環境変数を一括でロードする構造に設計。

#### 3. [ecs-monitors.ts, rds-monitors.ts (アラート定義)](file:///c:/Git/learning-ts-concepts/monitoring/lib/monitors/ecs-monitors.ts)
- 推奨プラクティスに基づき、AWSリソースのタグ（`app:three-tier`, `env:xxx`）を用いてアラート対象をフィルタリングするよう設計。
- ECS: CPU使用率 (>80%) / メモリ使用率 (>80%) のアラートモニター。
- RDS: CPU使用率 (>80%) / DB接続数 (>100) / 空きストレージ容量 (<5GB) のアラートモニター。

#### 4. [datadog-stack.ts, main.ts (ハイブリッドリモートバックエンドの導入)](file:///c:/Git/learning-ts-concepts/monitoring/main.ts)
- 環境変数に S3 バケット名が設定されている場合のみ `S3Backend`（S3 + DynamoDB ロック）を自動有効化する設計（ハイブリッドバックエンド）を導入。
- これにより、環境変数を設定しないローカル開発時は自動的にローカルバックエンド (`local`) にフォールバックするため、手軽なローカル検証（`cdktf synth`）と CI/CD からの厳密なステート管理が両立します。

#### 5. [datadog.yml (CI/CD ＆ AWS認証設定)](file:///c:/Git/learning-ts-concepts/.github/workflows/datadog.yml)
- CDKTF 監視デプロイ用のワークフローを追加。
- ジョブ全体の `env` 節として、ステート用 S3 バケット設定と AWS 認証用 Secrets （`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`）をバインドし、GitHub Actions 上での安全なステート読み書きを可能にしました。
- プルリクエスト時には `cdktf diff` を、`main`/`develop` へのマージ（プッシュ）時には `cdktf deploy` を自動実行させます。

---

## 動作確認

### AWS CDK (infra)
```bash
PASS test/stack.test.ts (8.018 s)
  √ ThreeTierStack Synthesizes Correctly (690 ms)

Test Suites: 1 passed, 1 total
Tests:       1 passed, 1 total
Snapshots:   0 total
Time:        8.253 s, estimated 9 s
Ran all test suites.
```

### CDKTF (monitoring)
```bash
> tsc --noEmit
# 正常に終了（エラーなし）

# 環境変数をシミュレートした状態でのローカル synth 検証
> $env:TERRAFORM_STATE_BUCKET="dummy"; $env:TERRAFORM_LOCK_TABLE="dummy"; npx cdktf synth
Generated Terraform code for the stacks: datadog-monitoring-dev
# cdk.tf.json 内の backend が正しく "s3" として出力されていることを確認済
```

---

## 次のステップ
- **プッシュの完了**:
  - AWSインフラの変更（コミットID: `ffe54c3`）および CDKTF Datadog 監視設定の追加（コミットID: `288fa80`）は、指定された noreply メールアドレスを用いてすべて正常にリモートの `main` ブランチへプッシュされました。
- **GitHub Secrets の設定**:
  - GitHub Actions 側の動作のために、GitHub リポジトリ設定（Secrets）に以下の項目を登録してください。
    - `DATADOG_API_KEY` / `DATADOG_APP_KEY`（Datadog接続用）
    - `TERRAFORM_STATE_BUCKET` / `TERRAFORM_LOCK_TABLE`（AWS S3バケット名 / DynamoDBテーブル名）
    - `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`（上記バケット読み書き用の AWS 認証情報）
