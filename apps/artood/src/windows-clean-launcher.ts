import { z } from "zod";
import type { ArtoodConfig } from "./main.js";
import { openSourceLifecycleObserver, claimSourceCleanRestart, closeSourceLifecycleObserver } from "./source-lifecycle-observer.js";
import { prepareCleanSupervisorConfiguration, prepareCleanRestartGeneration, describeCleanRestartGeneration } from "./windows-clean-local-configuration.js";
import { startCleanWindowsSupervisor, type CleanSupervisedOwner } from "./windows-clean-supervised-owner.js";
import { installSupervisedStdinControl, supervisedStdinControlEnabled } from "./windows-daemon-launcher.js";

/** This outer CLI survives one planned normal closure. It opens a distinct
 * original observer and starts a fresh Supervisor/daemon CLI only after the
 * original committed receipt. It is not crash/OS-reboot recovery. */
export async function launchCleanWindowsSupervisedCli(env: NodeJS.ProcessEnv, config: ArtoodConfig, entry: string): Promise<void> {
  const lineageFile = env.ARTOO_SOURCE_CLEAN_CONFIG_FILE;
  if (!lineageFile) throw Error("Clean supervised startup requires protected local lineage configuration");
  let userStopped = false, owner: CleanSupervisedOwner | undefined, stopFailure: unknown;
  let observer: Awaited<ReturnType<typeof openSourceLifecycleObserver>> | undefined;
  const stdinControl = supervisedStdinControlEnabled(env.ARTOO_SUPERVISED_STDIN_CONTROL);
  const stop = () => {
    userStopped = true;
    void owner?.stop().catch(error => { stopFailure ??= error; });
  };
  // This latch remains installed during preparation, old-observer closure,
  // successor claim and native startup, including gaps with no active owner.
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  const removeStdin = stdinControl
    ? installSupervisedStdinControl(process.stdin, stop, error => { stopFailure ??= error; stop(); }) : () => {};
  try {
    const predecessor = prepareCleanSupervisorConfiguration({ config, env, entry, lineageFile });
    let stopId = env.ARTOO_SOURCE_CLEAN_RESTART_STOP_ID === undefined ? undefined : z.string().uuid().parse(env.ARTOO_SOURCE_CLEAN_RESTART_STOP_ID);
    // At most an initial generation and its one accepted-H6 successor. A manual
    // successor selection is already the second generation and cannot loop.
    for (let generationIndex = stopId === undefined ? 0 : 1; generationIndex <= 1 && !userStopped; generationIndex++) {
      observer = await openSourceLifecycleObserver({ nodeUrl: config.url, nodeId: config.nodeId });
      if (userStopped) break;
      let configuration = predecessor;
      if (stopId !== undefined) {
        const grant = await claimSourceCleanRestart(observer, stopId);
        if (userStopped) break; // Preserve any reserved grant; never start after Stop.
        const generation = prepareCleanRestartGeneration({ predecessor, observer, grant });
        const description = describeCleanRestartGeneration(generation);
        const currentEnv = { ...env, ARTOO_PRODUCT_SOURCE_CONFIG_FILE: description.source_configuration_file };
        const { loadPreparedConfigFromEnv } = await import("./main.js");
        if (userStopped) break;
        configuration = prepareCleanSupervisorConfiguration({ config: loadPreparedConfigFromEnv(currentEnv), env: currentEnv, entry, lineageFile, generation });
      }
      if (userStopped) break;
      owner = startCleanWindowsSupervisor({ configuration, observer, manageStopSignals: false, onReady(generation) {
        process.stdout.write(JSON.stringify({ kind: "artoo.supervised.ready", generation, node_id: config.nodeId }) + "\n");
      } });
      const transition = generationIndex === 0 ? owner.transitionAfterAcceptedH6() : Promise.resolve();
      void transition.catch(() => {}); // The owner retains failure and joins native closure.
      const completion = await owner.completion;
      await transition;
      await closeSourceLifecycleObserver(observer); observer = undefined; owner = undefined;
      if (completion.receipt) process.stdout.write(JSON.stringify({ kind: "artoo.supervised.clean-stop", receipt: completion.receipt,
        reason: completion.reason }) + "\n");
      if (stopFailure) throw stopFailure;
      if (userStopped || completion.reason === "user-stop") break;
      if (generationIndex !== 0 || completion.reason !== "planned-transition") throw Error("Only one original planned transition may start a successor");
      stopId = completion.receipt.stop_id;
    }
    if (observer) { await closeSourceLifecycleObserver(observer); observer = undefined; }
    if (stopFailure) throw stopFailure;
    process.stdout.write(JSON.stringify({ kind: "artoo.supervised.stopped", cleanupConfirmed: true }) + "\n");
  } catch (error) {
    // Cancel an outstanding planned wait and join the existing owner; neither a
    // failure nor a copied receipt may create a replacement native process.
    const errors = [error];
    if (owner) {
      try { await owner.stop(); } catch (stopping) { if (stopping !== error) errors.push(stopping); }
      try { await owner.completion; } catch (closing) { if (closing !== error) errors.push(closing); }
    }
    if (observer) try { await closeSourceLifecycleObserver(observer); } catch (closing) { errors.push(closing); }
    if (errors.length > 1) throw new AggregateError(errors, "Clean launcher failed and original closure was not fully confirmed");
    throw error;
  } finally {
    process.off("SIGINT", stop); process.off("SIGTERM", stop); removeStdin();
  }
}
