import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { interactive, which } from "../exec";
import { keyEntry, mergeKeys } from "../keys";
import { cmdFor, dynamoTableUsedBy, environment, type DebugkitConfig } from "../state";
import { ask, bail, choose, code, dim, fail, next, p, yes } from "../ui";
import { adminEnv, type ProviderResult, type SetupContext } from "./types";

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

  if (!identity.Account) bail("AWS didn't say which account these credentials belong to.");
  const account = identity.Account;

  // One table per environment, so preview and production data never share a table. Refuse one
  // another environment of this app already uses (same account, or an older config without one).
  const takenBy = (t: string) => dynamoTableUsedBy(ctx.app.cwd, t, region, account);
  const table = await ask("DynamoDB table name", {
    initial: environment.get() ? `debugkit-${environment.get()}` : "debugkit",
    validate: (v) => {
      if (!/^[A-Za-z0-9_.-]{3,40}$/.test(v)) return "3–40 characters: letters, digits, _ . -";
      const owner = takenBy(v);
      return owner ? `${owner} already uses ${v} in ${region}. Each environment needs its own table.` : undefined;
    },
  });
  // With --yes the default name isn't validated, so check it here (there's nobody to ask again).
  const tableOwner = takenBy(table);
  if (tableOwner) bail(`${table} in ${region} is already ${tableOwner}'s table. Each environment needs its own table: run again without --yes and pick another name.`);
  // One ingest function per table; any number of apps share it through their own keys.
  const functionName = `debugkit-ingest-${table}`.slice(0, 64);
  const roleName = `debugkit-ingest-${table}-${region}`.slice(0, 64);
  await next(`Create the table, role and function in ${region}`);

  const s = p.spinner();
  const [ddbMod, iamMod, lambdaMod] = await Promise.all([import("@aws-sdk/client-dynamodb"), import("@aws-sdk/client-iam"), import("@aws-sdk/client-lambda")]);

  /* ---------- 2. DynamoDB ---------- */
  const ddb = new ddbMod.DynamoDBClient(base);
  s.start(`Checking DynamoDB table ${table}`);
  let tableArn: string | undefined;
  let ownTable = false;
  const found = await lookup(() => ddb.send(new ddbMod.DescribeTableCommand({ TableName: table })));
  if (found) {
    tableArn = found.Table?.TableArn;
    const tags = await ddb.send(new ddbMod.ListTagsOfResourceCommand({ ResourceArn: tableArn }));
    ownTable = !!tags.Tags?.some((t) => t.Key === CREATED_BY && t.Value === "debugkit");
    const keys = Object.fromEntries((found.Table?.KeySchema ?? []).map((k) => [k.KeyType, k.AttributeName]));
    const types = Object.fromEntries((found.Table?.AttributeDefinitions ?? []).map((a) => [a.AttributeName, a.AttributeType]));
    if (keys.HASH !== "pk" || keys.RANGE !== "sk" || types.pk !== "S" || types.sk !== "S") {
      s.error(`Table ${table} exists with a different key schema`);
      bail(`${table} isn't a deBug table (it needs string keys pk and sk). Run again and choose another table name.`);
    }
    s.stop(ownTable ? `Reusing deBug's table ${table}` : `Table ${table} exists and wasn't created by deBug`);
    if (!ownTable && !(await yes(`Store deBug's data in your existing table ${table}? deBug only adds its own items (pk APPS and APP#…).`, false)))
      bail("Run again and choose a new table name.");
  } else {
    s.message(`Creating DynamoDB table ${table}`);
    const out = await ddb.send(
      new ddbMod.CreateTableCommand({
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
        Tags: [{ Key: CREATED_BY, Value: "debugkit" }],
      }),
    );
    tableArn = out.TableDescription?.TableArn;
    ownTable = true;
    let active = false;
    for (let i = 0; i < 90 && !active; i++) {
      active = (await ddb.send(new ddbMod.DescribeTableCommand({ TableName: table }))).Table?.TableStatus === "ACTIVE";
      if (!active) await sleep(2000);
    }
    if (!active) throw new Error(`Table ${table} didn't become active within 3 minutes. Check it in the AWS console, then run ${cmdFor("init")} again.`);
  }
  if (!tableArn) throw new Error(`AWS didn't return the ARN for table ${table}.`);

  // Raw events carry an expiry in `ttl`. Only switch TTL on if it's off; never change another setting.
  const ttl = (await ddb.send(new ddbMod.DescribeTimeToLiveCommand({ TableName: table }))).TimeToLiveDescription;
  const ttlOn = ttl?.TimeToLiveStatus === "ENABLED" || ttl?.TimeToLiveStatus === "ENABLING";
  if (ttlOn && ttl?.AttributeName !== "ttl") {
    p.log.warn(`${table} already expires items on "${ttl?.AttributeName}", so deBug's raw events won't expire on their own. Clean them up yourself, or use a separate table.`);
  } else if (!ttlOn) {
    await ddb.send(new ddbMod.UpdateTimeToLiveCommand({ TableName: table, TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true } }));
  }
  p.log.success(`DynamoDB table ${table} is ready (30-day expiry on raw events)`);

  /* ---------- 3. IAM role for the function: write to this table, and logs ---------- */
  const iam = new iamMod.IAMClient(base);
  s.start(`Setting up IAM role ${roleName}`);
  let roleArn: string;
  let newRole = false;
  const role = await lookup(() => iam.send(new iamMod.GetRoleCommand({ RoleName: roleName })));
  if (role) {
    if (!role.Role?.Tags?.some((t) => t.Key === CREATED_BY && t.Value === "debugkit")) {
      s.error(`Role ${roleName} exists and wasn't created by deBug`);
      bail(`deBug won't change a role it didn't create. Delete or rename ${roleName}, or choose another table name.`);
    }
    roleArn = role.Role.Arn!;
  } else {
    roleArn = (
      await iam.send(
        new iamMod.CreateRoleCommand({
          RoleName: roleName,
          Description: `deBug ingest Lambda: writes to the DynamoDB table ${table}`.slice(0, 1000),
          AssumeRolePolicyDocument: JSON.stringify({
            Version: "2012-10-17",
            Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole", Condition: { StringEquals: { "aws:SourceAccount": account } } }],
          }),
          Tags: [{ Key: CREATED_BY, Value: "debugkit" }],
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
  const zip = lambdaZip();
  s.start(`Deploying Lambda ${functionName}`);
  const fn = await lookup(() => lambda.send(new lambdaMod.GetFunctionCommand({ FunctionName: functionName })));
  if (fn) {
    if (fn.Tags?.[CREATED_BY] !== "debugkit") {
      s.error(`Function ${functionName} exists and wasn't created by deBug`);
      bail(`deBug won't overwrite a function it didn't create. Rename ${functionName}, or choose another table name.`);
    }
    // Keep every key the function already accepts: other apps, and builds of this one, use them.
    const keys = mergeKeys(fn.Configuration?.Environment?.Variables?.DEBUG_INGEST_KEYS, ctx.ingestKey, ctx.app.appId);
    await lambda.send(new lambdaMod.UpdateFunctionCodeCommand({ FunctionName: functionName, ZipFile: zip }));
    await waitUpdated(lambda, lambdaMod, functionName);
    await lambda.send(
      new lambdaMod.UpdateFunctionConfigurationCommand({
        FunctionName: functionName,
        Role: roleArn,
        Environment: {
          Variables: { ...fn.Configuration?.Environment?.Variables, DEBUG_TABLE: table, DEBUG_INGEST_KEYS: keys, DEBUG_RETENTION_DAYS: String(ctx.retentionDays), DEBUG_ADMIN_TOKEN: ctx.adminToken },
        },
      }),
    );
  } else {
    const env = { Variables: { DEBUG_TABLE: table, DEBUG_INGEST_KEYS: keyEntry(ctx.ingestKey, ctx.app.appId), DEBUG_RETENTION_DAYS: String(ctx.retentionDays), DEBUG_ADMIN_TOKEN: ctx.adminToken } };
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
            Tags: { [CREATED_BY]: "debugkit" },
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

  const urlCfg = await lookup(() => lambda.send(new lambdaMod.GetFunctionUrlConfigCommand({ FunctionName: functionName })));
  const url = urlCfg?.FunctionUrl ?? (await lambda.send(new lambdaMod.CreateFunctionUrlConfigCommand({ FunctionName: functionName, AuthType: "NONE" }))).FunctionUrl;
  if (!url) throw new Error(`AWS didn't return a URL for ${functionName}.`);
  // A public Function URL needs both permissions. The ingest key checks every request.
  for (const [sid, input] of [
    ["debugkit-public-url", { Action: "lambda:InvokeFunctionUrl", FunctionUrlAuthType: "NONE" }],
    ["debugkit-public-invoke", { Action: "lambda:InvokeFunction", InvokedViaFunctionUrl: true }],
  ] as const) {
    try {
      await lambda.send(new lambdaMod.AddPermissionCommand({ FunctionName: functionName, StatementId: sid, Principal: "*", ...input } as never));
    } catch (err) {
      if ((err as { name?: string }).name !== "ResourceConflictException") p.log.warn(`Couldn't add ${sid}: ${(err as Error).message}`);
    }
  }
  s.stop(`Lambda ${functionName} is live at ${url}`);

  /* ---------- 5. A read-only policy for hosting the dashboard later ---------- */
  let readOnlyPolicyArn: string | undefined = `arn:aws:iam::${account}:policy/debugkit-dashboard-readonly-${table}`.slice(0, 2048);
  try {
    if (!(await lookup(() => iam.send(new iamMod.GetPolicyCommand({ PolicyArn: readOnlyPolicyArn })))))
      await iam.send(
        new iamMod.CreatePolicyCommand({
          PolicyName: `debugkit-dashboard-readonly-${table}`.slice(0, 128),
          PolicyDocument: JSON.stringify({
            Version: "2012-10-17",
            Statement: [{ Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:DescribeTable"], Resource: tableArn }],
          }),
          Description: `Read-only access to the deBug table ${table}, for hosting the dashboard`,
          Tags: [{ Key: CREATED_BY, Value: "debugkit" }],
        }),
      );
  } catch (err) {
    p.log.warn(`Skipped the read-only dashboard policy: ${(err as Error).message}`);
    readOnlyPolicyArn = undefined;
  }

  return {
    config: { provider: "aws", endpoint: url.replace(/\/$/, ""), ingestKey: ctx.ingestKey, aws: { region, profile, table, functionName, roleName, readOnlyPolicyArn, account } },
    dashboardEnv: { DEBUG_STORE: "dynamodb", AWS_REGION: region, DEBUG_DYNAMO_TABLE: table, ...(profile ? { AWS_PROFILE: profile } : {}), ...adminEnv(url, ctx) },
    created: [
      `DynamoDB table ${code(table)} in ${region}${ownTable ? " (on-demand)" : " (your existing table)"}`,
      `Lambda ${code(functionName)} with a public URL: ${code(url)}`,
      `IAM role ${code(roleName)} that can only write to the table`,
      ...(readOnlyPolicyArn ? [`Read-only policy for hosting the dashboard: ${code(readOnlyPolicyArn)}`] : []),
    ],
  };
}

const CREATED_BY = "created-by";

/**
 * Upgrade: new code for the same ingest Lambda, keeping its URL, role, keys and settings. Only a
 * function deBug created is touched.
 */
export async function upgradeAwsIngest(cfg: DebugkitConfig): Promise<void> {
  const aws = cfg.aws ?? bail(`This setup has no AWS function saved. Run ${cmdFor("init")} again.`);
  const { fromNodeProviderChain } = await import("@aws-sdk/credential-providers");
  const lambdaMod = await import("@aws-sdk/client-lambda");
  const lambda = new lambdaMod.LambdaClient({ region: aws.region, credentials: fromNodeProviderChain(aws.profile ? { profile: aws.profile } : {}) });
  const s = p.spinner();
  s.start(`Updating Lambda ${aws.functionName} in ${aws.region}`);
  // A missing or foreign function is checked before anything changes; AWS errors stop with what AWS said.
  const stop = (summary: string, err: unknown): never => {
    s.error(summary);
    const name = (err as { name?: string }).name ?? "";
    const signIn = /Credential|Token|Expired|SSO|UnrecognizedClient/i.test(name + (err as Error).message);
    const sso = aws.profile && awsProfiles().find((x) => x.name === aws.profile)?.sso;
    fail(`${(err as Error).message}${signIn && sso ? `\nSign in again with ${code(`aws sso login --profile ${aws.profile}`)}, then rerun ${code(cmdFor("upgrade"))}.` : ""}`);
  };
  const fn = await lookup(() => lambda.send(new lambdaMod.GetFunctionCommand({ FunctionName: aws.functionName }))).catch((err) => stop(`Couldn't read ${aws.functionName}`, err));
  if (!fn) {
    s.error(`${aws.functionName} isn't in ${aws.region}`);
    fail(`The ingest function is gone. Run ${cmdFor("init")} to set it up again.`);
  }
  if (fn.Tags?.[CREATED_BY] !== "debugkit") {
    s.error(`${aws.functionName} wasn't created by deBug`);
    fail("deBug won't overwrite a function it didn't create.");
  }
  try {
    await lambda.send(new lambdaMod.UpdateFunctionCodeCommand({ FunctionName: aws.functionName, ZipFile: lambdaZip() }));
    await waitUpdated(lambda, lambdaMod, aws.functionName);
  } catch (err) {
    stop(`Couldn't update ${aws.functionName}`, err);
  }
  s.stop(`Lambda ${aws.functionName} runs this version`);
}

/**
 * Run an AWS "describe" call. Returns undefined only when the resource doesn't exist; any other
 * error (access denied, throttling, a wrong region) is thrown so it isn't mistaken for "missing".
 */
export async function lookup<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    const name = (err as { name?: string }).name ?? "";
    if (name === "ResourceNotFoundException" || name === "NoSuchEntityException" || name === "NoSuchEntity") return undefined;
    throw err;
  }
}

async function waitUpdated(lambda: { send(c: unknown): Promise<any> }, mod: typeof import("@aws-sdk/client-lambda"), name: string) {
  for (let i = 0; i < 60; i++) {
    const c = await lambda.send(new mod.GetFunctionConfigurationCommand({ FunctionName: name }));
    if (c.State !== "Pending" && c.LastUpdateStatus !== "InProgress") return;
    await sleep(1500);
  }
}

