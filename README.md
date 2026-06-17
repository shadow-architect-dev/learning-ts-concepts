# learning-ts-concepts

このリポジトリは、TypeScript と AWS CDK を用いて学習用の三層アーキテクチャ（ECS on Fargate + Aurora Serverless v2）を構築するサンプルです。

## 構成（概要）

- VPC
- Web/App 層: ECS on Fargate
- Data 層: Amazon Aurora (Serverless v2)
- 各環境: `dev` / `stg` / `prod` の 3 スタック

## アーキテクチャ図

![Architecture](architecture.svg?v=2)

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

## ネットワーク / ポート

- ALB: 80 / 443 をリスン（外部）
- ALB → ECS: 3000 (コンテナのアプリケーションポートの例)
- ECS → Aurora: 3306 (MySQL。Connections API を用いて自動連携)

作成日: 2026-06-17
