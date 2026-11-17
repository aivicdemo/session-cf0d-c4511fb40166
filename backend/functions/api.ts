import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  DynamoDBClient,
  BatchWriteItemCommand,
  BatchWriteItemCommandInput,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  ScanCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { extractRBACContext, checkPermission, RBACContext } from './rbac';

const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-1' });
const docClient = DynamoDBDocumentClient.from(client);
const tableName = process.env.MAIN_TABLE || 'repair-management';

interface AuditLog {
  pk: string;
  sk: string;
  action: string;
  userId: string;
  loginId: string;
  timestamp: number;
  details: Record<string, unknown>;
}

async function createAuditLog(
  action: string,
  context: RBACContext,
  details: Record<string, unknown>
): Promise<void> {
  const auditLog: AuditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}#${randomUUID()}`,
    action,
    userId: context.userId,
    loginId: context.loginId,
    timestamp: Date.now(),
    details,
  };
  await docClient.send(new PutCommand({ TableName: tableName, Item: auditLog }));
}

function errorResponse(statusCode: number, message: string): APIGatewayProxyResult {
  return {
    statusCode,
    body: JSON.stringify({ error: message }),
    headers: { 'Content-Type': 'application/json' },
  };
}

function successResponse(statusCode: number, data: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    body: JSON.stringify(data),
    headers: { 'Content-Type': 'application/json' },
  };
}

async function handleGetResources(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const context = extractRBACContext(event);
  if (!context || !checkPermission(context, 'canViewRepairRequest')) {
    return errorResponse(403, 'Forbidden');
  }

  try {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: 'attribute_exists(#pk) AND #pk <> :auditPk',
        ExpressionAttributeNames: { '#pk': 'pk' },
        ExpressionAttributeValues: { ':auditPk': 'AUDIT' },
      })
    );

    return successResponse(200, {
      items: result.Items || [],
      count: result.Count || 0,
    });
  } catch (error) {
    console.error('Error fetching resources:', error);
    return errorResponse(500, 'Internal Server Error');
  }
}

async function handleBulkImport(
  event: APIGatewayProxyEvent,
  tableIndex: string
): Promise<APIGatewayProxyResult> {
  const context = extractRBACContext(event);
  if (!context || !checkPermission(context, 'canBulkImport')) {
    return errorResponse(403, 'Forbidden: Bulk import not allowed for this role');
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const items = body.items || [];

    if (!Array.isArray(items) || items.length === 0) {
      return errorResponse(400, 'Invalid request: items must be a non-empty array');
    }

    const now = Date.now();
    const enrichedItems = items.map((item: Record<string, unknown>) => ({
      ...item,
      id: item.id || randomUUID(),
      createdAt: item.createdAt || now,
      updatedAt: item.updatedAt || now,
      pk: item.pk || `${tableIndex}#${item.id || randomUUID()}`,
      sk: item.sk || `${now}`,
    }));

    const chunks: Record<string, unknown>[][] = [];
    for (let i = 0; i < enrichedItems.length; i += 25) {
      chunks.push(enrichedItems.slice(i, i + 25));
    }

    let imported = 0;
    const errors: string[] = [];

    for (const chunk of chunks) {
      const writeRequests = chunk.map((item) => ({
        PutRequest: {
          Item: item,
        },
      }));

      const params: BatchWriteItemCommandInput = {
        RequestItems: {
          [tableName]: writeRequests,
        },
      };

      try {
        await client.send(new BatchWriteItemCommand(params));
        imported += chunk.length;
      } catch (chunkError) {
        const errorMsg = chunkError instanceof Error ? chunkError.message : 'Unknown error';
        errors.push(`Batch write failed: ${errorMsg}`);
      }
    }

    await createAuditLog('BULK_IMPORT', context, {
      tableIndex,
      itemCount: items.length,
      imported,
      failed: items.length - imported,
    });

    return successResponse(200, {
      imported,
      failed: items.length - imported,
      errors,
    });
  } catch (error) {
    console.error('Error in bulk import:', error);
    return errorResponse(500, 'Internal Server Error');
  }
}

async function handleGetResourceById(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const context = extractRBACContext(event);
  if (!context || !checkPermission(context, 'canViewRepairRequest')) {
    return errorResponse(403, 'Forbidden');
  }

  const id = event.pathParameters?.id;
  if (!id) {
    return errorResponse(400, 'Missing id parameter');
  }

  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: id, sk: id },
      })
    );

    if (!result.Item) {
      return errorResponse(404, 'Resource not found');
    }

    return successResponse(200, result.Item);
  } catch (error) {
    console.error('Error fetching resource:', error);
    return errorResponse(500, 'Internal Server Error');
  }
}

