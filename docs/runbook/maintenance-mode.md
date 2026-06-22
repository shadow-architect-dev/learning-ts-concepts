# メンテナンスモード切り替え手順書 (Maintenance Mode Guide)

本ドキュメントでは、AWS WAFv2（Regional WebACL）を利用し、インフラの再デプロイやサービス停止を伴わずに、**瞬時にサービスをメンテナンスモードに移行・復旧させる手順**を定義します。

---

## 1. メンテナンスモードの仕組み（アプローチA）

本アーキテクチャでは、AWS WAFv2 にあらかじめ以下のルールと設定を組み込んでいます。

* **通常稼働状態**
  * `MaintenanceModeRule` のアクションが **`Count`**（マッチしてもカウントするだけで通過）に設定されているため、全ユーザーが通常通りアクセスできます。
* **メンテナンス状態**
  * `MaintenanceModeRule` のアクションを **`Block`**（遮断）に切り替えます。
  * このルールは「メンテナンス用IPセット（`MaintenanceIpSet`）に登録されている管理者IP**以外**からの全アクセス」にマッチするため、一般ユーザーはすべて遮断され、指定したメンテナンス画面（HTML）が表示されます。
  * ブロック時の応答は、検索エンジン等に悪影響を与えないよう、正しいステータスコードである **`HTTP 503 Service Unavailable`** で返されます。
  * 管理者（IPセットに登録されたIP）は通常通り本番サイトにアクセスできるため、メンテナンス中の動作確認が可能です。

---

## 2. メンテナンスモードの開始手順（サービス遮断）

AWS CLI を使用して、WAF WebACL のルールアクションを `Count` から `Block` に変更します。

### Step 1: 現在の WebACL 設定 (JSON) の取得
現在の WebACL 定義と、更新に必要なロック用トークン（`LockToken`）を取得します。
```bash
# WebACL情報を取得し、JSONファイルとして一時保存
aws wafv2 get-web-acl \
  --name AlbWebAcl \
  --scope REGIONAL \
  --query "{WebACL: WebACL, LockToken: LockToken}" \
  > temp-web-acl.json
```

### Step 2: 設定ファイル (JSON) の修正
出力された `temp-web-acl.json` をテキストエディタで開き、`Rules` 配下の `MaintenanceModeRule` のアクションを **`Count`** から **`Block`** に書き換えます。

* **修正前（通常稼働）**:
  ```json
  {
    "Name": "MaintenanceModeRule",
    "Priority": 1,
    "Statement": { ... },
    "Action": {
      "Count": {}
    },
    ...
  }
  ```
* **修正後（メンテナンス開始）**:
  ```json
  {
    "Name": "MaintenanceModeRule",
    "Priority": 1,
    "Statement": { ... },
    "Action": {
      "Block": {
        "CustomResponse": {
          "ResponseCode": 503,
          "CustomResponseBodyKey": "MaintenanceHtml"
        }
      }
    },
    ...
  }
  ```

### Step 3: WebACL の更新適用
修正した JSON ファイルと LockToken を指定して、WAF WebACL を更新します。数秒で世界中のエッジ（ALB）に反映され、メンテナンス画面に切り替わります。
```bash
# jq 等を用いて JSON からパラメータを抽出してアップデートを実行
# (※実務では、これらの一連の処理を自動化スクリプトや CI/CD のデプロイジョブにして運用します)
aws wafv2 update-web-acl \
  --name AlbWebAcl \
  --scope REGIONAL \
  --id <WEB_ACL_ID> \
  --default-action Allow={} \
  --rules "$(jq '.WebACL.Rules' temp-web-acl.json)" \
  --visibility-config "$(jq '.WebACL.VisibilityConfig' temp-web-acl.json)" \
  --custom-response-bodies "$(jq '.WebACL.CustomResponseBodies' temp-web-acl.json)" \
  --lock-token "$(jq -r '.LockToken' temp-web-acl.json)"
```

---

## 3. メンテナンスモードの解除手順（サービス復旧）

メンテナンス作業が完了し、一般ユーザーへのアクセス制限を解除する手順です。

1. **現在の WebACL 設定の取得**:
   開始時と同様に `get-web-acl` コマンドで最新の JSON と LockToken を取得します。
2. **JSON の修正**:
   `Rules` 配下の `MaintenanceModeRule` のアクションを **`Block`** から **`Count`** に書き戻します。
3. **WebACL の更新適用**:
   `update-web-acl` コマンドを実行して反映します。即座に一般アクセスが再開されます。

---

## 4. メンテナンス除外IP（管理者IP）の追加・更新・削除手順

メンテナンス中であっても、作業中の開発メンバーや動作検証用の端末からのみアクセスを許可するために、IPセット（`MaintenanceIpSet`）にIPを追加・更新・削除する手順です。

> [!IMPORTANT]
> AWS WAFv2 の `update-ip-set` コマンドは差分更新ではなく、**指定したIPリストによる「完全上書き」**となります。そのため、IPを追加または削除する際は、現在登録されているIPリストを正しく把握した上で実行する必要があります。

### Step 1: 現在の IPSet 設定（登録されているIPリスト）の取得
更新に必要な `LockToken`、`Id`、および現在登録されているIPリストを取得します。
```bash
aws wafv2 get-ip-set \
  --name MaintenanceIpSet-prod \
  --scope REGIONAL \
  --query "{IPSet: IPSet, LockToken: LockToken}" \
  > temp-ip-set.json

# 現在登録されている IP アドレスの一覧を表示して確認
jq -r '.IPSet.Addresses[]' temp-ip-set.json
```

### Step 2: IPアドレスの更新（追加・削除）の実行
取得した `LockToken` を使用し、**残したい（接続を許可し続けたい）IPアドレスのみ**を `--addresses` に指定して `update-ip-set` コマンドを実行します。

* **IPを追加したい場合**:
  現在登録されているIPリストに、新しく許可したいIPを加えたリストを指定します。
  ```bash
  aws wafv2 update-ip-set \
    --name MaintenanceIpSet-prod \
    --scope REGIONAL \
    --id <IP_SET_ID> \
    --addresses "203.0.113.10/32" "198.51.100.0/24" "新しく追加したいIP/32" \
    --lock-token "$(jq -r '.LockToken' temp-ip-set.json)"
  ```

* **IPを削除したい場合 (退職や作業完了に伴うIP除外)**:
  `temp-ip-set.json` から確認した現在登録されているIPリストから、**削除したい不要なIPを除外したリスト**を指定して実行します（指定しなかったIPは自動的に削除されます）。
  ```bash
  aws wafv2 update-ip-set \
    --name MaintenanceIpSet-prod \
    --scope REGIONAL \
    --id <IP_SET_ID> \
    --addresses "不要IPを除外した残りのIP/32" \
    --lock-token "$(jq -r '.LockToken' temp-ip-set.json)"
  ```

* **反映時間**: コマンド実行から数秒で反映されます。
