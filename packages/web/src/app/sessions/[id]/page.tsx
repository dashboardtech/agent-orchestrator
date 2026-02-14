import { notFound } from "next/navigation";
import { getServices, getTracker } from "@/lib/services";
import { sessionToDashboard, enrichSessionIssue } from "@/lib/serialize";
import { SessionDetail } from "@/components/SessionDetail";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function SessionPage({ params }: Props) {
  const { id } = await params;

  const { config, registry, sessionManager } = await getServices().catch(() => {
    notFound();
    // notFound() throws, so this never runs, but TS needs the return type
    return null as never;
  });

  const coreSession = await sessionManager.get(id);
  if (!coreSession) {
    notFound();
  }

  const dashboardSession = sessionToDashboard(coreSession);

  // Enrich issue label using tracker plugin
  if (dashboardSession.issueUrl) {
    let project = config.projects[coreSession.projectId];
    if (!project) {
      const entry = Object.entries(config.projects).find(([, p]) =>
        coreSession.id.startsWith(p.sessionPrefix),
      );
      if (entry) project = entry[1];
    }
    const tracker = getTracker(registry, project);
    if (tracker && project) {
      enrichSessionIssue(dashboardSession, tracker, project);
    }
  }

  return <SessionDetail session={dashboardSession} />;
}
