import { Construct } from "constructs";
import { Monitor } from "@cdktf/provider-datadog/lib/monitor";

export interface RdsMonitorsProps {
  env: string;
}

export class RdsMonitors extends Construct {
  constructor(scope: Construct, id: string, props: RdsMonitorsProps) {
    super(scope, id);

    const filterTags = `app:three-tier,env:${props.env}`;

    // Aurora (RDS) CPU使用率監視
    new Monitor(this, "RdsCpuMonitor", {
      name: `[RDS] [${props.env.toUpperCase()}] Aurora CPU Utilization High`,
      type: "metric alert",
      query: `avg(last_5m):avg:aws.rds.cpuutilization{${filterTags}} > 80`,
      message: `Aurora Database CPU usage has exceeded 80% on env:${props.env}.\nNotify: @slack-alerts`,
      tags: ["app:three-tier", `env:${props.env}`],
    });

    // Aurora (RDS) DB接続数監視
    new Monitor(this, "RdsConnectionsMonitor", {
      name: `[RDS] [${props.env.toUpperCase()}] Aurora Database Connection Count High`,
      type: "metric alert",
      query: `avg(last_5m):avg:aws.rds.database_connections{${filterTags}} > 100`,
      message: `Aurora Database connection count has exceeded 100 on env:${props.env}.\nNotify: @slack-alerts`,
      tags: ["app:three-tier", `env:${props.env}`],
    });

    // Aurora (RDS) 空きストレージ容量監視
    new Monitor(this, "RdsFreeStorageMonitor", {
      name: `[RDS] [${props.env.toUpperCase()}] Aurora Database Free Storage Low`,
      type: "metric alert",
      query: `avg(last_5m):avg:aws.rds.free_local_storage{${filterTags}} < 5000000000`, // 5GB
      message: `Aurora Database free local storage is low (<5GB) on env:${props.env}.\nNotify: @slack-alerts`,
      tags: ["app:three-tier", `env:${props.env}`],
    });
  }
}
