import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

const ec2 = cdk.aws_ec2;

export interface VpcConstructProps {
  envName?: string;
}

export class VpcConstruct extends Construct {
  public readonly vpc: cdk.aws_ec2.Vpc;
  public readonly ecsSecurityGroup: cdk.aws_ec2.SecurityGroup;
  public readonly dbSecurityGroup: cdk.aws_ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props?: VpcConstructProps) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
    });

    this.ecsSecurityGroup = new ec2.SecurityGroup(this, "EcsSecurityGroup", {
      vpc: this.vpc,
      description: "Security group for ECS tasks",
    });

    this.dbSecurityGroup = new ec2.SecurityGroup(this, "DbSecurityGroup", {
      vpc: this.vpc,
      description: "Security group for Aurora DB",
    });
  }
}
