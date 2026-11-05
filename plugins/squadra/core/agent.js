// What core asks of the agent it runs under. The entry point fills it in, before
// anything can arrive:
//   deliver({ content, meta })       put a message or a notice in front of it
//   takePermissionReply(msg, match)  a "yes abcde" from another session: the
//                                    verdict, null to drop it, 'chat' if it isn't one
//   givePermission(verdict)          hand it that answer
export const agent = {}

export function useAgent(a) {
  Object.assign(agent, a)
}
