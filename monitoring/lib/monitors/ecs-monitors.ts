import { Construct } from "constructs";
import { Monitor } from "@cdktf/provider-datadog/lib/monitor";

export interface EcsMonitorsProps {
  env: string;
}

export class EcsMonitors extends Construct {
  constructor(scope: Construct, id: string, props: EcsMonitorsProps) {
    super(scope, id);

    const filterTags = `app:three-tier,env:${props.env}`;

    // ECS Fargate CPU使用率監視
    new Monitor(this, "EcsCpuMonitor", {
      name: `[ECS] [${props.env.toUpperCase()}] Fargate CPU Utilization High`,
      type: "metric alert",
      query: `avg(last_5m):avg:aws.ecs.cpuutilization{${filterTags}} > 80`,
      message: `ECS Fargate CPU usage has exceeded 80% on env:${props.env}.\nNotify: @slack-alerts`,
      tags: ["app:three-tier", `env:${props.env}`],
    });

    // ECS Fargate メモリ使用率監視
    new Monitor(this, "EcsMemoryMonitor", {
      name: `[ECS] [${props.env.toUpperCase()}] Fargate Memory Utilization High`,
      type: "metric alert",
      query: `avg(last_5m):avg:aws.ecs.memoryutilization{${filterTags}} > 80`,
      message: `ECS Fargate Memory usage has exceeded 80% on env:${props.env}.\nNotify: @slack-alerts`,
      tags: ["app:three-tier", `env:${props.env}`],
    });
  }
}
