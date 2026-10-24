import assert from 'node:assert/strict';
import test from 'node:test';
import { stableLambdaConfiguration } from './lambda-configuration.mjs';
import { contentHash } from './vendor/json-contract.mjs';

const CONFIGURATION = Object.freeze({
  FunctionName: 'beta-anywear-pre-sign-up',
  FunctionArn: 'arn:aws:lambda:ap-east-1:650880818323:function:beta-anywear-pre-sign-up',
  Runtime: 'nodejs24.x',
  Handler: 'index.handler',
  Role: 'arn:aws:iam::650880818323:role/beta-anywear-pre-sign-up',
  MemorySize: 512,
  Timeout: 30,
  Architectures: ['arm64'],
  Environment: { Variables: { B_VAR: 'b', A_VAR: 'a' } },
  Layers: [
    { Arn: 'arn:aws:lambda:ap-east-1:650880818323:layer:two', CodeSize: 2 },
    { Arn: 'arn:aws:lambda:ap-east-1:650880818323:layer:one', CodeSize: 1 },
  ],
  VpcConfig: {
    SubnetIds: ['subnet-b', 'subnet-a'],
    SecurityGroupIds: ['sg-b', 'sg-a'],
    Ipv6AllowedForDualStack: true,
    VpcId: 'vpc-1',
  },
  EphemeralStorage: { Size: 1024 },
  LoggingConfig: { LogFormat: 'JSON' },
  KMSKeyArn: 'arn:aws:kms:ap-east-1:650880818323:key/example',
  RevisionId: 'revision-1',
  LastModified: '2026-10-24T00:00:00.000+0000',
  CodeSha256: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  State: 'Active',
});

test('the stable projection keeps the reviewed runtime identity and drops AWS-managed fields', () => {
  assert.deepEqual(stableLambdaConfiguration(CONFIGURATION), {
    FunctionName: 'beta-anywear-pre-sign-up',
    Runtime: 'nodejs24.x',
    Handler: 'index.handler',
    Role: 'arn:aws:iam::650880818323:role/beta-anywear-pre-sign-up',
    MemorySize: 512,
    Timeout: 30,
    Architectures: ['arm64'],
    Environment: { Variables: { B_VAR: 'b', A_VAR: 'a' } },
    Layers: [
      'arn:aws:lambda:ap-east-1:650880818323:layer:two',
      'arn:aws:lambda:ap-east-1:650880818323:layer:one',
    ],
    VpcConfig: {
      SubnetIds: ['subnet-a', 'subnet-b'],
      SecurityGroupIds: ['sg-a', 'sg-b'],
      Ipv6AllowedForDualStack: true,
    },
    EphemeralStorage: { Size: 1024 },
    LoggingConfig: { LogFormat: 'JSON' },
    KMSKeyArn: 'arn:aws:kms:ap-east-1:650880818323:key/example',
  });
});

// The projection exists to hash a deployment's own configuration: a field AWS
// updates on every side effect must not change the recorded identity.
test('AWS-managed fields do not change the configuration hash', () => {
  const baseline = contentHash(stableLambdaConfiguration(CONFIGURATION));
  assert.equal(contentHash(stableLambdaConfiguration({ ...CONFIGURATION, RevisionId: 'revision-2' })), baseline);
  const withoutManaged = { ...CONFIGURATION };
  delete withoutManaged.RevisionId;
  delete withoutManaged.LastModified;
  delete withoutManaged.CodeSha256;
  delete withoutManaged.State;
  delete withoutManaged.FunctionArn;
  assert.equal(contentHash(stableLambdaConfiguration(withoutManaged)), baseline);
});

test('an unavailable Lambda environment is refused instead of being recorded as empty', () => {
  for (const environment of [{ Error: { ErrorCode: 'AccessDeniedException' } }, {}, { Variables: 'not-a-map' }]) {
    assert.throws(() => stableLambdaConfiguration({ ...CONFIGURATION, Environment: environment }),
      /Lambda environment observation unavailable/);
  }
});

test('an absent optional projection member stays absent', () => {
  const minimal = {
    FunctionName: 'beta-anywear-post-confirmation-sync',
    Runtime: 'nodejs24.x',
    Handler: 'index.handler',
    Role: 'arn:aws:iam::650880818323:role/beta-anywear-post-confirmation-sync',
    MemorySize: 512,
    Timeout: 30,
    Architectures: ['arm64'],
  };
  assert.deepEqual(stableLambdaConfiguration(minimal), minimal);
  const noDualStack = stableLambdaConfiguration({
    ...CONFIGURATION,
    VpcConfig: { SubnetIds: ['subnet-b', 'subnet-a'], SecurityGroupIds: ['sg-b', 'sg-a'] },
  });
  assert.equal(Object.hasOwn(noDualStack.VpcConfig, 'Ipv6AllowedForDualStack'), false);
});

test('a configuration missing a required stable field is refused by name', () => {
  for (const field of ['FunctionName', 'Runtime', 'Handler', 'Role', 'MemorySize', 'Timeout', 'Architectures']) {
    const incomplete = { ...CONFIGURATION };
    delete incomplete[field];
    assert.throws(() => stableLambdaConfiguration(incomplete), new RegExp(`Missing Lambda stable field ${field}`));
  }
});
