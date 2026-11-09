import { createHash } from "node:crypto";
import { request } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { ApplicationPublicationHealthV1Schema, type ApplicationPublicationHealthV1 } from "@artoo/domain";
import { readApplicationPublicationExecution, type PreparedApplicationPublicationExecution } from "./application-publication-acceptance.js";
import { readApplicationPublicationProfile } from "./application-publication-profile.js";
import type { ApplicationPublicationService } from "./application-publication-process.js";

const sha = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** Fixed local HTTP observer. No redirects, pool, proxy, cookies, credentials,
 * mutation, browser code or product-selected health URL is involved. Completion
 * waits for both response end and the original request's actual close event. */
async function read(origin: string, path: string, maximumBytes: number, probe: ApplicationPublicationService["probe"],
  deadline: number, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  if (performance.now() >= deadline) throw Error("Application publication health deadline elapsed");
  const url = new URL(path, origin);
  if (url.origin !== origin || url.pathname + url.search !== path || url.hash) throw Error("Application publication health path changed origin");
  return new Promise((resolve, reject) => {
    let response: Buffer | undefined, failure: Error | undefined, ended = false, size = 0;
    const chunks: Buffer[] = [];
    const original = request(url, { method: "GET", agent: false, headers: { origin, connection: "close", ...probe.requestHeaders } });
    const fail = (error: unknown) => {
      failure ??= error instanceof Error ? error : Error("Application publication health transport failed");
      original.destroy(failure);
    };
    const abort = () => fail(Error("Application publication health cancelled"));
    const timer = setTimeout(() => fail(Error("Application publication health deadline elapsed")), Math.max(1, deadline - performance.now()));
    original.on("error", error => { failure ??= error; });
    original.on("response", incoming => {
      incoming.on("error", fail);
      incoming.on("aborted", () => fail(Error("Application publication health response aborted")));
      incoming.on("data", (value: Buffer) => {
        size += value.length;
        if (size > maximumBytes) fail(Error("Application publication health response exceeds its fixed bound"));
        else chunks.push(Buffer.from(value));
      });
      incoming.on("end", () => {
        try {
          if (incoming.statusCode !== 200 || !incoming.complete || incoming.rawTrailers.length
            || incoming.headers["content-encoding"] !== undefined) throw Error("Application publication health response framing differs");
          for (const [name, expected] of Object.entries(probe.responseHeaders)) {
            let count = 0;
            for (let index = 0; index < incoming.rawHeaders.length; index += 2)
              if (incoming.rawHeaders[index]!.toLowerCase() === name) count++;
            if (count !== 1 || incoming.headers[name] !== expected) throw Error("Application publication health responder identity differs");
          }
          const bytes = Buffer.concat(chunks, size);
          if (path !== "/") {
            if (!/^application\/json(?:\s*;|$)/iu.test(String(incoming.headers["content-type"]))) throw Error("Application publication persistence read is not JSON");
            const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            JSON.parse(text, (_key, value: unknown) => {
              if (typeof value === "number" && !Number.isFinite(value)) throw Error("Nonfinite application publication response");
              return value;
            });
          }
          response = bytes; ended = true;
        } catch (error) { fail(error); }
      });
    });
    original.once("close", () => {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (failure || !ended || !response) reject(failure ?? Error("Application publication health closed before its response ended"));
      else resolve(response);
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    original.end();
  });
}

/** Readiness observes the published store. Business criteria were verified on
 * separate author/reviewer stores; never replay their writes or expected fixture
 * contents against the user's new deployment. */
export async function inspectApplicationPublicationHealth(execution: PreparedApplicationPublicationExecution,
  service: ApplicationPublicationService, input: { deadline: number; signal: AbortSignal; clientEntryDigest: string }): Promise<ApplicationPublicationHealthV1> {
  const started = performance.now(), signal = input.signal;
  // Restrictive owner control uses the captured original pipe. A full profile
  // read here would race business writes before the host's settlement proof.
  signal.throwIfAborted(); await service.quiesce(); signal.throwIfAborted();
  const current = () => {
    signal.throwIfAborted();
    if (performance.now() >= deadline) throw Error("Application publication health deadline elapsed");
    const original = readApplicationPublicationExecution(execution);
    if (original !== saved) throw Error("Application publication health original execution changed");
    const profile = readApplicationPublicationProfile(saved.publicationProfile);
    if (service.origin !== profile.config.origin || service.identity.origin !== profile.config.origin
      || service.identity.publication_id !== saved.request.publication_id
      || service.identity.artifact_digest !== saved.request.author.candidate.artifact_digest)
      throw Error("Application publication health service differs from its original candidate/profile");
    // Both original-authority getters may perform synchronous protected-file
    // audits. Their time remains inside this original health deadline.
    signal.throwIfAborted();
    if (performance.now() >= deadline) throw Error("Application publication health deadline elapsed during original authority audit");
  };
  const saved = readApplicationPublicationExecution(execution), configured = readApplicationPublicationProfile(saved.publicationProfile);
  const deadline = Math.min(input.deadline, started + configured.config.limits.health_timeout_ms);
  current();
  const before = await service.observe(); current();
  if (!isDeepStrictEqual(before.service, service.identity) || before.requests_used > 253 || before.in_flight !== 0)
    throw Error("Application publication health requires its original idle owner and remaining request capacity");
  if (service.preflight.existing_database !== true || service.preflight.process_exit_confirmed !== true)
    throw Error("Application publication health lacks original existing-database preflight closure");
  const client = await service.runProbe("/", headers => read(service.origin, "/", 16_777_216,
    { ...service.probe, requestHeaders: { ...service.probe.requestHeaders, ...headers } }, deadline, signal)); current();
  if (sha(client) !== input.clientEntryDigest) throw Error("Application publication client bytes differ from the installed candidate");
  const path = saved.definition.persistence.read.path;
  const persistence = await service.runProbe(path, headers => read(service.origin, path, 65_536,
    { ...service.probe, requestHeaders: { ...service.probe.requestHeaders, ...headers } }, deadline, signal)); current();
  // HTTP completion can precede the host's verified stdout progress. Await
  // original counters within this same deadline before recording readiness.
  await service.waitForRequestCounters(before.requests_used + 2, { deadline, signal }); current();
  return ApplicationPublicationHealthV1Schema.parse({ version: 1, scope: "application-readiness-point-in-time", service: service.identity,
    checked_at: new Date().toISOString(), broker_preflight: service.preflight,
    client: { status_code: 200, body_digest: sha(client) }, persistence_read: { path, status_code: 200, body_digest: sha(persistence) } });
}
