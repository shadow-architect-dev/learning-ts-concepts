import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

const kms = cdk.aws_kms;
const iam = cdk.aws_iam;

export interface KmsConstructProps {
  envName?: string;
}

export class KmsConstruct extends Construct {
  public readonly kmsKey: cdk.aws_kms.Key;

  constructor(scope: Construct, id: string, props?: KmsConstructProps) {
    super(scope, id);

    const envName = props?.envName ?? "dev";
    const region = cdk.Stack.of(this).region;

    // CloudWatch Logs 向けのキーポリシーを作成
    const logsPolicyStatement = new iam.PolicyStatement({
      sid: "AllowCloudWatchLogs",
      effect: iam.Effect.ALLOW,
      principals: [
        new iam.ServicePrincipal(`logs.${region}.amazonaws.com`),
      ],
      actions: [
        "kms:Encrypt*",
        "kms:Decrypt*",
        "kms:ReEncrypt*",
        "kms:GenerateDataKey*",
        "kms:Describe*"
      ],
      resources: ["*"],
    });

    // キーポリシー全体を定義（管理権限を含む）
    const keyPolicy = new iam.PolicyDocument({
      statements: [
        // ルートユーザーによる管理権限を確保（必須）
        new iam.PolicyStatement({
          sid: "EnableIAMUserPermissions",
          effect: iam.Effect.ALLOW,
          principals: [new iam.AccountRootPrincipal()],
          actions: ["kms:*"],
          resources: ["*"],
        }),
        logsPolicyStatement,
      ],
    });

    // KMS キーの定義
    this.kmsKey = new kms.Key(this, "AppEncryptionKey", {
      description: `KMS key for data encryption in ${envName} environment`,
      alias: `alias/app-key-${envName}`,
      enableKeyRotation: envName === "prod", // 本番環境（prod）のみ自動ローテーションを有効化
      policy: keyPolicy,
      removalPolicy: envName === "prod" 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY,
    });
  }
}
