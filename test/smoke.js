/**
 * Smoke test: starts the server over stdio and exercises the read-only tools.
 * Run with `npm test`. Needs a local Bambu Studio / OrcaSlicer install.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["src/server.js"],
});

const client = new Client({ name: "smoke", version: "0" }, { capabilities: {} });

function textOf(result) {
  return result?.content?.map((c) => c.text ?? "").join("\n") ?? "";
}

try {
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log("tools:", tools.map((t) => t.name).join(", "));

  const detect = await client.callTool({ name: "detect_slicer", arguments: {} });
  console.log("\n--- detect_slicer ---\n" + textOf(detect));

  const presets = await client.callTool({
    name: "list_presets",
    arguments: { kind: "process", query: "0.28", limit: 5 },
  });
  console.log("\n--- list_presets(process, 0.28) ---\n" + textOf(presets));

  const flat = await client.callTool({
    name: "flatten_preset",
    arguments: { name: "0.28mm Extra Draft @BBL X1C", kind: "process", only_keys: false },
  });
  console.log("\n--- flatten_preset ---");
  if (flat.isError) {
    console.log(textOf(flat));
  } else {
    const parsed = JSON.parse(textOf(flat));
    console.log("chain:", parsed.chain);
    console.log("keys:", parsed.keyCount, "| layer_height:", parsed.config?.layer_height);
  }

  if (detect.isError) {
    console.error("\nFAIL: slicer not detected");
    process.exitCode = 1;
  }
} catch (err) {
  console.error("smoke test failed:", err);
  process.exitCode = 1;
} finally {
  await client.close();
}
