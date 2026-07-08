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

---

## 8. クロスアカウントログ集約（CloudWatch Logs ➔ Kinesis Data Firehose）の実装

管理アカウント/集約アカウントでプロビジョニングされた Kinesis Data Firehose に対し、ECS Fargate のコンテナログ（CloudWatch Logs）からログを自動転送する `SubscriptionFilter` パイプラインを構築しました。

### 変更内容

#### 1. [stack.ts (CDKインフラ定義)](file:///c:/Git/learning-ts-concepts/infra/lib/stack.ts)
- `shared-outputs.md` のファイルをビルド・合成（synth）時に同期的にパースし、指定環境の `LOG_ARCHIVE_FIREHOSE_ARN` および `LOG_ARCHIVE_DELIVERY_ROLE_ARN` を自動的に抽出するヘルパー関数を実装。
- トランスパイル後や Jest テスト実行時などのパス変更に対応するため、フォールバック検索（`process.cwd()` を含む3階層）を実装。
- 抽出した接続情報を `ComputeConstruct` へ引き渡すことで、連携ドキュメントの値がそのままインフラコードへ自動ロードされる仕組みを確立。

#### 2. [compute.ts (ECS Fargate定義)](file:///c:/Git/learning-ts-concepts/infra/lib/constructs/compute.ts)
- Fargate コンテナログ用に、明示的なロググループ（`aws_logs.LogGroup`）を作成。
- クロスアカウントの Kinesis Firehose へのログ配信におけるバインディングエラーを回避するため、L2 リソースではなく L1 リソースの `aws_logs.CfnSubscriptionFilter` を使用して、指定された Firehose ARN と配信ロールの ARN をロググループに直接紐付ける処理を実装。

#### 3. [stack.test.ts (CDKユニットテストの追加)](file:///c:/Git/learning-ts-concepts/infra/test/stack.test.ts)
- `dev`, `stg`, `prod` すべての環境スタックのテストケースに、`AWS::Logs::SubscriptionFilter` が 1 つ作成されること、および送信先ストリームARNや配信用ロールARNが `shared-outputs.md` に記載したダミー値（`LogArchiveDeliveryStream` 等）と正しく紐づいていることを検証するアサーションを追加。






## 9. AWS ElastiCache (Redis) の環境別導入（SRE強化フェーズ 1）

環境間パリティを維持しつつ開発コストを抑えるため、環境別にトポロジーを動的に切り替える ElastiCache (Redis) キャッシュレイヤーを構築しました。

### 変更内容

#### 1. [cache.ts (キャッシュ定義)](file:///c:/Git/learning-ts-concepts/infra/lib/constructs/cache.ts) [NEW]
- `CacheConstruct` を新規作成し、VPCのアイソレーテッドサブネットに配置する Redis サブネットグループを定義。
- `dev`環境：コスト極小化のため、レプリカなし・マルチAZ無効のシングルノード（`CfnCacheCluster`）で構築（`cache.t4g.micro`）。
- `stg` / `prod`環境：高可用性を担保するため、プライマリ1＋レプリカ1のマルチAZ構成・自動フェイルオーバー有効のレプリケーションクラスター（`CfnReplicationGroup`）で構築（`cache.t4g.micro`）。

#### 2. [network.ts (ネットワーク定義)](file:///c:/Git/learning-ts-concepts/infra/lib/constructs/network.ts)
- Redis 専用のセキュリティグループ `redisSecurityGroup` を追加。
- ECSタスク用セキュリティグループ `ecsSecurityGroup` からの Port 6379 接続のみを許可するインバウンドルールを定義。

#### 3. [stack.ts (CDKスタック統合)](file:///c:/Git/learning-ts-concepts/infra/lib/stack.ts)
- `CacheConstruct` をインスタンス化し、作成された Redis のエンドポイントアドレスを `ComputeConstruct` へ引き渡す。

#### 4. [compute.ts (ECS Fargate定義)](file:///c:/Git/learning-ts-concepts/infra/lib/constructs/compute.ts)
- ECSの `AppContainer` の環境変数として `REDIS_HOST` および `REDIS_PORT` をインジェクションし、アプリケーションから透過的に接続可能な構成を実装。

#### 5. [stack.test.ts (CDKアサーションテストの更新)](file:///c:/Git/learning-ts-concepts/infra/test/stack.test.ts)
- `dev`環境：`AWS::ElastiCache::CacheCluster` （NumCacheNodes: 1）が作成されていることの検証を追加。
- `stg`/`prod`環境：`AWS::ElastiCache::ReplicationGroup` （NumCacheClusters: 2、MultiAZ/Failover 有効）が作成されていることの検証を追加。
- `AppContainer` の環境変数に `REDIS_HOST`/`REDIS_PORT` が正しくセットされていることのアサーションを追加。

