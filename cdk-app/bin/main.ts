import * as cdk from "aws-cdk-lib";
import { ThreeTierStack } from "../lib/stack";

const app = new cdk.App();

const envs = [
  { id: "dev", name: "dev", instanceSize: "t3.small", dbCapacity: 1 },
  { id: "stg", name: "stg", instanceSize: "t3.medium", dbCapacity: 2 },
  { id: "prod", name: "prod", instanceSize: "t3.large", dbCapacity: 5 },
];

for (const e of envs) {
  const stack = new ThreeTierStack(app, `ThreeTierStack-${e.id}`, {
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.CDK_DEFAULT_REGION,
    },
    stackName: `ThreeTierStack-${e.name}`,
    instanceSize: e.instanceSize,
    dbCapacity: e.dbCapacity,
    envName: e.name,
  });

  // Add an 'Environment' tag to each stack
  cdk.Tags.of(stack).add("Environment", e.name);
}

app.synth();
