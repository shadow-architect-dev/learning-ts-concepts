# 📈 負荷テスト ＆ キャパシティプランニング計画書

本ドキュメントは、アプリケーションシステム（ Route 53 ➔ CloudFront ➔ ALB ➔ ECS Fargate ➔ RDS Aurora / Redis ）の信頼性と限界性能を測定し、インフラリソース（CPU/メモリ、DBクラスターサイズ）のキャパシティおよびオートスケーリング動作の正当性を証明するための負荷テスト計画を定義します。

---

## 1. 検証目的

1. **ボトルネックの特定**: 高負荷時において、システムのどのレイヤー（ECSコンテナ、ネットワーク帯域、DBコネクション、Redisメモリ等）が最初に限界（ボトルネック）に達するかを検出する。
2. **オートスケーリングの妥当性検証**: CPU/メモリ使用率が 70% を超えた際、Fargate サービスが設定通りに自動でスケールアウト（2台 ➔ 最大10台）し、システム全体が応答性能を維持できるかを検証する。
3. **Aurora Serverless v2 の追従性検証**: 突発的なアクセス増加に対し、Aurora Serverless v2 がミリ秒単位でスケール（0.5 ACU ➔ 最大 5.0 ACU）し、応答遅延や接続飽和を起こさないかを確認する。
4. **SLO（サービスレベル目標）の防衛線検証**: ピーク負荷時に [SLO定義書](file:///c:/Git/learning-ts-concepts/docs/sre/slo-sli.md) で定めた「95%のリクエストが 500ms 以内」を維持できるかを確認する。

---

## 2. 負荷測定目標 (Load Metrics)

ビジネス要件および過去のアクセス推移予測より、以下の3つの負荷ステージを定義します。

| 負荷ステージ | 想定スループット | 同時接続ユーザー数 (VU) | 許容レスポンス速度 (p95) | 概要 |
| :--- | :--- | :--- | :--- | :--- |
| **Stage 1: 通常負荷** | **100 RPS** | 1,000 | 100ms 以下 | 平常時のトラフィック状態。 |
| **Stage 2: ピーク負荷** | **500 RPS** | 5,000 | **500ms 以下** | キャンペーンやスパイク発生時の瞬間的なピーク状態。 |
| **Stage 3: 限界負荷** | **1,000+ RPS** | 10,000+ | - | システムがクラッシュ（接続拒否、5xxエラー多発）する限界点と崩壊シナリオを測定。 |

---

## 3. テストシナリオ ＆ ツール設計

負荷テストツールには、テストシナリオを JavaScript で記述でき、コンテナやローカル環境から低リソースで大量のトラフィックを生成できる **k6** (Grafana社) を採用します。

### シナリオ 1: 静的アセットキャッシュテスト (CloudFront & S3)
* **検証内容**: 静的アセットバケット ([storage.ts](file:///c:/Git/learning-ts-concepts/infra/lib/constructs/storage.ts)) のアセット（`/assets/*`）への大量リクエスト。
* **確認指標**: CloudFront の Cache Hit Rate が 95% 以上を維持し、S3 や ECS へのリクエストが防げていること。

### シナリオ 2: 動的 API トランザクションテスト
* **検証内容**: ALB ➔ ECS ➔ Redis (セッションキャッシュ) ➔ DB (Aurora MySQL) という全レイヤーを貫通する動的なデータ読み書きリクエスト。
* **テストコード例 (`load_test_scenario.js`)**:
```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '2m', target: 100 }, // 2分かけて通常負荷 (100 VU) にランプアップ
    { duration: '5m', target: 100 }, // 通常負荷を5分間維持
    { duration: '3m', target: 500 }, // さらに3分かけてピーク負荷 (500 VU) へ引き上げ
    { duration: '5m', target: 500 }, // ピーク負荷を5分間維持
    { duration: '2m', target: 0 },   // 2分かけて負荷をゼロに戻す
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'], // p95レスポンスタイムが 500ms 未満であること (SLO閾値)
    http_req_failed: ['rate<0.001'],  // エラー率が 0.1% 未満であること
  },
};

export default function () {
  // 動的APIリクエストのシミュレーション (JSONボディ送信)
  const url = 'https://app-prod.example.com/api/v1/resource';
  const payload = JSON.stringify({
    userId: `user-${Math.floor(Math.random() * 10000)}`,
    action: 'query_data'
  });
  
  const params = {
    headers: {
      'Content-Type': 'application/json',
      'X-Origin-Verify': 'secret-token-ThreeTierStack-prod' // ALBオリジン検証用ヘッダー
    },
  };

  const res = http.post(url, payload, params);
  
  check(res, {
    'status is 200': (r) => r.status === 200,
    'body has data': (r) => r.body.indexOf('success') !== -1,
  });

  sleep(1); // ユーザーの思考時間を模倣して1秒スリープ
}
```

---

## 4. 実行手順 ＆ モニタリング監視

負荷テストを実行する際は、インフラを保護し、正しい計測結果を得るために以下のワークフローに沿って実施します。

```
[負荷テスト開始]
     │
     ▼
[Datadogダッシュボード監視] ── (CPU, メモリ, コネクション数, レスポンスタイム)
     │
     ├─► Fargate スケールアウト確認 (タスク数が 2台 ➔ 10台 へ自動増幅するか)
     ├─► Aurora ACU スケール確認 (0.5 ACU ➔ 5.0 ACU へ自動スケールするか)
     │
     ▼
[負荷テスト終了]
     │
     ▼
[レポート作成] ➔ (限界スループット、ボトルネック箇所、オートスケーリングの遅延評価)
```

### テスト中の Datadog 監視項目 (Key Metrics)
* **ECS (Fargate)**:
  * `aws.ecs.cpuutilization` / `aws.ecs.memoryutilization` (タスク全体の平均負荷。70%を超えてからスケールアウトが開始されるまでのタイムラグを測定)。
  * `DesiredCount` / `RunningCount` (稼働コンテナ数の推移)。
* **Aurora Serverless v2**:
  * `ServerlessDatabaseCapacity` (ACU の現在値。スパイクに対して即座にスケールアップできているか)。
  * `DatabaseConnections` (最大接続数に対して接続プールが飽和していないか)。
* **ElastiCache (Redis)**:
  * `EngineCPUUtilization` / `FreeableMemory` (Redisのシングルスレッド限界値とメモリ空き容量)。
* **ALB**:
  * `HTTPCode_Target_5XX_Count` (スケールアウト時のコンテナのタスク切り替えやDB飽和によるエラー発生数)。

---

## 5. キャパシティプランニング (評価と改善)

負荷テストの結果をもとに、インフラのサイズとオートスケーリングのポリシーを定期的にチューニングします。

* **スケールアウト遅延のチューニング**:
  Fargate コンテナがスケールアウトするまでに時間がかかり（イメージのプル、コンテナ起動、ALBのターゲット登録で約2〜3分を要する）、その間に一時的にレスポンスが遅延する場合は、スケーリング閾値を `70%` から `60%` に引き下げる、あるいは `scaleOutCooldown`（クールダウン期間）を短縮する対策を行います。
* **Redisスペック見直し**:
  Redisメモリ使用率が80%を超えた場合、ノードサイズを `cache.t4g.micro`（0.5GB）から `cache.t4g.small`（1.3GB）へ CDK パラメータにて拡張します。
* **本テストの自動化**:
  GitHub Actionsの定期実行パイプライン（深夜帯）に、本テスト（k6）をステージング環境（`stg`）に向けて実行するジョブを統合し、リグレッション性能テスト（パフォーマンス劣化の自動検知）として運用します。
