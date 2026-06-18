# learning-ts-concepts (AWS CDK 3-Tier Architecture Template)

このリポジトリは、TypeScript と AWS CDK を用いて、**セキュリティ**・**可観測性（Observability）**・**テスト自動化**・**CI/CD品質ゲート**を統合した、プロダクションレディな学習用三層アーキテクチャテンプレートです。

ポートフォリオとして、実用的なSREおよびクラウドインフラの設計プラクティスを網羅しています。

---

## 🏗️ アーキテクチャ構成

- **DNS / CDN層**: Route 53 (DNS) + CloudFront (CDN)
- **セキュリティ層**: AWS WAFv2 (Web ACL) によるALB保護、カスタムヘッダーによる直接ALBアクセス拒否
- **ロードバランサー層**: Application Load Balancer (ALB)
- **Web / アプリケーション層**: ECS on Fargate (3 AZs)
- **可観測性 (Observability)**: **Datadog Agent (サイドカーパターン)** による APM トレース ＆ カスタムメトリクス収集
- **データ層**: Amazon Aurora Serverless v2 (MySQL 互換)
- **マルチ環境対応**: `dev` / `stg` / `prod` の独立した 3 スタック構成

### 📊 アーキテクチャ図

![Architecture](diagrams/architecture_v2.svg)

---

## 🌟 インフラ設計のこだわり（SREプラクティス）

### 1. セキュリティ ＆ ガードレール
*   **非Root（非特権）ユーザー実行の徹底（コンテナセキュリティ）**: アプリケーション（Nginx）コンテナの実行ポートを特権ポートの `80` から非特権ポートの `8080` に変更し、コンテナを非特権ユーザー（`nginx` ユーザー）で稼働。万が一コンテナが侵害された場合でも、ホストへのエスケープや他コンテナへの影響を極小化する多層防御を施しています。
*   **バージョンピン留めによる再現性担保**: Dockerベースイメージ（`nginx:1.25.4-alpine`）および Datadog Agent サイドカーイメージ（`gcr.io/datadoghq/agent:7.54.0`）のバージョンを厳密に固定。不意の自動アップデートによる起動失敗（SPOF）を回避します。
*   **オリジン保護**: CloudFront と ALB 間にカスタムヘッダー（`X-Origin-Verify`）による検証を導入。ALBパブリックDNSへの直接アクセスを ALB リスナーレベルで `403 Forbidden` としてシャットアウトし、アクセスを必ず CloudFront + WAF 経由に強制します。
*   **最小権限の原則**: GitHub Actions 用の IAM ロール（OIDC認証）は、対応する環境（`develop` ブランチは `dev` ロール、`main` ブランチは `prod` ロールのみを引き受け可能）へ厳密に分離し、過剰な権限付与を防いでいます。

### 2. データ堅牢性の保護（変更管理・事故防止）
*   **本番DB削除保護と保持ポリシー**: 本番環境（`prod`）の Aurora Serverless v2 DBクラスターに対して、`deletionProtection: true` を明示的に設定。また、スタック削除時にもデータが安全に保護されるよう `removalPolicy` を `RETAIN` に設定しています（`dev`/`stg` 環境は開発効率のために `DESTROY` を許容）。

### 3. 可観測性 (Observability) - Datadog サイドカー
*   **サイドカーパターン**: 各 ECS タスク内に、アプリケーションコンテナ（`AppContainer`）と並行して **Datadog Agent** コンテナを同居させるサイドカー設計を採用。
*   **通信の局所化**: Fargate の `awsvpc` モードの特性を活かし、メインアプリと Datadog Agent 間の通信は `localhost` (Port: 8125/UDP for DogStatsD, 8126/TCP for APM) を通じて超低延遅で完結します。
*   **起動順序制御 (Container Dependency)**: APMやメトリクス収集の漏れを防ぐため、Datadog Agent が正常に起動（`START`）した後にアプリケーションコンテナが立ち上がる依存関係を CDK で定義しています。

