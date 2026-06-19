import { Construct } from "constructs";
import { ServiceLevelObjective } from "@cdktf/provider-datadog/lib/service-level-objective";
import { Monitor } from "@cdktf/provider-datadog/lib/monitor";

export interface SloMonitorsProps {
  envName: string;
  // SLOで使用する、あらかじめ作成されたモニターがある場合に引き渡すためのオプショナルプロパティ
  apiErrorMonitor?: Monitor;
}

export class SloMonitors extends Construct {
  public readonly availabilitySlo: ServiceLevelObjective;
  public readonly latencySlo?: ServiceLevelObjective;

  constructor(scope: Construct, id: string, props: SloMonitorsProps) {
    super(scope, id);

    const env = props.envName.toLowerCase();

    // 1. 可用性 (Availability) SLO - メトリクスベース (Metric-based SLO)
    // 計算式: (5xx以外の総リクエスト数) / (総リクエスト数) が 99.9% 以上であることを目標とする
    this.availabilitySlo = new ServiceLevelObjective(this, "AvailabilitySlo", {
      name: `[${env.toUpperCase()}] API Availability SLO`,
      type: "metric",
      description: "Metrics-based SLO evaluating the ratio of non-5xx responses from Application Load Balancer.",
      query: {
        // 分子: 総リクエスト数から4xxおよび5xxエラーを除外したもの（＝2xx/3xxの健全リクエスト数）
        numerator: `sum:aws.applicationelb.request_count{environment:${env}}.as_count() - sum:aws.applicationelb.httpcode_elb_4xx{environment:${env}}.as_count() - sum:aws.applicationelb.httpcode_elb_5xx{environment:${env}}.as_count()`,
        // 分母: 総リクエスト数から4xxエラー（ユーザー起因エラー）を除外したもの（＝システム本来の評価対象リクエスト数）
        denominator: `sum:aws.applicationelb.request_count{environment:${env}}.as_count() - sum:aws.applicationelb.httpcode_elb_4xx{environment:${env}}.as_count()`,
      },
      thresholds: [
        {
          timeframe: "30d",
          target: 99.9,      // 目標値 (SLO): 99.9%
          warning: 99.95,    // 警告値 (Warning): 99.95%
        },
        {
          timeframe: "7d",
          target: 99.9,
          warning: 99.95,
        }
      ],
      tags: ["app:three-tier", `env:${env}`, "sre:slo", "slo:availability"],
    });

    // 2. 応答速度 (Latency) SLO - モニターベース (Monitor-based SLO)
    // 特定のレイテンシモニター（例: p95レイテンシが500msを超えたらアラート）の健全時間割合が 95% 以上であることを目標とする
    if (props.apiErrorMonitor) {
      this.latencySlo = new ServiceLevelObjective(this, "LatencySlo", {
        name: `[${env.toUpperCase()}] API Latency SLO`,
        type: "monitor",
        description: "Monitor-based SLO tracking HTTP latency threshold behavior.",
        monitorIds: [Number(props.apiErrorMonitor.id)],
        thresholds: [
          {
            timeframe: "30d",
            target: 95.0,    // 30日間のうち 95% の時間は応答速度目標を維持していること
            warning: 97.0,
          }
        ],
        tags: ["app:three-tier", `env:${env}`, "sre:slo", "slo:latency"],
      });
    }
  }
}
