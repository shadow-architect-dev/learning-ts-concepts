import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { ThreeTierStack } from "../lib/stack";

test("ThreeTierStack Synthesizes Correctly", () => {
  const app = new cdk.App();
  const stack = new ThreeTierStack(app, "TestStack", {
    env: {
      account: "123456789012",
      region: "ap-northeast-1",
    },
    envName: "dev",
    instanceSize: "t3.small",
    dbCapacity: 1,
    vpcCidr: "10.0.0.0/16",
  });

  const template = Template.fromStack(stack);

  // VPC が作成されていることを確認
  template.resourceCountIs("AWS::EC2::VPC", 1);

  // ALB が作成されていることを確認
  template.resourceCountIs("AWS::ElasticLoadBalancingV2::LoadBalancer", 1);

  // WAF (WebACL) が作成されていることを確認
  template.resourceCountIs("AWS::WAFv2::WebACL", 1);

  // ECS クラスターとサービスが作成されていることを確認
  template.resourceCountIs("AWS::ECS::Cluster", 1);
  template.resourceCountIs("AWS::ECS::Service", 1);

  // データベース (RDS Aurora Cluster) が作成されていることを確認
  template.resourceCountIs("AWS::RDS::DBCluster", 1);

  // Datadog Agent サイドカーがタスク定義に含まれていることを確認
  template.hasResourceProperties("AWS::ECS::TaskDefinition", {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Name: "DatadogAgent",
        Image: Match.stringLikeRegexp("gcr.io/datadoghq/agent"),
        PortMappings: Match.arrayWith([
          Match.objectLike({ ContainerPort: 8125, Protocol: "udp" }),
          Match.objectLike({ ContainerPort: 8126, Protocol: "tcp" }),
        ]),
        Environment: Match.arrayWith([
          { Name: "ECS_FARGATE", Value: "true" },
          { Name: "DD_SITE", Value: "ap1.datadoghq.com" },
        ]),
      }),
    ]),
  });

  // AppContainer が Datadog Agent に依存して起動し、環境変数が設定されていることを確認
  // AppContainer が Datadog Agent に依存して起動し、環境変数が設定されていることを確認
  const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
  const taskDefKeys = Object.keys(taskDefs);
  expect(taskDefKeys.length).toBe(1);
  const taskDef = taskDefs[taskDefKeys[0]];
  const containerDefs = taskDef.Properties.ContainerDefinitions;

  const appContainer = containerDefs.find((c: any) => c.Name === "AppContainer");
  expect(appContainer).toBeDefined();

  // ポートマッピングの確認（非Root化: 8080）
  expect(appContainer.PortMappings).toContainEqual(
    expect.objectContaining({ ContainerPort: 8080 })
  );

  // 環境変数の確認
  const env = appContainer.Environment;
  expect(env).toContainEqual({ Name: "DD_AGENT_HOST", Value: "localhost" });
  expect(env).toContainEqual({ Name: "DD_TRACE_AGENT_PORT", Value: "8126" });

  const dbHostEnv = env.find((e: any) => e.Name === "DB_HOST");
  expect(dbHostEnv).toBeDefined();
  expect(dbHostEnv.Value).toHaveProperty("Fn::GetAtt");
  expect(dbHostEnv.Value["Fn::GetAtt"][1]).toBe("Endpoint.Address");

  // シークレットの確認
  const secrets = appContainer.Secrets;
  expect(secrets).toBeDefined();
  expect(secrets).toContainEqual(
    expect.objectContaining({ Name: "DB_USER" })
  );
  expect(secrets).toContainEqual(
    expect.objectContaining({ Name: "DB_PASSWORD" })
  );

  // 依存関係の確認
  expect(appContainer.DependsOn).toContainEqual({
    Condition: "START",
    ContainerName: "DatadogAgent",
  });

  // Fargate の夜間自動停止用スケーリングターゲットとスケジュールが存在することを確認
  template.hasResourceProperties("AWS::ApplicationAutoScaling::ScalableTarget", {
    MinCapacity: 0,
    MaxCapacity: 1,
    ScheduledActions: Match.arrayWith([
      Match.objectLike({
        ScheduledActionName: "NightlyStopFargate",
        Schedule: "cron(0 11 * * ? *)",
      }),
      Match.objectLike({
        ScheduledActionName: "DailyStartFargate",
        Schedule: "cron(0 23 * * ? *)",
      }),
    ]),
  });

  // Aurora の夜間自動停止用 Lambda と EventBridge ルールが存在することを確認
  template.resourceCountIs("AWS::Lambda::Function", 1);
  template.resourceCountIs("AWS::Events::Rule", 2);

  // dev環境では DBProxy が存在しないこと（追加コスト0）を確認
  template.resourceCountIs("AWS::RDS::DBProxy", 0);

  // dev環境では DBInstance が 1つ（Writer のみ、Reader なし）であることを確認
  template.resourceCountIs("AWS::RDS::DBInstance", 1);
});

