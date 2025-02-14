#!/usr/bin/env node
/**
 * index.ts
 *
 * Run MCP stdio servers over SSE or vice versa
 *
 * Usage:
 *   # stdio -> SSE
 *   npx -y supergateway --stdio "npx -y @modelcontextprotocol/server-filesystem /some/folder" \
 *                       --port 8000 --baseUrl http://localhost:8000 --ssePath /sse --messagePath /message
 *
 *   # SSE -> stdio
 *   npx -y supergateway --sse "https://mcp-server.superinterface.app"
 */
// import { instrumentApp } from './instrumentation/index.js' // This will initialize the instrumentation
// instrumentApp().catch(err => {
//   logger.error('Fatal error:', err)
//   process.exit(1)
// })
import { logger } from './logger/index.js'
import express from 'express'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import { readFileSync } from 'fs'
import { WebSocketServerTransport } from './server/websocket-transport.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function getVersion(): string {
  try {
    const packageJsonPath = join(__dirname, '../package.json')
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
    return packageJson.version || '1.0.0'
  } catch (err) {
    logger.error('Unable to retrieve version:', err)
    return 'unknown'
  }
}

const stdioToWebSocket = async (
  stdioCmd: string,
  port: number,
) => {
  logger.info('Starting...')
  logger.info(`  - port: ${port}`)
  logger.info(`  - stdio: ${stdioCmd}`)

  let wsTransport: WebSocketServerTransport | null = null
  let child: ChildProcessWithoutNullStreams | null = null

  // Cleanup function
  const cleanup = () => {
    if (wsTransport) {
      wsTransport.close().catch(err => {
        logger.error('Error stopping WebSocket server:', err)
      })
    }
    if (child) {
      child.kill()
    }
  }

  // Handle process termination
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  try {
    child = spawn(stdioCmd, { shell: true })
    child.on('exit', (code, signal) => {
      logger.error(`Child exited: code=${code}, signal=${signal}`)
      cleanup()
      process.exit(code ?? 1)
    })

    const server = new Server(
      { name: 'supergateway', version: getVersion() },
      { capabilities: {} }
    )

    // Create and start WebSocket server
    wsTransport = new WebSocketServerTransport(port)
    await wsTransport.start()
    await server.connect(wsTransport)

    wsTransport.onmessage = (msg: JSONRPCMessage) => {
      const line = JSON.stringify(msg)
      logger.info(`WebSocket → Child: ${line}`)
      child!.stdin.write(line + '\n')
    }

    wsTransport.onclose = () => {
      logger.info('WebSocket connection closed')
    }

    wsTransport.onerror = err => {
      logger.error('WebSocket error:', err)
    }

    // Handle child process output
    let buffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      lines.forEach(line => {
        if (!line.trim()) return
        try {
          const jsonMsg = JSON.parse(line)
          logger.info('Child → WebSocket:', jsonMsg)
          wsTransport?.send(jsonMsg).catch(err => {
            logger.error('Failed to send message:', err)
          })
        } catch {
          logger.error(`Child non-JSON: ${line}`)
        }
      })
    })

    child.stderr.on('data', (chunk: Buffer) => {
      logger.info(`Child stderr: ${chunk.toString('utf8')}`)
    })

    // Simple health check endpoint
    const app = express()
    app.get("/health", (req, res) => {
      res.send("OK")
    })

    app.listen(port + 1, () => {
      logger.info(`Health check endpoint listening on port ${port + 1}`)
      logger.info(`WebSocket endpoint: ws://localhost:${port}`)
    })
  } catch (err: any) {
    logger.error(`Failed to start: ${err.message}`)
    cleanup()
    process.exit(1)
  }
}

const main = async () => {
  const argv = yargs(hideBin(process.argv))
    .option('stdio', {
      type: 'string',
      description: 'Command to run an MCP server over Stdio'
    })
    .option('port', {
      type: 'number',
      default: 8000,
      description: 'Port to run WebSocket server on'
    })
    .help()
    .parseSync()
  
  const port = parseInt(process.env.PORT ?? argv.port?.toString() ?? '8000', 10)
  await stdioToWebSocket(argv.stdio!, port)
}

main().catch(err => {
  logger.error('Fatal error:', err)
  process.exit(1)
})
