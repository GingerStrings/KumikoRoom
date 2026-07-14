import { ProjectWorkspace } from "../../../../src/components/studio/ProjectWorkspace";

interface StudioProjectPageProps {
  params: { id: string };
}

export default function StudioProjectPage({ params }: StudioProjectPageProps) {
  return <ProjectWorkspace projectId={params.id} />;
}
