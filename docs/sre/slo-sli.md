# SLO/SLI 策定定義書 (Template)

本ドキュメントは、本アプリケーションサービス（3層 Web アーキテクチャ）における信頼性目標（SLO）およびその評価指標（SLI）を定義するテンプレートです。

---

## 1. サービス概要とユーザー体験の定義
本システムにおける重要ユーザー体験 (Critical User Journey: CUJ) は以下の通りです。
1. **トップページの表示とアセット読み込み (CloudFront / S3)**: ユーザーがブラウザでサービスを開くことができる。
2. **動的 API リクエストとレスポンス (ALB / ECS Fargate / DB)**: ユーザーがアプリケーション内で動的な操作や認証を行うことができる。

---

## 2. SLI/SLO 定義シート

### 1. 可用性 (Availability)
ユーザーがシステムを健全に利用できる割合を評価します。

| 指標名 (SLI) | 計測方法 (データソース) | サービスレベル目標 (SLO) | 測定期間 | 備考 / 計算式 / 運用リンク |
| :--- | :--- | :--- | :--- | :--- |
| **API 可用性** | ALB ログ / メトリクス | **99.9%** (エラーバジェット: 0.1%) | **30日間のローリングウィンドウ** (移動平均) | `(HTTP status 2xx/3xx の総数) / (総リクエスト数 - HTTP status 4xx の総数)` <br>※ ユーザー起因のエラー (4xx: Bad Requestや404) を分母・分子の双方から除外し、システム自体の健全性 (5xx率) のみを厳密に評価。 <br>👉 [Datadog SLO Dashboard](https://app.datadoghq.com/dashboard/availability-slo) / [障害対応Runbook](../runbook/troubleshooting-availability.md) |
| **静的アセット可用性** | CloudFront メトリクス | **99.99%** (エラーバジェット: 0.01%) | **30日間のローリングウィンドウ** (移動平均) | `(CloudFront 送信成功リクエスト数) / (CloudFront 総リクエスト数)` <br>👉 [CloudFront SLO Dashboard](https://app.datadoghq.com/dashboard/cloudfront-slo) / [CF障害対応Runbook](../runbook/troubleshooting-cloudfront.md) |

### 2. 応答速度 (Latency)
ユーザーがストレスを感じずに操作できるレスポンス速度を評価します。

| 指標名 (SLI) | 計測方法 (データソース) | サービスレベル目標 (SLO) | 測定期間 | 備考 / 計算式 / 運用リンク |
| :--- | :--- | :--- | :--- | :--- |
| **API レスポンス速度 (p95)** | Datadog APM / ALB メトリクス | **95% のリクエストが 500ms 以内** | **30日間のローリングウィンドウ** (移動平均) | 応答速度の 95 パーセンタイル値が 500ms 以下である割合 <br>👉 [APM Latency Dashboard](https://app.datadoghq.com/apm/services) / [遅延調査Runbook](../runbook/troubleshooting-latency.md) |
| **API レスポンス速度 (p99)** | Datadog APM / ALB メトリクス | **99% のリクエストが 1500ms 以内** | **30日間のローリングウィンドウ** (移動平均) | 応答速度の 99 パーセンタイル値が 1500ms 以下である割合 <br>👉 [APM Latency Dashboard](https://app.datadoghq.com/apm/services) / [遅延調査Runbook](../runbook/troubleshooting-latency.md) |

---

## 3. エラーバジェットポリシー (Error Budget Policy)

SLO の目標値を下回る「許容される不健全時間（エラーバジェット）」の運用ポリシーを定義します。

### 1. バジェット消費に対するアクション基準
* **バジェット残り 50% 消費**: SRE・開発チーム合同でコード上のボトルネックやアラート原因を調査。
* **バジェット残り 80% 消費**: アラート対応以外の新規フィーチャー開発の優先度を下げ、信頼性改善タスクをスプリントへ強制割り込み。
* **バジェット枯渇 (100%消費)**: 次のスプリントでは新規機能リリースを完全に凍結し、システムの安定化・パフォーマンスチューニングのみを実施。

### 2. レポーティング
* 毎月の月次ミーティングにて、プロダクトオーナーを含めてエラーバジェットの消費状況と信頼性の推移を確認。

---

## 4. 信頼性向上のための関連ドキュメント
* **障害振り返り報告書**: [post-mortem-sample.md](post-mortems/post-mortem-sample.md) (過去に発生した障害の根本原因分析と再発防止アクションアイテムの記述例)
* **災害復旧方針書**: [disaster-recovery-policy.md](disaster-recovery-policy.md) (RTO / RPO の目標定義と、東京リージョン被災時の大阪リージョンでの復旧プロセス)
* **負荷テスト計画書**: [load-testing-plan.md](load-testing-plan.md) (目標負荷（RPS/VU）の定義と、k6 による自動スケーリング検証シナリオ)
* **カオスエンジニアリング実験計画書**: [chaos-engineering.md](chaos-engineering.md) (AWS FIS を用いた DB/ネットワーク/キャッシュの障害注入と復旧検証シナリオ)
