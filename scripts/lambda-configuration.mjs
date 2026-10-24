// Stable projection of a deployed Lambda's configuration.
//
// The authenticated platform observation records this projection, not the raw
// `lambda get-function` body: only the fields that define the function's runtime
// identity are kept, so an AWS-managed field such as `RevisionId` or
// `LastModified` changing cannot make two observations of one deployment differ.
// E2E owns this module because #191 re-sourced the vendored Infra contract and the
// producer no longer exports it; the function body is unchanged from the vendored
// copy it replaces.
export function stableLambdaConfiguration(config) {
  const mapping = ['FunctionName', 'Runtime', 'Handler', 'Role', 'MemorySize', 'Timeout', 'Architectures', 'Environment',
    'Layers', 'VpcConfig', 'EphemeralStorage', 'LoggingConfig', 'KMSKeyArn'];
  const out = {};
  for (const key of mapping) if (config[key] !== undefined) out[key] = config[key];
  if (out.Environment) {
    if (out.Environment.Error || !out.Environment.Variables || typeof out.Environment.Variables !== 'object') throw new Error('Lambda environment observation unavailable');
    out.Environment = { Variables: out.Environment.Variables };
  }
  if (out.Layers) out.Layers = out.Layers.map(layer => layer.Arn);
  if (out.VpcConfig) out.VpcConfig = {
    SubnetIds: [...out.VpcConfig.SubnetIds].sort(), SecurityGroupIds: [...out.VpcConfig.SecurityGroupIds].sort(),
    ...(out.VpcConfig.Ipv6AllowedForDualStack !== undefined ? { Ipv6AllowedForDualStack: out.VpcConfig.Ipv6AllowedForDualStack } : {}),
  };
  for (const required of ['FunctionName', 'Runtime', 'Handler', 'Role', 'MemorySize', 'Timeout', 'Architectures']) {
    if (out[required] === undefined) throw new Error(`Missing Lambda stable field ${required}`);
  }
  return out;
}
