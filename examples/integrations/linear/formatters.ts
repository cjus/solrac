/**
 * Linear response formatters. Slim — kept just enough fields to be useful
 * to the agent without bloating tool-result tokens. If you fork this for
 * a richer integration, add fields here in one place rather than inline
 * in handlers.
 *
 * Ported structurally from `apps/utcp-tools/src/integrations/linear/formatters.ts`
 * in the PNXStudios monorepo. Trimmed: dropped `formatCycle` and
 * `formatProject` since this example only ports 4 of utcp-tools' 8 ops.
 */

interface LinearIssueLike {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly priority: number;
  readonly dueDate?: string | null;
  readonly updatedAt?: string | Date | null;
  readonly url: string;
  readonly state: Promise<{ name: string } | null>;
  readonly assignee: Promise<{ name: string } | null>;
  readonly labels: () => Promise<{ nodes: ReadonlyArray<{ name: string }> }>;
}

const PRIORITY_LABELS = ["None", "Urgent", "High", "Normal", "Low"] as const;

export async function formatIssue(issue: LinearIssueLike): Promise<{
  id: string;
  identifier: string;
  title: string;
  status: string;
  priority: number;
  priorityLabel: string;
  assignee: string;
  labels: string[];
  dueDate: string | null;
  updatedAt: string | null;
  url: string;
}> {
  const [state, assignee, labels] = await Promise.all([
    issue.state,
    issue.assignee,
    issue.labels(),
  ]);
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    status: state?.name ?? "Unknown",
    priority: issue.priority,
    priorityLabel: PRIORITY_LABELS[issue.priority] ?? "Unknown",
    assignee: assignee?.name ?? "Unassigned",
    labels: labels.nodes.map((l) => l.name),
    dueDate: issue.dueDate ?? null,
    updatedAt: issue.updatedAt
      ? new Date(issue.updatedAt as string | Date).toISOString()
      : null,
    url: issue.url,
  };
}
