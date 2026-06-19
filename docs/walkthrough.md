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

## 4. stg/prod 環境へのリードレプリカ導入および構成整合

本番（`prod`）およびステージング（`stg`）環境において、接続数オーバーおよびフェイルオーバー対策として **Amazon RDS Proxy** に加え、**Aurora Serverless v2 のリードレプリカ (Reader 2台)** を導入し、それに対応するテストコードおよびアーキテクチャ構成図の整合性を確保しました。

### 変更内容

#### 1. [database.ts (RDSインフラ定義)](file:///c:/Git/learning-ts-concepts/infra/lib/constructs/database.ts)
- `prod` / `stg` 環境のみ Aurora Serverless v2 のリードレプリカ (`reader1`, `reader2`) を `readers` プロパティへ追加する実装（ローカル適用済み）を確認。
- `dev` 環境は引き続きシングルWriter構成（Proxyなし・Readerなし）を維持し、無駄な追加料金が発生しないようコスト最適化設計を徹底。

#### 2. [stack.test.ts (CDKユニットテストの追加と強化)](file:///c:/Git/learning-ts-concepts/infra/test/stack.test.ts)
- `dev` 環境に加え、新たに `stg` および `prod` 用 of テストケースを新規追加。
- 各環境ごとに、以下のリソース構成が期待通りに構築されているか検証するアサーションを追加：
  - `stg` / `prod` 環境: `AWS::RDS::DBProxy` が 1 つ作成され、かつ `AWS::RDS::DBInstance` が合計 3 つ（Writer 1台 + Reader 2台）作成されていること。夜間一時停止スケジュール（dev専用）が存在しないこと。
  - `dev` 環境: `AWS::RDS::DBProxy` は 0 件、かつ `AWS::RDS::DBInstance` が 1 つ（Writer のみ、Reader なし）であること。

#### 3. [architecture.svg (アーキテクチャ構成図の更新)](file:///c:/Git/learning-ts-concepts/diagrams/architecture.svg)
- AZ-b および AZ-c 的な Isolated サブネット内に `Aurora DB (Reader) (prod/stg only)` を追加。
- RDS Proxy から Reader への接続線および Writer から Reader へのレプリケーション関係（`Replicate (prod/stg)`）を構成図に追加。

---

## 動作確認

### AWS CDK (infra)
```bash
> cdk-three-tier-3az@0.1.0 test
> jest

PASS test/stack.test.ts (11.026 s)
  √ ThreeTierStack Synthesizes Correctly (958 ms)
  √ ThreeTierStack - Staging Environment Synthesizes Correctly (651 ms)
  √ ThreeTierStack - Production Environment Synthesizes Correctly (571 ms)

Test Suites: 1 passed, 1 total
Tests:       3 passed, 3 total
Snapshots:   0 total
Time:        11.233 s, estimated 13 s
Ran all test suites.
```

### CDKTF (monitoring)
```bash
# 環境変数をシミュレートした状態でのローカル synth 検証
> $env:TERRAFORM_STATE_BUCKET="dummy"; $env:TERRAFORM_LOCK_TABLE="dummy"; npx cdktf synth
Generated Terraform code for the stacks: datadog-monitoring-dev
# シンセサイズがエラーなく完了することを確認
```

---

## 次のステップ
- **コミット ＆ プッシュの完了**:
  - リードレプリカの導入とテスト強化、構成図の整合性対応をすべてコミットし、`main` ブランチへ正常にプッシュしました。
    - コミットID: `d4da092`
    - メッセージ: `feat: add database read replicas for prod/stg and update tests/architecture diagram to match`
- **GitHub Actions での CI/CD 実行確認**:
  - プッシュに伴い自動実行される GitHub Actions 上でインフラテストおよび CDKTF シンセサイズが正常にパスすること（グリーン状態）をご確認ください。

---

## 5. ポートフォリオ用ガバナンス設計ドキュメントの追加

本テンプレートがポートフォリオとしての価値を最大化できるよう、検証用シングルアカウント構成（コスト0円での動作チェック）の背景にあるエンタープライズ向けの「設計・財務ガバナンス思想」を明文化したドキュメントを追加しました。

### 追加された設計書

#### 1. [multi-account-design.md (マルチアカウント設計方針)](file:///c:/Git/learning-ts-concepts/docs/governance/multi-account-design.md)
- AWS Organizations と AWS Control Tower を活用した組織（OU）設計。
- 各アカウント（Management, Log Archive, Audit, Shared Services, workloads）の明確な役割定義とリポジトリ分離の設計思想。

