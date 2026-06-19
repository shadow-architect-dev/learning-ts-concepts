import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

const ecs = cdk.aws_ecs;
const ec2 = cdk.aws_ec2;
const ecr = cdk.aws_ecr;

export interface ComputeConstructProps {
  instanceSize?: string;
  envName?: string;
  vpc: cdk.aws_ec2.IVpc;
  ecsSecurityGroup?: cdk.aws_ec2.ISecurityGroup;
  dbSecurityGroup?: cdk.aws_ec2.ISecurityGroup;
  dbSecret?: cdk.aws_secretsmanager.ISecret;
  dbHost?: string;
  logFirehoseArn?: string;
  logDeliveryRoleArn?: string;
  redisHost?: string;
  redisPort?: number;
}

export class ComputeConstruct extends Construct {
  public readonly cluster: cdk.aws_ecs.ICluster;
  public readonly service?: cdk.aws_ecs.FargateService;
  public readonly repository: cdk.aws_ecr.Repository;

  constructor(scope: Construct, id: string, props: ComputeConstructProps) {
    super(scope, id);

    const instanceSize = props.instanceSize ?? "t3.small";
    const mapping: Record<string, { cpu: number; memoryMiB: number }> = {
      "t3.small": { cpu: 512, memoryMiB: 1024 }, // Datadog Agent 導入に伴い引き上げ
      "t3.medium": { cpu: 512, memoryMiB: 1024 },
      "t3.large": { cpu: 1024, memoryMiB: 2048 },
    };
    const spec = mapping[instanceSize] ?? { cpu: 512, memoryMiB: 1024 };

    // ECRリポジトリの定義
    // 開発用/本番用の環境名を含めたリポジトリを作成
    this.repository = new ecr.Repository(this, "AppRepository", {
      repositoryName: `app-repo-${props.envName ?? "dev"}`,
      // 開発時は DESTROY、本番（prod）時は意図しないデータ消失を防ぐため RETAIN とし、
      // 開発用はスタック削除時に自動でイメージを含め削除する
      removalPolicy: props.envName === "prod" 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: props.envName !== "prod",
      imageScanOnPush: true, // セキュリティ向上のためイメージスキャンを有効化
    });

    // 操作履歴を保存する監査用ロググループ
    const execAuditLogGroup = new cdk.aws_logs.LogGroup(this, "EcsExecAuditLogGroup", {
      logGroupName: `/ecs/${props.envName ?? "dev"}/AppExecAudit`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: cdk.aws_logs.RetentionDays.ONE_MONTH,
    });

    const cluster = new ecs.Cluster(this, "EcsCluster", {
      vpc: props.vpc,
      executeCommandConfiguration: {
        logConfiguration: {
          cloudWatchLogGroup: execAuditLogGroup,
          cloudWatchEncryptionEnabled: false,
        },
        logging: ecs.ExecuteCommandLogging.OVERRIDE,
      },
    });
    this.cluster = cluster;

    const taskDef = new ecs.FargateTaskDefinition(this, "TaskDef", {
      cpu: spec.cpu,
      memoryLimitMiB: spec.memoryMiB,
    });

    // ECS Exec (AWS SSM) に必要な IAM 権限の付与 (Task Role に対して)
    taskDef.addToTaskRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: [
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel",
        ],
        resources: ["*"],
      })
    );

    // 監査ロググループへの書き込み権限の付与
    taskDef.addToTaskRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogGroups",
          "logs:DescribeLogStreams",
        ],
        resources: [execAuditLogGroup.logGroupArn],
      })
    );

    // Datadog API キー用のシークレット（ダミーのARNを参照）
    // ※ 実際にデプロイする際はSecrets Managerに実キーを登録し、そのARNに差し替えてください。
    const ddApiKeySecret = cdk.aws_secretsmanager.Secret.fromSecretAttributes(this, "DdApiKey", {
      secretCompleteArn: `arn:aws:secretsmanager:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:secret:datadog-api-key-dummy-xxxxxx`,
    });

    // CDKコンテキストパラメータからイメージタグを取得する
    const imageTag = this.node.tryGetContext("imageTag");
    
    // imageTagコンテキストパラメータが存在する場合はECRからイメージを取得し、
    // 存在しない（初回デプロイ等）場合はサンプルイメージを使用する
    const containerImage = imageTag
      ? ecs.ContainerImage.fromEcrRepository(this.repository, imageTag)
      : ecs.ContainerImage.fromRegistry("amazon/amazon-ecs-sample");

    const containerSecrets: Record<string, cdk.aws_ecs.Secret> = {};
    if (props.dbSecret) {
      containerSecrets.DB_USER = ecs.Secret.fromSecretsManager(props.dbSecret, "username");
      containerSecrets.DB_PASSWORD = ecs.Secret.fromSecretsManager(props.dbSecret, "password");
    }

    // 明示的なロググループの定義（サブスクリプションフィルター登録用）
    const appLogGroup = new cdk.aws_logs.LogGroup(this, "AppLogGroup", {
      logGroupName: `/ecs/${props.envName ?? "dev"}/AppContainer`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: cdk.aws_logs.RetentionDays.ONE_WEEK,
    });

    const container = taskDef.addContainer("AppContainer", {
      image: containerImage,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: appLogGroup,
        streamPrefix: "app",
      }),
      environment: {
        ENV: props.envName ?? "dev",
        DB_HOST: props.dbHost ?? "",
        DD_AGENT_HOST: "localhost",
        DD_TRACE_AGENT_PORT: "8126",
        REDIS_HOST: props.redisHost ?? "",
        REDIS_PORT: props.redisPort ? String(props.redisPort) : "6379",
      },
      secrets: containerSecrets,
    });

    // 集約アカウントへのログ転送（CfnSubscriptionFilter）の設定
    if (props.logFirehoseArn && props.logDeliveryRoleArn) {
      new cdk.aws_logs.CfnSubscriptionFilter(this, "LogArchiveSubscriptionFilter", {
        logGroupName: appLogGroup.logGroupName,
        filterPattern: cdk.aws_logs.FilterPattern.allEvents().logPatternString,
        destinationArn: props.logFirehoseArn!,
        roleArn: props.logDeliveryRoleArn!,
      });
    }
    container.addPortMappings({ containerPort: 8080 });

    const ddAgentContainer = taskDef.addContainer("DatadogAgent", {
      image: ecs.ContainerImage.fromRegistry("gcr.io/datadoghq/agent:7.54.0"),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "datadog-agent" }),
      environment: {
        ECS_FARGATE: "true",
        DD_SITE: "ap1.datadoghq.com",
        DD_DOGSTATSD_NON_LOCAL_TRAFFIC: "true",
        DD_APM_ENABLED: "true",
        DD_APM_NON_LOCAL_TRAFFIC: "true",
      },
      secrets: {
        DD_API_KEY: ecs.Secret.fromSecretsManager(ddApiKeySecret),
      },
    });

    ddAgentContainer.addPortMappings(
      { containerPort: 8125, protocol: ecs.Protocol.UDP },
      { containerPort: 8126, protocol: ecs.Protocol.TCP }
    );

    // 起動順序の依存関係設定
    container.addContainerDependencies({
      container: ddAgentContainer,
      condition: ecs.ContainerDependencyCondition.START,
    });

    const sg = props.ecsSecurityGroup ?? new ec2.SecurityGroup(this, "EcsSecurityGroup", { vpc: props.vpc });

    // natGatewaysが0の場合はパブリックサブネット配置＆パブリックIP付与を有効化（コスト最適化）
    const natGatewaysContext = this.node.tryGetContext("natGateways");
    const natGateways = natGatewaysContext !== undefined ? Number(natGatewaysContext) : 1;
    const isPublicSubnet = natGateways === 0;

    // prod環境では ECS Exec を無効化し、それ以外（dev/stg）ではデバッグのために有効化
    const enableExec = props.envName !== "prod";

    const service = new ecs.FargateService(this, "FargateService", {
      cluster,
      taskDefinition: taskDef,
      assignPublicIp: isPublicSubnet,
      securityGroups: [sg],
      vpcSubnets: isPublicSubnet
        ? { subnetType: ec2.SubnetType.PUBLIC }
        : { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      enableExecuteCommand: enableExec,
    });

    this.service = service;
  }
}

