import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { interactive, which } from "../exec";
import { ask, bail, choose, code, dim, next, p } from "../ui";
import type { ProviderResult, SetupContext } from "./types";

const REGIONS = [
  { value: "af-south-1", label: "Cape Town (af-south-1)" },
  { value: "eu-west-1", label: "Ireland (eu-west-1)" },
  { value: "eu-central-1", label: "Frankfurt (eu-central-1)" },
  { value: "us-east-1", label: "N. Virginia (us-east-1)" },
  { value: "us-west-2", label: "Oregon (us-west-2)" },
  { value: "ap-southeast-1", label: "Singapore (ap-southeast-1)" },
];

/** Profile names from ~/.aws/config and ~/.aws/credentials. */
export function awsProfiles(home = homedir()): { name: string; region?: string; sso: boolean }[] {
  const out = new Map<string, { name: string; region?: string; sso: boolean }>();
  const read = (file: string, isConfig: boolean) => {
    if (!existsSync(file)) return;
    let cur: { name: string; region?: string; sso: boolean } | undefined;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const h = /^\s*\[\s*(?:profile\s+)?([^\]\s]+)\s*\]/.exec(line);
      if (h) {
        if (isConfig && h[1] && /^sso-session\b/.test(line.replace(/^\s*\[\s*/, ""))) {
          cur = undefined;
          continue;
        }
        cur = out.get(h[1]!) ?? { name: h[1]!, sso: false };
        out.set(cur.name, cur);
        continue;
      }
      const kv = /^\s*([a-z_]+)\s*=\s*(.+?)\s*$/.exec(line);
      if (!cur || !kv) continue;
      if (kv[1] === "region") cur.region = kv[2];
      if (kv[1]!.startsWith("sso_")) cur.sso = true;
    }
  };
  read(process.env.AWS_CONFIG_FILE ?? join(home, ".aws", "config"), true);
  read(process.env.AWS_SHARED_CREDENTIALS_FILE ?? join(home, ".aws", "credentials"), false);
  return [...out.values()];
}

