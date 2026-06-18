import { App } from "cdktf";
import { DatadogStack } from "./lib/datadog-stack";
import { getDatadogConfig } from "./lib/config/config";

const app = new App();

// 抽象化された環境変数ローダーから設定を取得
const config = getDatadogConfig();

// スタックを作成
new DatadogStack(app, `datadog-monitoring-${config.env}`, {
  config: config,
});

app.synth();