async function handleCreateResource(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const context = extractRBACContext(event);
  if (!context || !checkPermission(context, 'canCreateRepairRequest')) {
    return errorResponse(403, 'Forbidden');
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const id = randomUUID();
    const now = Date.now();

    const item = {
      ...body,
      pk: id,
      sk: id,
      id,
      createdAt: now,
      updatedAt: now,
      createdBy: context.userId,
    };

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
      })
    );

    await createAuditLog('CREATE_RESOURCE', context, { id, itemType: body.type });

    return successResponse(201, item);
  } catch (error) {
    console.error('Error creating resource:', error);
    return errorResponse(500, 'Internal Server Error');
  }
}

async function handleUpdateResource(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const context = extractRBACContext(event);
  if (!context || !checkPermission(context, 'canUpdateRepairRequest')) {
    return errorResponse(403, 'Forbidden');
  }

  const id = event.pathParameters?.id;
  if (!id) {
    return errorResponse(400, 'Missing id parameter');
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const now = Date.now();

    const updateExpressionParts: string[] = [];
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, unknown> = {};

    Object.entries(body).forEach(([key, value], index) => {
      if (key !== 'pk' && key !== 'sk' && key !== 'id' && key !== 'createdAt') {
        const attrName = `#attr${index}`;
        const attrValue = `:val${index}`;
        updateExpressionParts.push(`${attrName} = ${attrValue}`);
        expressionAttributeNames[attrName] = key;
        expressionAttributeValues[attrValue] = value;
      }
    });

    updateExpressionParts.push('#updatedAt = :updatedAt');
    expressionAttributeNames['#updatedAt'] = 'updatedAt';
    expressionAttributeValues[':updatedAt'] = now;

    const updateExpression = `SET ${updateExpressionParts.join(', ')}`;

    const result = await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk: id, sk: id },
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW',
      })
    );

    await createAuditLog('UPDATE_RESOURCE', context, { id, changes: body });

    return successResponse(200, result.Attributes);
  } catch (error) {
    console.error('Error updating resource:', error);
    return errorResponse(500, 'Internal Server Error');
  }
}

async function handleDeleteResource(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const context = extractRBACContext(event);
  if (!context || !checkPermission(context, 'canDeleteRepairRequest')) {
    return errorResponse(403, 'Forbidden');
  }

  const id = event.pathParameters?.id;
  if (!id) {
    return errorResponse(400, 'Missing id parameter');
  }

  try {
    await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: { pk: id, sk: id },
      })
    );

    await createAuditLog('DELETE_RESOURCE', context, { id });

    return successResponse(204, null);
  } catch (error) {
    console.error('Error deleting resource:', error);
    return errorResponse(500, 'Internal Server Error');
  }
}

async function handleQueryByStatus(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const context = extractRBACContext(event);
  if (!context || !checkPermission(context, 'canViewRepairRequest')) {
    return errorResponse(403, 'Forbidden');
  }

  const status = event.queryStringParameters?.status;
  if (!status) {
    return errorResponse(400, 'Missing status parameter');
  }

  try {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: '#status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': status },
      })
    );

    return successResponse(200, {
      items: result.Items || [],
      count: result.Count || 0,
    });
  } catch (error) {
    console.error('Error querying by status:', error);
    return errorResponse(500, 'Internal Server Error');
  }
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const httpMethod = event.httpMethod;
  const path = event.path;

  console.log(`${httpMethod} ${path}`);

  if (httpMethod === 'GET' && path === '/resources') {
    return handleGetResources(event);
  }

  if (httpMethod === 'GET' && path.match(/^\/resources\/[^/]+$/)) {
    return handleGetResourceById(event);
  }

  if (httpMethod === 'GET' && path === '/resources' && event.queryStringParameters?.status) {
    return handleQueryByStatus(event);
  }

  if (httpMethod === 'POST' && path.match(/^\/api\/[^/]+\/bulk$/)) {
    const tableIndex = path.split('/')[2];
    return handleBulkImport(event, tableIndex);
  }

  if (httpMethod === 'POST' && path === '/resources') {
    return handleCreateResource(event);
  }

  if (httpMethod === 'PUT' && path.match(/^\/resources\/[^/]+$/)) {
    return handleUpdateResource(event);
  }

  if (httpMethod === 'DELETE' && path.match(/^\/resources\/[^/]+$/)) {
    return handleDeleteResource(event);
  }

  return errorResponse(404, 'Not Found');
}