### 4. 高可用性 ＆ 動的オートスケーリング
*   **ターゲット追跡スケーリング（Target Tracking）**: 本番（`prod`）およびステージング（`stg`）環境において、CPU使用率およびメモリ使用率（閾値: 70%）に基づく動的なオートスケーリングを設定。突発的なアクセススパイクに対応可能です。
*   **最小稼働台数のマルチAZ保護**: 本番環境（`prod`）では、常に最低 2 台以上のタスクが異なるAZ（アベイラビリティゾーン）に分散配置され、単一障害点（SPOF）を徹底して排除しています。
*   **開発コストの極小化とスケジュール制御**: 開発環境（`dev`）ではオートスケーリングを排し、毎日夜間自動停止（タスク数 0）と朝の自動起動を行うスケジュールスケーリングを適用。クラウド費用を節約します。

### 5. テスト自動化 (CDK Assertion Tests)
*   `aws-cdk-lib/assertions` と Jest を用いた**インフラ単体テスト**を実装。
*   AWSアカウントにデプロイすることなく、ローカルおよびCI上で「VPC、ALB、WAF、ECSクラスター・サービス、RDSクラスター」が仕様通りに構成されているかを瞬時に検証可能です。

### 6. CI/CD セキュリティゲート (GitHub Actions)
*   **Hadolint**: Dockerfile の静的解析を行い、コンテナビルドのベストプラクティスを強制。
*   **Trivy**: コンテナイメージの脆弱性スキャンを実行し、危険度の高い脆弱性（`HIGH`/`CRITICAL`）を自動検知してデプロイをブロック。
*   **OSパッケージの自動最新化**: Trivy で検出されたベースイメージ由来の既知の脆弱性を自動解消するため、`Dockerfile` ビルド時に `apk update && apk upgrade` を実行するセキュリティパッチ構造を実装。
*   **検証（Local/CI）モードの適用**: 現在はAWSのデプロイ費用を0円に抑えるため、実際のデプロイステップをバイパスし、Linter、Trivyスキャン、アサーションテスト、`cdk synth` による構文チェックのみを安全に実行するCI構成となっています。

---

## 📂 主要ディレクトリ構成

- `infra/` - CDK アプリケーション（AWSインフラ定義）
  - `bin/main.ts` - スタック生成エントリ（dev/stg/prod）
  - `lib/constructs/network.ts` - VPC / セキュリティグループ定義
  - `lib/constructs/compute.ts` - ECS Fargate ＆ **Datadog Agent サイドカー**定義
  - `lib/constructs/database.ts` - Aurora Serverless v2 定義
  - `lib/stack.ts` - 3層アーキテクチャ統合スタック
  - `test/stack.test.ts` - **CDKアサーションテストコード**
- `monitoring/` - CDKTF アプリケーション（Datadog監視定義）
  - `main.ts` - CDKTFスタック生成エントリ
  - `lib/config/config.ts` - 環境設定抽象化ヘルパー
  - `lib/datadog-stack.ts` - Datadogスタック定義（S3/DynamoDBリモートステート対応）
  - `lib/monitors/` - 各AWSリソース（ECS/RDS）のDatadogモニター（アラート）定義
- `diagrams/` - 構成図（Architecture Diagram）の格納
  - `architecture.svg` - **アーキテクチャ図（RDS Proxy 構成版）**
