import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

const ecs = cdk.aws_ecs;
const ec2 = cdk.aws_ec2;

export interface ComputeConstructProps {
  instanceSize?: string;
  envName?: string;
  vpc: cdk.aws_ec2.IVpc;
  ecsSecurityGroup?: cdk.aws_ec2.ISecurityGroup;
  dbSecurityGroup?: cdk.aws_ec2.ISecurityGroup;
  dbSecretArn?: string;
}

export class ComputeConstruct extends Construct {
  public readonly cluster: cdk.aws_ecs.ICluster;
  public readonly service?: cdk.aws_ecs.FargateService;

  constructor(scope: Construct, id: string, props: ComputeConstructProps) {
    super(scope, id);

    const instanceSize = props.instanceSize ?? "t3.small";
    const mapping: Record<string, { cpu: number; memoryMiB: number }> = {
      "t3.small": { cpu: 256, memoryMiB: 512 },
      "t3.medium": { cpu: 512, memoryMiB: 1024 },
      "t3.large": { cpu: 1024, memoryMiB: 2048 },
    };
    const spec = mapping[instanceSize] ?? { cpu: 512, memoryMiB: 1024 };

    const cluster = new ecs.Cluster(this, "EcsCluster", { vpc: props.vpc });
    this.cluster = cluster;

    const taskDef = new ecs.FargateTaskDefinition(this, "TaskDef", {
      cpu: spec.cpu,
      memoryLimitMiB: spec.memoryMiB,
    });

    const container = taskDef.addContainer("AppContainer", {
      image: ecs.ContainerImage.fromRegistry("amazon/amazon-ecs-sample"),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "app" }),
      environment: {
        ENV: props.envName ?? "dev",
        DB_SECRET_ARN: props.dbSecretArn ?? "",
      },
    });
    container.addPortMappings({ containerPort: 80 });

    const sg = props.ecsSecurityGroup ?? new ec2.SecurityGroup(this, "EcsSecurityGroup", { vpc: props.vpc });

    const service = new ecs.FargateService(this, "FargateService", {
      cluster,
      taskDefinition: taskDef,
      assignPublicIp: false,
      securityGroups: [sg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
    });

    if (props.dbSecurityGroup) {
      // allow the ECS tasks to connect to the DB on default MySQL port
      props.dbSecurityGroup.addIngressRule(sg, ec2.Port.tcp(3306), "Allow ECS to connect to DB");
    }

    this.service = service;
  }
}
