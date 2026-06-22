# アプリケーションデプロイ手順書 (Application Deployment Guide)

本ドキュメントでは、本アーキテクチャにおけるアプリケーションエンジニア向けのデプロイ手順を定義します。
このインフラは **「コンテナ（ECS Fargate）による動的アプリ/API配信」** と **「S3 + CloudFront による静的アセット（CSS/JS/画像）のオリジン分割配信」** のハイブリッド構成をとっているため、それぞれに最適なデプロイ手順を用意しています。

---

## 1. デプロイモデルの概要

本システムでは、パフォーマンスとコスト効率を最大化するため、デプロイメントオブジェクトを2種類に分離して配信します。

```
[アプリケーション開発・ビルド]
   │
   ├──① 動的アプリコード ➔ Dockerイメージ化 ➔ Amazon ECR ➔ ECS Fargate (ローリングデプロイ)
   │
   └──② 静的アセット (CSS/JS) ➔ Amazon S3 ➔ CloudFront OAC (キャッシュクリアで即時反映)
```

---

## 2. 前提条件

デプロイを実行するクライアント（開発環境、または CI/CD のランナー）は、以下の条件を満たしている必要があります。

### 必要なツール
- **Docker**: コンテナイメージのビルドおよびローカル検証用
- **AWS CLI (v2)**: AWSリソース（ECR、S3、CloudFront）の操作用
- **AWS CDK CLI**: ECSサービスへの新しいタスク定義のデプロイ用

### 必要な IAM 権限 (最小権限)
デプロイを実行する IAM ロール/ユーザーには、以下のポリシーがアタッチされている必要があります。
- `ecr:GetAuthorizationToken` (ECRログイン用)
- `ecr:BatchCheckLayerAvailability`, `ecr:PutImage`, `ecr:InitiateLayerUpload` 等 (ECRプッシュ用)
- `s3:PutObject`, `s3:DeleteObject` on `arn:aws:s3:::app-static-assets-*` (アセットバケット操作用)
- `cloudfront:CreateInvalidation` on CloudFront Distribution (キャッシュクリア用)
- `ecs:UpdateService`, `ecs:RegisterTaskDefinition` 等 (ECSデプロイ用)

---

## 3. コンテナアプリ (ECS Fargate) のデプロイ手順

動的なアプリケーション（Nginx、APIサーバー等）のソースコードやコンテナ設定を変更した際の手動デプロイ手順です。

### Step 1: AWS ECR へのログイン認証
AWS CLI を使用して、Docker デーモンを AWS のプライベートリポジトリ（ECR）に認証させます。
```powershell
# アカウントIDとリージョンを指定してログイントークンを取得し、docker loginを実行
aws ecr get-login-password --region ap-northeast-1 | docker login --username AWS --password-stdin <AWS_ACCOUNT_ID>.dkr.ecr.ap-northeast-1.amazonaws.com
```

### Step 2: コンテナイメージのビルド
アプリケーションディレクトリ（`app/`）に移動し、イメージをビルドします。
```powershell
# app/ ディレクトリの Dockerfile をビルド
docker build -t app-image:latest ./app
```

### Step 3: イメージへのタグ付けと ECR へのプッシュ
一意の識別子（通常は Git のコミットハッシュ値）をタグとして付与し、ECRへ送信します。
```powershell
# 一意のタグ（Gitコミットハッシュなど）を定義
$IMAGE_TAG = (git rev-parse --short HEAD)

# ECRリポジトリのURLに合わせてタグ付け (開発環境 dev の例)
docker tag app-image:latest <AWS_ACCOUNT_ID>.dkr.ecr.ap-northeast-1.amazonaws.com/app-repo-dev:$IMAGE_TAG

# イメージをプッシュ
docker push <AWS_ACCOUNT_ID>.dkr.ecr.ap-northeast-1.amazonaws.com/app-repo-dev:$IMAGE_TAG
```

### Step 4: AWS CDK による ECS サービスの更新デプロイ
CDKのコンテキストパラメータ `imageTag` にプッシュしたイメージのタグを指定して、CDKデプロイを実行します。これによってタスク定義が更新され、ECSサービスがローリングデプロイを開始します。
```powershell
cd infra
npx cdk deploy ThreeTierStack-dev -c imageTag=$IMAGE_TAG --require-approval never
```
> [!NOTE]
> ECS Fargate は、新しいタスク（コンテナ）を立ち上げてヘルスチェックが成功したことを確認してから古いタスクを順次停止するため、**無停止でのローリングアップデート**が自動的に行われます。

---

## 4. 静的アセット (S3 & CloudFront) のデプロイ手順

HTML、CSS、JavaScript、画像などのアセットファイルを更新するフローです。コンテナの再起動を伴わずに即時反映が可能です。

