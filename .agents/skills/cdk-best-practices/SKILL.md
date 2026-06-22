---
name: cdk-best-practices
description: AWS CDK でのインフラ構築ルール。コンストラクト設計、ネーミング規則。
---
# AWS CDK 構築ガイドライン
## 設計方針
- L3 Construct (Patterns) を優先使用し、複雑な設定を隠蔽する。
- リソースには必ず `Tags` を付与する。
- 物理名は固定せず、CDK の自動生成（CloudFormation）に任せる。

## ワークフロー
1. Construct の定義
2. プロパティの明示的設定
3. `cdk synth` による CloudFormation テンプレートの検証