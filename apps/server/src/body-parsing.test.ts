import { afterEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";

async function createTaskId(server: TestServer): Promise<string> {
  const res = await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: { project_id: "proj_artoo", title: "body task", acceptance_criteria: ["x"] },
  });
  return res.json().task.id as string;
}

describe("JSON body parsing", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("tolerates an empty JSON body on a no-body POST (no 500)", async () => {
    server = await buildTestServer();
    const taskId = await createTaskId(server);
    const ready = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/ready`,
      headers: { "content-type": "application/json" },
    });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().task.status).toBe("ready");
  });

  it("returns 400 (not 500) for malformed JSON", async () => {
    server = await buildTestServer();
    const taskId = await createTaskId(server);
    const res = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/assign`,
      headers: { "content-type": "application/json" },
      payload: "{not valid json",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });
});
