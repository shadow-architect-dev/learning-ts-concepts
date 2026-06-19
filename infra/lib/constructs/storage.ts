import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

const s3 = cdk.aws_s3;

export interface StorageConstructProps {
  envName?: string;
  kmsKey?: cdk.aws_kms.IKey;
}

export class StorageConstruct extends Construct {
  public readonly assetBucket: cdk.aws_s3.Bucket;

  constructor(scope: Construct, id: string, props: StorageConstructProps) {
    super(scope, id);

    const envName = props.envName ?? "dev";

    this.assetBucket = new s3.Bucket(this, "StaticAssetBucket", {
      bucketName: `static-assets-${envName}-${cdk.Stack.of(this).account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryptionKey: props.kmsKey,
      enforceSSL: true,
      removalPolicy: envName === "prod" 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: envName !== "prod",
    });
  }
}
