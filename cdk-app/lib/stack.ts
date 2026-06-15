import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { VpcConstruct } from "./constructs/network";
import { DatabaseConstruct } from "./constructs/database";
import { ComputeConstruct } from "./constructs/compute";
import { ApplicationConstruct } from "./constructs/application";

export interface ThreeTierStackProps extends cdk.StackProps {
  /** EC2 instance size or similar identifier used by the application layer */
  instanceSize?: string;
  /** Logical capacity for the database */
  dbCapacity?: number;
  /** Logical environment name (dev/stg/prod) */
  envName?: string;
}

export class ThreeTierStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: ThreeTierStackProps) {
    super(scope, id, props);

    const instanceSize = props?.instanceSize;
    const dbCapacity = props?.dbCapacity;
    const envName = props?.envName;

    const vpcConstruct = new VpcConstruct(this, "VpcConstruct", { envName });

    const db = new DatabaseConstruct(this, "DatabaseConstruct", {
      dbCapacity,
      envName,
      vpc: vpcConstruct.vpc,
      dbSecurityGroup: vpcConstruct.dbSecurityGroup,
    });

    const compute = new ComputeConstruct(this, "ComputeConstruct", {
      instanceSize,
      envName,
      vpc: vpcConstruct.vpc,
      ecsSecurityGroup: vpcConstruct.ecsSecurityGroup,
      dbSecurityGroup: vpcConstruct.dbSecurityGroup,
      dbSecretArn: db.secret?.secretArn,
    });

    // Allow DB secret to be read by ECS task role if needed
    if (db.secret && compute.service) {
      db.secret.grantRead(compute.service.taskDefinition.taskRole);
    }
  }
}
