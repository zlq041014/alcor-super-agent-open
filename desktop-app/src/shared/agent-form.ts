import { ProfileSchema } from "./contracts";
/** Invoke only from the final submit action of a form with a visible model and effort.
 * Conversation requests do not use these fields: they return a pending creation card. */
export async function submitAgentForm(
  send: (value: any) => Promise<any>,
  value: any,
) {
  if (
    !value.profile ||
    !["task.create", "discussion.open", "agent.delegate"].includes(value.op)
  )
    return send(value);
  const { profile, catalogVersion, ...intent } = value,
    selected = ProfileSchema.parse(profile);
  const pending = await send(intent);
  if (!pending.launchId) return pending;
  return send({
    op: "agent.launch.confirm",
    id: pending.launchId,
    profile: selected,
    ...(catalogVersion ? { catalogVersion } : {}),
  });
}