## 10. ECS Exec (AWS SSM) の環境別有効化と監査ロギング（SRE強化フェーズ 2）

コンテナへの安全なリモートデバッグ環境を提供する ECS Exec を導入し、SREとしてのセキュリティガバナンス設計（本番環境での無効化・監査ロギングの自動化）を実装しました。

### 変更内容

#### 1. [compute.ts (ECS Fargate定義)](file:///c:/Git/learning-ts-concepts/infra/lib/constructs/compute.ts)
- 専用の監査ログ保存用 CloudWatch Logs ロググループ `EcsExecAuditLogGroup` (`/ecs/env/AppExecAudit`) を作成。
- ECSタスク定義の Task Role に対し、コンテナ内 SSM Agent が AWS SSM サービスと通信するための最小権限ポリシー（`ssmmessages:CreateControlChannel` 等）および監査ログ書き込み権限ポリシーをアタッチ。
- ECS Cluster 側の `executeCommandConfiguration` で、すべての操作セッション履歴を `EcsExecAuditLogGroup` へロギング保存する設定をオーバーライド適用。
- `FargateService` で `enableExecuteCommand` を環境パラメータ（`dev`/`stg` は `true` で開発デバッグを許可、`prod` は `false` で本番への侵入防止を強制）に基づいて動的にスイッチする設計を実装。

#### 2. [stack.test.ts (CDKアサーションテストの更新)](file:///c:/Git/learning-ts-concepts/infra/test/stack.test.ts)
- `dev` / `stg`環境テスト：`AWS::ECS::Service` の `EnableExecuteCommand` が `true` であること、監査ロググループが作成されていること、および Task Role に対し SSM/Logs 操作権限ポリシーが正しく設定されていることをアサーション検証。
- `prod`環境テスト：`AWS::ECS::Service` の `EnableExecuteCommand` が `false` であることの検証を追加。

## 11. AWS KMS によるリソース暗号化ガバナンスの導入（SRE強化フェーズ 3）

データの保護をAWSのデフォルト共有鍵から、アクセス制御とローテーションライフサイクル管理が可能な **KMS カスタマー管理キー (CMK)** によるデータ暗号化へアップグレードしました。

### 変更内容

#### 1. [kms.ts (KMS定義)](file:///c:/Git/learning-ts-concepts/infra/lib/constructs/kms.ts) [NEW]
- `KmsConstruct` を新規作成。各環境共通で KMS キーを作成し、環境間パリティを担保。
- セキュリティ要件に合わせ、本番環境（`prod`）のみ **キー自動ローテーション (EnableKeyRotation)** を有効化し、削除ポリシーを `RETAIN`（それ以外は `DESTROY`）に設定。
- CloudWatch Logs サービスプリンシパル（`logs.<region>.amazonaws.com`）に対して、ロググループの暗号化・復号操作（`kms:Encrypt` 等）を許可するキーポリシー（Key Policy）を設定。

#### 2. [database.ts (RDS & シークレット定義)](file:///c:/Git/learning-ts-concepts/infra/lib/constructs/database.ts)
- `DatabaseConstruct` 内で、Aurora クラスターの `storageEncryptionKey` に KMS キーを割り当て、DBストレージ暗号化を適用。
- データベース認証情報シークレット (Secrets Manager) の `encryptionKey` に KMS キーを割り当て、資格情報の暗号化を強化。

#### 3. [compute.ts (ECS Fargate定義)](file:///c:/Git/learning-ts-concepts/infra/lib/constructs/compute.ts)
- アプリケーションコンテナのロググループ `AppLogGroup` および ECS Exec 用監査ロググループ `EcsExecAuditLogGroup` の `encryptionKey` に KMS キーを割り当て。
- ECS Cluster の `executeCommandConfiguration` で、監査ログの転送時の暗号化 `cloudWatchEncryptionEnabled` を `true` に設定。

#### 4. [stack.ts (CDKスタック統合)](file:///c:/Git/learning-ts-concepts/infra/lib/stack.ts)
- `KmsConstruct` をインスタンス化し、作成された KMS キーを `DatabaseConstruct` および `ComputeConstruct` に引き渡し。

