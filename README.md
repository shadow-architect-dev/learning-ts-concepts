# learning-ts-concepts

このリポジトリは、TypeScript と AWS CDK を用いて学習用のセキュアな三層アーキテクチャ（CloudFront + WAF + ALB + ECS on Fargate + Aurora Serverless v2）を構築するサンプルです。

## 構成（概要）

- エッジ/DNS層: Route 53 (DNS) + CloudFront (CDN)
- セキュリティ層: AWS WAF (Web ACL) によるALB保護
- ロードバランサー層: Application Load Balancer (ALB)
- Web/App 層: ECS on Fargate
- Data 層: Amazon Aurora (Serverless v2)
- 各環境: `dev` / `stg` / `prod` の 3 スタック

## アーキテクチャ図

![Architecture](architecture.svg?v=3)

## 主要ファイル

- `cdk-app/` - CDK アプリケーション
  - `bin/main.ts` - スタック生成エントリ（dev/stg/prod）
  - `lib/constructs/network.ts` - VPC / SG
  - `lib/constructs/compute.ts` - ECS (Fargate)
  - `lib/constructs/database.ts` - Aurora Serverless v2
  - `lib/stack.ts` - 3 層をまとめるスタック

## 使い方（ローカル）

```powershell
cd cdk-app
npx tsc --noEmit   # 型チェック
npx cdk synth      # 合成
npx cdk deploy ThreeTierStack-dev   # 例: dev をデプロイ
```

## 注意

- デフォルトでは `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION` を使用します。環境ごとに異なるアカウント/リージョンへデプロイする場合は `bin/main.ts` を調整してください。
- Secrets Manager や RDS の削除ポリシーは開発用に `DESTROY` を設定しています。本番では注意してください。

---

## ネットワーク / ポート / セキュリティ

- エッジ (CloudFront): HTTPS :443 で受け付け、ALB (HTTP :80) へ転送。カスタムヘッダー（`X-Origin-Verify`）を付与してオリジン（ALB）へリクエストを送信
- セキュリティ (WAF & カスタムヘッダー): AWS WAFv2 (WebACL) で外部攻撃から保護。また、CloudFront 以外からの直接アクセス（ALBパブリックDNSへの直打ちなど）は ALB リスナー側で `403 Forbidden` を返しシャットアウトします
- ALB: 80番ポートでリスン
- ALB → ECS: 80 (コンテナのアプリケーションポート。amazon-ecs-sampleの既定ポート)
- ECS → Aurora: 3306 (MySQL。Connections API を用いて自動連携)

作成日: 2026-06-17

---

## 自動デプロイ (CI/CD) 設定手順

本リポジトリは GitHub Actions と AWS CDK を用いた、Fargateへのセキュアかつ自動化されたCI/CDパイプラインに対応しています。

### 1. AWS 側：GitHub OIDC プロバイダーの登録
AWSアカウント内に GitHub 用の OIDC プロバイダーが未登録の場合、AWS IAM に登録してください。
- **プロバイダーURL**: `https://token.actions.githubusercontent.com`
- **対象者 (Audience)**: `sts.amazonaws.com`

### 2. GitHub 側：Secrets / Variables の設定
リポジトリの **Settings > Secrets and variables > Actions** にて以下を設定します。
- **Repository secrets**:
  - `AWS_ACCOUNT_ID`: デプロイ対象のAWSアカウントID
- **Repository variables**:
  - `AWS_REGION`: デプロイ先のAWSリージョン（デフォルト: `ap-northeast-1`）

### 3. 初回デプロイ (インフラ・ロール・ECRの構築)
ローカルから手動でCDKデプロイを実行し、自動デプロイに必要なIAMロールおよびECRリポジトリを作成します。
```powershell
cd cdk-app
# 開発環境 (developブランチ用) の構築
npx cdk deploy ThreeTierStack-dev --require-approval never
# ステージング環境 (release/*ブランチ用) の構築
npx cdk deploy ThreeTierStack-stg --require-approval never
# 本番環境 (mainブランチ用) の構築
npx cdk deploy ThreeTierStack-prod --require-approval never
```
※ 初回デプロイ時はイメージタグを指定しないため、Fargateサービスは自動的にAWS公式のサンプルイメージ (`amazon-ecs-sample`) を使用して起動し、安定します。

### 4. 自動デプロイの実行
以降は、対象ブランチへのプッシュで自動デプロイが起動します。
- `develop` ブランチへのプッシュ: 開発環境 (`ThreeTierStack-dev`) へデプロイ
- `release/*` ブランチへのプッシュ: ステージング環境 (`ThreeTierStack-stg`) へデプロイ
- `main` ブランチへのプッシュ: 本番環境 (`ThreeTierStack-prod`) へデプロイ

CI/CD実行時にビルドされたアプリケーションイメージが ECR にプッシュされ、CDK のデプロイにおいて `imageTag` コンテキスト引数（コミットSHA）が渡され、ECSサービスが更新されます。