/** The bundled Lambda handler (built by tsup next to the CLI). */
function lambdaZip(): Uint8Array {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = [join(here, "lambda", "index.mjs"), join(here, "..", "dist", "lambda", "index.mjs")].find(existsSync);
  if (!file) throw new Error("The bundled ingest Lambda is missing. Reinstall debugkit.");
  return zipSync({ "index.mjs": readFileSync(file) }, { level: 9 });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function setupAws(ctx: SetupContext): Promise<ProviderResult> {
  /* ---------- 1. Credentials ---------- */
  p.note(
    [
      "deBug creates a DynamoDB table, a Lambda function with a public URL, and an IAM role in your own AWS account.",
      "It uses an AWS profile on this machine. With AWS SSO (IAM Identity Center) you sign in through your browser; no access keys are needed.",
      "Your credentials stay on this machine. deBug doesn't receive them.",
    ].join("\n"),
    "Sign in to AWS",
  );
  const profiles = awsProfiles();
  const SSO = "__sso__";
  const ENV = "__env__";
  const options = [
    ...profiles.map((x) => ({ value: x.name, label: x.name, hint: [x.sso ? "SSO" : "keys", x.region].filter(Boolean).join(" · ") })),
    ...(process.env.AWS_ACCESS_KEY_ID ? [{ value: ENV, label: "Credentials from the environment (AWS_ACCESS_KEY_ID)" }] : []),
    { value: SSO, label: "Sign in with AWS SSO (IAM Identity Center)", hint: which("aws") ? "opens your browser" : "needs the AWS CLI" },
  ];
  let profile: string | undefined = await choose("Which AWS credentials should deBug use?", options, profiles[0]?.name ?? SSO);
  if (profile === SSO) {
    if (!which("aws")) bail("AWS SSO sign-in needs the AWS CLI: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html");
    const name = await ask("Name for the new AWS profile", { initial: "debugkit" });
    p.log.step(`Running ${code(`aws configure sso --profile ${name}`)}. It asks for your SSO start URL and region, then opens your browser to approve access.`);
    if ((await interactive("aws", ["configure", "sso", "--profile", name])) !== 0) bail("AWS SSO setup didn't finish.");
    profile = name;
  } else if (profile === ENV) profile = undefined;

  const { fromNodeProviderChain } = await import("@aws-sdk/credential-providers");
  const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
  const defaultRegion = profiles.find((x) => x.name === profile)?.region ?? process.env.AWS_REGION ?? "af-south-1";
  const region = await choose("Which AWS region?", REGIONS.some((r) => r.value === defaultRegion) ? REGIONS : [{ value: defaultRegion, label: defaultRegion }, ...REGIONS], defaultRegion);
  const credentials = fromNodeProviderChain(profile ? { profile } : {});
  const base = { region, credentials };

  let identity: { Account?: string; Arn?: string };
  try {
    identity = await new STSClient(base).send(new GetCallerIdentityCommand({}));
  } catch (err) {
    const sso = profiles.find((x) => x.name === profile)?.sso;
    if (sso && which("aws")) {
      p.log.info("Your SSO session has expired. Signing in again.");
      if ((await interactive("aws", ["sso", "login", "--profile", profile!])) !== 0) bail("AWS SSO sign-in didn't finish.");
      identity = await new STSClient({ region, credentials: fromNodeProviderChain({ profile }) }).send(new GetCallerIdentityCommand({}));
    } else bail(`Those AWS credentials didn't work: ${(err as Error).message}`);
  }
  p.log.success(`Signed in to AWS account ${code(identity.Account ?? "?")} ${dim(identity.Arn ?? "")}`);

  const table = await ask("DynamoDB table name", { initial: "debugkit" });
  const functionName = "debugkit-ingest";
  const roleName = `debugkit-ingest-${region}`;
  await next(`Create the table, role and function in ${region}`);

  const s = p.spinner();
  const [{ DynamoDBClient, CreateTableCommand, DescribeTableCommand, UpdateTimeToLiveCommand }, iamMod, lambdaMod] = await Promise.all([
    import("@aws-sdk/client-dynamodb"),
    import("@aws-sdk/client-iam"),
    import("@aws-sdk/client-lambda"),
  ]);

  /* ---------- 2. DynamoDB ---------- */
  const ddb = new DynamoDBClient(base);
  s.start(`Creating DynamoDB table ${table}`);
  let tableArn: string | undefined;
  try {
    tableArn = (await ddb.send(new DescribeTableCommand({ TableName: table }))).Table?.TableArn;
    s.message(`Table ${table} already exists, reusing it`);
  } catch {
    const out = await ddb.send(
      new CreateTableCommand({
        TableName: table,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        Tags: [{ Key: "created-by", Value: "debugkit" }],
      }),
    );
    tableArn = out.TableDescription?.TableArn;
    for (let i = 0; i < 60; i++) {
      const st = (await ddb.send(new DescribeTableCommand({ TableName: table }))).Table?.TableStatus;
      if (st === "ACTIVE") break;
      await sleep(2000);
    }
  }
  try {
    await ddb.send(new UpdateTimeToLiveCommand({ TableName: table, TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true } }));
  } catch (err) {
    if (!/already enabled|TimeToLive is already/i.test((err as Error).message)) throw err;
  }
  s.stop(`DynamoDB table ${table} is ready (on-demand billing, 30-day expiry on raw events)`);

  /* ---------- 3. IAM role for the function: write to this table, and logs ---------- */
  const iam = new iamMod.IAMClient(base);
  s.start(`Creating IAM role ${roleName}`);
  let roleArn: string;
  let newRole = false;
  try {
    roleArn = (await iam.send(new iamMod.GetRoleCommand({ RoleName: roleName }))).Role!.Arn!;
  } catch {
    roleArn = (
      await iam.send(
        new iamMod.CreateRoleCommand({
          RoleName: roleName,
          Description: "deBug ingest Lambda: writes to the deBug DynamoDB table",
          AssumeRolePolicyDocument: JSON.stringify({
            Version: "2012-10-17",
            Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
          }),
          Tags: [{ Key: "created-by", Value: "debugkit" }],
        }),
      )
    ).Role!.Arn!;
    newRole = true;
  }
  await iam.send(new iamMod.AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" }));
  await iam.send(
    new iamMod.PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: "debugkit-table-write",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:BatchWriteItem", "dynamodb:GetItem"], Resource: tableArn }],
      }),
    }),
  );
  s.stop(`IAM role ${roleName} can write to ${table} and nothing else`);

  /* ---------- 4. Lambda + Function URL ---------- */
  const lambda = new lambdaMod.LambdaClient(base);
  const env = { Variables: { DEBUG_TABLE: table, DEBUG_INGEST_KEYS: `${ctx.ingestKey}:${ctx.app.appId}` } };
  const zip = lambdaZip();
  s.start(`Deploying Lambda ${functionName}`);
  let exists = true;
  try {
    await lambda.send(new lambdaMod.GetFunctionCommand({ FunctionName: functionName }));
  } catch {
    exists = false;
  }
  if (exists) {
    await lambda.send(new lambdaMod.UpdateFunctionCodeCommand({ FunctionName: functionName, ZipFile: zip }));
    await waitUpdated(lambda, lambdaMod, functionName);
    await lambda.send(new lambdaMod.UpdateFunctionConfigurationCommand({ FunctionName: functionName, Environment: env, Role: roleArn }));
  } else {
    // A new role takes a few seconds before Lambda can assume it.
    for (let attempt = 0; ; attempt++) {
      try {
        await lambda.send(
          new lambdaMod.CreateFunctionCommand({
            FunctionName: functionName,
            Runtime: "nodejs22.x",
            Architectures: ["arm64"],
            Handler: "index.handler",
            Role: roleArn,
            Code: { ZipFile: zip },
            MemorySize: 256,
            Timeout: 10,
            Environment: env,
            Description: "deBug ingest: receives SDK events and writes them to DynamoDB",
            Tags: { "created-by": "debugkit" },
          }),
        );
        break;
      } catch (err) {
        if (attempt < 10 && /cannot be assumed|role defined for the function/i.test((err as Error).message)) {
          s.message(newRole ? "Waiting for the new IAM role to be ready" : "Retrying");
          await sleep(3000);
        } else throw err;
      }
    }
  }
  await waitUpdated(lambda, lambdaMod, functionName);

  let url: string;
  try {
    url = (await lambda.send(new lambdaMod.GetFunctionUrlConfigCommand({ FunctionName: functionName }))).FunctionUrl!;
  } catch {
    url = (await lambda.send(new lambdaMod.CreateFunctionUrlConfigCommand({ FunctionName: functionName, AuthType: "NONE" }))).FunctionUrl!;
  }
  // A public Function URL needs both permissions. The ingest key checks every request.
  for (const [sid, input] of [
    ["debugkit-public-url", { Action: "lambda:InvokeFunctionUrl", FunctionUrlAuthType: "NONE" }],
    ["debugkit-public-invoke", { Action: "lambda:InvokeFunction", InvokedViaFunctionUrl: true }],
  ] as const) {
    try {
      await lambda.send(new lambdaMod.AddPermissionCommand({ FunctionName: functionName, StatementId: sid, Principal: "*", ...input } as never));
    } catch (err) {
      if (!/already exists/i.test((err as Error).message)) p.log.warn(`Couldn't add ${sid}: ${(err as Error).message}`);
    }
  }
  s.stop(`Lambda ${functionName} is live at ${url}`);

  /* ---------- 5. A read-only policy for hosting the dashboard later ---------- */
  let readOnlyPolicyArn: string | undefined;
  try {
    const policyName = `debugkit-dashboard-readonly-${table}`;
    const doc = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:DescribeTable"], Resource: tableArn }],
    });
    readOnlyPolicyArn = `arn:aws:iam::${identity.Account}:policy/${policyName}`;
    try {
      await iam.send(new iamMod.GetPolicyCommand({ PolicyArn: readOnlyPolicyArn }));
    } catch {
      await iam.send(new iamMod.CreatePolicyCommand({ PolicyName: policyName, PolicyDocument: doc, Description: "Read-only access to the deBug table, for the dashboard" }));
    }
  } catch (err) {
    p.log.warn(`Skipped the read-only dashboard policy: ${(err as Error).message}`);
    readOnlyPolicyArn = undefined;
  }

  return {
    config: { provider: "aws", endpoint: url.replace(/\/$/, ""), ingestKey: ctx.ingestKey, aws: { region, profile, table, functionName, roleName, readOnlyPolicyArn } },
    dashboardEnv: { DEBUG_STORE: "dynamodb", AWS_REGION: region, DEBUG_DYNAMO_TABLE: table, ...(profile ? { AWS_PROFILE: profile } : {}) },
    created: [
      `DynamoDB table ${code(table)} in ${region} (on-demand, TTL on ${code("ttl")})`,
      `Lambda ${code(functionName)} with a public URL: ${code(url)}`,
      `IAM role ${code(roleName)} that can only write to the table`,
      ...(readOnlyPolicyArn ? [`Read-only policy for hosting the dashboard: ${code(readOnlyPolicyArn)}`] : []),
    ],
  };
}

async function waitUpdated(lambda: { send(c: unknown): Promise<any> }, mod: typeof import("@aws-sdk/client-lambda"), name: string) {
  for (let i = 0; i < 60; i++) {
    const c = await lambda.send(new mod.GetFunctionConfigurationCommand({ FunctionName: name }));
    if (c.State !== "Pending" && c.LastUpdateStatus !== "InProgress") return;
    await sleep(1500);
  }
}

/** Is the AWS CLI around? Only SSO sign-in needs it. */
