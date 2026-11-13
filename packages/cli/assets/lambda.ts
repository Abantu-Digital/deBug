// Deployed by `npx debugkit init` (AWS) as the ingest Lambda behind a Function URL.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoStore } from "@debugkit/adapters/dynamodb";
import { parseIngestKeys } from "@debugkit/ingest";
import { lambdaHandler } from "@debugkit/ingest/lambda";

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

export const handler = lambdaHandler({
  store: new DynamoStore(doc, { table: process.env.DEBUG_TABLE ?? "debugkit" }),
  keys: parseIngestKeys(process.env.DEBUG_INGEST_KEYS),
});
