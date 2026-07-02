import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

const rds = cdk.aws_rds;
const secrets = cdk.aws_secretsmanager;

export interface DatabaseConstructProps {
  dbCapacity?: number;
  envName?: string;
  vpc: cdk.aws_ec2.IVpc;
  dbSecurityGroup?: cdk.aws_ec2.ISecurityGroup;
  kmsKey?: cdk.aws_kms.IKey;
}

export class DatabaseConstruct extends Construct {
  public readonly cluster: cdk.aws_rds.DatabaseCluster;
  public readonly secret: cdk.aws_secretsmanager.ISecret;
  public readonly proxy?: cdk.aws_rds.DatabaseProxy;

  constructor(scope: Construct, id: string, props: DatabaseConstructProps) {
    super(scope, id);

    const dbCapacity = props.dbCapacity ?? 1;

    this.secret = new secrets.Secret(this, "DbSecret", {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "clusteradmin" }),
        excludePunctuation: true,
        includeSpace: false,
        generateStringKey: "password",
      },
      encryptionKey: props.kmsKey,
    });

    // prod/stg 環境のみリーダーインスタンス（リードレプリカ）を2台追加
    const isProdOrStg = props.envName === "prod" || props.envName === "stg";
    const readers = isProdOrStg ? [
      rds.ClusterInstance.serverlessV2("reader1", { scaleWithWriter: true }),
      rds.ClusterInstance.serverlessV2("reader2", { scaleWithWriter: true }),
    ] : undefined;

    this.cluster = new rds.DatabaseCluster(this, "AuroraServerlessV2", {
      engine: rds.DatabaseClusterEngine.auroraMysql({
        version: rds.AuroraMysqlEngineVersion.VER_3_05_2,
      }),
      credentials: rds.Credentials.fromSecret(this.secret),
      vpc: props.vpc,
      vpcSubnets: { subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED },
      writer: rds.ClusterInstance.serverlessV2("writer"),
      readers: readers,
      serverlessV2MinCapacity: dbCapacity,
      serverlessV2MaxCapacity: dbCapacity * 2,
      removalPolicy: props.envName === "prod" 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY,
      deletionProtection: props.envName === "prod",
      securityGroups: props.dbSecurityGroup ? [props.dbSecurityGroup] : undefined,
      storageEncryptionKey: props.kmsKey,
    });

    // Resource Scheduler用タグの追加 (dev/stg環境のみ夜間自動停止)
    if (props.envName === "dev" || props.envName === "stg") {
      cdk.Tags.of(this.cluster).add("Schedule", "office-hours");
    }

    // 本番（prod）およびステージング（stg）環境のみ RDS Proxy を有効化
    if (props.envName === "prod" || props.envName === "stg") {
      this.proxy = this.cluster.addProxy("DbProxy", {
        secrets: [this.secret],
        vpc: props.vpc,
        securityGroups: props.dbSecurityGroup ? [props.dbSecurityGroup] : undefined,
        requireTLS: false, // テスト・接続のしやすさを優先
      });

      // Secrets Manager 自動ローテーション設定 of 追加
      new secrets.SecretRotation(this, "DbSecretRotation", {
        secret: this.secret,
        target: this.cluster,
        application: secrets.SecretRotationApplication.MYSQL_ROTATION_SINGLE_USER,
        vpc: props.vpc,
        vpcSubnets: { subnetType: cdk.aws_ec2.SubnetType.PRIVATE_WITH_EGRESS },
        automaticallyAfter: cdk.Duration.days(30),
      });
    }
  }
}
