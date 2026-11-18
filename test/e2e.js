/**
 * End-to-end test: build + slice the same model for several values of one
 * parameter and print the comparison table. Slow by design (it really slices).
 *
 *   node test/e2e.js <model.stl|model.3mf> [param] [v1,v2,...]
 *
 * Example:
 *   node test/e2e.js ./benchy.stl support_threshold_angle 25,30
 */
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const model = process.argv[2];
if (!model) {
  console.error("usage: node test/e2e.js <model.stl|model.3mf> [param] [v1,v2,...]");
  process.exit(2);
}
const param = process.argv[3] || "support_threshold_angle";
const values = (process.argv[4] || "25,30").split(",").map((v) => v.trim());

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["src/server.js"],
});
const client = new Client({ name: "e2e", version: "0" }, { capabilities: {} });

try {
  await client.connect(transport);

  const result = await client.callTool(
    {
      name: "optimize",
      arguments: {
        input: path.resolve(model),
        sweep_param: param,
        values,
        machine: "Bambu Lab X1 Carbon 0.4 nozzle",
        process: "0.28mm Extra Draft @BBL X1C",
        filament: "Bambu PLA Basic @BBL X1C",
        base_overrides: { enable_support: "1", support_type: "tree(auto)" },
        timeout_seconds: 1200,
      },
    },
    undefined,
    { timeout: 60 * 60 * 1000 },
  );

  const text = result.content.map((c) => c.text ?? "").join("\n");
  if (result.isError) {
    console.error("ERROR:\n" + text);
    process.exitCode = 1;
  } else {
    const parsed = JSON.parse(text);
    console.log(parsed.table);
    console.log("\nbest:", JSON.stringify(parsed.best, null, 2));
  }
} catch (err) {
  console.error("e2e failed:", err);
  process.exitCode = 1;
} finally {
  await client.close();
}