#### 2. [security-and-audit.md (監査・セキュリティ基準)](file:///c:/Git/learning-ts-concepts/docs/governance/security-and-audit.md)
- SCP (Service Control Policy) を用いた「許可外リージョンでのリソース作成禁止」「セキュリティツールの無効化防止」などの強制ガードレール設計。
- GuardDuty / Security Hub / Config の委任管理（Delegated Admin）の概念。

#### 3. [cost-management.md (コスト管理・財務ガバナンス方針)](file:///c:/Git/learning-ts-concepts/docs/governance/cost-management.md)
- 一括請求（Consolidated Billing）による割引枠の共有ルール。
- 開発環境（`dev`）における夜間自動停止や Nat Gateway 回避などの徹底したコスト最適化、および AWS Budgets と Cost Anomaly Detection による FinOps 管理設計。

## 6. SRE観点での追加設計改善（非Root実行・バージョン固定・本番保護・オートスケーリング）

引き継ぎ後に、SREおよびセキュリティレベルをプロダクションレディに高めるための追加設計改善を実装し、最新のコードツリーに適用しました。

### 変更内容

#### 1. [Dockerfile (コンテナセキュリティ)](file:///d:/kai.oshino/Projects/Git/private/learning-ts-concepts/app/Dockerfile)
- **非Root実行化**: Nginxを特権ユーザー（root）ではなく、非特権の `nginx` ユーザーで起動するように設定。公開ポートを `8080` に変更。
- **設定ファイルの追加**: PID書き込み先やキャッシュディレクトリ等のパーミッションエラーを回避するため、PIDと一時ファイルパスを `/tmp` に逃がしたカスタム [nginx.conf](file:///d:/kai.oshino/Projects/Git/private/learning-ts-concepts/app/nginx.conf) および [default.conf](file:///d:/kai.oshino/Projects/Git/private/learning-ts-concepts/app/default.conf) を追加。
- **バージョン固定**: ベースイメージを `nginx:1.25.4-alpine` にピン留め。

#### 2. [compute.ts (CDKインフラ定義)](file:///d:/kai.oshino/Projects/Git/private/learning-ts-concepts/infra/lib/constructs/compute.ts)
- Datadog Agent のイメージを `gcr.io/datadoghq/agent:7.54.0` にピン留め。
- Fargateのポートマッピングを `8080` に変更。

#### 3. [database.ts (CDKデータベース定義)](file:///d:/kai.oshino/Projects/Git/private/learning-ts-concepts/infra/lib/constructs/database.ts)
- 本番環境（`prod`）のみ、DBの削除保護（`deletionProtection: true`）および `removalPolicy: RETAIN` を適用。

#### 4. [stack.ts (CDKインフラ定義)](file:///d:/kai.oshino/Projects/Git/private/learning-ts-concepts/infra/lib/stack.ts)
- ALBのターゲットポートを `8080` に変更。
- 本番（`prod`/最小2, 最大10）およびステージング（`stg`/最小1, 最大4）環境に対して、CPUおよびメモリ使用率70%をターゲットとする **ターゲット追跡動的オートスケーリング** を実装。

#### 5. [stack.test.ts (CDKアサーションテスト)](file:///d:/kai.oshino/Projects/Git/private/learning-ts-concepts/infra/test/stack.test.ts)
- AppContainerのポートが8080であることをテストアサーションに追加。
- 本番環境における DB削除保護/RETAIN設定、および ECS Auto Scaling ポリシーの適用が定義通りであるかを検証するテストケースを新規追加。

---

## 🧪 動作確認（全体チェック完了）

### AWS CDK (infra)
- `npm test` によるユニットテストがすべて正常にパスすることを確認（PASS）。
- `cdk synth` による CloudFormation 合成確認（dev / stg / prod）が正常に完了することを確認。

### CDKTF (monitoring)
- Windows環境でのインストールエラーを回避しつつ、依存関係のクリーンインストール（`npm install --ignore-scripts`）が完了。
- `npm run compile`（TypeScriptコンパイル）が正常に完了することを確認。
- `npx cdktf synth` による Terraform JSON 合成が正常に完了することを確認。

---

## 7. リポジトリ間連携用インターフェース（shared-outputs.md）の追加

ドキュメント駆動によるマルチリポジトリ（`aws-landing-zone` との）連携を実現するため、OIDCデプロイロールARNやアカウントIDなどの変数を定義・同期するためのインターフェース仕様書 [shared-outputs.md](file:///c:/Git/learning-ts-concepts/docs/governance/shared-outputs.md) を追加しました。

これにより、双方の独立したリポジトリで動作する AI アシスタント（Antigravity）が、本ファイルの変更（プッシュ）をトリガーにして安全に最新のインフラ構築値を引き引き継ぎ・適用できるようになります。




