# AIアシスタント開発ルール・設計思想ガイドライン

このリポジトリで作業するすべてのAIコーディングエージェント（モデルを問わない）は、以下の設計思想および開発プロセス、実装のベストプラクティスを遵守して構築・提案を行わなければならない。

---

## 1. コア設計思想

### ① 運用の即時性と非破壊性 (Operational Agility)
- インフラの変更やトラブル対応において、極力「時間のかかる再デプロイ」や「サービス停止」を伴わない手法を優先する。
- 状態のコントロールは、コントロールプレーン（WAFv2のルールアクション変更、Route 53 のルーティング切り替え等）のAPI更新のみで完結させる設計を検討すること。

### ② 堅牢性と復旧力 (Resilience & Reliability)
- 単一障害点（SPOF）を排除し、障害時のフェイルオーバーやDR（災害復旧）を考慮したインフラ構成を設計する。
- 障害発生時には Blameless Post-Mortem（非難を伴わない振り返り）を前提とし、再発防止策をテストや自動化コードに落とし込める構成にすること。

### ③ セキュリティと最小権限 (Security by Design)
- 通信経路や実行権限は、必要な最小限に絞り込む（データベース/キャッシュのEgress通信の徹底遮断、コンテナの非Root実行、OIDCを用いたIAMロール連携など）。
- マルチアカウント環境におけるガバナンスと SCP（Service Control Policy）を考慮し、不正なリージョンやリソースの作成を防ぐ。

### ④ コスト最適化 (FinOps)
- 開発環境（`dev`）はシングル構成かつ夜間自動停止（ECSスケールダウン・DB一時停止）を適用してコストを徹底的に削減する。
- NAT Gateway の代わりに VPC ゲートウェイエンドポイント（S3等）を優先使用する。
- 本番・検証環境は信頼性を優先し、Compute Savings Plans や Reserved Instances を活用した削減シナリオを提示する。

---

## 2. 開発プロセスルール

### ① テスト駆動インフラ (TDI)
- `infra/lib/` 配下のインフラ定義を変更・追加する際は、必ず `infra/test/stack.test.ts` にテストケースまたはアサーションを追加すること。
- コード変更完了後、回答をユーザーに返す前に、ローカル環境で必ず `npm test` を実行し、テストが 100% グリーンであることを自律的に確認すること。

### ② 監視とオブザーバビリティのコード化
- 監視設定（Datadogモニターなど）は、クラウドコンソールでの手動設定を避け、CDKTF 等を用いてコード管理（GitOps）すること。

### ③ 歴史と文脈の引き継ぎ (Context Preservation)
- 新たにチャットセッションを開始、または別モデルへ移行した際は、まず `docs/walkthrough.md` および `README.md` を読み込んで、これまでの設計上の決定事項と直近の変更履歴を確実に把握すること。
- 作業完了後は、`docs/walkthrough.md` に実施した変更内容と動作確認結果を明文化して追記すること。

### ④ 自律型デバッグ＆自己修復ループ (Self-Healing Loop) の動作規約
リポジトリへ変更を加えて GitHub へプッシュする際、以下の「自己修復ループ」を自律的に回し、パイプラインの成功を確認するまでタスクを完了させてはなりません。
* **プッシュ後の CI 監視義務**:
  * リポジトリへの変更をプッシュ (`git push`) した後、ユーザーに完了報告を行う前に、必ず GitHub CLI (`gh run watch` または `gh run list`) を用いて GitHub Actions のステータスをリアルタイムで追跡・確認すること。
* **エラー検出時の自動修復 (Self-Healing)**:
  * もしパイプラインが失敗（failed）した場合は、直ちに `gh run view <run-id> --log` コマンド等を用いてエラーログを自動的に抽出し、不具合の原因を特定してコードを自己修正し、再プッシュすること。
  * ローカル環境で事前に `fmt` や `validate` などの検証を実行し、エラーが解消されたことを確認してから再プッシュを行うこと。
* **完了報告の基準**:
  * GitHub Actions パイプラインが完全に成功（success）となったことを自律確認するまで、ユーザーに対してタスクの「完了」を報告してはならない。

---

## 3. 実装上のベストプラクティス ＆ トラブルシューティング

### ① AWS CDK (TypeScript)
- **RDS Proxy 接続許可の定義**:
  - `DatabaseProxy` (RDS Proxy) にはデフォルトポートが定義されていないため、Proxy へのアクセス許可（セキュリティグループルール）を定義する際は、`allowDefaultPortFrom()` ではなく、ポートを明示的に指定した `allowFrom()` を使用すること。
    * 例: `db.proxy.connections.allowFrom(compute.service, cdk.aws_ec2.Port.tcp(3306));`