### Step 1: アセットのビルド（フロントエンド）
※ Webpack、Vite、npm 等でビルド成果物を出力します。
```powershell
# dist/ や build/ フォルダに静的コンテンツを生成
npm run build
```

### Step 2: S3 アセットバケットへの同期
ローカルのビルド成果物（静的ファイル）を S3 バケットの `assets/` パスに同期します。バケット名は、`docs/governance/shared-outputs.md` に記載されている対象環境の **AWS Account ID** を組み込んで決定します（命名規則: `static-assets-<ENV_NAME>-<AWS_ACCOUNT_ID>`）。

```powershell
# 同期コマンド（不要になった古いファイルを削除する --delete オプション付き）
# 例（開発環境でアカウントIDが555555555555の場合）: aws s3 sync ./app/dist/assets s3://static-assets-dev-555555555555/assets/ --delete
aws s3 sync ./app/dist/assets s3://static-assets-<ENV_NAME>-<AWS_ACCOUNT_ID>/assets/ --delete
```

### Step 3: CloudFront のキャッシュクリア (Invalidation)
CloudFront のエッジサーバーにキャッシュされている古いコンテンツを強制クリアし、S3 上の新しいファイルが即座にユーザーに届くようにします。
```powershell
# キャッシュ無効化 (Invalidation) の作成
aws cloudfront create-invalidation --distribution-id <CLOUDFRONT_DISTRIBUTION_ID> --paths "/assets/*"
```
> [!TIP]
> キャッシュ無効化は全体（`/*`）で行うとパフォーマンス上非効率になるため、更新したフォルダパス（`/assets/*` など）に限定して実行することを推奨します。

---

## 5. GitHub Actions を使った CI/CD パイプラインの自動化

実務では、上記のデプロイ手順を GitHub Actions ワークフローによって完全に自動化し、ブランチへのプッシュ（または Pull Request のマージ）をトリガーにして実行します。

### ワークフロー設定例 (`.github/workflows/deploy.yml`)
```yaml
name: Deploy Application

on:
  push:
    branches:
      - main # 本番環境 (prod) デプロイ
      - develop # 開発環境 (dev) デプロイ

permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      - name: Configure AWS Credentials (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: ap-northeast-1

      # --- 1. 静的アセットのデプロイ ---
      - name: Build Front-End Assets
        run: |
          npm ci
          npm run build

      - name: Deploy Assets to S3
        run: |
          aws s3 sync ./app/dist/assets s3://${{ secrets.S3_BUCKET_NAME }}/assets/ --delete

      - name: Invalidate CloudFront Cache
        run: |
          aws cloudfront create-invalidation --distribution-id ${{ secrets.CLOUDFRONT_DIST_ID }} --paths "/assets/*"

      # --- 2. コンテナアプリのデプロイ ---
      - name: Login to Amazon ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build and Push Container Image
        id: build-image
        env:
          ECR_REGISTRY: ${{ steps.login-ecr.outputs.registry }}
          ECR_REPOSITORY: ${{ secrets.ECR_REPO_NAME }}
          IMAGE_TAG: ${{ github.sha }}
        run: |
          docker build -t $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG ./app
          docker push $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG
          echo "image_tag=$IMAGE_TAG" >> $GITHUB_OUTPUT

      - name: Deploy ECS Task via CDK
        run: |
          cd infra
          npm ci
          npx cdk deploy ThreeTierStack-${{ github.ref_name == 'main' && 'prod' || 'dev' }} -c imageTag=${{ steps.build-image.outputs.image_tag }} --require-approval never
```

---

## 6. デプロイ後の確認 ＆ ロールバック（切り戻し）手順

### デプロイステータスの確認
デプロイ後、新しいコンテナタスクが正常に起動し、古いタスクが停止したことを AWS CLI で確認します。
```powershell
aws ecs describe-services --cluster <ECS_CLUSTER_NAME> --services <ECS_SERVICE_NAME> --query "services[0].deployments"
```

### 障害発生時の緊急ロールバック手順
新バージョンに深刻なバグや障害が発覚した場合、直近の「正常に稼働していたコンテナイメージのタグ」を指定して、再度CDKデプロイを実行することで、即座に安全な旧バージョンにサービスをロールバックできます。

```powershell
# 1. 安定稼働していた直前のイメージタグを指定してCDKデプロイを実行
cd infra
npx cdk deploy ThreeTierStack-dev -c imageTag=<PREVIOUS_STABLE_TAG> --require-approval never

# 2. 静的アセットを旧状態に戻す場合は、Gitで直前コミットにチェックアウトし、S3を同期し直してCloudFrontキャッシュをクリアします
git checkout HEAD~1
aws s3 sync ./app/dist/assets s3://static-assets-<ENV_NAME>-<AWS_ACCOUNT_ID>/assets/ --delete
aws cloudfront create-invalidation --distribution-id <CLOUDFRONT_DISTRIBUTION_ID> --paths "/assets/*"
```
