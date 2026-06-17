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

![Architecture](architecture.svg?v=4)

---

## 🌟 インフラ設計のこだわり（SREプラクティス）

### 1. セキュリティ ＆ ガードレール
*   **オリジン保護**: CloudFront と ALB 間にカスタムヘッダー（`X-Origin-Verify`）による検証を導入。ALBパブリックDNSへの直接アクセスを ALB リスナーレベルで `403 Forbidden` としてシャットアウトし、アクセスを必ず CloudFront + WAF 経由に強制します。
*   **最小権限の原則**: GitHub Actions 用の IAM ロール（OIDC認証）は、対応する環境（`develop` ブランチは `dev` ロール、`main` ブランチは `prod` ロールのみを引き受け可能）へ厳密に分離し、過剰な権限付与を防いでいます。

### 2. 可観測性 (Observability) - Datadog サイドカー
*   **サイドカーパターン**: 各 ECS タスク内に、アプリケーションコンテナ（`AppContainer`）と並行して **Datadog Agent** コンテナを同居させるサイドカー設計を採用。
*   **通信の局所化**: Fargate の `awsvpc` モードの特性を活かし、メインアプリと Datadog Agent 間の通信は `localhost` (Port: 8125/UDP for DogStatsD, 8126/TCP for APM) を通じて超低遅延で完結します。
*   **起動順序制御 (Container Dependency)**: APMやメトリクス収集の漏れを防ぐため、Datadog Agent が正常に起動（`START`）した後にアプリケーションコンテナが立ち上がる依存関係を CDK で定義しています。

### 3. テスト自動化 (CDK Assertion Tests)
*   `aws-cdk-lib/assertions` と Jest を用いた**インフラ単体テスト**を実装。
*   AWSアカウントにデプロイすることなく、ローカルおよびCI上で「VPC、ALB、WAF、ECSクラスター・サービス、RDSクラスター」が仕様通りに構成されているかを瞬時に検証可能です。

### 4. CI/CD セキュリティゲート (GitHub Actions)
*   **Hadolint**: Dockerfile の静的解析を行い、コンテナビルドのベストプラクティスを強制。
*   **Trivy**: コンテナイメージの脆弱性スキャンを実行し、危険度の高い脆弱性（`HIGH`/`CRITICAL`）を自動検知してデプロイをブロック。
*   **OSパッケージの自動最新化**: Trivy で検出されたベースイメージ由来の既知の脆弱性を自動解消するため、`Dockerfile` ビルド時に `apk update && apk upgrade` を実行するセキュリティパッチ構造を実装。
*   **検証（Local/CI）モードの適用**: 現在はAWSのデプロイ費用を0円に抑えるため、実際のデプロイステップをバイパスし、Linter、Trivyスキャン、アサーションテスト、`cdk synth` による構文チェックのみを安全に実行するCI構成となっています。

---

## 📂 主要ディレクトリ構成

- `cdk-app/` - CDK アプリケーション
  - `bin/main.ts` - スタック生成エントリ（dev/stg/prod）
  - `lib/constructs/network.ts` - VPC / セキュリティグループ定義
  - `lib/constructs/compute.ts` - ECS Fargate ＆ **Datadog Agent サイドカー**定義
  - `lib/constructs/database.ts` - Aurora Serverless v2 定義
  - `lib/stack.ts` - 3層アーキテクチャ統合スタック
  - `test/stack.test.ts` - **CDKアサーションテストコード**
- `app/` - アプリケーションコード
  - `Dockerfile` - Nginxコンテナ定義（**セキュリティ自動パッチ機能付き**）
  - `index.html` - 静的デモ画面

---

## 🛠️ ローカルでの開発・検証手順

### 1. 依存関係のインストール
```powershell
cd cdk-app
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
