import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ecr from "aws-cdk-lib/aws-ecr";

export interface GithubActionsRoleProps {
  /** 論理的な環境名 (dev, prod など) */
  envName: string;
  /** GitHubのユーザー名または組織名 */
  githubOrg: string;
  /** GitHubのリポジトリ名 */
  githubRepo: string;
  /** デプロイを許可するGitHubブランチ名 (main, develop など) */
  allowedBranch: string;
  /** GitHub Actionsがプッシュを許可されるECRリポジトリ */
  ecrRepository: ecr.IRepository;
}

/**
 * GitHub ActionsがOIDC認証を用いてセキュアにAWSにアクセスし、
 * ECRへのプッシュとCDKデプロイを実行するためのIAMロールを定義するコンストラクト。
 */
export class GithubActionsRoleConstruct extends Construct {
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: GithubActionsRoleProps) {
    super(scope, id);

    const { envName, githubOrg, githubRepo, allowedBranch, ecrRepository } = props;
    const accountId = cdk.Stack.of(this).account;

    // 1. GitHub OIDC Provider の参照
    // ※ AWSアカウント全体で1つしか存在できないリソースのため、既存のプロバイダーを参照します。
    // もしAWS環境にまだOIDCプロバイダーが存在しない場合は、AWS IAM コンソールで設定するか、
    // 以下のコメントアウト部分を有効化してプロバイダーを作成してください。
    /*
    const oidcProvider = new iam.OpenIdConnectProvider(this, "GithubOidcProvider", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });
    */
    const oidcProviderArn = `arn:aws:iam::${accountId}:oidc-provider/token.actions.githubusercontent.com`;
    const oidcProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      "ImportedGithubOidcProvider",
      oidcProviderArn
    );

    // 2. GitHub Actions用 IAM ロールの作成と信頼ポリシーの設定（最小権限の原則）
    // - STSの AssumeRoleWithWebIdentity を使用
    // - 指定された Organization/Repository の特定の branch からのアクセスのみに限定
    this.role = new iam.Role(this, "GithubActionsDeployRole", {
      roleName: `github-actions-deploy-role-${envName}`,
      assumedBy: new iam.FederatedPrincipal(
        oidcProvider.openIdConnectProviderArn,
        {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          },
          StringLike: {
            // 例: "repo:my-org/my-repo:ref:refs/heads/main"
            "token.actions.githubusercontent.com:sub": `repo:${githubOrg}/${githubRepo}:ref:refs/heads/${allowedBranch}`,
          },
        },
        "sts:AssumeRoleWithWebIdentity"
      ),
      description: `IAM Role for GitHub Actions to deploy resources to the ${envName} environment`,
    });

    // 3. ECR への最小権限ポリシーの付与
    // GetAuthorizationToken はリソースを制限できないため "*" に付与
    this.role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ecr:GetAuthorizationToken"],
        resources: ["*"],
      })
    );

    // 特定のECRリポジトリに対するイメージプッシュ・プル権限を付与
    ecrRepository.grantPullPush(this.role);

    // 4. CDK デプロイに必要な権限（最小権限の原則）
    // GitHub Actionsロール自体に強力なリソース作成権限を持たせるのではなく、
    // CDKブートストラップによって事前に生成されたデプロイ関連のロールへの AssumeRole のみを許可します。
    this.role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["sts:AssumeRole"],
        resources: [
          `arn:aws:iam::${accountId}:role/cdk-hnb659fds-deploy-role-${accountId}-*`,
          `arn:aws:iam::${accountId}:role/cdk-hnb659fds-file-publishing-role-${accountId}-*`,
          `arn:aws:iam::${accountId}:role/cdk-hnb659fds-image-publishing-role-${accountId}-*`,
          `arn:aws:iam::${accountId}:role/cdk-hnb659fds-lookup-role-${accountId}-*`,
        ],
      })
    );
  }
}