#### 5. [stack.test.ts (CDKアサーションテストの更新)](file:///c:/Git/learning-ts-concepts/infra/test/stack.test.ts)
- 各環境のテストケースで、`AWS::KMS::Key` が作成されていること、および `prod` 環境のみ `EnableKeyRotation: true` であることをアサーション検証。
- DB クラスター、Secrets Manager、CloudWatch Logs ロググループのそれぞれに `KmsKeyId` が設定され、KMS 暗号化が適用されていることをアサーション検証。

## 12. S3 + CloudFront による静的アセットのオリジン分割配信（SRE強化フェーズ 4）

### 変更内容

#### 1. [storage.ts (静的アセットS3バケット定義)](file:///c:/Git/learning-ts-concepts/infra/lib/constructs/storage.ts) [NEW]
- 静的アセット専用のプライベートな S3 バケット `StaticAssetBucket` を定義。
- セキュリティ要件に合わせ、KMS カスタマー管理キー (CMK) を用いたデフォルト暗号化を適用。
- パブリックアクセスの完全ブロック、および SSL 通信の強制 (`enforceSSL: true`) を設定。
- `dev` / `stg` 環境ではコスト削減と検証の容易化のため、スタック削除時に自動でバケット内のオブジェクトを削除しバケット自体も削除する (`autoDeleteObjects: true`, `removalPolicy: DESTROY`)。
- `prod` 環境ではデータの永続保護のため `removalPolicy: RETAIN` を設定。

#### 2. [stack.ts (CloudFront & S3 連携)](file:///c:/Git/learning-ts-concepts/infra/lib/stack.ts)
- CloudFront へのアクセス制限を厳密に行うため、**Origin Access Control (OAC)** を定義 (`CfnOriginAccessControl`)。
- CloudFront のキャッシュビヘイビア `/assets/*` に対するオリジンとして S3 バケットを登録。
- パフォーマンスとエッジキャッシュ最適化のため、`/assets/*` に対して `CachingOptimized` キャッシュポリシーを割り当て。
- S3 側のバケットポリシーに、この CloudFront ディストリビューションからの `s3:GetObject` のみを受け入れるポリシーを自動生成・バインド。
- CloudFormation (L1) オーバーライド手法により OAC を S3 オリジンへ明示的に紐付け。

#### 3. [stack.test.ts (CDKアサーションテストの更新)](file:///c:/Git/learning-ts-concepts/infra/test/stack.test.ts)
- 各環境において、S3 バケットの構築、パブリックブロック設定、KMS 暗号化設定が設計通りに適用されていることをアサーション検証。
- CloudFront にて ALB と S3 のマルチオリジン構成、`/assets/*` のキャッシュビヘイビア、および OAC によるアクセス制限が正しく適用されているかを検証。
- `autoDeleteObjects: true` 設定に伴う自動生成 Lambda 数（devで2、stgで1、prodで0）を正確に検証するよう Lambda 個数の期待値をアサーション調整。

---

## 13. Secrets Manager 認証情報の Lambda 自動ローテーション（SRE強化フェーズ 5）

### 変更内容

#### 1. [database.ts (RDS & シークレット定義)](file:///c:/Git/learning-ts-concepts/infra/lib/constructs/database.ts)
- `stg` / `prod` 環境において、RDS クラスター接続用の Secrets Manager シークレットに `SecretRotation` をアタッチ。
- 標準提供されているシングルユーザー用ローテーションテンプレート `MYSQL_ROTATION_SINGLE_USER` を使用。
- ローテーション期間を 30 日（`cdk.Duration.days(30)`）に設定。
- ローテーション Lambda はデータベースと同じ VPC 内のプライベートサブネット (`PRIVATE_WITH_EGRESS`) に配置。
- ローテーション Lambda 用セキュリティグループから RDS (3306ポート) への疎通を許可するインバウンド通信ルールを自動で DB セキュリティグループに適用。
- `dev` 環境では `SecretRotation` の構築を完全にバイパスし、無駄なリソース作成とコストを回避。

#### 2. [stack.test.ts (CDKアサーションテスト of 更新)](file:///c:/Git/learning-ts-concepts/infra/test/stack.test.ts)
- `dev` 環境にて `AWS::SecretsManager::RotationSchedule` が 0 件であることを検証。
- `stg` / `prod` 環境にて `AWS::SecretsManager::RotationSchedule` が 1 件作成されていることをアサーション検証。
- 環境ごとのローテーション Lambda 作成（サーバーレスアプリケーションテンプレート経由）に配慮しつつ、各環境でプロビジョニングされる Lambda 個数の期待値（dev: 2、stg: 1、prod: 0）が正しいことを検証。

