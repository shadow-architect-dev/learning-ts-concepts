import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { VpcConstruct } from "./constructs/network";
import { DatabaseConstruct } from "./constructs/database";
import { ComputeConstruct } from "./constructs/compute";
import { GithubActionsRoleConstruct } from "./constructs/github-role";

export interface ThreeTierStackProps extends cdk.StackProps {
  /** EC2 instance size or similar identifier used by the application layer */
  instanceSize?: string;
  /** Logical capacity for the database */
  dbCapacity?: number;
  /** Logical environment name (dev/stg/prod) */
  envName?: string;
  /** Optional domain name for Route 53 */
  domainName?: string;
  /** Optional custom VPC CIDR block */
  vpcCidr?: string;
  /** GitHub Organization or Username */
  githubOrg?: string;
  /** GitHub Repository name */
  githubRepo?: string;
}

export class ThreeTierStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: ThreeTierStackProps) {
    super(scope, id, props);

    const instanceSize = props?.instanceSize;
    const dbCapacity = props?.dbCapacity;
    const envName = props?.envName;
    const vpcCidr = props?.vpcCidr;
    const githubOrg = props?.githubOrg ?? "shadow-architect-dev";
    const githubRepo = props?.githubRepo ?? "ecs-fargate-ci-cd-platform";

    const vpcConstruct = new VpcConstruct(this, "VpcConstruct", { envName, vpcCidr });

    const db = new DatabaseConstruct(this, "DatabaseConstruct", {
      dbCapacity,
      envName,
      vpc: vpcConstruct.vpc,
      dbSecurityGroup: vpcConstruct.dbSecurityGroup,
    });

    // DB接続先ホスト名の決定（Proxy がある場合は Proxy のエンドポイント、ない場合は DB クラスターのホスト名）
    const dbHost = db.proxy 
      ? db.proxy.endpoint 
      : db.cluster.clusterEndpoint.hostname;

    const compute = new ComputeConstruct(this, "ComputeConstruct", {
      instanceSize,
      envName,
      vpc: vpcConstruct.vpc,
      ecsSecurityGroup: vpcConstruct.ecsSecurityGroup,
      dbSecurityGroup: vpcConstruct.dbSecurityGroup,
      dbSecret: db.secret,
      dbHost: dbHost,
    });

    // GitHub Actions用 IAM ロールの作成（環境ごとにブランチを分離して最小権限を適用）
    // dev環境は develop ブランチ、stg環境は release/* ブランチ、prod環境は main ブランチからのデプロイのみを許可
    let allowedBranch = "develop";
    if (envName === "prod") {
      allowedBranch = "main";
    } else if (envName === "stg") {
      allowedBranch = "release/*";
    }

    new GithubActionsRoleConstruct(this, "GithubActionsRole", {
      envName: envName ?? "dev",
      githubOrg,
      githubRepo,
      allowedBranch,
      ecrRepository: compute.repository,
    });

    // Allow ECS tasks to connect to the DB (or Proxy)
    if (compute.service) {
      if (db.proxy) {
        db.proxy.connections.allowFrom(compute.service, cdk.aws_ec2.Port.tcp(3306));
      } else {
        db.cluster.connections.allowDefaultPortFrom(compute.service);
      }
    }

    // Create Application Load Balancer
    const elbv2 = cdk.aws_elasticloadbalancingv2;
    const alb = new elbv2.ApplicationLoadBalancer(this, "ApplicationLoadBalancer", {
      vpc: vpcConstruct.vpc,
      internetFacing: true,
      securityGroup: vpcConstruct.albSecurityGroup,
      vpcSubnets: { subnetType: cdk.aws_ec2.SubnetType.PUBLIC },
    });

    const customHeaderName = "X-Origin-Verify";
    const customHeaderValue = "secret-token-" + this.stackName;

    // Add HTTP Listener on Port 80 (Deny direct access by default)
    const listener = alb.addListener("HttpListener", {
      port: 80,
      open: true,
      defaultAction: elbv2.ListenerAction.fixedResponse(403, {
        contentType: "text/plain",
        messageBody: "Access Denied: Direct ALB access is not allowed.",
      }),
    });

    // Add ECS Service as target only if X-Origin-Verify header matches
    if (compute.service) {
      listener.addTargets("EcsTarget", {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [compute.service],
        healthCheck: {
          path: "/",
          interval: cdk.Duration.seconds(30),
        },
        conditions: [
          elbv2.ListenerCondition.httpHeader(customHeaderName, [customHeaderValue]),
        ],
        priority: 1,
      });
    }

