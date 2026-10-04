import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';

try {
  const server = createServer(loadConfig());
  const close = async () => { await server.close(); process.exit(0); };
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
  await server.connect(new StdioServerTransport());
} catch {
  process.stderr.write('n8n-workflow-builder failed to start. Check environment configuration and README.\n');
  process.exitCode = 1;
}
