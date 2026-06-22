import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as fs from "fs";
import * as path from "path";
import { VpcConstruct } from "./constructs/network";
import { DatabaseConstruct } from "./constructs/database";
import { ComputeConstruct } from "./constructs/compute";
import { GithubActionsRoleConstruct } from "./constructs/github-role";
import { CacheConstruct } from "./constructs/cache";
import { KmsConstruct } from "./constructs/kms";
import { StorageConstruct } from "./constructs/storage";
import * as cloudfront_origins from "aws-cdk-lib/aws-cloudfront-origins";

function getSharedOutputs(envName: string) {
  try {
    let filePath = path.join(__dirname, "../../docs/governance/shared-outputs.md");
    if (!fs.existsSync(filePath)) {
      filePath = path.join(__dirname, "../../../docs/governance/shared-outputs.md");
    }
    if (!fs.existsSync(filePath)) {
      filePath = path.join(process.cwd(), "../docs/governance/shared-outputs.md");
    }
    if (!fs.existsSync(filePath)) {
      console.warn("Warning: shared-outputs.md not found at any path.");
      return { firehoseArn: undefined, roleArn: undefined };
    }
    const content = fs.readFileSync(filePath, "utf-8");
    
    // Split sections to extract corresponding env block
    const sections = content.split(/### \d+\./);
    let targetSection = "";
    
    if (envName === "dev") {
      targetSection = sections.find(s => s.includes("開発環境")) || "";
    } else if (envName === "stg") {
      targetSection = sections.find(s => s.includes("検証環境")) || "";
    } else if (envName === "prod") {
      targetSection = sections.find(s => s.includes("本番環境")) || "";
    }
    
    const firehoseMatch = targetSection.match(/LOG_ARCHIVE_FIREHOSE_ARN(?:\*\*)?\s*\|\s*`([^`]+)`/);
    const roleMatch = targetSection.match(/LOG_ARCHIVE_DELIVERY_ROLE_ARN(?:\*\*)?\s*\|\s*`([^`]+)`/);
    
    const firehoseArn = firehoseMatch && !firehoseMatch[1].includes("未設定") ? firehoseMatch[1] : undefined;
    const roleArn = roleMatch && !roleMatch[1].includes("未設定") ? roleMatch[1] : undefined;
    
    return { firehoseArn, roleArn };
  } catch (err) {
    console.warn("Warning: Failed to read shared-outputs.md:", err);
    return { firehoseArn: undefined, roleArn: undefined };
  }
}


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

    const kms = new KmsConstruct(this, "KmsConstruct", { envName });

    const storage = new StorageConstruct(this, "StorageConstruct", {
      envName,
      kmsKey: kms.kmsKey,
    });

    const cache = new CacheConstruct(this, "CacheConstruct", {
      envName,
      vpc: vpcConstruct.vpc,
      redisSecurityGroup: vpcConstruct.redisSecurityGroup,
    });

    const db = new DatabaseConstruct(this, "DatabaseConstruct", {
      dbCapacity,
      envName,
      vpc: vpcConstruct.vpc,
      dbSecurityGroup: vpcConstruct.dbSecurityGroup,
      kmsKey: kms.kmsKey,
    });

    // DB接続先ホスト名の決定（Proxy がある場合は Proxy のエンドポイント、ない場合は DB クラスターのホスト名）
    const dbHost = db.proxy 
      ? db.proxy.endpoint 
      : db.cluster.clusterEndpoint.hostname;

    const { firehoseArn, roleArn } = getSharedOutputs(envName ?? "dev");

    const compute = new ComputeConstruct(this, "ComputeConstruct", {
      instanceSize,
      envName,
      vpc: vpcConstruct.vpc,
      ecsSecurityGroup: vpcConstruct.ecsSecurityGroup,
      dbSecurityGroup: vpcConstruct.dbSecurityGroup,
      dbSecret: db.secret,
      dbHost: dbHost,
      logFirehoseArn: firehoseArn,
      logDeliveryRoleArn: roleArn,
      redisHost: cache.redisHost,
      redisPort: cache.redisPort,
      kmsKey: kms.kmsKey,
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
        port: 8080,
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

    // メンテナンス用IPセット
    const maintenanceIpSet = new wafv2.CfnIPSet(this, "MaintenanceIpSet", {
      addresses: ["203.0.113.0/24"], // 管理者IP（ダミー）
      ipAddressVersion: "IPV4",
      scope: "REGIONAL",
      description: "IP set allowed during maintenance mode",
      name: `MaintenanceIpSet-${envName}`,
    });

    const webAcl = new wafv2.CfnWebACL(this, "AlbWebAcl", {
      defaultAction: { allow: {} },
      scope: "REGIONAL",
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "AlbWebAcl",
        sampledRequestsEnabled: true,
      },
      customResponseBodies: {
        MaintenanceHtml: {
          contentType: "TEXT_HTML",
          content: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>メンテナンス中 - Service Temporarily Unavailable</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; text-align: center; padding: 150px 20px; background-color: #f8fafc; color: #334155; }
    h1 { font-size: 40px; font-weight: 800; color: #0f172a; margin-bottom: 8px; }
    p { font-size: 18px; color: #64748b; line-height: 1.6; }
    .icon { font-size: 64px; margin-bottom: 24px; }
  </style>
</head>
<body>
  <div class="icon">🛠️</div>
  <h1>ただいまメンテナンス中です</h1>
  <p>サービス向上に向けたメンテナンスを実施しております。<br>ご不便をおかけいたしますが、しばらく経ってから再度アクセスしてください。</p>
</body>
</html>
          `.trim(),
        },
      },
      rules: [
        {
          name: "MaintenanceModeRule",
          priority: 1,
          statement: {
            notStatement: {
              statement: {
                ipSetReferenceStatement: {
                  arn: maintenanceIpSet.attrArn,
                },
              },
            },
          },
          // 初期状態は COUNT（通常稼働。ルールにマッチしてもブロックせずスルー）
          // メンテナンス時は CLI から BLOCK に変更する
          action: { count: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "MaintenanceModeRule",
            sampledRequestsEnabled: true,
          },
        },
        {
          name: "AWSManagedRulesCommonRuleSet",
          priority: 2,
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

    // 2. Amazon CloudFront Distribution (Origin: ALB & S3)
    const cloudfront = cdk.aws_cloudfront;
    const origins = cdk.aws_cloudfront_origins;

    // CloudFront OAC (Origin Access Control) の作成
    const oac = new cloudfront.CfnOriginAccessControl(this, "S3OAC", {
      originAccessControlConfig: {
        name: `S3-OAC-${envName ?? "dev"}-${this.stackName}`,
        originAccessControlOriginType: "s3",
        signingBehavior: "always",
        signingProtocol: "sigv4",
        description: "Access control for static asset bucket",
      },
    });

    const s3Origin = new cloudfront_origins.S3Origin(storage.assetBucket);

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
      additionalBehaviors: {
        "/assets/*": {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
      },
    });

    // S3バケットポリシーにて CloudFront (OAC) からの GetObject を許可
    storage.assetBucket.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [storage.assetBucket.arnForObjects("*")],
        principals: [new cdk.aws_iam.ServicePrincipal("cloudfront.amazonaws.com")],
        conditions: {
          ArnEquals: {
            "AWS:SourceArn": `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
          },
        },
      })
    );

    // CfnDistribution (L1) を取得し、S3 オリジンに OAC をバインド
    const cfnDistribution = distribution.node.defaultChild as cdk.aws_cloudfront.CfnDistribution;
    cfnDistribution.addPropertyOverride(
      "DistributionConfig.Origins.1.OriginAccessControlId",
      oac.attrId
    );
    cfnDistribution.addPropertyOverride(
      "DistributionConfig.Origins.1.S3OriginConfig.OriginAccessIdentity",
      ""
    );

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

    // 本番環境 (prod) および ステージング環境 (stg) の動的オートスケーリング (Target Tracking)
    if (compute.service && (envName === "prod" || envName === "stg")) {
      const scaling = compute.service.autoScaleTaskCount({
        minCapacity: envName === "prod" ? 2 : 1, // prodは最低2台でマルチAZ可用性確保、stgは1台から
        maxCapacity: envName === "prod" ? 10 : 4,
      });

      scaling.scaleOnCpuUtilization("CpuScaling", {
        targetUtilizationPercent: 70,
        scaleInCooldown: cdk.Duration.seconds(300),
        scaleOutCooldown: cdk.Duration.seconds(60),
      });

      scaling.scaleOnMemoryUtilization("MemoryScaling", {
        targetUtilizationPercent: 70,
        scaleInCooldown: cdk.Duration.seconds(300),
        scaleOutCooldown: cdk.Duration.seconds(60),
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

    // DB & Redis セキュリティグループの送信（Egress）通信の遮断を確実にするため、
    // すべての接続設定が完了した後に、明示的にダミー拒否Egressルールを追加する。
    // これにより、CDK内部処理によるルールの喪失を防ぎ、CloudFormationによるデフォルト全許可の自動作成を回避する。
    vpcConstruct.dbSecurityGroup.addEgressRule(
      cdk.aws_ec2.Peer.ipv4("255.255.255.255/32"),
      cdk.aws_ec2.Port.icmpTypeAndCode(252, 86),
      "Disallow all outbound traffic"
    );
    vpcConstruct.redisSecurityGroup.addEgressRule(
      cdk.aws_ec2.Peer.ipv4("255.255.255.255/32"),
      cdk.aws_ec2.Port.icmpTypeAndCode(252, 86),
      "Disallow all outbound traffic"
    );
  }
}
