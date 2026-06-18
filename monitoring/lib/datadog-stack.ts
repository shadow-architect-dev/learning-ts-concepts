import { TerraformStack, S3Backend } from "cdktf";
import { Construct } from "constructs";
import { DatadogProvider } from "@cdktf/provider-datadog/lib/provider";
import { DatadogConfig } from "./config/config";
import { EcsMonitors } from "./monitors/ecs-monitors";
import { RdsMonitors } from "./monitors/rds-monitors";

export interface DatadogStackProps {
  config: DatadogConfig;
}

export class DatadogStack extends TerraformStack {
  constructor(scope: Construct, id: string, props: DatadogStackProps) {
    super(scope, id);

    // S3 バックエンドの設定（環境変数でバケットが指定されている場合のみ有効化）
    if (props.config.stateBucket) {
      new S3Backend(this, {
        bucket: props.config.stateBucket,
        key: `datadog/monitoring-${props.config.env}/terraform.tfstate`,
        region: props.config.awsRegion ?? "ap-northeast-1",
        dynamodbTable: props.config.stateDynamoTable,
      });
    }

    // Datadog プロバイダーの定義
    new DatadogProvider(this, "datadog", {
      apiKey: props.config.apiKey,
      appKey: props.config.appKey,
    });

    // 各監視アラートの構築
    new EcsMonitors(this, "EcsMonitors", { env: props.config.env });
    new RdsMonitors(this, "RdsMonitors", { env: props.config.env });
  }
}
