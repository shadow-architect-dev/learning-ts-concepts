# 🌋 災害復旧 (Disaster Recovery: DR) 実行手順書

本ドキュメントは、東京リージョン（`ap-northeast-1`）全体が被災・全面停止し、事業継続（BCP）のために**大阪リージョン（`ap-northeast-3`）への手動フェイルオーバー**を行う際の、SREチーム用オペレーションランブックです。

---

## 🚨 事前前提条件

本ランブックの実行は、経営層またはインシデントコマンダーによる**「DR発動宣言（東京リージョンの放棄と大阪への切り替え指示）」**を以て開始します。

### 事前に完了しているべき仕込み項目
1.  **CDK Bootstrap**: 大阪リージョン (`ap-northeast-3`) はあらかじめ `cdk bootstrap` が実行済みであること。
2.  **KMS CMK**: 大阪リージョン側に、DRデプロイ用の KMS カスタマー管理キーが定義され、東京から自動コピーされるDBスナップショットの「ターゲットKMSキー」として設定済みであること。
3.  **S3/ECR レプリケーション**: 静的アセットバケットおよび ECR コンテナイメージの、大阪リージョンへのクロスリージョンレプリケーションが常時稼働していること。

---

## 🛠️ 復旧実行手順

SREオンコール担当者は、AWS CLI が実行可能な端末、または被災していない別のリージョンで起動した管理用EC2インスタンスから以下を実行します。

### Step 1. 大阪リージョンでのステートレスインフラ構築

1.  大阪リージョンを指定し、環境変数に DR 用コンテキスト（`env=prod-dr`）を渡して CDK デプロイを実行します。
    ```bash
    # 接続先を大阪に指定してインフラの箱を生成
    npx cdk deploy ThreeTierStack-prod-dr \
      --region ap-northeast-3 \
      -c env=prod-dr \
      --require-approval never
    ```
2.  **確認項目**:
    *   大阪リージョンに VPC、ALB、ECSクラスター、Secrets Manager、WAF が正常にプロビジョニングされたことを確認します。

---

### Step 2. ECR コンテナイメージの同期確認（レプリケーション未完了時のフォールバック）

通常は自動レプリケーションされていますが、被災直前の最新イメージが大阪に届いていない場合は、ローカルまたはビルドサーバーから大阪の ECR へ直接プッシュします。

1.  大阪の ECR リポジトリへログインします。
    ```bash
    aws ecr get-login-password --region ap-northeast-3 | \
      docker login --username AWS --password-stdin [ACCOUNT_ID].dkr.ecr.ap-northeast-3.amazonaws.com
    ```
2.  最新イメージをビルド、またはローカルキャッシュからタグ付けしてプッシュします。
    ```bash
    docker tag app-image:latest [ACCOUNT_ID].dkr.ecr.ap-northeast-3.amazonaws.com/app-repo-prod-dr:latest
    docker push [ACCOUNT_ID].dkr.ecr.ap-northeast-3.amazonaws.com/app-repo-prod-dr:latest
    ```

---

### Step 3. 大阪コピー済みの「最新スナップショット」から Aurora DB を復元

CDKデプロイで作成された空のDBクラスターを削除し、東京リージョン被災直前のバックアップスナップショットからデータをリストアします。

1.  **大阪リージョンへコピーされた最新のスナップショット ARN の特定**:
    ```bash
    aws rds describe-db-cluster-snapshots \
      --db-cluster-identifier prod-database-cluster \
      --region ap-northeast-3 \
      --query "DBClusterSnapshots[?Status=='available'] | [-1].DBClusterSnapshotArn" \
      --output text
    ```
    *(※ 正常に取得できた場合、`arn:aws:rds:ap-northeast-3:[ACCOUNT_ID]:cluster-snapshot:...` が出力されます。)*

2.  **スナップショットからの DB クラスター復元実行**:
    ```bash
    aws rds restore-db-cluster-from-snapshot \
      --db-cluster-identifier prod-db-cluster-dr \
      --snapshot-identifier [上記で取得したスナップショットのARN] \
      --engine aurora-mysql \
      --engine-version 8.0.mysql_aurora.3.04.1 \
      --db-subnet-group-name [CDKで大阪に作成されたサブネットグループ名] \
      --vpc-security-group-ids [CDKで大阪に作成されたDB用セキュリティグループID] \
      --region ap-northeast-3
    ```

3.  **復元ステータスの監視**:
    復元処理が完了し、ステータスが `available` になるまで監視します（完了まで約10分〜20分を要します）。
    ```bash
    aws rds describe-db-clusters \
      --db-cluster-identifier prod-db-cluster-dr \
      --region ap-northeast-3 \
      --query "DBClusters[0].Status" \
      --output text
    ```

4.  **復元後のエンドポイントの取得と Secrets Manager の更新**:
    復旧したDBのエンドポイントアドレス（ホスト名）を取得します。
    ```bash
    aws rds describe-db-clusters \
      --db-cluster-identifier prod-db-cluster-dr \
      --region ap-northeast-3 \
      --query "DBClusters[0].Endpoint" \
      --output text
    ```
    取得したホスト名を、大阪の Secrets Manager に登録された接続シークレット（`DB_HOST`）に手動で上書きし、ECSタスクが自動追従できるようにします。

---

### Step 4. Route 53 DNS の切り替え（大阪への切り替え）

1.  大阪リージョンに新設された CloudFront Distribution のドメイン名（例: `d111111abcdef8.cloudfront.net`）を取得します。
2.  レコード切り替え用の JSON ファイル（`dns-failover-to-osaka.json`）をカレントディレクトリに作成します。
    ```json
    {
      "Comment": "Failover to Osaka CF Distribution during Tokyo outage",
      "Changes": [
        {
          "Action": "UPSERT",
          "ResourceRecordSet": {
            "Name": "app.example.com.",
            "Type": "A",
            "AliasTarget": {
              "HostedZoneId": "Z2FDTNDATAQYW2",
              "DNSName": "[大阪のCloudFrontドメイン名].",
              "EvaluateTargetHealth": false
            }
          }
        }
      ]
    }
    ```
    *(※ `Z2FDTNDATAQYW2` は CloudFront エイリアス共通の固定 Hosted Zone ID です)*

3.  DNS切り替えコマンドを実行します。
    ```bash
    aws route53 change-resource-record-sets \
      --hosted-zone-id [YOUR_HOSTED_ZONE_ID] \
      --change-batch file://dns-failover-to-osaka.json
    ```

---

## 🧪 復旧確認（ポストチェック）

切り替え完了後、SRE担当者は以下の項目を検証し、サービスが安全に再開されたかを確認します。

1.  **DNS解決確認**:
    ローカル端末から `dig app.example.com` を実行し、CName/Alias が大阪の CloudFront を指しているか確認します。
2.  **API疎通テスト**:
    curl コマンドで疎通とデータ書き込みを検証します。
    ```bash
    curl -X POST https://app.example.com/api/v1/health \
      -H "Content-Type: application/json" \
      -d '{"test": "dr-verification"}'
    ```
    正常に応答が返り、データベースに検証ログが書き込まれることを確認します。
3.  **可観測性の確認**:
    Datadog 上で、大阪リージョンのメトリクス（ECS CPU/Memory, Aurora Connections）の収集が開始され、エラーレートが 0% に収束していることを確認します。
