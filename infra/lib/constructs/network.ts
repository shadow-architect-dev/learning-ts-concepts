import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

const ec2 = cdk.aws_ec2;

export interface VpcConstructProps {
  envName?: string;
  vpcCidr?: string;
}

export class VpcConstruct extends Construct {
  public readonly vpc: cdk.aws_ec2.Vpc;
  public readonly albSecurityGroup: cdk.aws_ec2.SecurityGroup;
  public readonly ecsSecurityGroup: cdk.aws_ec2.SecurityGroup;
  public readonly dbSecurityGroup: cdk.aws_ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props?: VpcConstructProps) {
    super(scope, id);

    const vpcCidr = props?.vpcCidr ?? "10.0.0.0/16";

    // コンテキストから natGateways の数を取得（指定がない場合はデフォルト 1。コスト最適化のため 0 を指定可能にする）
    const natGatewaysContext = this.node.tryGetContext("natGateways");
    const natGateways = natGatewaysContext !== undefined ? Number(natGatewaysContext) : 1;

    // 3層構造のVPC: Public (ALB) → Private (Fargate) → Isolated (DB)
    this.vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr(vpcCidr),
      maxAzs: 3,
      natGateways: natGateways,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: "Private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: "Isolated",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // ALB用セキュリティグループ
    this.albSecurityGroup = new ec2.SecurityGroup(this, "AlbSecurityGroup", {
      vpc: this.vpc,
      description: "Security group for ALB",
    });

    // ALB からのインバウンドを許可 (HTTP/HTTPS)
    this.albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      "Allow HTTP from anywhere"
    );
    this.albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "Allow HTTPS from anywhere"
    );

    // ECS/Fargate 用セキュリティグループ
    this.ecsSecurityGroup = new ec2.SecurityGroup(this, "EcsSecurityGroup", {
      vpc: this.vpc,
      description: "Security group for ECS tasks",
    });

    // ALB → ECS の通信を許可 (ポート 80 を想定)
    this.ecsSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      ec2.Port.tcp(80),
      "Allow inbound from ALB"
    );

    // DB用セキュリティグループ
    this.dbSecurityGroup = new ec2.SecurityGroup(this, "DbSecurityGroup", {
      vpc: this.vpc,
      description: "Security group for Aurora DB",
    });

  }
}
