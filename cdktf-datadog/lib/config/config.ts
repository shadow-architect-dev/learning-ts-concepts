export interface DatadogConfig {
  apiKey: string;
  appKey: string;
  env: string;
  stateBucket?: string;
  stateDynamoTable?: string;
  awsRegion?: string;
}

export function getDatadogConfig(): DatadogConfig {
  return {
    apiKey: process.env.DATADOG_API_KEY ?? "",
    appKey: process.env.DATADOG_APP_KEY ?? "",
    env: process.env.APP_ENV ?? "dev",
    stateBucket: process.env.TERRAFORM_STATE_BUCKET,
    stateDynamoTable: process.env.TERRAFORM_LOCK_TABLE,
    awsRegion: process.env.TERRAFORM_STATE_REGION ?? "ap-northeast-1",
  };
}