---

## 14. データベースおよびRedisセキュリティグループの送信通信（Egress）遮断の徹底

### 変更内容

#### 1. [stack.ts (CDKインフラ定義)](file:///c:/Git/learning-ts-concepts/infra/lib/stack.ts)
- `dbSecurityGroup` と `redisSecurityGroup` に対し、すべてのリソースと接続設定の完了後に明示的にダミー拒否 Egress ルール（`255.255.255.255/32` ICMP 252/86、Description: `"Disallow all outbound traffic"`) を追加する処理を実装。
- これにより、CDKの `connections.allowFrom` などの処理の後に意図せず CloudFormation のデフォルト「全送信許可 (0.0.0.0/0)」が自動付与されてしまう挙動を完全に抑止。

#### 2. [stack.test.ts (CDKアサーションテストの更新)](file:///c:/Git/learning-ts-concepts/infra/test/stack.test.ts)
- `dev`、`stg`、`prod` すべての環境において、`DbSecurityGroup` および `RedisSecurityGroup` にインラインでダミー拒否ルールが定義されていることをアサーション検証するテストを追加。

---

## 15. VPC S3 ゲートウェイエンドポイントの追加

### 変更内容

#### 1. [network.ts (VPC定義)](file:///c:/Git/learning-ts-concepts/infra/lib/constructs/network.ts)
- `ec2.Vpc` のコンストラクタパラメータに `gatewayEndpoints` を定義し、S3 ゲートウェイエンドポイントを有効化。これにより、各サブネットのルートテーブルに自動的に S3 へのルーティングルールが構成され、NAT Gateway を経由するデータ処理料金（$0.062 / GB）を完全に回避して無料かつ高速に通信が可能になりました。

#### 2. [stack.test.ts (CDKユニットテストの追加)](file:///c:/Git/learning-ts-concepts/infra/test/stack.test.ts)
- すべての環境スタックにおいて、S3 ゲートウェイエンドポイント（`AWS::EC2::VPCEndpoint`, Type: `Gateway`）が正しくプロビジョニングされていることをアサーション検証するテストを追加。

---

## 16. ECS Fargate コンテナの読み取り専用ルートファイルシステム化

### 変更内容

#### 1. [compute.ts (ECS Fargate定義)](file:///c:/Git/learning-ts-concepts/infra/lib/constructs/compute.ts)
- コンテナの実行時改ざんリスクを物理的に排除するため、`AppContainer` の定義に `readonlyRootFilesystem: true` を設定し、システム領域を完全に読み取り専用化。
- Nginxの動作に不可避な一時書き込み先 `/tmp` を逃がすため、タスク定義に一時ボリューム `tmp-volume` を定義し、`AppContainer` の `/tmp` ディレクトリにインメモリボリュームとしてマウントする設定（`addMountPoints`）を追加。

#### 2. [stack.test.ts (CDKアサーションテストの追加)](file:///c:/Git/learning-ts-concepts/infra/test/stack.test.ts)
- `AppContainer` の `ReadonlyRootFilesystem` が `true` に設定されていること、`/tmp` に対するマウントポイント設定、および `tmp-volume` ボリュームの存在をアサーション検証するテストコードを追加。

---

## 17. アプリケーションデプロイ手順書（ランブック）の新規作成

### 追加内容

#### 1. [application-deployment.md](file:///c:/Git/learning-ts-concepts/docs/runbook/application-deployment.md)
- アプリケーションエンジニア向けに、動的コンテナアプリ（ECS Fargate）と静的アセット（S3 + CloudFront）のそれぞれのデプロイ手順（手動コマンド、必要な権限、GitHub ActionsによるCI/CD自動化定義例、および障害時の緊急ロールバック手順）を明文化した手順書を新規作成しました。

---

## 18. AWS WAFv2 を利用したメンテナンスモードの実装と手順書の作成

### 変更内容

#### 1. [stack.ts (CDKインフラ定義)](file:///c:/Git/learning-ts-concepts/infra/lib/stack.ts)
- AWS WAFv2 (WebACL) に、ホワイトリスト除外IPを管理するための `CfnIPSet` を追加しました。
- メンテナンスモード中の静的HTML（503レスポンス）を登録する `customResponseBodies` を定義しました。
- `MaintenanceModeRule` (優先度1) を追加しました。デフォルトで `Action: Count` (通常稼働) に設定されています。

