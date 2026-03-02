import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { IncomingMessage, ServerResponse } from "http";
import { registerTools } from "../src/tools.js";

// Let Vercel parse the JSON body — passed directly to the transport as parsedBody,
// bypassing the @hono/node-server bridge that causes timeouts in serverless environments.
export const config = {
  api: { bodyParser: true },
};

export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse
): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, MCP-Protocol-Version"
  );

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed. Use POST." }));
    return;
  }

  // Build a Web Standard Request — body will be supplied via parsedBody so
  // we don't need to pipe the Node.js stream through the Hono bridge.
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v != null) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  const webRequest = new Request(
    `https://fema-nfhl-mcp.vercel.app${req.url ?? "/api/mcp"}`,
    { method: "POST", headers }
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — new instance per request
    enableJsonResponse: true,      // return JSON instead of an open SSE stream
  });

  const server = new McpServer({ name: "fema-nfhl", version: "1.0.0" });
  registerTools(server);
  await server.connect(transport);

  // Pass the pre-parsed body so the transport doesn't try to read the stream
  const webResponse = await transport.handleRequest(webRequest, {
    parsedBody: req.body,
  });

  await server.close();

  // Convert the Web Standard Response back to a Node.js response
  res.writeHead(
    webResponse.status,
    Object.fromEntries(webResponse.headers.entries())
  );
  res.end(await webResponse.text());
}