    // 1. AWS WAF (Web Application Firewall) - Regional WebACL for ALB
    const wafv2 = cdk.aws_wafv2;
    const webAcl = new wafv2.CfnWebACL(this, "AlbWebAcl", {
      defaultAction: { allow: {} },
      scope: "REGIONAL",
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "AlbWebAcl",
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: "AWSManagedRulesCommonRuleSet",
          priority: 1,
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "AWSManagedRulesCommonRuleSet",
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    new wafv2.CfnWebACLAssociation(this, "AlbWebAclAssociation", {
      resourceArn: alb.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    });

    // 2. Amazon CloudFront Distribution (Origin: ALB)
    const cloudfront = cdk.aws_cloudfront;
    const origins = cdk.aws_cloudfront_origins;

    const distribution = new cloudfront.Distribution(this, "CloudFrontDistribution", {
      defaultBehavior: {
        origin: new origins.LoadBalancerV2Origin(alb, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          customHeaders: {
            [customHeaderName]: customHeaderValue,
          },
        }),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      },
    });

    // 3. Amazon Route 53 (Optional - only if domainName is provided)
    if (props?.domainName) {
      const route53 = cdk.aws_route53;
      const targets = cdk.aws_route53_targets;

      const zone = route53.HostedZone.fromLookup(this, "HostedZone", {
        domainName: props.domainName,
      });

      new route53.ARecord(this, "AliasRecord", {
        zone: zone,
        recordName: props.domainName,
        target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
      });
    }

    // 開発環境 (dev) のみの夜間自動停止（Fargate & RDS）
    if (envName === "dev") {
      const lambda = cdk.aws_lambda;
      const events = cdk.aws_events;
      const targets = cdk.aws_events_targets;
      const iam = cdk.aws_iam;

      // 1. Fargate の夜間自動停止スケジュール
      if (compute.service) {
        const scaling = compute.service.autoScaleTaskCount({
          minCapacity: 0,
          maxCapacity: 1,
        });

        // 夜20:00 (JST) = 11:00 (UTC) に 0台にスケールダウン
        scaling.scaleOnSchedule("NightlyStopFargate", {
          schedule: cdk.aws_applicationautoscaling.Schedule.cron({ minute: "0", hour: "11" }),
          minCapacity: 0,
          maxCapacity: 0,
        });

        // 朝08:00 (JST) = 23:00 (UTC) に 1台にスケールアップ
        scaling.scaleOnSchedule("DailyStartFargate", {
          schedule: cdk.aws_applicationautoscaling.Schedule.cron({ minute: "0", hour: "23" }),
          minCapacity: 1,
          maxCapacity: 1,
        });
      }

      // 2. Aurora (RDS) の夜間自動一時停止・起動 (Lambda & EventBridge)
      const rdsControlLambda = new lambda.Function(this, "RdsControlFunction", {
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: "index.handler",
        code: lambda.Code.fromInline(`
          const { RDSClient, StopDBClusterCommand, StartDBClusterCommand } = require("@aws-sdk/client-rds");
          const rds = new RDSClient();
          exports.handler = async (event) => {
            const clusterIdentifier = process.env.CLUSTER_IDENTIFIER;
            console.log("Received event:", JSON.stringify(event));
            try {
              if (event.action === "stop") {
                console.log("Stopping DB Cluster:", clusterIdentifier);
                await rds.send(new StopDBClusterCommand({ DBClusterIdentifier: clusterIdentifier }));
              } else if (event.action === "start") {
                console.log("Starting DB Cluster:", clusterIdentifier);
                await rds.send(new StartDBClusterCommand({ DBClusterIdentifier: clusterIdentifier }));
              }
            } catch (err) {
              console.error("Error executing RDS command:", err);
              throw err;
            }
          };
        `),
        environment: {
          CLUSTER_IDENTIFIER: db.cluster.clusterIdentifier,
        },
        timeout: cdk.Duration.seconds(30),
      });

      // Lambda に対する RDS 操作権限の付与
      rdsControlLambda.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["rds:StartDBCluster", "rds:StopDBCluster", "rds:DescribeDBClusters"],
          resources: [db.cluster.clusterArn],
        })
      );

      // 夜間停止の EventBridge ルール（毎日 JST 20:00 = UTC 11:00）
      const stopDbRule = new events.Rule(this, "StopDbRule", {
        schedule: events.Schedule.cron({ minute: "0", hour: "11" }),
      });
      stopDbRule.addTarget(
        new targets.LambdaFunction(rdsControlLambda, {
          event: events.RuleTargetInput.fromObject({ action: "stop" }),
        })
      );

      // 朝起動の EventBridge ルール（毎日 JST 08:00 = UTC 23:00）
      const startDbRule = new events.Rule(this, "StartDbRule", {
        schedule: events.Schedule.cron({ minute: "0", hour: "23" }),
      });
      startDbRule.addTarget(
        new targets.LambdaFunction(rdsControlLambda, {
          event: events.RuleTargetInput.fromObject({ action: "start" }),
        })
      );
    }
  }
}