#### 2. [stack.test.ts (CDKアサーションテストの更新)](file:///c:/Git/learning-ts-concepts/infra/test/stack.test.ts)
- `CfnIPSet` の存在と、WAF WebACL の `Rules` / `CustomResponseBodies` の構成（`MaintenanceModeRule` の存在確認など）を検証するアサーションを追加しました。

#### 3. [maintenance-mode.md](file:///c:/Git/learning-ts-concepts/docs/runbook/maintenance-mode.md)
- インフラの再デプロイを伴わない、AWS CLI を用いた瞬時のメンテナンス切り替え（`Count` ➔ `Block` への変更適用）手順、復旧手順、および除外管理者IPの更新・削除手順を定義したランブックを新規作成・改修しました。

---

## 19. SLO/SLI 運用手順書と月次報告書テンプレートの作成

### 変更内容

#### 1. [slo-reporting-guide.md (新規)](file:///c:/Git/learning-ts-concepts/docs/runbook/slo-reporting-guide.md)
- SREの実務プロセスとして、Datadog SLO 機能を用いた可用性およびレイテンシの実績値の抽出方法、定例会議での報告フロー、ならびにエラーバジェットが枯渇した際の新機能リリース制限（リリースゲート）を規定する「エラーバジェットポリシー」を定義した運用手順書を新規作成しました。

#### 2. [template.md (新規)](file:///c:/Git/learning-ts-concepts/docs/sre/reports/template.md)
- 毎月の SLO 実績値やエラーバジェット消費イベントの分析、および次月のアクションプランを Docs as Code で記述して Git 履歴に蓄積するための月次報告書テンプレートを作成しました。

---

## 20. CDK非推奨警告の解消およびセキュリティグループのポート整合性修正

### 変更内容

#### 1. [stack.ts (CDKインフラ定義)](file:///c:/Git/learning-ts-concepts/infra/lib/stack.ts)
- `S3Origin` が非推奨警告を出していたため、推奨される `S3BucketOrigin.withOriginAccessIdentity` に置き換え。OACによるバインド（L1プロパティオーバーライド）はそのまま維持し、非推奨警告を解消。

#### 2. [network.ts (ネットワーク定義)](file:///c:/Git/learning-ts-concepts/infra/lib/constructs/network.ts)
- `ecsSecurityGroup` の ingress ルールに不要かつコンテナ実行ポート（`8080`）と不整合を起こしていたポート `80` の許可が残っていたため、実際のコンテナポート `8080` へ修正。最小権限（Security by Design）の適用。

### 動作確認
- `npm test` によるユニットテストがすべて正常にパス（PASS）することを確認。

---

## 21. Resource Scheduler（夜間自動停止・朝自動起動）用タグの適用

### 変更内容

#### 1. [database.ts (RDSインフラ定義)](file:///c:/Git/learning-ts-concepts/infra/lib/constructs/database.ts)
- `dev` および `stg` 環境向けに、プラットフォーム共通の自動停止/起動システム（Resource Scheduler）と連動させるため、`DatabaseCluster` に `Schedule = office-hours` タグを付与するロジックを追加。

### 動作確認
- `npm test` によるユニットテストがすべて正常にパス（PASS）することを確認。

---

## 22. 組織中央セキュリティガードレールへの適合修正

### 変更内容

#### 1. [compute.ts (ECSコンピューティング定義)](file:///c:/Git/learning-ts-concepts/infra/lib/constructs/compute.ts)
- プラットフォームのセキュリティ監査（非Root実行の強制ポリシー）に適合するため、ECSタスク定義における `AppContainer` に対し `user: "nginx"`、`DatadogAgent` に対して `user: "datadog"` を明示的に指定。IaC定義レベルで非Rootユーザー実行を保証。

### 動作確認
- `npm test` によるユニットテストがすべて正常にパス（PASS）することを確認。

---

## 23. プラットフォーム開発指示（AWS Landing Zone ガードレールポリシー）の AI 開発ルールへの統合

### 変更内容

#### 1. [.agents/AGENTS.md (AI開発ルールブック)](file:///c:/Git/learning-ts-concepts/.agents/AGENTS.md)
- SREプラットフォームチームから提供された「WORKLOAD_INSTRUCTIONS（共通 AWS Landing Zone 接続仕様 ＆ セキュリティガードレール）」の規則を `AGENTS.md` の第5章にインポート・マージ。State Backendの構成定義、デプロイ用 OIDC ロールの AssumeRole 制約、およびセキュリティグループ・コンテナ非Root実行などのガードレール要件を AI 側の厳格な自己規制として統合。

### 動作確認
- `npm test` によるユニットテストがすべて正常にパス（PASS）することを確認。
