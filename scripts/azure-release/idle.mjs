/** Only explicitly paused, never-planned waiting automations may remain during maintenance. */
export const IDLE_WORK_QUERY = `SELECT
  (SELECT count(*) FROM public.runs r
    WHERE r.status IN ('queued','starting','running','awaiting_input','paused')
      OR (r.status = 'failed' AND r.failure_reason = 'daemon_disconnect'
        AND NOT EXISTS (
          SELECT 1 FROM public.event_log e
          WHERE e.organization_id = r.organization_id AND e.run_id = r.id
            AND e.type IN ('run.failed','run.reconciled')
            AND e.payload->'process_exit_confirmed' = 'true'::jsonb
        ))) +
  (SELECT count(*) FROM public.file_leases WHERE status = 'held') +
  (SELECT count(*) FROM public.assistant_turns WHERE status IN ('queued','waiting','running')) +
  (SELECT count(*) FROM public.goal_automations ga
    WHERE COALESCE(ga.status, '') NOT IN ('completed','failed','cancelled')
      AND NOT EXISTS (
        SELECT 1 FROM public.goals g
        WHERE ga.status = 'waiting' AND g.id = ga.goal_id
          AND g.organization_id = ga.organization_id AND g.status = 'paused'
          AND ga.plan_id IS NULL AND ga.discussion_id IS NULL AND g.current_plan_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM public.plans p WHERE p.goal_id = ga.goal_id)
          AND NOT EXISTS (SELECT 1 FROM public.discussions d WHERE d.goal_id = ga.goal_id)
      )) AS active`;
