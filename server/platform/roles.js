// What a user is in a company, from less to more. (The table of what each can
// do is next to each action: see server/dashboard/dashboard.js.)
export const ROLES = ['observer', 'operator', 'manager', 'owner']
export const atLeast = (role, needed) => ROLES.includes(needed) && ROLES.indexOf(role) >= ROLES.indexOf(needed)
