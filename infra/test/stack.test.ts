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

  const redisHostEnv = env.find((e: any) => e.Name === "REDIS_HOST");
  expect(redisHostEnv).toBeDefined();
  expect(redisHostEnv.Value).toHaveProperty("Fn::GetAtt");

  const redisPortEnv = env.find((e: any) => e.Name === "REDIS_PORT");
  expect(redisPortEnv).toBeDefined();
  expect(redisPortEnv.Value).toBe("6379");

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

  // Aurora の夜間自動停止用 Lambda と S3 オブジェクト自動削除用のカスタムリソース Lambda が存在することを確認
  template.resourceCountIs("AWS::Lambda::Function", 2);
  template.resourceCountIs("AWS::Events::Rule", 2);

  // dev環境では DBProxy が存在しないこと（追加コスト0）を確認
  template.resourceCountIs("AWS::RDS::DBProxy", 0);

  // dev環境では DBInstance が 1つ（Writer のみ、Reader なし）であることを確認
  template.resourceCountIs("AWS::RDS::DBInstance", 1);

  // ログ集約用の SubscriptionFilter の作成確認
  template.resourceCountIs("AWS::Logs::SubscriptionFilter", 1);
  template.hasResourceProperties("AWS::Logs::SubscriptionFilter", {
    DestinationArn: "arn:aws:firehose:ap-northeast-1:222222222222:deliverystream/LogArchiveDeliveryStream",
    RoleArn: "arn:aws:iam::222222222222:role/CrossAccountLogsDeliveryRole",
    FilterPattern: "",
  });

  // dev環境では ElastiCache CacheCluster が 1つ作成されていることを確認（ReplicationGroupではない）
  template.resourceCountIs("AWS::ElastiCache::CacheCluster", 1);
  template.hasResourceProperties("AWS::ElastiCache::CacheCluster", {
    CacheNodeType: "cache.t4g.micro",
    Engine: "redis",
    NumCacheNodes: 1,
  });
  template.resourceCountIs("AWS::ElastiCache::SubnetGroup", 1);

  // ECS Exec 有効化の検証 (dev環境では true)
  template.hasResourceProperties("AWS::ECS::Service", {
    EnableExecuteCommand: true,
  });

  // ECS Cluster の executeCommandConfiguration 設定の検証
  template.hasResourceProperties("AWS::ECS::Cluster", {
    Configuration: {
      ExecuteCommandConfiguration: {
        Logging: "OVERRIDE",
        LogConfiguration: {
          CloudWatchEncryptionEnabled: true,
          CloudWatchLogGroupName: Match.anyValue(),
        },
      },
    },
  });

  // 監査ログ用ロググループの検証
  template.hasResourceProperties("AWS::Logs::LogGroup", {
    LogGroupName: "/ecs/dev/AppExecAudit",
    RetentionInDays: 30,
    KmsKeyId: Match.anyValue(),
  });

  // Task Roleに必要な SSM および Logs 権限ポリシーの付与を検証
  template.hasResourceProperties("AWS::IAM::Policy", {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: [
            "ssmmessages:CreateControlChannel",
            "ssmmessages:CreateDataChannel",
            "ssmmessages:OpenControlChannel",
            "ssmmessages:OpenDataChannel",
          ],
          Effect: "Allow",
          Resource: "*",
        }),
        Match.objectLike({
          Action: [
            "logs:CreateLogStream",
            "logs:PutLogEvents",
            "logs:DescribeLogGroups",
            "logs:DescribeLogStreams",
          ],
          Effect: "Allow",
          Resource: Match.anyValue(),
        }),
      ]),
    }),
  });

  // KMSキー作成の確認 (dev環境)
  template.resourceCountIs("AWS::KMS::Key", 1);
  template.hasResourceProperties("AWS::KMS::Key", {
    EnableKeyRotation: false,
  });

  // DatabaseCluster が KMS 暗号化されていることを確認
  template.hasResourceProperties("AWS::RDS::DBCluster", {
    StorageEncrypted: true,
    KmsKeyId: Match.anyValue(),
  });

  // Secrets Manager が KMS 暗号化されていることを確認
  template.hasResourceProperties("AWS::SecretsManager::Secret", {
    KmsKeyId: Match.anyValue(),
  });

  // AppContainer ロググループも KMS 暗号化されていることを確認
  template.hasResourceProperties("AWS::Logs::LogGroup", {
    LogGroupName: "/ecs/dev/AppContainer",
    KmsKeyId: Match.anyValue(),
  });

  // S3静的アセットバケットの検証 (dev環境)
  template.resourceCountIs("AWS::S3::Bucket", 1);
  template.hasResourceProperties("AWS::S3::Bucket", {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
    BucketEncryption: {
      ServerSideEncryptionConfiguration: [
        {
          ServerSideEncryptionByDefault: {
            KMSMasterKeyID: Match.anyValue(),
            SSEAlgorithm: "aws:kms",
          },
        },
      ],
    },
  });

  // CloudFront OAC の検証
  template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);

  // CloudFront Distribution のマルチオリジンおよびキャッシュビヘイビアの検証
  template.hasResourceProperties("AWS::CloudFront::Distribution", {
    DistributionConfig: {
      Origins: Match.arrayWith([
        Match.objectLike({
          CustomOriginConfig: Match.objectLike({
            OriginProtocolPolicy: "http-only",
          }),
        }),
        Match.objectLike({
          S3OriginConfig: {
            OriginAccessIdentity: "",
          },
          OriginAccessControlId: Match.anyValue(),
        }),
      ]),
      CacheBehaviors: Match.arrayWith([
        Match.objectLike({
          PathPattern: "/assets/*",
          ViewerProtocolPolicy: "redirect-to-https",
          CachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6",
        }),
      ]),
    },
  });
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

  // 夜間一時停止スケジュール（dev専用）は存在しないが、S3アセット自動削除用のカスタムリソース Lambda が存在することを確認
  template.resourceCountIs("AWS::Lambda::Function", 1);
  template.resourceCountIs("AWS::Events::Rule", 0);

  // ログ集約用の SubscriptionFilter の作成確認
  template.resourceCountIs("AWS::Logs::SubscriptionFilter", 1);
  template.hasResourceProperties("AWS::Logs::SubscriptionFilter", {
    DestinationArn: "arn:aws:firehose:ap-northeast-1:222222222222:deliverystream/LogArchiveDeliveryStream",
    RoleArn: "arn:aws:iam::222222222222:role/CrossAccountLogsDeliveryRole",
    FilterPattern: "",
  });

  // ElastiCache ReplicationGroup の作成確認 (Multi-AZ, 自動フェイルオーバー有効)
  template.resourceCountIs("AWS::ElastiCache::ReplicationGroup", 1);
  template.hasResourceProperties("AWS::ElastiCache::ReplicationGroup", {
    CacheNodeType: "cache.t4g.micro",
    Engine: "redis",
    MultiAZEnabled: true,
    AutomaticFailoverEnabled: true,
    NumCacheClusters: 2,
  });
  template.resourceCountIs("AWS::ElastiCache::SubnetGroup", 1);

  // ECS Exec 有効化の検証 (stg環境では true)
  template.hasResourceProperties("AWS::ECS::Service", {
    EnableExecuteCommand: true,
  });

  // 監査ログ用ロググループの検証
  template.hasResourceProperties("AWS::Logs::LogGroup", {
    LogGroupName: "/ecs/stg/AppExecAudit",
    RetentionInDays: 30,
    KmsKeyId: Match.anyValue(),
  });

  // KMSキー作成の確認 (stg環境)
  template.resourceCountIs("AWS::KMS::Key", 1);
  template.hasResourceProperties("AWS::KMS::Key", {
    EnableKeyRotation: false,
  });

  // DatabaseCluster が KMS 暗号化されていることを確認
  template.hasResourceProperties("AWS::RDS::DBCluster", {
    StorageEncrypted: true,
    KmsKeyId: Match.anyValue(),
  });

  // Secrets Manager が KMS 暗号化されていることを確認
  template.hasResourceProperties("AWS::SecretsManager::Secret", {
    KmsKeyId: Match.anyValue(),
  });

  // AppContainer ロググループも KMS 暗号化されていることを確認
  template.hasResourceProperties("AWS::Logs::LogGroup", {
    LogGroupName: "/ecs/stg/AppContainer",
    KmsKeyId: Match.anyValue(),
  });

  // S3静的アセットバケットの検証 (stg環境)
  template.resourceCountIs("AWS::S3::Bucket", 1);
  template.hasResourceProperties("AWS::S3::Bucket", {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });

  // CloudFront OAC の検証
  template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
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

  // ログ集約用の SubscriptionFilter の作成確認
  template.resourceCountIs("AWS::Logs::SubscriptionFilter", 1);
  template.hasResourceProperties("AWS::Logs::SubscriptionFilter", {
    DestinationArn: "arn:aws:firehose:ap-northeast-1:222222222222:deliverystream/LogArchiveDeliveryStream",
    RoleArn: "arn:aws:iam::222222222222:role/CrossAccountLogsDeliveryRole",
    FilterPattern: "",
  });

  // ElastiCache ReplicationGroup の作成確認 (Multi-AZ, 自動フェイルオーバー有効)
  template.resourceCountIs("AWS::ElastiCache::ReplicationGroup", 1);
  template.hasResourceProperties("AWS::ElastiCache::ReplicationGroup", {
    CacheNodeType: "cache.t4g.micro",
    Engine: "redis",
    MultiAZEnabled: true,
    AutomaticFailoverEnabled: true,
    NumCacheClusters: 2,
  });
  template.resourceCountIs("AWS::ElastiCache::SubnetGroup", 1);

  // ECS Exec 有効化の検証 (prod環境では false)
  template.hasResourceProperties("AWS::ECS::Service", {
    EnableExecuteCommand: false,
  });

  // 監査ログ用ロググループの検証
  template.hasResourceProperties("AWS::Logs::LogGroup", {
    LogGroupName: "/ecs/prod/AppExecAudit",
    RetentionInDays: 30,
    KmsKeyId: Match.anyValue(),
  });

  // KMSキー作成の確認 (prod環境ではキーローテーションが有効)
  template.resourceCountIs("AWS::KMS::Key", 1);
  template.hasResourceProperties("AWS::KMS::Key", {
    EnableKeyRotation: true,
  });

  // DatabaseCluster が KMS 暗号化されていることを確認
  template.hasResourceProperties("AWS::RDS::DBCluster", {
    StorageEncrypted: true,
    KmsKeyId: Match.anyValue(),
  });

  // Secrets Manager が KMS 暗号化されていることを確認
  template.hasResourceProperties("AWS::SecretsManager::Secret", {
    KmsKeyId: Match.anyValue(),
  });

  // AppContainer ロググループも KMS 暗号化されていることを確認
  template.hasResourceProperties("AWS::Logs::LogGroup", {
    LogGroupName: "/ecs/prod/AppContainer",
    KmsKeyId: Match.anyValue(),
  });

  // S3静的アセットバケットの検証 (prod環境)
  template.resourceCountIs("AWS::S3::Bucket", 1);
  template.hasResourceProperties("AWS::S3::Bucket", {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });

  // CloudFront OAC の検証
  template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
});