- **CDK Assertions テストの安定化**:
  - `Match.objectLike` などのアサーションヘルパーは、`Fn::GetAtt` 等の CloudFormation 組み込み関数（オブジェクト値）を含む配列を検証する際に不安定になる場合がある。
  - `Match` ヘルパーで不一致エラーが発生した場合は、`template.findResources('AWS::ECS::TaskDefinition')` 等でプレーンオブジェクトを取得し、Jest の `expect().toContainEqual(...)` や `expect().toHaveProperty(...)` でアサートを行うこと。

### ② CDK for Terraform (CDKTF)
- **Windows 環境でのインストールエラーの回避**:
  - Windows 環境で `cdktf-cli` の依存モジュールをインストールする際、`node-pty` のビルドが失敗しインストールが中断することがある。
  - この現象を回避するため、Windows 環境でローカルインストールする際は、インストールスクリプトを無視するフラグを付与すること：
    * コマンド: `npm install --ignore-scripts`

---

## 4. AI エージェント（Antigravity）に対する外部スコープ書き込み制限

- **他リポジトリへの書き込み・変更コマンドの禁止 (No Write/Modifying Operations on Outer Repositories)**:
  - `learning-ts-concepts` 以外のディレクトリ内におけるファイル更新（`write_to_file` / `replace_file_content` などの実行）およびコマンド実行は、ポリシー違反であり、厳格に禁止する。

---

## 5. 共通 AWS Landing Zone 接続仕様 ＆ セキュリティガードレール

このリポジトリのインフラを拡張・変更する際は、SREが構築したプラットフォームの接続仕様およびセキュリティガードレールに厳密に準拠すること。

### ① Terraform 状態管理 (State Backend) の接続設定
インフラのステート管理バケットや DynamoDB ロックテーブルは事前作成（払い出し）されています。インフラ自体の作成は行わず、`providers.tf` などのバックエンド定義に以下の設定を使用して接続してください。
* **S3 Bucket**: `aws-landing-zone-<環境名>-tfstate-<AWSアカウントID>`
* **DynamoDB Lock Table**: `terraform-state-lock`
* **KMS Key**: `alias/terraform-state-key` (バケット暗号化用)
* **接続スニペット例**:
  ```hcl
  terraform {
    backend "s3" {
      bucket         = "aws-landing-zone-dev-tfstate-888888888888" # ※各環境のバケット名に置換
      key            = "workload/terraform.tfstate"
      region         = "ap-northeast-1"
      dynamodb_table = "terraform-state-lock"
      encrypt        = true
    }
  }
  ```

### ② CI/CD デプロイ用 IAM ロールの使用
GitHub Actions などの CI/CD からデプロイを行う際は、機密のアクセスキーを直接発行せず、プラットフォームから提供されている OIDC 連携用デプロイロールを引き受けて（AssumeRole）実行してください。
* **使用するロール ARN**: `arn:aws:iam::<AWSアカウントID>:role/GitHubActionsEKSDeployRole`
* **ブランチ制約 (注意)**: 本番環境（Prod）へのデプロイは、プラットフォーム側のセキュリティポリシーにより `main` ブランチからのリクエストのみ AssumeRole が許可されています。開発ブランチから本番アカウントへの接続を試みないでください。

### ③ セキュリティガードレールへの準拠
以下の基準に違反する IaC コードを書いた場合、デプロイ直後にシステムによってリソースが強制変更・削除されます。
* **セキュリティグループのパブリック開放禁止 (自律修復対象)**:
  * SSH（ポート22）や RDP（ポート3389）をインターネット全体（`0.0.0.0/0`）に開放するセキュリティグループを作成しないこと。作成された場合、SSM Automation により数秒でルールが強制削除されます。
* **データベース/キャッシュの送信先制限**:
  * データベース（RDS等）やキャッシュ（ElastiCache等）に紐付けるセキュリティグループのアウトバウンド（Egress）通信は、必要最小限の IP / セキュリティグループ ID に絞り、`0.0.0.0/0` への全送信許可を行わないこと。
* **コンテナの Root 実行禁止**:
  * ECS タスク定義や Kubernetes マニフェストにおいて、コンテナが Root（管理者）権限で起動される設定にしないこと。必ず非Rootユーザー（`user` や `securityContext`）を明示的に指定すること。