test("ThreeTierStack - Staging Environment Synthesizes Correctly", () => {
  const app = new cdk.App();
  const stack = new ThreeTierStack(app, "StgStack", {
    env: {
      account: "123456789012",
      region: "ap-northeast-1",
    },
    envName: "stg",
    instanceSize: "t3.medium",
    dbCapacity: 2,
    vpcCidr: "10.1.0.0/16",
  });

  const template = Template.fromStack(stack);

  // DBProxy が作成されていることを確認
  template.resourceCountIs("AWS::RDS::DBProxy", 1);

  // DBCluster が 1 つ作成されていることを確認
  template.resourceCountIs("AWS::RDS::DBCluster", 1);

  // DBInstance が 3 つ（Writer x1, Reader x2）作成されていることを確認
  template.resourceCountIs("AWS::RDS::DBInstance", 3);

  // 夜間一時停止スケジュール（dev専用）が存在しないことを確認
  template.resourceCountIs("AWS::Lambda::Function", 0);
  template.resourceCountIs("AWS::Events::Rule", 0);
});

test("ThreeTierStack - Production Environment Synthesizes Correctly", () => {
  const app = new cdk.App();
  const stack = new ThreeTierStack(app, "ProdStack", {
    env: {
      account: "123456789012",
      region: "ap-northeast-1",
    },
    envName: "prod",
    instanceSize: "t3.large",
    dbCapacity: 5,
    vpcCidr: "10.2.0.0/16",
  });

  const template = Template.fromStack(stack);

  // DBProxy が作成されていることを確認
  template.resourceCountIs("AWS::RDS::DBProxy", 1);

  // DBCluster が 1 つ作成されていることを確認
  template.resourceCountIs("AWS::RDS::DBCluster", 1);

  // DBInstance が 3 つ（Writer x1, Reader x2）作成されていることを確認
  template.resourceCountIs("AWS::RDS::DBInstance", 3);

  // データベース (RDS Aurora Cluster) の削除保護と RETAIN ポリシーの検証
  template.hasResource("AWS::RDS::DBCluster", {
    DeletionPolicy: "Retain",
    UpdateReplacePolicy: "Retain",
    Properties: Match.objectLike({
      DeletionProtection: true,
    }),
  });

  // ECS Auto Scaling (Target Tracking) が設定されていることを検証
  template.hasResourceProperties("AWS::ApplicationAutoScaling::ScalableTarget", {
    MinCapacity: 2,
    MaxCapacity: 10,
    ScalableDimension: "ecs:service:DesiredCount",
    ServiceNamespace: "ecs",
  });

  // CPU ターゲット追跡ポリシーが存在することを確認
  template.hasResourceProperties("AWS::ApplicationAutoScaling::ScalingPolicy", {
    PolicyType: "TargetTrackingScaling",
    TargetTrackingScalingPolicyConfiguration: Match.objectLike({
      TargetValue: 70,
      PredefinedMetricSpecification: {
        PredefinedMetricType: "ECSServiceAverageCPUUtilization",
      },
    }),
  });

  // メモリ ターゲット追跡ポリシーが存在することを確認
  template.hasResourceProperties("AWS::ApplicationAutoScaling::ScalingPolicy", {
    PolicyType: "TargetTrackingScaling",
    TargetTrackingScalingPolicyConfiguration: Match.objectLike({
      TargetValue: 70,
      PredefinedMetricSpecification: {
        PredefinedMetricType: "ECSServiceAverageMemoryUtilization",
      },
    }),
  });

  // 夜間一時停止スケジュール（dev専用）が存在しないことを確認
  template.resourceCountIs("AWS::Lambda::Function", 0);
  template.resourceCountIs("AWS::Events::Rule", 0);
});

