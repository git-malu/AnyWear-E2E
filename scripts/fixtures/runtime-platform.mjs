export function platformOutputs(stack) {
  return { EcsClusterName: stack.cluster, WardrobeBucketName: stack.bucket, UserPoolId: stack.userPoolId,
    OneShotExecutionRoleArn: stack.oneShotExecutionRoleArn, VerificationTaskRoleArn: stack.verificationTaskRoleArn,
    LifecycleTaskRoleArn: stack.lifecycleTaskRoleArn, ServiceRepositoryUri: '650880818323.dkr.ecr.ap-east-1.amazonaws.com/anywear',
    OneShotLogGroupName: '/anywear/beta/one-shot', DatabaseSecretArn: 'arn:aws:secretsmanager:ap-east-1:650880818323:secret:mocked-db',
    DatabaseHost: 'mocked-db.example', DatabasePort: '5432', DatabaseName: 'anywear', VtoQueueUrl: stack.queues?.vto ?? 'https://sqs.example/vto',
    AutoTaggingQueueUrl: stack.queues?.autoTagging ?? 'https://sqs.example/autoTagging',
    VtoDlqUrl: stack.queues?.vtoDlq ?? 'https://sqs.example/vtoDlq', AutoTaggingDlqUrl: stack.queues?.autoTaggingDlq ?? 'https://sqs.example/autoTaggingDlq' };
}

export function completeOneShotDefinition(definition, stack) {
  const outputs = platformOutputs(stack);
  const container = definition.containerDefinitions[0];
  Object.assign(definition, { networkMode: 'awsvpc', requiresCompatibilities: ['FARGATE'], cpu: '512', memory: '1024' });
  container.essential = true;
  container.environment.push(...Object.entries({ DB_SECRET_ARN: outputs.DatabaseSecretArn, DB_HOST: outputs.DatabaseHost,
    DB_PORT: outputs.DatabasePort, DB_NAME: outputs.DatabaseName, SQS_VTO_QUEUE_URL: outputs.VtoQueueUrl,
    SQS_AUTO_TAGGING_QUEUE_URL: outputs.AutoTaggingQueueUrl,
    ...(!definition.family.endsWith('task-audit') ? { SQS_VTO_DLQ_URL: outputs.VtoDlqUrl, SQS_AUTO_TAGGING_DLQ_URL: outputs.AutoTaggingDlqUrl } : {}) })
    .map(([name, value]) => ({ name, value })));
  container.logConfiguration = { logDriver: 'awslogs', options: { 'awslogs-group': outputs.OneShotLogGroupName,
    'awslogs-region': 'ap-east-1', 'awslogs-stream-prefix': definition.family } };
  return definition;
}
