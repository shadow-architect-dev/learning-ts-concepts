# 監査・セキュリティ基準（Security & Audit Standards）

本ドキュメントでは、組織内のすべての AWS アカウントに適用される共通のセキュリティ統制、監査基準、およびガードレール設計（SCP）について定義します。

---

## 1. サービスコントロールポリシー（SCP）による統制ガードレール

管理アカウントから組織（Organizations）のルート、または各 OU に対して強制される **SCP（Service Control Policy）** により、メンバーアカウントのローカル管理者であっても突破できないセキュリティ境界を定義します。

### 代表的な強制ポリシー例

#### ① 管理対象外リージョンの使用制限
開発用・本番用ともに、許可されたリージョン（東京リージョン `ap-northeast-1` 等）以外でのリソース作成を禁止し、予期しないコストの発生やセキュリティホールを防ぎます。
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyAllOutsideRequestedRegions",
      "Effect": "Deny",
      "NotAction": [
        "iam:*",
        "organizations:*",
        "route53:*",
        "cloudfront:*",
        "wafv2:*",
        "support:*"
      ],
      "Resource": "*",
      "Condition": {
        "StringNotEquals": {
          "aws:RequestedRegion": [
            "ap-northeast-1"
          ]
        }
      }
    }
  ]
}
```

#### ② セキュリティ・監査ツールの無効化防止
メンバーアカウントにて、悪意あるユーザーまたは誤操作によって AWS GuardDuty、AWS Config、Security Hub、CloudTrail が停止されるのを強制的に阻止します。
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PreventSecurityServicesDisable",
      "Effect": "Deny",
      "Action": [
        "guardduty:DeleteDetector",
        "guardduty:DisassociateFromMasterAccount",
        "securityhub:DisableSecurityHub",
        "config:DeleteDeliveryChannel",
        "config:StopConfigurationRecorder",
        "cloudtrail:StopLogging",
        "cloudtrail:DeleteTrail"
      ],
      "Resource": "*"
    }
  ]
}
```

#### ③ 本番アカウントデータの削除・変更制限
本番環境（`prod`）アカウントにおいて、S3のバージョニング無効化や、特定の暗号化バケットの削除を禁止します。
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PreventBucketDeletionInProd",
      "Effect": "Deny",
      "Action": [
        "s3:DeleteBucket",
        "s3:PutBucketVersioning"
      ],
      "Resource": "arn:aws:s3:::prod-*"
    }
  ]
}
```

---

## 2. 委任管理者（Delegated Administrator）による監査の集約

組織全体のセキュリティ監視は、管理アカウントではなく **Audit / Security（監査・セキュリティ）アカウント** に機能権限を委任して運用します。

- **AWS Security Hub**: 組織全体のセキュリティ基準（CIS Benchmarks, AWS Foundational Security Best Practices）への準拠スコアを一元管理。
- **Amazon GuardDuty**: 全アカウントの VPC Flow Logs、DNS クエリログ、CloudTrail イベントを機械学習で常時スキャンし、異常な API コールや悪意ある通信（ブルートフォース、C&Cサーバー通信など）を即座に検知。
- **AWS Config**: リソース変更の履歴を追跡。グローバルなルール（「S3バケットのパブリックアクセス禁止」「RDS暗号化必須」など）に違反したリソースが存在する場合、自動でアラートまたは修復（AWS Systems Manager Automation経由）をトリガー。

---

## 3. コンポーネント別のセキュリティ基準（ベストプラクティス）

本リポジトリのインフラコードでも適用されている、各データ/計算レイヤーごとの具体的なセキュリティ基準です。

### ネットワーク（VPC）
- **パブリックサブネット配置制限**: データベース（Aurora）および ECS タスクは、原則としてパブリック IP を持たないプライベートまたはアイソレートされたサブネットに配置。
- **Flow Logs の有効化**: すべての VPC において、VPC Flow Logs を有効化し `Log Archive` アカウントへ集約。

### データベース（Aurora Serverless v2）
- **通信暗号化 (TLS)**: RDS への接続は TLS (Transport Layer Security) を強制。
- **ストレージ暗号化**: AWS KMS (Key Management Service) を用いたストレージの常時暗号化。
- **認証情報の自動ローテーション**: Secrets Manager を用いて、DB マスターパスワードを定期的（30日〜90日）に自動ローテーションし、流出時のリスクを軽減。

### コンテナ（ECS on Fargate）
- **読み取り専用ルートファイルシステム**: タスクのコンテナ定義において `readonlyRootFilesystem: true` を有効化し、攻撃者によるコンテナ内のシステムファイル書き換えを防止。
- **CI/CDイメージスキャン**: Hadolint (Dockerfile linter) および Trivy (コンテナ脆弱性スキャン) をデプロイパイプラインに組み込み、既知の脆弱性があるコンテナイメージの起動をビルド段階で拒否。
