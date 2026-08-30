#!/usr/bin/env node

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FeatureConfig } from './config-loader.js';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { validateTransportAuthConfig } from './auth/startup-validation.js';
import { resolveRuntimeConfig } from './config-loader.js';
import { startServer } from './server-utils.js';
import { BraveMcpServer, createBraveMcpRuntimeState } from './server.js';

interface CliOptions {
  checkConfigPath?: string;
  isHttp: boolean;
  isUI: boolean;
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  const checkConfigIndex = argv.indexOf('--check-config');
  let checkConfigPath: string | undefined;

  if (checkConfigIndex !== -1) {
    checkConfigPath = argv[checkConfigIndex + 1];
    if (!checkConfigPath || checkConfigPath.startsWith('--'))
      throw new Error('Error: --check-config requires a file path');
  }

  return {
    checkConfigPath,
    isHttp: argv.includes('--http'),
    isUI: argv.includes('--ui'),
  };
}

function createServerFactory(apiKey: string, isUI: boolean, featureConfig: FeatureConfig): () => McpServer {
  const runtimeState = createBraveMcpRuntimeState();
  return () => {
    try {
      return new BraveMcpServer(apiKey, isUI, undefined, featureConfig, runtimeState).serverInstance;
    }
    catch (error) {
      console.error(`Error: Failed to start server: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
      return undefined as never;
    }
  };
}

function resolveBraveApiKey(env: NodeJS.ProcessEnv): string | undefined {
  const apiKeyFile = env.BRAVE_API_KEY_FILE?.trim();
  if (!apiKeyFile)
    return env.BRAVE_API_KEY;

  const apiKey = readFileSync(apiKeyFile, 'utf8').trim();
  if (!apiKey)
    throw new Error(`BRAVE_API_KEY_FILE is empty: ${apiKeyFile}`);
  return apiKey;
}

async function main(): Promise<void> {
  const cliOptions = parseCliOptions(process.argv.slice(2));
  const runtimeConfig = resolveRuntimeConfig({
    env: process.env,
    explicitConfigPath: cliOptions.checkConfigPath,
    warn: message => console.warn(message),
  });

  if (cliOptions.checkConfigPath) {
    console.log(JSON.stringify(runtimeConfig.maskedForDisplay, null, 2));
    return;
  }

  const braveApiKey = resolveBraveApiKey(process.env);
  if (!braveApiKey) {
    console.error('Error: BRAVE_API_KEY or BRAVE_API_KEY_FILE is required');
    process.exit(1);
    return;
  }

  if (runtimeConfig.mode === 'file' && runtimeConfig.configPath)
    console.error(`Loaded config file: ${runtimeConfig.configPath}`);

  validateTransportAuthConfig(
    runtimeConfig.featureConfig.auth,
    cliOptions.isHttp,
    message => console.warn(message),
  );

  await startServer(
    createServerFactory(braveApiKey, cliOptions.isUI, runtimeConfig.featureConfig),
    cliOptions.isHttp,
    {
      allowedHosts: runtimeConfig.featureConfig.server.allowedHosts,
      corsOrigins: runtimeConfig.featureConfig.server.corsOrigins,
      auth: runtimeConfig.featureConfig.auth,
      enableSessionCorrelation: runtimeConfig.featureConfig.audit.enabled,
    },
  );
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : `Failed to start MCP server: ${String(error)}`,
  );
  process.exit(1);
});