- `docs/` - 運用ドキュメント・ウォークスルーの格納
  - `walkthrough.md` - **設計・実装履歴ウォークスルー**
  - `governance/` - **エンタープライズガバナンス設計ドキュメント（ポートフォリオ用）**
    - [multi-account-design.md](file:///c:/Git/learning-ts-concepts/docs/governance/multi-account-design.md) - マルチアカウント設計方針
    - [security-and-audit.md](file:///c:/Git/learning-ts-concepts/docs/governance/security-and-audit.md) - 監査・セキュリティ基準
    - [cost-management.md](file:///c:/Git/learning-ts-concepts/docs/governance/cost-management.md) - コスト管理・財務ガバナンス方針
- `app/` - アプリケーションコード
  - `Dockerfile` - Nginxコンテナ定義（**セキュリティ自動パッチ機能付き**）
  - `index.html` - 静的デモ画面

---

## 🛠️ ローカルでの開発・検証手順

### 1. 依存関係のインストール
```powershell
cd infra
npm ci
```

### 2. インフラの単体テスト実行 (CDK Assertions & Jest)
```powershell
npm test
```

### 3. CloudFormation テンプレート of 合成 (synth) の動作チェック
```powershell
# 開発環境 (dev) のシンセサイズ確認
npx cdk synth ThreeTierStack-dev -c imageTag=local-test -c natGateways=0
```

---

## 📊 Datadog 監視（CDK for Terraform）の導入 ＆ セットアップ

AWSインフラ（ECS, RDS）のアラート（Monitor）を TypeScript から宣言的に管理するため、**CDK for Terraform (CDKTF)** を導入しました。
状態管理（State）は Amazon S3 および DynamoDB を用いたリモートバックエンドに対応しており、ローカル実行時は自動的にローカルステートにフォールバックするハイブリッド設計となっています。

### 🔑 ユーザー側で必要なアクション（GitHub Secrets の設定）

CDKTF による Datadog への自動デプロイ（GitHub Actions）を動作させるために、GitHub リポジトリの **Settings > Secrets and variables > Actions** に以下の Secrets を必ず登録してください。

| Secret 名 | 説明 |
| :--- | :--- |
| `DATADOG_API_KEY` | Datadog の API キー（アカウントの監視権限） |
| `DATADOG_APP_KEY` | Datadog の Application キー（モニター等リソース操作用） |
| `TERRAFORM_STATE_BUCKET` | `.tfstate` 状態ファイルを保存する AWS S3 バケット名 |
| `TERRAFORM_LOCK_TABLE` | 同時実行衝突を防ぐための AWS DynamoDB ロックテーブル名 |
| `AWS_ACCESS_KEY_ID` | 上記 S3/DynamoDB を操作可能な IAM ユーザーのアクセスキー |
| `AWS_SECRET_ACCESS_KEY` | 上記 IAM ユーザー of シークレットアクセスキー |

### 🛠️ ローカルでの CDKTF 開発・検証手順

`cdktf-datadog` ディレクトリ内で動作確認を行います。

```powershell
cd monitoring
# 1. 依存関係のインストール（Windowsでのnode-ptyビルドエラーを避けるため ignore-scripts を指定）
npm install --ignore-scripts

# 2. TypeScript コンパイル確認
npm run compile

# 3. CloudFormation 相当の Terraform JSON の合成 (synth)
# (ローカル検証用に適当なダミー値を設定)
$env:TERRAFORM_STATE_BUCKET="dummy"; $env:TERRAFORM_LOCK_TABLE="dummy"; npx cdktf synth
```

---

## 🚀 将来の実際のAWSデプロイへのロードマップ

実際に AWS 環境への自動デプロイを再開したい場合は、以下の手順を実施します。

1.  **AWS OIDC ロールの初回デプロイ**:
    ローカル環境からAWS CLIに認証した上で、手動で以下のCDKデプロイを実行し、各環境に必要なデプロイ用IAMロールおよびECRリポジトリを作成します。
    ```powershell
    npx cdk deploy ThreeTierStack-dev --require-approval never
    ```
2.  **GitHub Secrets の設定**:
    GitHub リポジトリの **Settings > Secrets and variables > Actions** にて、作成された IAM ロール ARN を `ROLE_ARN_DEV` / `ROLE_ARN_STG` / `ROLE_ARN_PROD` として登録します。
3.  **GitHub Actions のデプロイステップ復元**:
    [.github/workflows/deploy.yml](.github/workflows/deploy.yml) 内の、コメントアウトまたは削除された `Configure AWS credentials via OIDC` ステップ、ECRへのログイン・プッシュ、および `npx cdk deploy` コマンドを有効化します。
