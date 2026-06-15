import { Construct } from "constructs";

export interface ApplicationConstructProps {
  /** EC2 instance size or similar runtime size identifier */
  instanceSize?: string;
  /** Logical environment name (dev/stg/prod) */
  envName?: string;
}

export class ApplicationConstruct extends Construct {
  constructor(scope: Construct, id: string, props?: ApplicationConstructProps) {
    super(scope, id);
    this.initialize(props);
  }

  public initialize(props?: ApplicationConstructProps): void {
    const instanceSize = props?.instanceSize ?? "t3.micro";
    const envName = props?.envName ?? "unknown";
    // TODO: define application resources here using instanceSize and envName
  }
}
