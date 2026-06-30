import * as cdk from "aws-cdk-lib";
import { ThreeTierStack } from "../lib/stack";

const app = new cdk.App();

const envs = [
  {
    id: "dev",
    name: "dev",
    instanceSize: "t3.small",
    dbCapacity: 1,
    ipamPoolId: "ipam-pool-dummy-shared-by-landing-zone",
    tgwId: "tgw-dummy-shared-by-landing-zone",
  },
  {
    id: "stg",
    name: "stg",
    instanceSize: "t3.medium",
    dbCapacity: 2,
    vpcCidr: "10.1.0.0/16",
    tgwId: "tgw-dummy-shared-by-landing-zone",
  },
  {
    id: "prod",
    name: "prod",
    instanceSize: "t3.large",
    dbCapacity: 5,
    vpcCidr: "10.2.0.0/16",
    tgwId: "tgw-dummy-shared-by-landing-zone",
  },
];

for (const e of envs) {
  const stack = new ThreeTierStack(app, `ThreeTierStack-${e.id}`, {
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.CDK_DEFAULT_REGION,
    },
    stackName: `ThreeTierStack-${e.name}`,
    terminationProtection: e.name !== "dev",
    instanceSize: e.instanceSize,
    dbCapacity: e.dbCapacity,
    envName: e.name,
    vpcCidr: e.vpcCidr,
    ipamPoolId: e.ipamPoolId,
    tgwId: e.tgwId,
  });

  // Add an 'Environment' tag to each stack
  cdk.Tags.of(stack).add("Environment", e.name);
}

app.synth();
