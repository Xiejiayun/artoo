import { readFileSync } from "node:fs";
import { TextDecoder } from "node:util";
import { ApplicationBrokerConfigurationSchema, ApplicationBrokerControl, APPLICATION_BROKER_LIMITS as limits } from "./application-broker-control.js";

// Dedicated trusted child entry. No product modules, network listeners, dynamic
// imports, process execution or environment-selected plugins are loaded here.
async function main(): Promise<void> {
  if (process.argv.length !== 4 || process.argv[2] !== "--application-broker-v1"
    || Object.keys(process.env).some(key => /^(NODE_OPTIONS|NODE_PATH)$/iu.test(key))) throw Error("configuration");
  const configBytes = readFileSync(process.argv[3]!);
  if (configBytes.length > 65_536) throw Error("configuration");
  const configuration = ApplicationBrokerConfigurationSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(configBytes)));
  const control = new ApplicationBrokerControl(configuration);
  let retained = Buffer.alloc(0), inputBytes = 0, outputBytes = 0, stopped = false;
  const send = async (value: unknown) => {
    const output = Buffer.from(JSON.stringify(value) + "\n"); outputBytes += output.length;
    if (output.length > limits.lineBytes || outputBytes > limits.totalOutputBytes) throw Error("output-limit");
    await new Promise<void>((resolve, reject) => process.stdout.write(output, error => error ? reject(error) : resolve()));
  };
  try {
    await send({ version: 1, kind: "ready", protocol: "artoo.application-broker.v1", maximumAccess: configuration.maximumAccess });
    for await (const input of process.stdin) {
      const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
      inputBytes += bytes.length;
      if (inputBytes > limits.totalInputBytes || retained.length + bytes.length > limits.lineBytes + 65_536) throw Error("input-limit");
      retained = Buffer.concat([retained, bytes]);
      for (let end; (end = retained.indexOf(10)) >= 0;) {
        if (end > limits.lineBytes) throw Error("line-limit");
        const line = retained.subarray(0, end); retained = retained.subarray(end + 1);
        const reply = control.accept(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)));
        if (reply.stopped && retained.length) throw Error("input-after-shutdown");
        await send(reply);
        if (reply.stopped) { stopped = true; break; }
      }
      if (stopped) break;
      if (retained.length > limits.lineBytes) throw Error("line-limit");
    }
    if (!stopped || retained.length) throw Error("unexpected-eof");
  } finally { control.dispose(); }
}

try { await main(); }
catch {
  // Never emit paths, SQL, request data, stack traces or arbitrary errors to control output.
  process.stderr.write("application_broker_failed\n"); process.exitCode = 1;
  process.stdin.destroy();
}
