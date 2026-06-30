import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

const ec2 = cdk.aws_ec2;

export interface VpcConstructProps {
  envName?: string;
  vpcCidr?: string;
  ipamPoolId?: string;
  tgwId?: string;
}

export class VpcConstruct extends Construct {
  public readonly vpc: cdk.aws_ec2.Vpc;
  public readonly albSecurityGroup: cdk.aws_ec2.SecurityGroup;
  public readonly ecsSecurityGroup: cdk.aws_ec2.SecurityGroup;
  public readonly dbSecurityGroup: cdk.aws_ec2.SecurityGroup;
  public readonly redisSecurityGroup: cdk.aws_ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props?: VpcConstructProps) {
    super(scope, id);

    const vpcCidr = props?.vpcCidr ?? "10.0.0.0/16";
    const ipamPoolId = props?.ipamPoolId;

    // コンテキストから natGateways の数を取得（IPAM利用時は0台に強制）
    const natGatewaysContext = this.node.tryGetContext("natGateways");
    const natGateways = ipamPoolId ? 0 : (natGatewaysContext !== undefined ? Number(natGatewaysContext) : 1);

    // 3層構造のVPC: Public (ALB) → Private (Fargate) → Isolated (DB)
    this.vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ipamPoolId
        ? ec2.IpAddresses.awsIpamAllocation({
            ipv4IpamPoolId: ipamPoolId,
            ipv4NetmaskLength: 16,
          })
        : ec2.IpAddresses.cidr(vpcCidr),
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
      gatewayEndpoints: {
        S3: {
          service: ec2.GatewayVpcEndpointAwsService.S3,
        },
      },
    });

    // Transit Gateway (TGW) Peering & Routing
    if (props?.tgwId) {
      // 1. TGW VPC Attachment の作成 (L1 Cfn Resource)
      new ec2.CfnTransitGatewayAttachment(this, "TgwVpcAttachment", {
        transitGatewayId: props.tgwId,
        vpcId: this.vpc.vpcId,
        // アタッチメントを配置するプライベートサブネットを指定
        subnetIds: this.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
        tags: [{
          key: "Name",
          value: `${cdk.Stack.of(this).stackName}-tgw-attachment`,
        }],
      });

      // 2. プライベートサブネットのルートテーブルに 0.0.0.0/0 ➔ TGW のルートを追加
      const privateSubnets = this.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS });
      privateSubnets.subnets.forEach((subnet, index) => {
        new ec2.CfnRoute(this, `RouteToTgw-${index}`, {
          routeTableId: subnet.routeTable.routeTableId,
          destinationCidrBlock: "0.0.0.0/0", // 集約アウトバウンド宛てデフォルトルート
          transitGatewayId: props.tgwId!,
        });
      });
    }

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
      description: "Security group for Aurora DB (No outbound allowed)",
      allowAllOutbound: false,
    });

    // Redis用セキュリティグループ
    this.redisSecurityGroup = new ec2.SecurityGroup(this, "RedisSecurityGroup", {
      vpc: this.vpc,
      description: "Security group for ElastiCache Redis (No outbound allowed)",
      allowAllOutbound: false,
    });

    // ECS → Redis (6379) の通信を許可
    this.redisSecurityGroup.addIngressRule(
      this.ecsSecurityGroup,
      ec2.Port.tcp(6379),
      "Allow inbound from ECS tasks on Redis port"
    );

  }
}
